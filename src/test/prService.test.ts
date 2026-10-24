import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  sanitizeBranchSlug,
  isValidBranchName,
  buildBranchName,
  parseGitHubRepo,
  generatePullRequestDetails,
  preflightTargetRepo,
  createAndCheckoutBranch,
  commitVerifiedFix,
  runGit,
  checkGhCli,
} from '../git/prService';

describe('prService — Git Branch & Pull Request Helper', () => {
  let testRepoDir: string;

  before(async () => {
    // Create an isolated scratch git repo for testing git operations
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firstpr-test-git-'));
    await runGit(['init', '-b', 'main'], testRepoDir);
    await runGit(['config', 'user.name', 'FirstPR Test'], testRepoDir);
    await runGit(['config', 'user.email', 'test@firstpr.internal'], testRepoDir);

    // Initial commit
    fs.writeFileSync(path.join(testRepoDir, 'README.md'), '# Test Repo\n');
    fs.writeFileSync(path.join(testRepoDir, 'index.js'), 'module.exports = 42;\n');
    await runGit(['add', '.'], testRepoDir);
    await runGit(['commit', '-m', 'chore: initial commit'], testRepoDir);
  });

  after(() => {
    if (testRepoDir && fs.existsSync(testRepoDir)) {
      try {
        fs.rmSync(testRepoDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  describe('slug and branch name validation', () => {
    it('sanitizes titles into safe kebab-case slugs', () => {
      const slug = sanitizeBranchSlug('Fix discount-type calculation formatting discrepancy!');
      assert.strictEqual(slug, 'fix-discount-type-calculation-formatting-discrepancy');

      assert.strictEqual(sanitizeBranchSlug('   hello / world   '), 'hello-world');
      assert.strictEqual(sanitizeBranchSlug(''), 'fix-issue');
    });

    it('builds standard firstpr branch name with prefix', () => {
      const branch = buildBranchName('calc format');
      assert.strictEqual(branch, 'firstpr/calc-format');
    });

    it('validates compliant and non-compliant git branch names', () => {
      assert.strictEqual(isValidBranchName('firstpr/fix-bug'), true);
      assert.strictEqual(isValidBranchName('feature-123'), true);
      assert.strictEqual(isValidBranchName('patch_v1.0'), true);

      // Invalid patterns
      assert.strictEqual(isValidBranchName(''), false);
      assert.strictEqual(isValidBranchName('firstpr/../escape'), false);
      assert.strictEqual(isValidBranchName('branch~1'), false);
      assert.strictEqual(isValidBranchName('branch^2'), false);
      assert.strictEqual(isValidBranchName('branch:name'), false);
      assert.strictEqual(isValidBranchName('branch?name'), false);
      assert.strictEqual(isValidBranchName('branch*name'), false);
      assert.strictEqual(isValidBranchName('branch[name'), false);
      assert.strictEqual(isValidBranchName('/leading-slash'), false);
      assert.strictEqual(isValidBranchName('trailing-slash/'), false);
      assert.strictEqual(isValidBranchName('branch.lock'), false);
      assert.strictEqual(isValidBranchName('has space'), false);
    });
  });

  describe('parseGitHubRepo', () => {
    it('parses valid GitHub HTTPS URLs', () => {
      const res = parseGitHubRepo('https://github.com/facebook/react');
      assert.ok(res);
      assert.strictEqual(res.owner, 'facebook');
      assert.strictEqual(res.repo, 'react');

      const withGit = parseGitHubRepo('https://github.com/TheGreatPratyush/Hack.git');
      assert.ok(withGit);
      assert.strictEqual(withGit.owner, 'TheGreatPratyush');
      assert.strictEqual(withGit.repo, 'Hack');

      const withWww = parseGitHubRepo('https://www.github.com/owner/repo/');
      assert.ok(withWww);
      assert.strictEqual(withWww.owner, 'owner');
      assert.strictEqual(withWww.repo, 'repo');
    });

    it('parses valid GitHub SSH URLs', () => {
      const res = parseGitHubRepo('git@github.com:octocat/Hello-World.git');
      assert.ok(res);
      assert.strictEqual(res.owner, 'octocat');
      assert.strictEqual(res.repo, 'Hello-World');
    });

    it('returns null for non-GitHub or invalid URLs', () => {
      assert.strictEqual(parseGitHubRepo('https://gitlab.com/owner/repo'), null);
      assert.strictEqual(parseGitHubRepo('not-a-url'), null);
      assert.strictEqual(parseGitHubRepo(''), null);
    });
  });

  describe('generatePullRequestDetails', () => {
    it('generates structured PR details and comparison link', () => {
      const pr = generatePullRequestDetails({
        repoUrl: 'https://github.com/TheGreatPratyush/Hack',
        baseBranch: 'main',
        featureBranch: 'firstpr/fix-format',
        issueTitle: 'Format mismatch in calculateDiscount',
        fixTitle: 'Format returned discount to 2 decimal places',
        checkCommand: 'npm test',
        relativeFilePath: 'src/index.js',
        commitHash: 'abc1234',
      });

      assert.strictEqual(pr.title, 'fix: Format returned discount to 2 decimal places');
      assert.strictEqual(pr.baseBranch, 'main');
      assert.strictEqual(pr.headBranch, 'firstpr/fix-format');
      assert.ok(pr.body.includes('Format mismatch in calculateDiscount'));
      assert.ok(pr.body.includes('src/index.js'));
      assert.ok(pr.body.includes('npm test'));
      assert.ok(pr.body.includes('abc1234'));
      assert.ok(pr.body.includes('FirstPR'));

      // Check compare URL structure
      assert.ok(pr.compareUrl.startsWith('https://github.com/TheGreatPratyush/Hack/compare/main...firstpr/fix-format?'));
      assert.ok(pr.compareUrl.includes('expand=1'));
      assert.ok(pr.compareUrl.includes(encodeURIComponent('fix: Format returned discount to 2 decimal places')));
    });
  });

  describe('target repository Git operations', () => {
    it('runs preflight check on clean repository', async () => {
      const pre = await preflightTargetRepo(testRepoDir, ['index.js']);
      assert.strictEqual(pre.isGitRepo, true);
      assert.strictEqual(pre.currentBranch, 'main');
      assert.strictEqual(pre.isDetached, false);
      assert.strictEqual(pre.hasUnrelatedChanges, false);
      assert.strictEqual(pre.allowedModifiedFiles.length, 0);
    });

    it('identifies allowed modified files vs unrelated files', async () => {
      // Modify allowed file
      fs.writeFileSync(path.join(testRepoDir, 'index.js'), 'module.exports = 100;\n');

      const pre1 = await preflightTargetRepo(testRepoDir, ['index.js']);
      assert.strictEqual(pre1.hasUnrelatedChanges, false);
      assert.strictEqual(pre1.allowedModifiedFiles.length, 1);
      assert.strictEqual(pre1.cleanForCommit, true);

      // Now create an unrelated file
      fs.writeFileSync(path.join(testRepoDir, 'secret.txt'), 'do not commit this\n');

      const pre2 = await preflightTargetRepo(testRepoDir, ['index.js']);
      assert.strictEqual(pre2.hasUnrelatedChanges, true);
      assert.ok(pre2.unrelatedFiles.includes('secret.txt'));
      assert.strictEqual(pre2.cleanForCommit, false);

      // Cleanup secret.txt to restore clean state
      fs.unlinkSync(path.join(testRepoDir, 'secret.txt'));
      // Restore index.js
      await runGit(['checkout', 'index.js'], testRepoDir);
    });

    it('safely creates and switches to a dedicated feature branch', async () => {
      const branchRes = await createAndCheckoutBranch(testRepoDir, 'firstpr/fix-test-1');
      assert.strictEqual(branchRes.success, true);
      assert.strictEqual(branchRes.branchName, 'firstpr/fix-test-1');
      assert.strictEqual(branchRes.alreadyExisted, false);

      // Verify current branch is now firstpr/fix-test-1
      const pre = await preflightTargetRepo(testRepoDir);
      assert.strictEqual(pre.currentBranch, 'firstpr/fix-test-1');

      // Re-invoking on the same branch should succeed with alreadyExisted = true
      const branchRes2 = await createAndCheckoutBranch(testRepoDir, 'firstpr/fix-test-1');
      assert.strictEqual(branchRes2.success, true);
      assert.strictEqual(branchRes2.alreadyExisted, true);
    });

    it('rejects invalid branch names without modifying Git state', async () => {
      const branchRes = await createAndCheckoutBranch(testRepoDir, 'invalid..branch');
      assert.strictEqual(branchRes.success, false);
      assert.ok(branchRes.error?.includes('Invalid branch name'));
    });

    it('stages only approved files and commits them with structured message', async () => {
      // Modify index.js (approved) and add an untracked scratch.txt (unapproved)
      fs.writeFileSync(path.join(testRepoDir, 'index.js'), 'module.exports = 200;\n');
      fs.writeFileSync(path.join(testRepoDir, 'scratch.txt'), 'do not stage\n');

      const commitRes = await commitVerifiedFix(
        testRepoDir,
        ['index.js'],
        {
          title: 'fix: update index value to 200',
          body: 'Verified via unit test.\nFixes calculation anomaly.',
        }
      );

      assert.strictEqual(commitRes.success, true);
      assert.ok(commitRes.commitHash);
      assert.ok(commitRes.shortHash);
      assert.deepStrictEqual(commitRes.stagedFiles, ['index.js']);

      // Verify scratch.txt remained uncommitted
      const pre = await preflightTargetRepo(testRepoDir, []);
      assert.ok(pre.unrelatedFiles.includes('scratch.txt'));

      // Clean up scratch.txt
      fs.unlinkSync(path.join(testRepoDir, 'scratch.txt'));
    });

    it('rejects path traversal attempts in commitVerifiedFix', async () => {
      const res = await commitVerifiedFix(
        testRepoDir,
        ['../../etc/passwd'],
        {
          title: 'evil',
          body: 'evil',
        }
      );
      assert.strictEqual(res.success, false);
      assert.ok(res.error?.includes('Security error'));
    });

    it('checks gh CLI availability without error', async () => {
      const status = await checkGhCli();
      assert.strictEqual(typeof status.installed, 'boolean');
      assert.strictEqual(typeof status.authenticated, 'boolean');
    });
  });
});
