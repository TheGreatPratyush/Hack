import { LlmClient } from '../llm';
import { parseGitHubRepo } from './prService';

export interface FactualPrEvidence {
  repoUrl: string;
  baseBranch: string;
  featureBranch: string;
  changedFiles: string[];
  unifiedDiff: string;
  issueTitle: string;
  observedEvidence: string;
  likelyExplanation: string;
  patchApplied: boolean;
  verificationCommand: string;
  verificationExitCode: number | null;
  verificationPassed: boolean;
  rollbackOccurred: boolean;
  unrelatedFilesDetected?: string[];
}

export interface StructuredPrDraft {
  commitTitle: string;
  commitBody: string;
  prTitle: string;
  prBodyMarkdown: string;
  compareUrl: string;
  isDraft: true;
  isModelGenerated: boolean;
  warnings: string[];
}

const SECRET_PATTERNS = [
  /ghp_[a-zA-Z0-9_]{20,}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  /Bearer\s+[a-zA-Z0-9._\-]{20,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*["']?([^\s"';]+)["']?/gi
];

/**
 * Redacts any detected credentials, API tokens, or private keys from text.
 */
export function redactSensitiveContent(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED_SECRET]');
  }
  return result;
}

/**
 * Builds standard GitHub Compare URL.
 */
export function buildCompareUrl(
  repoUrl: string,
  baseBranch: string,
  featureBranch: string,
  prTitle: string,
  prBody: string
): string {
  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) {
    return repoUrl;
  }
  const cleanBase = encodeURIComponent(baseBranch || 'main');
  const cleanHead = encodeURIComponent(featureBranch);
  const cleanTitle = encodeURIComponent(prTitle);
  const cleanBody = encodeURIComponent(prBody);

  return `https://github.com/${parsed.owner}/${parsed.repo}/compare/${cleanBase}...${cleanHead}?expand=1&title=${cleanTitle}&body=${cleanBody}`;
}

/**
 * Strictly validates an untrusted draft against the PR draft schema.
 */
function validatePrDraftPayload(
  data: unknown,
  evidence: FactualPrEvidence
): { isValid: boolean; draft?: { commitTitle: string; commitBody: string; prTitle: string; prBodyMarkdown: string }; errors: string[] } {
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { isValid: false, errors: ['Draft response must be a non-null object.'] };
  }

  const obj = data as Record<string, unknown>;

  // commitTitle
  if (typeof obj.commitTitle !== 'string' || !obj.commitTitle.trim()) {
    errors.push('Missing or empty commitTitle.');
  }
  const commitTitle = typeof obj.commitTitle === 'string' ? obj.commitTitle.trim() : '';
  if (commitTitle.length > 100) {
    errors.push('commitTitle exceeds 100 characters limit.');
  }

  // commitBody
  if (typeof obj.commitBody !== 'string' || !obj.commitBody.trim()) {
    errors.push('Missing or empty commitBody.');
  }
  const commitBody = typeof obj.commitBody === 'string' ? obj.commitBody.trim() : '';
  if (commitBody.length > 3000) {
    errors.push('commitBody exceeds 3000 characters limit.');
  }

  // prTitle
  if (typeof obj.prTitle !== 'string' || !obj.prTitle.trim()) {
    errors.push('Missing or empty prTitle.');
  }
  const prTitle = typeof obj.prTitle === 'string' ? obj.prTitle.trim() : '';
  if (prTitle.length > 150) {
    errors.push('prTitle exceeds 150 characters limit.');
  }

  // prBodyMarkdown
  if (typeof obj.prBodyMarkdown !== 'string' || !obj.prBodyMarkdown.trim()) {
    errors.push('Missing or empty prBodyMarkdown.');
  }
  const prBodyMarkdown = typeof obj.prBodyMarkdown === 'string' ? obj.prBodyMarkdown.trim() : '';
  if (prBodyMarkdown.length > 6000) {
    errors.push('prBodyMarkdown exceeds 6000 characters limit.');
  }

  // Anti-Hallucination check: if verification failed or was not run, forbid claims that it succeeded
  if (!evidence.verificationPassed || evidence.verificationExitCode !== 0) {
    const lowerBody = prBodyMarkdown.toLowerCase();
    if (lowerBody.includes('verified: passed') || lowerBody.includes('verification: exit code 0')) {
      errors.push('Model hallucination: PR body claims verification passed, but actual verification failed.');
    }
  }

  if (errors.length > 0) {
    return { isValid: false, errors };
  }

  return {
    isValid: true,
    draft: {
      commitTitle,
      commitBody,
      prTitle,
      prBodyMarkdown
    },
    errors: []
  };
}

/**
 * Builds the prompt for local Ollama to draft the PR content.
 */
function buildPrDraftPrompt(evidence: FactualPrEvidence): string {
  const sanitizedEvidence = redactSensitiveContent(evidence.observedEvidence);
  const sanitizedDiff = redactSensitiveContent(evidence.unifiedDiff);

  const verificationStatusText = evidence.rollbackOccurred
    ? `ROLLED BACK (verification failed with exit code ${evidence.verificationExitCode})`
    : evidence.verificationPassed && evidence.verificationExitCode === 0
      ? `PASSED (command '${evidence.verificationCommand}' exited with code 0)`
      : `FAILED / UNVERIFIED (command '${evidence.verificationCommand}' exited with code ${evidence.verificationExitCode})`;

  return `You are FirstPR, an evidence-grounded pull request assistant.
Draft a concise, professional pull request and commit message based ONLY on the verified factual evidence below.
Return ONLY a valid JSON object matching the schema. Output pure JSON without markdown code blocks.

Factual Context:
- Repository: ${evidence.repoUrl}
- Base Branch: ${evidence.baseBranch}
- Feature Branch: ${evidence.featureBranch}
- Changed Files: ${evidence.changedFiles.join(', ') || 'None'}
- Issue: ${evidence.issueTitle}
- Observed Evidence:
\`\`\`
${sanitizedEvidence.slice(0, 1000)}
\`\`\`
- Likely Explanation: ${evidence.likelyExplanation}
- Verification Status: ${verificationStatusText}
- Patch Applied: ${evidence.patchApplied}
- Rollback Occurred: ${evidence.rollbackOccurred}
- Verified Unified Diff:
\`\`\`diff
${sanitizedDiff.slice(0, 1500)}
\`\`\`

Strict Anti-Hallucination Rules:
1. Do NOT invent issue numbers (e.g. #123), external URLs, or team member mentions.
2. If verification failed or rollback occurred, clearly state that verification failed or that the patch was rolled back. Do NOT claim the bug is resolved.
3. Only summarize the files and changes that actually appear in the verified diff.

Schema:
{
  "commitTitle": string (e.g. "fix: handle edge case in calc add"),
  "commitBody": string (2-4 lines summarizing the fix and verification),
  "prTitle": string (e.g. "fix: resolve calculation error in calc.js"),
  "prBodyMarkdown": string (Markdown with sections: Problem, Observed Evidence, Proposed Changes, Verification Results, and Limitations)
}`;
}

/**
 * Generates a deterministic fallback PR draft purely from verified facts.
 */
export function generateDeterministicPrDraft(evidence: FactualPrEvidence): StructuredPrDraft {
  const sanitizedEvidence = redactSensitiveContent(evidence.observedEvidence);
  const sanitizedDiff = redactSensitiveContent(evidence.unifiedDiff);

  const cleanTitle = evidence.issueTitle.replace(/[^\w\s-]/g, '').slice(0, 60).trim();
  const commitTitle = `fix: ${cleanTitle || 'resolve observed check failure'}`;
  const prTitle = `Fix: ${cleanTitle || 'resolve observed check failure'}`;

  const verificationLine = evidence.rollbackOccurred
    ? `**Verification Status:** ❌ **Failed (Rolled Back)** — command \`${evidence.verificationCommand}\` exited with code \`${evidence.verificationExitCode}\`.`
    : evidence.verificationPassed && evidence.verificationExitCode === 0
      ? `**Verification Status:** ✅ **Verified Locally** — command \`${evidence.verificationCommand}\` passed with exit code \`0\`.`
      : `**Verification Status:** ⚠️ **Unverified / Failed** — command \`${evidence.verificationCommand}\` exited with code \`${evidence.verificationExitCode}\`.`;

  let prBody = `## Problem Description\n\n`;
  prBody += `${evidence.issueTitle}\n\n`;
  prBody += `**Likely Explanation:** ${evidence.likelyExplanation}\n\n`;

  prBody += `## Observed Evidence\n\n`;
  prBody += `\`\`\`\n${sanitizedEvidence.slice(0, 800)}\n\`\`\`\n\n`;

  prBody += `## Proposed Changes\n\n`;
  prBody += `Modified files: ${evidence.changedFiles.map(f => `\`${f}\``).join(', ') || 'None'}\n\n`;
  if (sanitizedDiff) {
    prBody += `<details>\n<summary>View Unified Diff</summary>\n\n\`\`\`diff\n${sanitizedDiff.slice(0, 1500)}\n\`\`\`\n\n</details>\n\n`;
  }

  prBody += `## Local Verification Results\n\n`;
  prBody += `${verificationLine}\n\n`;

  prBody += `## Safety & Review Notes\n\n`;
  prBody += `- **FirstPR Review Gate:** Generated from verified local test and git execution evidence.\n`;
  prBody += `- **Staging Isolation:** Only approved files were modified.\n\n`;
  prBody += `_Draft generated by FirstPR Deterministic Engine._`;

  let commitBody = `Issue: ${evidence.issueTitle}\n`;
  commitBody += `Observed failure in ${evidence.changedFiles.join(', ')}\n`;
  commitBody += `Local verification: ${evidence.verificationPassed ? 'Passed (code 0)' : `Failed (code ${evidence.verificationExitCode})`}`;

  const compareUrl = buildCompareUrl(
    evidence.repoUrl,
    evidence.baseBranch,
    evidence.featureBranch,
    prTitle,
    prBody
  );

  return {
    commitTitle,
    commitBody,
    prTitle,
    prBodyMarkdown: prBody,
    compareUrl,
    isDraft: true,
    isModelGenerated: false,
    warnings: evidence.rollbackOccurred
      ? ['Verification failed and rollback was applied. This PR draft reflects an unverified or rolled-back state.']
      : []
  };
}

/**
 * Generates an evidence-backed PR draft using local LLM inference with deterministic fallback.
 */
export async function generateEvidenceBackedPrDraft(
  evidence: FactualPrEvidence,
  llmClient?: LlmClient,
  options?: { model?: string; timeoutMs?: number }
): Promise<StructuredPrDraft> {
  const warnings: string[] = [];

  if (evidence.rollbackOccurred) {
    warnings.push('Patch was rolled back on disk due to verification failure or user request.');
  }
  if (!evidence.verificationPassed && evidence.verificationExitCode !== 0) {
    warnings.push(`Local verification failed with exit code ${evidence.verificationExitCode}.`);
  }
  if (evidence.unrelatedFilesDetected && evidence.unrelatedFilesDetected.length > 0) {
    warnings.push(`Unrelated modified files detected in workspace: ${evidence.unrelatedFilesDetected.join(', ')}. These will NOT be staged.`);
  }

  if (!llmClient) {
    const fallback = generateDeterministicPrDraft(evidence);
    return { ...fallback, warnings: [...fallback.warnings, ...warnings] };
  }

  const prompt = buildPrDraftPrompt(evidence);
  const fetchFn = (llmClient as any).fetchImpl || globalThis.fetch;
  const baseUrl = (llmClient as any).baseUrl || 'http://127.0.0.1:11434';
  const model = options?.model || (llmClient as any).defaultModel || 'qwen2.5-coder:7b';
  const timeoutMs = options?.timeoutMs || 30000;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let rawJson: unknown = null;
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

    if (response.ok) {
      const envelope = (await response.json()) as { response?: string };
      if (envelope.response) {
        let cleaned = envelope.response.trim();
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        }
        rawJson = JSON.parse(cleaned);
      }
    }
  } catch {
    // Model unavailable, fall back cleanly
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!rawJson) {
    const fallback = generateDeterministicPrDraft(evidence);
    return { ...fallback, warnings: [...fallback.warnings, ...warnings, 'Local LLM unavailable; used deterministic draft template.'] };
  }

  const validated = validatePrDraftPayload(rawJson, evidence);
  if (!validated.isValid || !validated.draft) {
    const fallback = generateDeterministicPrDraft(evidence);
    return {
      ...fallback,
      warnings: [
        ...fallback.warnings,
        ...warnings,
        `LLM output schema validation failed (${validated.errors.join('; ')}); used deterministic draft template.`
      ]
    };
  }

  const draft = validated.draft;
  let finalBody = draft.prBodyMarkdown;
  if (!finalBody.includes('_Draft generated by FirstPR_')) {
    finalBody += `\n\n_Draft generated by FirstPR Local LLM Analysis._`;
  }

  const compareUrl = buildCompareUrl(
    evidence.repoUrl,
    evidence.baseBranch,
    evidence.featureBranch,
    draft.prTitle,
    finalBody
  );

  return {
    commitTitle: draft.commitTitle,
    commitBody: draft.commitBody,
    prTitle: draft.prTitle,
    prBodyMarkdown: finalBody,
    compareUrl,
    isDraft: true,
    isModelGenerated: true,
    warnings
  };
}
