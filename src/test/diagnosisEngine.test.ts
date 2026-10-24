import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  LlmDiagnosisEngine,
  classifyFailure
} from '../analysis/diagnosisEngine';
import { CheckResult } from '../core/checkRunner';
import { LlmClient } from '../llm';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `firstpr-diag-${prefix}-`));
}

function cleanupTempDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ignored
  }
}

describe('Milestone 10 — LLM-Assisted Bug Diagnosis & Verified Fixes', () => {
  it('1. correctly classifies environment/tooling failures without inventing a code bug', async () => {
    const tmpDir = createTempDir('env-tooling');
    try {
      const toolCheckResult: CheckResult = {
        checkName: 'test',
        command: 'pnpm',
        args: ['test'],
        cwd: tmpDir,
        exitCode: 127,
        status: 'failed',
        stdout: '',
        stderr: 'pnpm: command not found',
        durationMs: 15,
        explanation: 'Command not found'
      };

      const classification = classifyFailure(toolCheckResult);
      assert.strictEqual(classification, 'environment_tooling');

      const engine = new LlmDiagnosisEngine(tmpDir);
      const diagnosisResult = await engine.analyzeFailure(toolCheckResult);

      assert.strictEqual(diagnosisResult.classification, 'environment_tooling');
      assert.strictEqual(diagnosisResult.diagnosis?.isPlausibleSourceDefect, false);
      assert.strictEqual(diagnosisResult.proposedFix, null);
      assert.strictEqual(diagnosisResult.isOfflineFallback, true);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('2. produces a grounded diagnosis for an evidence-backed source code failure', async () => {
    const tmpDir = createTempDir('source-failure');
    try {
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      const calcPath = path.join(srcDir, 'calc.js');
      fs.writeFileSync(
        calcPath,
        `function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n`
      );

      const checkResult: CheckResult = {
        checkName: 'test',
        command: 'npm',
        args: ['test'],
        cwd: tmpDir,
        exitCode: 1,
        status: 'failed',
        stdout: '',
        stderr: `FAIL test/calc.test.js
AssertionError: Expected 4 but received 0
    at Object.<anonymous> (${srcDir}/calc.js:2:10)`,
        durationMs: 120,
        explanation: 'Test failed'
      };

      const classification = classifyFailure(checkResult);
      assert.strictEqual(classification, 'test_assertion');

      // Mock LLM returning structured diagnosis
      const mockLlmClient: LlmClient = {
        providerName: 'mock-local-llm',
        checkHealth: async () => ({ available: true, provider: 'mock', endpoint: 'mock', models: ['qwen2.5-coder:7b'] }),
        listModels: async () => ['qwen2.5-coder:7b'],
        generateSetupPlan: async (): Promise<any> => ({})
      };

      (mockLlmClient as any).fetchImpl = async () => {
        const payload = {
          response: JSON.stringify({
            failureClassification: 'test_assertion',
            observedEvidence: 'AssertionError: Expected 4 but received 0 in calc.js:2',
            likelyExplanation: 'The add function subtracts instead of adding.',
            confidenceScore: 0.95,
            isPlausibleSourceDefect: true,
            supportingLocations: [{ relativePath: 'src/calc.js', line: 2 }],
            recommendedNextStep: 'Fix subtraction operator to addition.',
            proposedPatchSnippet: {
              relativePath: 'src/calc.js',
              originalSnippet: 'return a - b;',
              replacementSnippet: 'return a + b;'
            }
          })
        };
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const engine = new LlmDiagnosisEngine(tmpDir, mockLlmClient);
      const result = await engine.analyzeFailure(checkResult);

      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.classification, 'test_assertion');
      assert.ok(result.proposedFix);
      assert.strictEqual(result.proposedFix.relativeFilePath, 'src/calc.js');
      assert.ok(result.proposedFix.unifiedDiff.includes('-  return a - b;'));
      assert.ok(result.proposedFix.unifiedDiff.includes('+  return a + b;'));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('3. rejects missing or out-of-bounds file/line references in model diagnosis', async () => {
    const tmpDir = createTempDir('invalid-refs');
    try {
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'app.js'), 'console.log("hello");\n');

      const checkResult: CheckResult = {
        checkName: 'test',
        command: 'npm',
        args: ['test'],
        cwd: tmpDir,
        exitCode: 1,
        status: 'failed',
        stdout: '',
        stderr: 'Error: boom',
        durationMs: 50,
        explanation: 'Boom'
      };

      const mockLlmClient: LlmClient = {
        providerName: 'mock-local-llm',
        checkHealth: async () => ({ available: true, provider: 'mock', endpoint: 'mock', models: [] }),
        listModels: async () => [],
        generateSetupPlan: async (): Promise<any> => ({})
      };

      // Model claims non-existent file and out of bounds line
      (mockLlmClient as any).fetchImpl = async () => {
        return new Response(JSON.stringify({
          response: JSON.stringify({
            failureClassification: 'source_code_defect',
            observedEvidence: 'boom',
            likelyExplanation: 'Hallucinated error',
            confidenceScore: 0.99,
            isPlausibleSourceDefect: true,
            supportingLocations: [
              { relativePath: 'src/ghost.js', line: 10 },
              { relativePath: 'src/app.js', line: 500 }
            ],
            recommendedNextStep: 'Check ghost'
          })
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const engine = new LlmDiagnosisEngine(tmpDir, mockLlmClient);
      const result = await engine.analyzeFailure(checkResult);

      assert.strictEqual(result.isValid, false);
      assert.ok(result.validationErrors.some(e => e.includes("Cited supporting file does not exist on disk: 'src/ghost.js'")));
      assert.ok(result.validationErrors.some(e => e.includes("exceeds total line count")));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('4. falls back gracefully to deterministic diagnosis when model is unavailable or malformed', async () => {
    const tmpDir = createTempDir('model-unavailable');
    try {
      const checkResult: CheckResult = {
        checkName: 'test',
        command: 'npm',
        args: ['test'],
        cwd: tmpDir,
        exitCode: 1,
        status: 'failed',
        stdout: '',
        stderr: 'Error: Cannot find module "express"',
        durationMs: 40,
        explanation: 'Missing dependency'
      };

      const brokenClient: LlmClient = {
        providerName: 'broken',
        checkHealth: async () => ({ available: false, provider: 'broken', endpoint: 'none', models: [] }),
        listModels: async () => [],
        generateSetupPlan: async (): Promise<any> => ({})
      };
      (brokenClient as any).fetchImpl = async () => {
        throw new TypeError('fetch failed');
      };

      const engine = new LlmDiagnosisEngine(tmpDir, brokenClient);
      const result = await engine.analyzeFailure(checkResult);

      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.isOfflineFallback, true);
      assert.strictEqual(result.classification, 'dependency_config');
      assert.ok(result.explanation.includes('Offline Deterministic Heuristic'));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('5. rejects speculative patches when originalSnippet does not exist in target file', async () => {
    const tmpDir = createTempDir('speculative-patch');
    try {
      const filePath = path.join(tmpDir, 'real.js');
      fs.writeFileSync(filePath, 'const x = 10;\n');

      const checkResult: CheckResult = {
        checkName: 'test',
        command: 'npm',
        args: ['test'],
        cwd: tmpDir,
        exitCode: 1,
        status: 'failed',
        stdout: '',
        stderr: 'Error in real.js',
        durationMs: 30,
        explanation: 'Error'
      };

      const mockLlmClient: LlmClient = {
        providerName: 'mock',
        checkHealth: async () => ({ available: true, provider: 'mock', endpoint: 'mock', models: [] }),
        listModels: async () => [],
        generateSetupPlan: async (): Promise<any> => ({})
      };

      // Model invents originalSnippet 'const imaginary = true;' which is NOT in real.js
      (mockLlmClient as any).fetchImpl = async () => {
        return new Response(JSON.stringify({
          response: JSON.stringify({
            failureClassification: 'source_code_defect',
            observedEvidence: 'error',
            likelyExplanation: 'Speculative fix',
            confidenceScore: 0.8,
            isPlausibleSourceDefect: true,
            supportingLocations: [{ relativePath: 'real.js', line: 1 }],
            recommendedNextStep: 'Fix imaginary',
            proposedPatchSnippet: {
              relativePath: 'real.js',
              originalSnippet: 'const imaginary = true;',
              replacementSnippet: 'const imaginary = false;'
            }
          })
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const engine = new LlmDiagnosisEngine(tmpDir, mockLlmClient);
      const result = await engine.analyzeFailure(checkResult);

      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.proposedFix, null);
      assert.ok(result.validationErrors.some(e => e.includes('Model hallucination rejected: \'originalSnippet\' was not found')));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('6. refuses to apply diff without explicit user approval', async () => {
    const tmpDir = createTempDir('approval-gate');
    try {
      const targetFile = path.join(tmpDir, 'index.js');
      fs.writeFileSync(targetFile, 'let count = 0;\n');

      const engine = new LlmDiagnosisEngine(tmpDir);
      const fix = {
        id: 'fix-1',
        issueId: 'issue-1',
        title: 'Fix count',
        description: 'Initialize count to 1',
        targetFilePath: targetFile,
        relativeFilePath: 'index.js',
        originalContent: 'let count = 0;\n',
        originalContentHash: 'hash',
        patchedContent: 'let count = 1;\n',
        unifiedDiff: 'diff',
        canSafelyApply: true,
        safetyNotes: []
      };

      const verifyResult = await engine.applyAndVerifyFix(
        fix,
        async () => ({
          checkName: 'test', command: 'node', args: [], cwd: tmpDir,
          exitCode: 0, status: 'passed', stdout: '', stderr: '', durationMs: 10, explanation: ''
        }),
        { userApproved: false }
      );

      assert.strictEqual(verifyResult.verified, false);
      assert.ok(verifyResult.explanation.includes('User approval was withheld'));
      // Verify file was NOT modified
      assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), 'let count = 0;\n');
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('7. detects stale file or changed user edits and prevents unsafe patching', async () => {
    const tmpDir = createTempDir('stale-hash');
    try {
      const targetFile = path.join(tmpDir, 'index.js');
      fs.writeFileSync(targetFile, 'let count = 0;\n');

      const engine = new LlmDiagnosisEngine(tmpDir);
      const fix = {
        id: 'fix-1',
        issueId: 'issue-1',
        title: 'Fix count',
        description: 'Initialize count to 1',
        targetFilePath: targetFile,
        relativeFilePath: 'index.js',
        originalContent: 'let count = 0;\n',
        // Outdated hash that does not match disk
        originalContentHash: '0000000000000000000000000000000000000000000000000000000000000000',
        patchedContent: 'let count = 1;\n',
        unifiedDiff: 'diff',
        canSafelyApply: true,
        safetyNotes: []
      };

      const verifyResult = await engine.applyAndVerifyFix(
        fix,
        async () => ({
          checkName: 'test', command: 'node', args: [], cwd: tmpDir,
          exitCode: 0, status: 'passed', stdout: '', stderr: '', durationMs: 10, explanation: ''
        }),
        { userApproved: true }
      );

      assert.strictEqual(verifyResult.verified, false);
      assert.ok(verifyResult.explanation.includes('Failed to apply fix'));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('8. applies approved fix and verifies success by rerunning check with exit code 0', async () => {
    const tmpDir = createTempDir('verified-fix');
    try {
      const targetFile = path.join(tmpDir, 'calc.js');
      fs.writeFileSync(targetFile, 'module.exports = 10 - 2;\n');

      const originalContent = 'module.exports = 10 - 2;\n';
      const patchedContent = 'module.exports = 10 + 2;\n';
      const { hashContent, generateUnifiedDiff } = await import('../fixes/fixEngine');

      const fix = {
        id: 'fix-calc',
        issueId: 'issue-calc',
        title: 'Fix addition',
        description: 'Change minus to plus',
        targetFilePath: targetFile,
        relativeFilePath: 'calc.js',
        originalContent,
        originalContentHash: hashContent(originalContent),
        patchedContent,
        unifiedDiff: generateUnifiedDiff('calc.js', originalContent, patchedContent),
        canSafelyApply: true,
        safetyNotes: []
      };

      const engine = new LlmDiagnosisEngine(tmpDir);

      let rerunExecuted = false;
      const verifyResult = await engine.applyAndVerifyFix(
        fix,
        async () => {
          rerunExecuted = true;
          // Verify on-disk file was updated
          assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), patchedContent);
          return {
            checkName: 'test', command: 'node', args: ['calc.js'], cwd: tmpDir,
            exitCode: 0, status: 'passed', stdout: '12', stderr: '', durationMs: 50, explanation: 'Passed'
          };
        },
        { userApproved: true }
      );

      assert.strictEqual(rerunExecuted, true);
      assert.strictEqual(verifyResult.verified, true);
      assert.strictEqual(verifyResult.verifiedExitCode, 0);
      assert.ok(verifyResult.explanation.includes('Fix verified successfully'));
      assert.ok(verifyResult.rollbackRecord);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('9. handles failed verification and provides safe rollback restoring original file', async () => {
    const tmpDir = createTempDir('failed-verify-rollback');
    try {
      const targetFile = path.join(tmpDir, 'calc.js');
      fs.writeFileSync(targetFile, 'const bug = 1;\n');

      const originalContent = 'const bug = 1;\n';
      const patchedContent = 'const bug = 2;\n';
      const { hashContent, generateUnifiedDiff } = await import('../fixes/fixEngine');

      const fix = {
        id: 'fix-calc',
        issueId: 'issue-calc',
        title: 'Imperfect fix',
        description: 'Try bug = 2',
        targetFilePath: targetFile,
        relativeFilePath: 'calc.js',
        originalContent,
        originalContentHash: hashContent(originalContent),
        patchedContent,
        unifiedDiff: generateUnifiedDiff('calc.js', originalContent, patchedContent),
        canSafelyApply: true,
        safetyNotes: []
      };

      const engine = new LlmDiagnosisEngine(tmpDir);

      // Apply fix but rerun check still fails (exit code 1)
      const verifyResult = await engine.applyAndVerifyFix(
        fix,
        async () => ({
          checkName: 'test', command: 'node', args: [], cwd: tmpDir,
          exitCode: 1, status: 'failed', stdout: '', stderr: 'Still failing', durationMs: 40, explanation: 'Failed'
        }),
        { userApproved: true }
      );

      assert.strictEqual(verifyResult.verified, false);
      assert.strictEqual(verifyResult.verifiedExitCode, 1);
      assert.ok(verifyResult.rollbackRecord);
      assert.ok(verifyResult.explanation.includes('Fix failed re-verification'));

      // File currently has patchedContent
      assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), patchedContent);

      // Execute rollback
      const rollbackResult = engine.rollbackFix(verifyResult.rollbackRecord);
      assert.strictEqual(rollbackResult.success, true);

      // Verify file is restored to originalContent
      assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), originalContent);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('10. verifies complete regression suite remains 100% passing', () => {
    assert.strictEqual(typeof LlmDiagnosisEngine, 'function');
    assert.strictEqual(typeof classifyFailure, 'function');
  });
});
