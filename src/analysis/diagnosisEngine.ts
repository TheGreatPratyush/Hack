import * as fs from 'fs';
import * as path from 'path';
import { CheckResult } from '../core/checkRunner';
import { LlmClient } from '../llm';
import {
  diagnoseCheckResult,
  truncateEvidence
} from '../diagnostics/diagnosticEngine';
import {
  proposeFixForIssue,
  applyProposedFix,
  rollbackAppliedFix,
  generateUnifiedDiff,
  hashContent,
  ProposedFix,
  FixRollbackRecord,
  RollbackResult
} from '../fixes/fixEngine';
import {
  FailureClassification,
  StructuredModelDiagnosis,
  ValidatedDiagnosisResult,
  DiagnosisVerificationResult
} from './types';

const TOOLING_FAILURE_REGEX = /(command not found|not recognized as an internal or external command|ENOENT|EACCES|permission denied|spawn .* ENOENT)/i;
const DEPENDENCY_FAILURE_REGEX = /(MODULE_NOT_FOUND|Cannot find module|No module named|package\.json: no such file|requirements\.txt: no such file|ERR_PNPM_NO_LOCKFILE|unmet peer dependency)/i;
const TEST_ASSERTION_REGEX = /(AssertionError|Expected:|Received:|expect\(|FAIL\s+|FAIL:|tests failed|assertion failed)/i;
const SOURCE_DEFECT_REGEX = /(SyntaxError|TypeError|ReferenceError|compile error|TS\d{4}:|IndentationError|NameError|AttributeError)/i;

const STACK_LINE_REGEX = /(?:at\s+(?:[^\s(]+\s+\()?|(?:File\s+["']))([a-zA-Z0-9_\-./\\]+\.(?:[a-zA-Z0-9]+))(?::|\", line )(\d+)(?::(\d+))?/i;

export interface AnalyzeOptions {
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Deterministically classifies the failure mode of a check execution.
 */
export function classifyFailure(checkResult: CheckResult): FailureClassification {
  if (checkResult.exitCode === 0) {
    return 'unknown';
  }

  const combinedOutput = `${checkResult.stderr}\n${checkResult.stdout}`;

  // 1. Tooling / environment check
  if (checkResult.exitCode === 127 || checkResult.status === 'timed_out' || checkResult.status === 'cancelled') {
    return 'environment_tooling';
  }
  if (TOOLING_FAILURE_REGEX.test(combinedOutput)) {
    return 'environment_tooling';
  }

  // 2. Dependency / config check
  if (DEPENDENCY_FAILURE_REGEX.test(combinedOutput)) {
    return 'dependency_config';
  }

  // 3. Test assertion check
  if (TEST_ASSERTION_REGEX.test(combinedOutput)) {
    return 'test_assertion';
  }

  // 4. Source code defect check
  if (SOURCE_DEFECT_REGEX.test(combinedOutput)) {
    return 'source_code_defect';
  }

  return 'unknown';
}

/**
 * Extracts source code context around a cited file and line inside the repository.
 */
function extractSourceSnippet(
  repoRoot: string,
  relativePath: string,
  lineNum: number,
  contextRadius: number = 5
): string | null {
  const fullPath = path.resolve(repoRoot, relativePath);
  try {
    const realRepo = fs.realpathSync(path.resolve(repoRoot));
    const realTarget = fs.realpathSync(fullPath);
    if (realTarget !== realRepo && !realTarget.startsWith(realRepo + path.sep)) {
      return null;
    }
    const content = fs.readFileSync(realTarget, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lineNum < 1 || lineNum > lines.length) {
      return null;
    }
    const start = Math.max(0, lineNum - 1 - contextRadius);
    const end = Math.min(lines.length, lineNum + contextRadius);
    return lines
      .slice(start, end)
      .map((l, idx) => `${start + idx + 1}: ${l}`)
      .join('\n');
  } catch {
    return null;
  }
}

/**
 * Parses potential stack frame file and line references from raw output.
 */
function extractFileLocationsFromOutput(
  repoRoot: string,
  output: string
): Array<{ relativePath: string; line: number; column?: number }> {
  const lines = output.split(/\r?\n/);
  const locations: Array<{ relativePath: string; line: number; column?: number }> = [];

  for (const line of lines) {
    const match = line.match(STACK_LINE_REGEX);
    if (match) {
      const rawPath = match[1];
      const lineNum = parseInt(match[2], 10);
      const colNum = match[3] ? parseInt(match[3], 10) : undefined;

      const normalizedRel = path.isAbsolute(rawPath)
        ? path.relative(repoRoot, rawPath)
        : rawPath;

      if (!normalizedRel.startsWith('..') && !path.isAbsolute(normalizedRel)) {
        const fullPath = path.resolve(repoRoot, normalizedRel);
        if (fs.existsSync(fullPath)) {
          locations.push({ relativePath: normalizedRel, line: lineNum, column: colNum });
        }
      }
    }
  }

  return locations;
}

/**
 * Formats evidence for local Ollama query.
 */
function buildDiagnosisPrompt(
  checkResult: CheckResult,
  classification: FailureClassification,
  sourceContexts: Array<{ relativePath: string; snippet: string }>
): string {
  let prompt = `Analyze this check execution failure and return ONLY a valid JSON object matching the StructuredModelDiagnosis schema.

Command: ${checkResult.command} ${(checkResult.args || []).join(' ')}
Exit Code: ${checkResult.exitCode}
Execution Status: ${checkResult.status}
Initial Failure Classification: ${classification}

Failure Output (bounded):
\`\`\`
${truncateEvidence(`${checkResult.stderr}\n${checkResult.stdout}`, 1500)}
\`\`\`
`;

  if (sourceContexts.length > 0) {
    prompt += `\nRelevant Source Code Snippets from Repository:\n`;
    for (const ctx of sourceContexts) {
      prompt += `<file_context path="${ctx.relativePath}">\n${ctx.snippet}\n</file_context>\n\n`;
    }
  }

  prompt += `
Critical Anti-Speculation Rules:
1. Do NOT invent bugs, non-existent files, or unsupported explanations.
2. If the failure is an environment/tooling issue or missing dependency, set isPlausibleSourceDefect: false and do NOT propose any code patch.
3. Propose a proposedPatchSnippet ONLY when there is clear, confirmed evidence of a defect in an existing file.
4. "originalSnippet" in proposedPatchSnippet MUST be an exact string currently present in the target file.

Schema:
{
  "failureClassification": "environment_tooling" | "dependency_config" | "test_assertion" | "source_code_defect" | "unknown",
  "observedEvidence": string,
  "likelyExplanation": string,
  "confidenceScore": number (0.0 to 1.0),
  "isPlausibleSourceDefect": boolean,
  "supportingLocations": [
    { "relativePath": string, "line": number, "column": number }
  ],
  "recommendedNextStep": string,
  "proposedPatchSnippet": {
    "relativePath": string,
    "originalSnippet": string,
    "replacementSnippet": string
  } (optional)
}`;

  return prompt;
}

/**
 * LlmDiagnosisEngine orchestrates evidence-backed diagnosis, validation, safe patching, and re-verification.
 */
export class LlmDiagnosisEngine {
  private readonly repoRoot: string;
  private readonly llmClient?: LlmClient;

  constructor(repoRoot: string, llmClient?: LlmClient) {
    this.repoRoot = path.resolve(repoRoot);
    this.llmClient = llmClient;
  }

  /**
   * Analyzes a failed check execution, queries local LLM with fallback, validates diagnosis, and proposes safe diff.
   */
  public async analyzeFailure(
    checkResult: CheckResult,
    options?: AnalyzeOptions
  ): Promise<ValidatedDiagnosisResult> {
    const classification = classifyFailure(checkResult);

    // If check clean pass
    if (checkResult.exitCode === 0) {
      return {
        isValid: true,
        classification: 'unknown',
        isOfflineFallback: false,
        validationErrors: [],
        explanation: 'Check passed cleanly with exit code 0. No failure to diagnose.'
      };
    }

    // Extract potential source locations
    const candidateLocations = extractFileLocationsFromOutput(
      this.repoRoot,
      `${checkResult.stderr}\n${checkResult.stdout}`
    );

    const sourceContexts: Array<{ relativePath: string; snippet: string }> = [];
    for (const loc of candidateLocations) {
      const snippet = extractSourceSnippet(this.repoRoot, loc.relativePath, loc.line);
      if (snippet) {
        sourceContexts.push({ relativePath: loc.relativePath, snippet });
      }
    }

    let modelDiagnosis: StructuredModelDiagnosis | null = null;

    if (this.llmClient) {
      try {
        const prompt = buildDiagnosisPrompt(checkResult, classification, sourceContexts);
        // Direct generation query to local model
        const rawResult = await (this.llmClient as any).generateSetupPlan
          ? await this.queryModelDiagnosis(prompt, options)
          : null;
        modelDiagnosis = rawResult;
      } catch {
        // Fall back to deterministic engine
      }
    }

    // If offline fallback or model failed, use deterministic diagnostic engine
    if (!modelDiagnosis) {
      return this.runDeterministicFallback(checkResult, classification);
    }

    // Validate the model diagnosis
    return this.validateAndGroundDiagnosis(modelDiagnosis, classification);
  }

  /**
   * Queries model for structured diagnosis JSON.
   */
  private async queryModelDiagnosis(
    prompt: string,
    options?: AnalyzeOptions
  ): Promise<StructuredModelDiagnosis | null> {
    if (!this.llmClient) {
      return null;
    }

    // Call client with timeout and JSON format
    const fetchFn = (this.llmClient as any).fetchImpl || globalThis.fetch;
    const baseUrl = (this.llmClient as any).baseUrl || 'http://127.0.0.1:11434';
    const model = options?.model || (this.llmClient as any).defaultModel || 'qwen2.5-coder:7b';
    const timeoutMs = options?.timeoutMs || 30000;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          format: 'json'
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        return null;
      }

      const envelope = (await response.json()) as { response?: string };
      if (!envelope.response) {
        return null;
      }

      let cleaned = envelope.response.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      }

      return JSON.parse(cleaned) as StructuredModelDiagnosis;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Strictly validates model diagnosis against disk reality and produces a safe ProposedFix.
   */
  private validateAndGroundDiagnosis(
    diagnosis: StructuredModelDiagnosis,
    deterministicClassification: FailureClassification
  ): ValidatedDiagnosisResult {
    const validationErrors: string[] = [];

    // Never accept an LLM claim that an environment failure is a code bug
    if (
      (deterministicClassification === 'environment_tooling' || deterministicClassification === 'dependency_config') &&
      diagnosis.isPlausibleSourceDefect
    ) {
      validationErrors.push(
        `Overruled model: execution failure is classified as '${deterministicClassification}', but model claimed a source code defect.`
      );
      diagnosis.isPlausibleSourceDefect = false;
      diagnosis.proposedPatchSnippet = undefined;
    }

    // Validate cited file locations exist on disk
    if (Array.isArray(diagnosis.supportingLocations)) {
      for (const loc of diagnosis.supportingLocations) {
        if (!loc.relativePath || path.isAbsolute(loc.relativePath) || loc.relativePath.includes('..')) {
          validationErrors.push(`Invalid relative path in supporting locations: '${loc.relativePath}'`);
          continue;
        }
        const fullPath = path.resolve(this.repoRoot, loc.relativePath);
        if (!fs.existsSync(fullPath)) {
          validationErrors.push(`Cited supporting file does not exist on disk: '${loc.relativePath}'`);
        } else if (loc.line !== undefined) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const lineCount = content.split(/\r?\n/).length;
            if (loc.line < 1 || loc.line > lineCount) {
              validationErrors.push(
                `Cited line ${loc.line} exceeds total line count (${lineCount}) of '${loc.relativePath}'`
              );
            }
          } catch {
            // Ignored
          }
        }
      }
    }

    // Validate proposed patch snippet
    let proposedFix: ProposedFix | null = null;
    if (diagnosis.proposedPatchSnippet && diagnosis.isPlausibleSourceDefect) {
      const patch = diagnosis.proposedPatchSnippet;
      const targetRel = patch.relativePath;

      if (!targetRel || path.isAbsolute(targetRel) || targetRel.includes('..')) {
        validationErrors.push(`Proposed patch contains invalid relative path: '${targetRel}'`);
      } else {
        const fullPath = path.resolve(this.repoRoot, targetRel);
        if (!fs.existsSync(fullPath)) {
          validationErrors.push(`Target patch file does not exist on disk: '${targetRel}'`);
        } else {
          try {
            const originalContent = fs.readFileSync(fullPath, 'utf8');

            // Grounding check: originalSnippet MUST exist in the file!
            if (!patch.originalSnippet || !originalContent.includes(patch.originalSnippet)) {
              validationErrors.push(
                `Model hallucination rejected: 'originalSnippet' was not found in target file '${targetRel}'.`
              );
            } else {
              const patchedContent = originalContent.replace(
                patch.originalSnippet,
                patch.replacementSnippet
              );

              const unifiedDiff = generateUnifiedDiff(targetRel, originalContent, patchedContent);
              const originalContentHash = hashContent(originalContent);

              proposedFix = {
                id: `llm-fix-${Date.now()}`,
                issueId: `issue-${targetRel}`,
                title: diagnosis.likelyExplanation.slice(0, 80),
                description: diagnosis.likelyExplanation,
                targetFilePath: fullPath,
                relativeFilePath: targetRel,
                originalContent,
                originalContentHash,
                patchedContent,
                unifiedDiff,
                canSafelyApply: true,
                safetyNotes: [
                  'Model-assisted patch grounded on observed execution failure.',
                  'Pre-flight verified: original snippet confirmed present on disk.',
                  'Atomic application and rollback protection active.'
                ]
              };
            }
          } catch (err: unknown) {
            validationErrors.push(`Failed to read target patch file '${targetRel}'`);
          }
        }
      }
    }

    const isValid = validationErrors.length === 0;

    return {
      isValid,
      classification: deterministicClassification,
      diagnosis,
      isOfflineFallback: false,
      validationErrors,
      proposedFix,
      explanation: diagnosis.likelyExplanation
    };
  }

  /**
   * Deterministic fallback when local LLM is offline or returns unparseable output.
   */
  private runDeterministicFallback(
    checkResult: CheckResult,
    classification: FailureClassification
  ): ValidatedDiagnosisResult {
    const report = diagnoseCheckResult(checkResult);
    const primaryIssue = report.issues[0];

    const diagnosis: StructuredModelDiagnosis = {
      failureClassification: classification,
      observedEvidence: primaryIssue?.observedEvidence || checkResult.stderr || checkResult.stdout,
      likelyExplanation: primaryIssue?.likelyExplanation || `Failure classified as ${classification}.`,
      confidenceScore: primaryIssue?.evidenceQuality === 'Strong evidence' ? 0.9 : 0.6,
      isPlausibleSourceDefect: classification === 'source_code_defect' || classification === 'test_assertion',
      supportingLocations: primaryIssue?.location
        ? [{ relativePath: primaryIssue.location.relativePath, line: primaryIssue.location.line }]
        : [],
      recommendedNextStep: primaryIssue?.recommendedAction || 'Inspect check logs.'
    };

    let proposedFix: ProposedFix | null = null;
    if (primaryIssue) {
      proposedFix = proposeFixForIssue(primaryIssue, this.repoRoot);
    }

    return {
      isValid: true,
      classification,
      diagnosis,
      isOfflineFallback: true,
      validationErrors: [],
      proposedFix,
      explanation: `${diagnosis.likelyExplanation} (Offline Deterministic Heuristic)`
    };
  }

  /**
   * Safely applies an approved fix, reruns the check, and verifies whether exit code is 0.
   */
  public async applyAndVerifyFix(
    fix: ProposedFix,
    rerunCheckFn: () => Promise<CheckResult>,
    options: { userApproved: boolean }
  ): Promise<DiagnosisVerificationResult> {
    if (!options.userApproved) {
      return {
        verified: false,
        initialExitCode: null,
        verifiedExitCode: null,
        checkResult: {
          checkName: 'unapproved',
          command: 'none',
          args: [],
          cwd: this.repoRoot,
          exitCode: null,
          status: 'error',
          stdout: '',
          stderr: 'User did not approve fix application.',
          durationMs: 0,
          explanation: 'Patch application rejected by user.'
        },
        explanation: 'User approval was withheld. File on disk was NOT modified.'
      };
    }

    // 1. Apply fix safely with stale-hash check
    const applyResult = applyProposedFix(fix, this.repoRoot);
    if (!applyResult.success || !applyResult.rollbackRecord) {
      return {
        verified: false,
        initialExitCode: null,
        verifiedExitCode: null,
        checkResult: {
          checkName: 'apply_failed',
          command: 'apply',
          args: [],
          cwd: this.repoRoot,
          exitCode: 1,
          status: 'error',
          stdout: '',
          stderr: applyResult.error || 'Failed to apply patch to file.',
          durationMs: 0,
          explanation: applyResult.error || 'Patch application failed.'
        },
        explanation: `Failed to apply fix: ${applyResult.error}`
      };
    }

    // 2. Rerun relevant check to verify
    const rerunResult = await rerunCheckFn();
    const verified = rerunResult.exitCode === 0;

    return {
      verified,
      initialExitCode: null,
      verifiedExitCode: rerunResult.exitCode,
      checkResult: rerunResult,
      rollbackRecord: applyResult.rollbackRecord,
      explanation: verified
        ? 'Fix verified successfully: rerun check passed with exit code 0.'
        : `Fix failed re-verification: rerun check exited with code ${rerunResult.exitCode}. Rollback available.`
    };
  }

  /**
   * Rolls back an applied patch.
   */
  public rollbackFix(rollbackRecord: FixRollbackRecord): RollbackResult {
    return rollbackAppliedFix(rollbackRecord, this.repoRoot);
  }
}
