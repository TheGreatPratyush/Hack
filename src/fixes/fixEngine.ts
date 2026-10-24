import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DiagnosticIssue } from '../diagnostics/diagnosticEngine';

export interface ProposedFix {
  id: string;
  issueId: string;
  title: string;
  description: string;
  targetFilePath: string;
  relativeFilePath: string;
  originalContent: string;
  originalContentHash: string;
  patchedContent: string;
  unifiedDiff: string;
  canSafelyApply: boolean;
  safetyNotes: string[];
}

export interface FixRollbackRecord {
  fixId: string;
  targetFilePath: string;
  relativeFilePath: string;
  originalContent: string;
  patchedContent: string;
  appliedAt: number;
}

export interface ApplyFixResult {
  success: boolean;
  rollbackRecord?: FixRollbackRecord;
  error?: string;
}

export interface RollbackResult {
  success: boolean;
  error?: string;
}

/**
 * Computes sha256 hash of text for integrity check.
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Generates a standard unified diff between originalContent and patchedContent.
 */
export function generateUnifiedDiff(
  relativeFilePath: string,
  originalContent: string,
  patchedContent: string
): string {
  const origLines = originalContent.split(/\r?\n/);
  const patchLines = patchedContent.split(/\r?\n/);

  // Find first and last differing lines
  let firstDiff = -1;
  const maxLen = Math.max(origLines.length, patchLines.length);

  for (let i = 0; i < maxLen; i++) {
    if (origLines[i] !== patchLines[i]) {
      firstDiff = i;
      break;
    }
  }

  if (firstDiff === -1) {
    return '(No differences detected)';
  }

  let origLastDiff = origLines.length - 1;
  let patchLastDiff = patchLines.length - 1;

  while (
    origLastDiff >= firstDiff &&
    patchLastDiff >= firstDiff &&
    origLines[origLastDiff] === patchLines[patchLastDiff]
  ) {
    origLastDiff--;
    patchLastDiff--;
  }

  // Include up to 2 context lines before and after
  const contextStart = Math.max(0, firstDiff - 2);
  const origContextEnd = Math.min(origLines.length, origLastDiff + 3);
  const patchContextEnd = Math.min(patchLines.length, patchLastDiff + 3);

  const origCount = origContextEnd - contextStart;
  const patchCount = patchContextEnd - contextStart;

  const header = `--- a/${relativeFilePath}\n+++ b/${relativeFilePath}\n@@ -${contextStart + 1},${origCount} +${contextStart + 1},${patchCount} @@\n`;

  let diffBody = '';

  // Leading context
  for (let i = contextStart; i < firstDiff; i++) {
    diffBody += ` ${origLines[i]}\n`;
  }

  // Deleted lines
  for (let i = firstDiff; i <= origLastDiff; i++) {
    if (i < origLines.length) {
      diffBody += `-${origLines[i]}\n`;
    }
  }

  // Added lines
  for (let i = firstDiff; i <= patchLastDiff; i++) {
    if (i < patchLines.length) {
      diffBody += `+${patchLines[i]}\n`;
    }
  }

  // Trailing context
  const trailingStart = origLastDiff + 1;
  for (let i = trailingStart; i < origContextEnd; i++) {
    if (i < origLines.length) {
      diffBody += ` ${origLines[i]}\n`;
    }
  }

  return header + diffBody.trimEnd();
}

/**
 * Deterministically proposes a fix for supported diagnostic issues.
 * Returns null if no safe fix can be generated.
 */
export function proposeFixForIssue(issue: DiagnosticIssue, cwd: string): ProposedFix | null {
  if (!cwd || !fs.existsSync(cwd)) {
    return null;
  }

  // Case A: Test assertion failure in demo calculator format discrepancy
  // Target: src/calc.js or src/calc.ts where return contains `${...}%` instead of numeric value
  if (issue.category === 'test_assertion_failure') {
    const candidateFiles = [
      path.join(cwd, 'src', 'calc.js'),
      path.join(cwd, 'src', 'calc.ts'),
      path.join(cwd, 'calc.js'),
    ];

    for (const candidate of candidateFiles) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        try {
          const content = fs.readFileSync(candidate, 'utf8');
          // Discrepancy pattern: return `${price * (discountPercent / 100)}%`;
          const pattern = /return\s+`\$\{([^}]+)\}%`;/;
          const match = content.match(pattern);

          if (match) {
            const innerExpr = match[1];
            const patched = content.replace(pattern, `return ${innerExpr};`);
            const relPath = path.relative(cwd, candidate);

            const diff = generateUnifiedDiff(relPath, content, patched);

            return {
              id: `fix-${issue.id}`,
              issueId: issue.id,
              title: 'Correct Return Value Type (Numeric instead of String)',
              description: `Function returns a formatted string "${match[0]}" instead of the expected numeric decimal. Fix changes the return statement to return the numeric expression.`,
              targetFilePath: candidate,
              relativeFilePath: relPath,
              originalContent: content,
              originalContentHash: hashContent(content),
              patchedContent: patched,
              unifiedDiff: diff,
              canSafelyApply: true,
              safetyNotes: [
                'Scoped strictly to the return statement.',
                'Preserves all existing function parameters and input validation guards.',
              ],
            };
          }
        } catch {
          // ignore
        }
      }
    }
  }

  // Case B: Missing external dependency that can be added to package.json
  if (issue.category === 'missing_dependency') {
    const pkgJsonPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const content = fs.readFileSync(pkgJsonPath, 'utf8');
        const pkg = JSON.parse(content);
        const match = issue.title.match(/Missing Dependency:\s*["']([^"']+)["']/i);
        const pkgName = match ? match[1] : null;

        if (pkgName && !pkgName.startsWith('.') && !pkgName.startsWith('/')) {
          const deps = pkg.dependencies || {};
          if (!deps[pkgName]) {
            const newDeps = { ...deps, [pkgName]: '*' };
            const newPkg = { ...pkg, dependencies: newDeps };
            const patched = JSON.stringify(newPkg, null, 2) + '\n';
            const relPath = 'package.json';
            const diff = generateUnifiedDiff(relPath, content, patched);

            return {
              id: `fix-${issue.id}`,
              issueId: issue.id,
              title: `Declare Missing Dependency "${pkgName}" in package.json`,
              description: `Adds "${pkgName}" to dependencies in package.json so it is recognized by package managers.`,
              targetFilePath: pkgJsonPath,
              relativeFilePath: relPath,
              originalContent: content,
              originalContentHash: hashContent(content),
              patchedContent: patched,
              unifiedDiff: diff,
              canSafelyApply: true,
              safetyNotes: [
                'Modifies package.json dependencies only.',
                'Running npm install is still required to download the package to node_modules.',
              ],
            };
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // Case C: TypeScript Compile Error TS2322 (String assigned to number in demo)
  if (issue.category === 'typescript_compile_error' && issue.location) {
    const targetPath = issue.location.filePath;
    if (fs.existsSync(targetPath)) {
      try {
        const content = fs.readFileSync(targetPath, 'utf8');
        // If line contains a quoted number assigned to number variable: e.g. = "100"; -> = 100;
        const lines = content.split('\n');
        const lineIdx = (issue.location.line || 1) - 1;
        if (lineIdx >= 0 && lineIdx < lines.length) {
          const targetLine = lines[lineIdx];
          const stringToNumMatch = targetLine.match(/=\s*["'](\d+)["'];/);
          if (stringToNumMatch) {
            lines[lineIdx] = targetLine.replace(/=\s*["'](\d+)["'];/, `= ${stringToNumMatch[1]};`);
            const patched = lines.join('\n');
            const relPath = issue.location.relativePath;
            const diff = generateUnifiedDiff(relPath, content, patched);

            return {
              id: `fix-${issue.id}`,
              issueId: issue.id,
              title: 'Convert String Literal to Number Literal',
              description: `Replaces string literal "${stringToNumMatch[1]}" with numeric literal ${stringToNumMatch[1]} to satisfy TypeScript type constraint.`,
              targetFilePath: targetPath,
              relativeFilePath: relPath,
              originalContent: content,
              originalContentHash: hashContent(content),
              patchedContent: patched,
              unifiedDiff: diff,
              canSafelyApply: true,
              safetyNotes: [
                'Single-line modification strictly addressing the type mismatch.',
              ],
            };
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return null;
}

/**
 * Applies an approved ProposedFix to disk safely with path traversal guards and conflict checks.
 */
export function applyProposedFix(fix: ProposedFix, cwd: string): ApplyFixResult {
  const resolvedTarget = path.resolve(fix.targetFilePath);
  const resolvedCwd = path.resolve(cwd);

  // Path traversal guard: must be strictly inside cwd
  const rel = path.relative(resolvedCwd, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      success: false,
      error: `Security error: Target path "${fix.targetFilePath}" is outside workspace directory.`,
    };
  }

  if (!fs.existsSync(resolvedTarget)) {
    return {
      success: false,
      error: `Target file "${fix.targetFilePath}" does not exist.`,
    };
  }

  let currentContent: string;
  try {
    currentContent = fs.readFileSync(resolvedTarget, 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to read target file: ${msg}`,
    };
  }

  // Conflict detection: verify target file has not changed since diff was generated
  const currentHash = hashContent(currentContent);
  if (currentHash !== fix.originalContentHash) {
    return {
      success: false,
      error: 'Conflict detected: The target file has been modified on disk since the proposed diff was generated. Review refreshed content before applying.',
    };
  }

  // Write new content safely
  try {
    fs.writeFileSync(resolvedTarget, fix.patchedContent, 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to write patched file: ${msg}`,
    };
  }

  const rollbackRecord: FixRollbackRecord = {
    fixId: fix.id,
    targetFilePath: resolvedTarget,
    relativeFilePath: fix.relativeFilePath,
    originalContent: fix.originalContent,
    patchedContent: fix.patchedContent,
    appliedAt: Date.now(),
  };

  return {
    success: true,
    rollbackRecord,
  };
}

/**
 * Safely rolls back an applied patch.
 * Rejects rollback if the file was modified independently after the patch was applied.
 */
export function rollbackAppliedFix(record: FixRollbackRecord, cwd: string): RollbackResult {
  const resolvedTarget = path.resolve(record.targetFilePath);
  const resolvedCwd = path.resolve(cwd);

  const rel = path.relative(resolvedCwd, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      success: false,
      error: 'Security error: Target file path is outside the workspace root.',
    };
  }

  if (!fs.existsSync(resolvedTarget)) {
    return {
      success: false,
      error: `Cannot rollback: Target file "${record.targetFilePath}" no longer exists.`,
    };
  }

  let currentContent: string;
  try {
    currentContent = fs.readFileSync(resolvedTarget, 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to read file for rollback: ${msg}`,
    };
  }

  // Check if file was modified after the patch was applied
  if (currentContent !== record.patchedContent) {
    return {
      success: false,
      error: 'Cannot rollback safely: The file has been modified independently since FirstPR applied the patch.',
    };
  }

  try {
    fs.writeFileSync(resolvedTarget, record.originalContent, 'utf8');
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to write original content during rollback: ${msg}`,
    };
  }
}
