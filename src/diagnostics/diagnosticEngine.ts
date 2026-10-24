import * as path from 'path';
import { CheckResult } from '../core/checkRunner';

export type DiagnosticCategory =
  | 'typescript_compile_error'
  | 'test_assertion_failure'
  | 'missing_dependency'
  | 'syntax_error'
  | 'build_error'
  | 'unknown_failure'
  | 'clean_pass';

export type EvidenceQuality =
  | 'Strong evidence'
  | 'Possible explanation'
  | 'Insufficient evidence';

export interface DiagnosticLocation {
  filePath: string;
  relativePath: string;
  line?: number;
  column?: number;
}

export interface DiagnosticIssue {
  id: string;
  category: DiagnosticCategory;
  title: string;
  severity: 'error' | 'warning' | 'info';
  evidenceQuality: EvidenceQuality;
  location?: DiagnosticLocation;
  observedEvidence: string;
  likelyExplanation: string;
  recommendedAction: string;
  failedCommand: string;
  exitCode: number | null;
}

export interface DiagnosticReport {
  hasIssues: boolean;
  summary: string;
  issues: DiagnosticIssue[];
  rawResultRef: {
    checkName: string;
    command: string;
    exitCode: number | null;
    status: string;
    durationMs: number;
  };
}

const MAX_EVIDENCE_CHARS = 1200;

/**
 * Truncates evidence text safely with ellipsis if too long.
 */
export function truncateEvidence(text: string, maxChars: number = MAX_EVIDENCE_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(0, maxChars) + '\n... [evidence truncated for display]';
}

/**
 * Normalizes a file path relative to repo cwd if within it.
 */
export function normalizePath(rawPath: string, cwd: string): { filePath: string; relativePath: string } {
  const cleanRaw = rawPath.trim().replace(/^['"]|['"]$/g, '');
  if (path.isAbsolute(cleanRaw)) {
    const rel = path.relative(cwd, cleanRaw);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { filePath: cleanRaw, relativePath: rel };
    }
  }
  return { filePath: cleanRaw, relativePath: cleanRaw };
}

/**
 * Parses CheckResult outputs and produces structured, evidence-backed diagnostic issues.
 */
export function diagnoseCheckResult(result: CheckResult): DiagnosticReport {
  const { checkName, command, args, exitCode, status, stdout, stderr, cwd, durationMs } = result;
  const fullCommand = `${command} ${args.join(' ')}`.trim();
  const combinedOutput = `${stdout}\n${stderr}`.trim();

  const rawResultRef = {
    checkName,
    command: fullCommand,
    exitCode,
    status,
    durationMs,
  };

  // Case 1: Clean pass
  if (status === 'passed' && exitCode === 0) {
    return {
      hasIssues: false,
      summary: `Check "${checkName}" completed successfully with exit code 0.`,
      issues: [
        {
          id: 'clean-pass-1',
          category: 'clean_pass',
          title: `Check "${checkName}" Passed Cleanly`,
          severity: 'info',
          evidenceQuality: 'Strong evidence',
          observedEvidence: truncateEvidence(
            stdout || stderr || `Command "${fullCommand}" exited with code 0.`
          ),
          likelyExplanation:
            'The executed test/build suite completed without errors. Note: Passing checks confirm that tested code meets existing test specifications, but do not guarantee absence of bugs in untested areas.',
          recommendedAction:
            'All existing checks are passing. You can safely explore the codebase, review open issues, or write new tests.',
          failedCommand: fullCommand,
          exitCode: 0,
        },
      ],
      rawResultRef,
    };
  }

  // Case 2: Cancelled or Timed out
  if (status === 'cancelled') {
    return {
      hasIssues: true,
      summary: `Check "${checkName}" was cancelled by the user.`,
      issues: [
        {
          id: 'cancelled-1',
          category: 'unknown_failure',
          title: `Check "${checkName}" Cancelled`,
          severity: 'warning',
          evidenceQuality: 'Strong evidence',
          observedEvidence: 'Process was terminated by user cancellation signal.',
          likelyExplanation: 'The operation was aborted before completion.',
          recommendedAction: 'Re-run the check when ready to inspect results.',
          failedCommand: fullCommand,
          exitCode: null,
        },
      ],
      rawResultRef,
    };
  }

  if (status === 'timed_out') {
    return {
      hasIssues: true,
      summary: `Check "${checkName}" timed out after execution limit.`,
      issues: [
        {
          id: 'timeout-1',
          category: 'build_error',
          title: `Check "${checkName}" Timed Out`,
          severity: 'error',
          evidenceQuality: 'Strong evidence',
          observedEvidence: truncateEvidence(
            combinedOutput || `Execution timed out after ${Math.round(durationMs / 1000)} seconds.`
          ),
          likelyExplanation:
            'The command exceeded the execution time limit. This commonly occurs with hanging processes, infinite loops, or watch-mode flags in scripts.',
          recommendedAction:
            'Check package.json to ensure the script does not run in interactive or watch mode (e.g. without --watch=false or --runInBand).',
          failedCommand: fullCommand,
          exitCode: null,
        },
      ],
      rawResultRef,
    };
  }

  // Case 3: Parse specific failure diagnostics
  const issues: DiagnosticIssue[] = [];

  // Pattern A: TypeScript Compile Errors
  // Example: src/index.ts:14:5 - error TS2322: Type 'string' is not assignable to type 'number'.
  const tsErrorRegex = /([a-zA-Z0-9_./\\-]+\.(?:ts|tsx|js|jsx)):(\d+):(\d+)\s*-\s*error\s*(TS\d+):\s*([^\r\n]+)/g;
  let tsMatch: RegExpExecArray | null;
  let tsIndex = 1;

  while ((tsMatch = tsErrorRegex.exec(combinedOutput)) !== null) {
    const rawFile = tsMatch[1];
    const line = parseInt(tsMatch[2], 10);
    const col = parseInt(tsMatch[3], 10);
    const tsCode = tsMatch[4];
    const tsMessage = tsMatch[5].trim();

    const loc = normalizePath(rawFile, cwd);

    // Extract surrounding context lines for evidence
    const matchPos = tsMatch.index;
    const snippet = combinedOutput.slice(matchPos, matchPos + 350).split('\n').slice(0, 4).join('\n');

    issues.push({
      id: `ts-err-${tsIndex++}`,
      category: 'typescript_compile_error',
      title: `TypeScript Compile Error (${tsCode})`,
      severity: 'error',
      evidenceQuality: 'Strong evidence',
      location: {
        filePath: loc.filePath,
        relativePath: loc.relativePath,
        line,
        column: col,
      },
      observedEvidence: truncateEvidence(snippet),
      likelyExplanation:
        `TypeScript static analysis detected a type incompatibility at ${loc.relativePath}:${line}. "${tsMessage}"`,
      recommendedAction:
        `Open ${loc.relativePath} at line ${line}, column ${col}. Review the assigned expression and adjust either the value or the type annotation.`,
      failedCommand: fullCommand,
      exitCode,
    });

    if (issues.length >= 5) {
      break; // Cap to top 5 diagnostics
    }
  }

  // Pattern B: Missing Module / Dependency Errors
  // Example: Cannot find module 'lodash' or Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express'
  if (issues.length === 0) {
    const missingModRegex = /(?:Cannot find (?:module|package)\s*['"]([^'"]+)['"]|Error\s*\[ERR_MODULE_NOT_FOUND\]:\s*Cannot find package\s*['"]([^'"]+)['"])/i;
    const modMatch = combinedOutput.match(missingModRegex);

    if (modMatch) {
      const missingPackage = modMatch[1] || modMatch[2];
      const isRelative = missingPackage.startsWith('.') || missingPackage.startsWith('/');

      // Check if calling file path is in the stack trace
      const stackFileRegex = /at\s+(?:[^\n]+\s+)?\(?([a-zA-Z0-9_./\\-]+\.(?:js|ts|mjs|cjs)):(\d+):(\d+)\)?/;
      const stackMatch = combinedOutput.match(stackFileRegex);
      let loc: DiagnosticLocation | undefined;
      if (stackMatch) {
        const norm = normalizePath(stackMatch[1], cwd);
        loc = {
          filePath: norm.filePath,
          relativePath: norm.relativePath,
          line: parseInt(stackMatch[2], 10),
          column: parseInt(stackMatch[3], 10),
        };
      }

      const snippetLines = combinedOutput
        .split('\n')
        .filter((l) => l.includes('Cannot find') || l.includes('MODULE_NOT_FOUND') || l.includes('requireStack'))
        .slice(0, 5)
        .join('\n');

      issues.push({
        id: 'missing-mod-1',
        category: 'missing_dependency',
        title: `Missing Dependency: "${missingPackage}"`,
        severity: 'error',
        evidenceQuality: 'Strong evidence',
        location: loc,
        observedEvidence: truncateEvidence(snippetLines || modMatch[0]),
        likelyExplanation: isRelative
          ? `A local module import failed because the target file "${missingPackage}" was not found at the expected relative path.`
          : `Package "${missingPackage}" is imported in code but is not installed in node_modules or is missing from package.json dependencies.`,
        recommendedAction: isRelative
          ? `Check if "${missingPackage}" exists or if there is a filename/extension mismatch.`
          : `Run "npm install" or install the missing package explicitly using "npm install ${missingPackage}".`,
        failedCommand: fullCommand,
        exitCode,
      });
    }
  }

  // Pattern C: Test Assertion Failures
  // Example (node:test): AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  // Example (Jest): FAIL src/test.js ... ● test name
  if (issues.length === 0) {
    const hasAssertion = /AssertionError(?:\s*\[[A-Z_]+\])?:/i.test(combinedOutput);
    const hasJestFail = /\bFAIL\b/i.test(combinedOutput) && /\bExpected\b/i.test(combinedOutput);

    if (hasAssertion || hasJestFail) {
      // Find failed test name if available
      // node:test: ✖ test name (duration)
      // Jest: ● test name
      let failedTestName = 'Test Assertion';
      const nodeTestMatch = combinedOutput.match(/✖\s+([^\r\n(]+)(?:\s*\([^)]*\))?/);
      const jestTestMatch = combinedOutput.match(/●\s+([^\r\n]+)/);
      if (nodeTestMatch) {
        failedTestName = nodeTestMatch[1].trim();
      } else if (jestTestMatch) {
        failedTestName = jestTestMatch[1].trim();
      }

      // Find file and line in stack trace
      const stackFileRegex = /at\s+(?:[^\n]+\s+)?\(?([a-zA-Z0-9_./\\-]+\.(?:test|spec)\.[a-zA-Z0-9]+):(\d+):(\d+)\)?/i;
      const genStackRegex = /at\s+(?:[^\n]+\s+)?\(?([a-zA-Z0-9_./\\-]+\.(?:js|ts)):(\d+):(\d+)\)?/i;
      const stackMatch = combinedOutput.match(stackFileRegex) || combinedOutput.match(genStackRegex);

      let loc: DiagnosticLocation | undefined;
      if (stackMatch) {
        const norm = normalizePath(stackMatch[1], cwd);
        loc = {
          filePath: norm.filePath,
          relativePath: norm.relativePath,
          line: parseInt(stackMatch[2], 10),
          column: parseInt(stackMatch[3], 10),
        };
      }

      // Extract assertion failure block
      const lines = combinedOutput.split('\n');
      const startIdx = lines.findIndex((l) => /AssertionError|FAIL|Expected:|Received:/i.test(l));
      const snippet = startIdx !== -1 ? lines.slice(startIdx, startIdx + 8).join('\n') : combinedOutput.slice(0, 300);

      issues.push({
        id: 'assertion-err-1',
        category: 'test_assertion_failure',
        title: `Test Assertion Failure: "${failedTestName}"`,
        severity: 'error',
        evidenceQuality: 'Strong evidence',
        location: loc,
        observedEvidence: truncateEvidence(snippet),
        likelyExplanation:
          'A test assertion evaluated to false. Hypothesis: The code implementation returned a value that deviated from the test expectation, or the test has an outdated expected result.',
        recommendedAction: loc
          ? `Open ${loc.relativePath} at line ${loc.line}. Compare the expected vs received values to isolate the logic discrepancy.`
          : 'Inspect the test file and the implementation under test to determine whether the bug is in the code logic or the test expectation.',
        failedCommand: fullCommand,
        exitCode,
      });
    }
  }

  // Pattern D: Syntax Errors
  // Example: SyntaxError: Unexpected token '}' at /path/to/file.js:15:3
  if (issues.length === 0) {
    const syntaxMatch = combinedOutput.match(/SyntaxError:\s*([^\r\n]+)/i);
    if (syntaxMatch) {
      const syntaxErrorMsg = syntaxMatch[1].trim();

      const locMatch = combinedOutput.match(/([a-zA-Z0-9_./\\-]+\.(?:js|ts|mjs|cjs)):(\d+)(?::(\d+))?/);
      let loc: DiagnosticLocation | undefined;
      if (locMatch) {
        const norm = normalizePath(locMatch[1], cwd);
        loc = {
          filePath: norm.filePath,
          relativePath: norm.relativePath,
          line: parseInt(locMatch[2], 10),
          column: locMatch[3] ? parseInt(locMatch[3], 10) : undefined,
        };
      }

      issues.push({
        id: 'syntax-err-1',
        category: 'syntax_error',
        title: `Syntax Error: "${syntaxErrorMsg}"`,
        severity: 'error',
        evidenceQuality: 'Strong evidence',
        location: loc,
        observedEvidence: truncateEvidence(syntaxMatch[0]),
        likelyExplanation:
          'The parser encountered invalid JavaScript or TypeScript syntax that prevented compilation or execution.',
        recommendedAction: loc
          ? `Open ${loc.relativePath} at line ${loc.line} and fix the syntax error (check for mismatched braces, missing commas, or typos).`
          : 'Check the error message above and verify that files conform to valid JavaScript/TypeScript syntax.',
        failedCommand: fullCommand,
        exitCode,
      });
    }
  }

  // Pattern E: Fallback Unknown Failure / Generic Build Error
  if (issues.length === 0) {
    const lines = combinedOutput.split('\n').filter((l) => l.trim().length > 0);
    const lastLines = lines.slice(-8).join('\n');

    issues.push({
      id: 'unknown-err-1',
      category: 'unknown_failure',
      title: `Command Failed (Exit Code ${exitCode !== null ? exitCode : 'Unknown'})`,
      severity: 'error',
      evidenceQuality: 'Insufficient evidence',
      observedEvidence: truncateEvidence(lastLines || `Process terminated with exit code ${exitCode}.`),
      likelyExplanation:
        'The command returned a non-zero exit code, but did not match standard compiler or assertion signatures. Root cause is currently unconfirmed.',
      recommendedAction:
        'Inspect the raw terminal output below to review the full error trace and context.',
      failedCommand: fullCommand,
      exitCode,
    });
  }

  return {
    hasIssues: true,
    summary: `Found ${issues.length} diagnostic issue(s) from check "${checkName}".`,
    issues,
    rawResultRef,
  };
}
