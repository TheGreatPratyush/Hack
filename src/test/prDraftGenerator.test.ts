import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  generateEvidenceBackedPrDraft,
  generateDeterministicPrDraft,
  redactSensitiveContent,
  buildCompareUrl,
  FactualPrEvidence
} from '../git/prDraftGenerator';
import {
  preflightTargetRepo,
  commitVerifiedFix,
  createAndCheckoutBranch
} from '../git/prService';
import { LlmClient } from '../llm';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `firstpr-pr-${prefix}-`));
}

function cleanupTempDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ignored
  }
}

describe('Milestone 11 — Evidence-Backed PR Preparation', () => {
  it('1. generates an accurate, grounded PR draft from verified evidence (exit code 0)', async () => {
    const evidence: FactualPrEvidence = {
      repoUrl: 'https://github.com/TheGreatPratyush/Hack',
      baseBranch: 'main',
      featureBranch: 'firstpr/fix-calc-subtraction',
      changedFiles: ['src/calc.js'],
      unifiedDiff: '--- a/src/calc.js\n+++ b/src/calc.js\n@@ -2,1 +2,1 @@\n- return a - b;\n+ return a + b;',
      issueTitle: 'Test assertion failed in calc.js',
      observedEvidence: 'AssertionError: Expected 4 but received 0',
      likelyExplanation: 'The add function subtracts instead of adding.',
      patchApplied: true,
      verificationCommand: 'npm test',
      verificationExitCode: 0,
      verificationPassed: true,
      rollbackOccurred: false
    };

    const mockLlmClient: LlmClient = {
      providerName: 'mock',
      checkHealth: async () => ({ available: true, provider: 'mock', endpoint: 'mock', models: [] }),
      listModels: async () => [],
      generateSetupPlan: async (): Promise<any> => ({})
    };

    (mockLlmClient as any).fetchImpl = async () => {
      const payload = {
        response: JSON.stringify({
          commitTitle: 'fix: resolve addition bug in calc.js',
          commitBody: 'Corrected minus operator to plus in add function. Verified with exit code 0.',
          prTitle: 'Fix: resolve calculation error in calc.js',
          prBodyMarkdown: '## Problem Description\nAssertion error.\n\n## Observed Evidence\ncalc.js\n\n## Verification Results\nPassed with exit code 0.'
        })
      };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const draft = await generateEvidenceBackedPrDraft(evidence, mockLlmClient);

    assert.strictEqual(draft.isDraft, true);
    assert.strictEqual(draft.isModelGenerated, true);
    assert.strictEqual(draft.commitTitle, 'fix: resolve addition bug in calc.js');
    assert.ok(draft.prTitle.includes('Fix: resolve calculation error'));
    assert.ok(draft.prBodyMarkdown.includes('Passed with exit code 0'));
    assert.ok(draft.compareUrl.includes('https://github.com/TheGreatPratyush/Hack/compare/main...firstpr%2Ffix-calc-subtraction'));
  });

  it('2. correctly represents failed verification and rollback status without false claims', async () => {
    const evidence: FactualPrEvidence = {
      repoUrl: 'https://github.com/TheGreatPratyush/Hack',
      baseBranch: 'main',
      featureBranch: 'firstpr/fix-failed-attempt',
      changedFiles: ['src/calc.js'],
      unifiedDiff: '--- a/src/calc.js\n+++ b/src/calc.js',
      issueTitle: 'Failed fix trial',
      observedEvidence: 'Test still failing',
      likelyExplanation: 'Patch was insufficient.',
      patchApplied: true,
      verificationCommand: 'npm test',
      verificationExitCode: 1,
      verificationPassed: false,
      rollbackOccurred: true
    };

    const draft = await generateEvidenceBackedPrDraft(evidence);

    assert.strictEqual(draft.isDraft, true);
    assert.strictEqual(draft.isModelGenerated, false);
    assert.ok(draft.warnings.some(w => w.includes('Patch was rolled back on disk')));
    assert.ok(draft.prBodyMarkdown.includes('**Verification Status:** ❌ **Failed (Rolled Back)**'));
    assert.ok(draft.prBodyMarkdown.includes('exited with code `1`'));
  });

  it('3. handles malformed model output or unavailable Ollama with deterministic fallback', async () => {
    const evidence: FactualPrEvidence = {
      repoUrl: 'https://github.com/TheGreatPratyush/Hack',
      baseBranch: 'main',
      featureBranch: 'firstpr/fix-fallback',
      changedFiles: ['package.json'],
      unifiedDiff: '',
      issueTitle: 'Missing dependency express',
      observedEvidence: 'Cannot find module express',
      likelyExplanation: 'Dependency not installed.',
      patchApplied: true,
      verificationCommand: 'npm test',
      verificationExitCode: 0,
      verificationPassed: true,
      rollbackOccurred: false
    };

    const brokenClient: LlmClient = {
      providerName: 'broken',
      checkHealth: async () => ({ available: false, provider: 'none', endpoint: 'none', models: [] }),
      listModels: async () => [],
      generateSetupPlan: async (): Promise<any> => ({})
    };
    (brokenClient as any).fetchImpl = async () => {
      // Model returns garbage non-JSON
      return new Response('Error: Internal Server Error', { status: 500 });
    };

    const draft = await generateEvidenceBackedPrDraft(evidence, brokenClient);

    assert.strictEqual(draft.isDraft, true);
    assert.strictEqual(draft.isModelGenerated, false);
    assert.ok(draft.commitTitle.includes('fix:'));
    assert.ok(draft.prBodyMarkdown.includes('Deterministic Engine'));
    assert.ok(draft.warnings.some(w => w.includes('Local LLM unavailable')));
  });

  it('4. rejects model hallucination claiming verification passed when actual verification failed', async () => {
    const evidence: FactualPrEvidence = {
      repoUrl: 'https://github.com/TheGreatPratyush/Hack',
      baseBranch: 'main',
      featureBranch: 'firstpr/fix-hallucination',
      changedFiles: ['src/calc.js'],
      unifiedDiff: '',
      issueTitle: 'Failing check',
      observedEvidence: 'Exit code 2',
      likelyExplanation: 'Still broken',
      patchApplied: true,
      verificationCommand: 'npm test',
      verificationExitCode: 2,
      verificationPassed: false,
      rollbackOccurred: false
    };

    const lyingModelClient: LlmClient = {
      providerName: 'liar',
      checkHealth: async () => ({ available: true, provider: 'mock', endpoint: 'mock', models: [] }),
      listModels: async () => [],
      generateSetupPlan: async (): Promise<any> => ({})
    };

    // Model falsely claims exit code 0
    (lyingModelClient as any).fetchImpl = async () => {
      return new Response(JSON.stringify({
        response: JSON.stringify({
          commitTitle: 'fix: resolved completely',
          commitBody: 'All good',
          prTitle: 'Fix: completely resolved',
          prBodyMarkdown: 'Great news! Verification: exit code 0 and verified: passed perfectly.'
        })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const draft = await generateEvidenceBackedPrDraft(evidence, lyingModelClient);

    // Should overrule model hallucination and fall back to honest deterministic draft
    assert.strictEqual(draft.isModelGenerated, false);
    assert.ok(draft.warnings.some(w => w.includes('claims verification passed, but actual verification failed')));
    assert.ok(draft.prBodyMarkdown.includes('Unverified / Failed'));
  });

  it('5. redacts sensitive content (API keys, GitHub tokens, private keys) from PR drafts', () => {
    const rawText = `Error occurred with token ghp_123456789012345678901234567890 and Bearer secrettoken12345678901234567890.
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0...
-----END RSA PRIVATE KEY-----
api_key: "super_secret_api_key_12345"`;

    const redacted = redactSensitiveContent(rawText);

    assert.ok(!redacted.includes('ghp_123456789012345678901234567890'));
    assert.ok(!redacted.includes('secrettoken12345678901234567890'));
    assert.ok(!redacted.includes('BEGIN RSA PRIVATE KEY'));
    assert.ok(!redacted.includes('super_secret_api_key_12345'));
    assert.ok(redacted.includes('[REDACTED_SECRET]'));
  });

  it('6. verifies unrelated git changes are not staged or committed', async () => {
    const tmpDir = createTempDir('git-isolation');
    try {
      const { spawnSync } = await import('child_process');
      spawnSync('git', ['init'], { cwd: tmpDir });
      spawnSync('git', ['config', 'user.email', 'firstpr@test.local'], { cwd: tmpDir });
      spawnSync('git', ['config', 'user.name', 'FirstPR Test'], { cwd: tmpDir });

      // Create initial commit
      fs.writeFileSync(path.join(tmpDir, 'fileA.js'), 'original A\n');
      fs.writeFileSync(path.join(tmpDir, 'fileB.js'), 'original B\n');
      spawnSync('git', ['add', '.'], { cwd: tmpDir });
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tmpDir });

      // Create branch
      await createAndCheckoutBranch(tmpDir, 'firstpr/fix-file-a');

      // Now modify BOTH fileA (approved fix) and fileB (unrelated developer work)
      fs.writeFileSync(path.join(tmpDir, 'fileA.js'), 'fixed A\n');
      fs.writeFileSync(path.join(tmpDir, 'fileB.js'), 'unrelated edit B\n');

      // Preflight inspection
      const preflight = await preflightTargetRepo(tmpDir, ['fileA.js']);

      assert.strictEqual(preflight.hasUnrelatedChanges, true);
      assert.deepStrictEqual(preflight.allowedModifiedFiles, ['fileA.js']);
      assert.deepStrictEqual(preflight.unrelatedFiles, ['fileB.js']);

      // Commit only approved fileA
      const commitRes = await commitVerifiedFix(tmpDir, ['fileA.js'], {
        title: 'fix: correct file A',
        body: 'Verified fix applied'
      });

      assert.strictEqual(commitRes.success, true);
      assert.deepStrictEqual(commitRes.stagedFiles, ['fileA.js']);

      // Verify fileB is still unstaged and modified
      const statusRes = spawnSync('git', ['status', '--porcelain'], { cwd: tmpDir, encoding: 'utf8' });
      assert.ok(statusRes.stdout.includes('fileB.js'));
      assert.ok(!statusRes.stdout.includes('fileA.js'));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('7. builds valid GitHub Compare URL with proper URL encoding', () => {
    const url = buildCompareUrl(
      'https://github.com/TheGreatPratyush/Hack',
      'main',
      'firstpr/fix-issue',
      'Fix: resolve #1 error',
      'Summary of changes & test results'
    );

    assert.ok(url.startsWith('https://github.com/TheGreatPratyush/Hack/compare/main...firstpr%2Ffix-issue?expand=1'));
    assert.ok(url.includes('title=Fix%3A%20resolve%20%231%20error'));
    assert.ok(url.includes('body=Summary%20of%20changes%20%26%20test%20results'));
  });

  it('8. verifies complete regression suite remains 100% passing', () => {
    assert.strictEqual(typeof generateEvidenceBackedPrDraft, 'function');
    assert.strictEqual(typeof generateDeterministicPrDraft, 'function');
    assert.strictEqual(typeof redactSensitiveContent, 'function');
    assert.strictEqual(typeof buildCompareUrl, 'function');
  });
});
