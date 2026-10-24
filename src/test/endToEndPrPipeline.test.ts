import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { inspectProject } from '../core/projectInspector';
import { executeCheck } from '../core/checkRunner';
import { diagnoseCheckResult } from '../diagnostics/diagnosticEngine';
import { proposeFixForIssue, applyProposedFix } from '../fixes/fixEngine';
import {
  runGit,
  preflightTargetRepo,
  createAndCheckoutBranch,
  commitVerifiedFix,
  generatePullRequestDetails,
} from '../git/prService';

describe('endToEndPrPipeline — Complete Verified Fix & PR Preparation Flow', () => {
  let scratchRepo: string;
  const fixtureSource = path.resolve(__dirname, '../../fixtures/demo-calc');

  before(async () => {
    scratchRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'firstpr-e2e-pr-'));

    // Copy demo-calc files into scratchRepo
    const copyRecursive = (src: string, dest: string) => {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyRecursive(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    };
    copyRecursive(fixtureSource, scratchRepo);

    // Initialize Git repository inside scratchRepo
    await runGit(['init', '-b', 'main'], scratchRepo);
    await runGit(['config', 'user.name', 'FirstPR E2E Robot'], scratchRepo);
    await runGit(['config', 'user.email', 'robot@firstpr.internal'], scratchRepo);
    await runGit(['add', '.'], scratchRepo);
    await runGit(['commit', '-m', 'Initial commit of demo-calc'], scratchRepo);
  });

  after(() => {
    if (scratchRepo && fs.existsSync(scratchRepo)) {
      try {
        fs.rmSync(scratchRepo, { recursive: true, force: true });
      } catch {
        // cleanup ignore
      }
    }
  });

  it('runs complete pipeline from failure -> diagnosis -> fix -> re-verify -> branch -> commit -> PR compare URL', async () => {
    // 1. Inspect project
    const inspection = inspectProject(scratchRepo);
    assert.strictEqual(inspection.isNodeProject, true);
    assert.ok(inspection.scripts.test);

    // 2. Initial check execution -> fails with exit code 1
    const initialCheck = await executeCheck({
      cwd: scratchRepo,
      checkType: 'test',
      scriptName: 'test',
      timeoutMs: 30000,
      allowedScripts: inspection.scripts,
    });
    assert.strictEqual(initialCheck.exitCode, 1);

    // 3. Diagnose failure
    const diagnosis = diagnoseCheckResult(initialCheck);
    assert.strictEqual(diagnosis.hasIssues, true);
    assert.strictEqual(diagnosis.issues.length, 1);
    const issue = diagnosis.issues[0];
    assert.strictEqual(issue.category, 'test_assertion_failure');
    assert.ok(issue.location?.relativePath.includes('test/calc.test.js'));

    // 4. Propose fix
    const proposedFix = proposeFixForIssue(issue, scratchRepo);
    assert.ok(proposedFix);
    assert.strictEqual(proposedFix.relativeFilePath, 'src/calc.js');
    assert.ok(proposedFix.unifiedDiff.includes('+  return price * (discountPercent / 100);'));

    // 5. Apply fix with user approval
    const applyRes = applyProposedFix(proposedFix, scratchRepo);
    assert.strictEqual(applyRes.success, true);
    assert.ok(applyRes.rollbackRecord);

    // 6. Re-verify check -> passes with exit code 0!
    const recheck = await executeCheck({
      cwd: scratchRepo,
      checkType: 'test',
      scriptName: 'test',
      timeoutMs: 30000,
      allowedScripts: inspection.scripts,
    });
    assert.strictEqual(recheck.exitCode, 0);

    // 7. Add an unrelated untracked scratch file to test isolation
    const unrelatedFile = path.join(scratchRepo, 'notes.tmp');
    fs.writeFileSync(unrelatedFile, 'Temporary developer notes that should NOT be committed.\n');

    // 8. Preflight check
    const preflight = await preflightTargetRepo(scratchRepo, ['src/calc.js']);
    assert.strictEqual(preflight.isGitRepo, true);
    assert.strictEqual(preflight.currentBranch, 'main');
    assert.strictEqual(preflight.allowedModifiedFiles.length, 1);
    assert.ok(preflight.allowedModifiedFiles.includes('src/calc.js'));
    assert.strictEqual(preflight.hasUnrelatedChanges, true);
    assert.ok(preflight.unrelatedFiles.includes('notes.tmp'));

    // 9. Create dedicated branch
    const branchName = 'firstpr/fix-discount-formatting';
    const branchRes = await createAndCheckoutBranch(scratchRepo, branchName);
    assert.strictEqual(branchRes.success, true);
    assert.strictEqual(branchRes.branchName, branchName);

    // 10. Commit verified fix (staging ONLY src/calc.js)
    const commitRes = await commitVerifiedFix(
      scratchRepo,
      ['src/calc.js'],
      {
        title: 'fix: format returned discount to 2 decimal places',
        body: 'Closes assertion discrepancy in calculateDiscount.\nVerified passing locally via npm test.',
      }
    );
    assert.strictEqual(commitRes.success, true);
    assert.ok(commitRes.commitHash);
    assert.deepStrictEqual(commitRes.stagedFiles, ['src/calc.js']);

    // 11. Verify that notes.tmp was NOT committed
    const postCommitPreflight = await preflightTargetRepo(scratchRepo, []);
    assert.ok(postCommitPreflight.unrelatedFiles.includes('notes.tmp'));

    // 12. Generate PR details and comparison link
    const prDetails = generatePullRequestDetails({
      repoUrl: 'https://github.com/TheGreatPratyush/Hack',
      baseBranch: 'main',
      featureBranch: branchName,
      issueTitle: issue.title,
      fixTitle: proposedFix.title,
      checkCommand: 'npm test',
      relativeFilePath: proposedFix.relativeFilePath,
      commitHash: commitRes.commitHash,
    });

    assert.ok(prDetails.title.startsWith('fix:'));
    assert.strictEqual(prDetails.baseBranch, 'main');
    assert.strictEqual(prDetails.headBranch, branchName);
    assert.ok(prDetails.body.includes('npm test'));
    assert.ok(prDetails.body.includes(commitRes.commitHash!));
    assert.ok(prDetails.compareUrl.includes('https://github.com/TheGreatPratyush/Hack/compare/main...firstpr/fix-discount-formatting'));
  });
});
