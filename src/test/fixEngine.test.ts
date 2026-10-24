import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  generateUnifiedDiff,
  proposeFixForIssue,
  applyProposedFix,
  rollbackAppliedFix,
} from '../fixes/fixEngine';
import { DiagnosticIssue } from '../diagnostics/diagnosticEngine';

describe('fixEngine', () => {
  const testRoot = path.join(os.tmpdir(), `firstpr-fix-test-${Date.now()}`);

  before(() => {
    fs.mkdirSync(testRoot, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('generates standard unified diff format with context lines', () => {
    const orig = 'line 1\nline 2\nconst discount = "20%";\nline 4\nline 5';
    const patch = 'line 1\nline 2\nconst discount = 20;\nline 4\nline 5';

    const diff = generateUnifiedDiff('src/calc.js', orig, patch);

    assert.ok(diff.includes('--- a/src/calc.js'));
    assert.ok(diff.includes('+++ b/src/calc.js'));
    assert.ok(diff.includes('-const discount = "20%";'));
    assert.ok(diff.includes('+const discount = 20;'));
    assert.ok(diff.includes(' line 1'));
  });

  it('proposes deterministic fix for demo calculator format discrepancy without modifying disk', () => {
    const demoDir = path.join(testRoot, 'demo-sub');
    const srcDir = path.join(demoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const calcFile = path.join(srcDir, 'calc.js');
    const originalContent = `function calculateDiscount(price, discountPercent) {
  if (price <= 0 || discountPercent < 0) return 0;
  return \`\${price * (discountPercent / 100)}%\`;
}
module.exports = { calculateDiscount };`;

    fs.writeFileSync(calcFile, originalContent, 'utf8');

    const issue: DiagnosticIssue = {
      id: 'iss-1',
      category: 'test_assertion_failure',
      title: 'Test Assertion Failure',
      severity: 'error',
      evidenceQuality: 'Strong evidence',
      observedEvidence: "'20%' !== 20",
      likelyExplanation: 'Hypothesis: String returned instead of number.',
      recommendedAction: 'Check return statement.',
      failedCommand: 'npm test',
      exitCode: 1,
    };

    const fix = proposeFixForIssue(issue, demoDir);

    assert.ok(fix !== null);
    if (fix) {
      assert.equal(fix.canSafelyApply, true);
      assert.ok(fix.unifiedDiff.includes('-  return `${price * (discountPercent / 100)}%`;'));
      assert.ok(fix.unifiedDiff.includes('+  return price * (discountPercent / 100);'));

      // Verify file on disk was NOT modified prior to approval
      const contentOnDisk = fs.readFileSync(calcFile, 'utf8');
      assert.equal(contentOnDisk, originalContent);
    }
  });

  it('proposes package.json dependency declaration for missing module', () => {
    const pkgDir = path.join(testRoot, 'pkg-sub');
    fs.mkdirSync(pkgDir, { recursive: true });
    const pkgFile = path.join(pkgDir, 'package.json');
    fs.writeFileSync(
      pkgFile,
      JSON.stringify({ name: 'my-lib', version: '1.0.0', dependencies: {} }, null, 2) + '\n'
    );

    const issue: DiagnosticIssue = {
      id: 'iss-mod-1',
      category: 'missing_dependency',
      title: 'Missing Dependency: "axios"',
      severity: 'error',
      evidenceQuality: 'Strong evidence',
      observedEvidence: "Cannot find module 'axios'",
      likelyExplanation: 'Package is missing.',
      recommendedAction: 'Install package.',
      failedCommand: 'npm test',
      exitCode: 1,
    };

    const fix = proposeFixForIssue(issue, pkgDir);
    assert.ok(fix !== null);
    if (fix) {
      assert.ok(fix.unifiedDiff.includes('"axios": "*"'));
    }
  });

  it('returns null for ambiguous or unclassifiable issue', () => {
    const issue: DiagnosticIssue = {
      id: 'iss-unknown',
      category: 'unknown_failure',
      title: 'Unknown Crash',
      severity: 'error',
      evidenceQuality: 'Insufficient evidence',
      observedEvidence: 'Process exited 137',
      likelyExplanation: 'Unconfirmed',
      recommendedAction: 'Inspect log',
      failedCommand: 'npm test',
      exitCode: 137,
    };

    const fix = proposeFixForIssue(issue, testRoot);
    assert.equal(fix, null);
  });

  it('safely applies approved patch and returns rollback record', () => {
    const appDir = path.join(testRoot, 'apply-sub');
    fs.mkdirSync(appDir, { recursive: true });
    const targetFile = path.join(appDir, 'index.js');
    const orig = 'const value = "old";\n';
    fs.writeFileSync(targetFile, orig, 'utf8');

    const patched = 'const value = "new";\n';
    const fix = {
      id: 'fix-1',
      issueId: 'iss-1',
      title: 'Update value',
      description: 'Changes old to new',
      targetFilePath: targetFile,
      relativeFilePath: 'index.js',
      originalContent: orig,
      originalContentHash: require('crypto').createHash('sha256').update(orig).digest('hex'),
      patchedContent: patched,
      unifiedDiff: generateUnifiedDiff('index.js', orig, patched),
      canSafelyApply: true,
      safetyNotes: [],
    };

    const res = applyProposedFix(fix, appDir);
    assert.equal(res.success, true);
    assert.ok(res.rollbackRecord !== undefined);

    const currentOnDisk = fs.readFileSync(targetFile, 'utf8');
    assert.equal(currentOnDisk, patched);

    // Rollback test
    const rb = rollbackAppliedFix(res.rollbackRecord!, appDir);
    assert.equal(rb.success, true);

    const rolledBack = fs.readFileSync(targetFile, 'utf8');
    assert.equal(rolledBack, orig);
  });

  it('rejects patch application if target file was modified since diff generation', () => {
    const confDir = path.join(testRoot, 'conflict-sub');
    fs.mkdirSync(confDir, { recursive: true });
    const targetFile = path.join(confDir, 'index.js');
    fs.writeFileSync(targetFile, 'content A\n', 'utf8');

    const fix = {
      id: 'fix-conf',
      issueId: 'iss-c',
      title: 'Test conflict',
      description: '',
      targetFilePath: targetFile,
      relativeFilePath: 'index.js',
      originalContent: 'content A\n',
      originalContentHash: require('crypto').createHash('sha256').update('content A\n').digest('hex'),
      patchedContent: 'content B\n',
      unifiedDiff: '',
      canSafelyApply: true,
      safetyNotes: [],
    };

    // User modifies file independently before approval
    fs.writeFileSync(targetFile, 'content MODIFIED\n', 'utf8');

    const res = applyProposedFix(fix, confDir);
    assert.equal(res.success, false);
    assert.match(res.error || '', /Conflict detected/);
  });

  it('rejects rollback if file was modified after patch was applied', () => {
    const rbDir = path.join(testRoot, 'rb-sub');
    fs.mkdirSync(rbDir, { recursive: true });
    const targetFile = path.join(rbDir, 'index.js');
    fs.writeFileSync(targetFile, 'content original\n', 'utf8');

    const record = {
      fixId: 'fix-rb',
      targetFilePath: targetFile,
      relativeFilePath: 'index.js',
      originalContent: 'content original\n',
      patchedContent: 'content patched\n',
      appliedAt: Date.now(),
    };

    // File is currently modified by a third party to content other than patchedContent
    fs.writeFileSync(targetFile, 'content third party edit\n', 'utf8');

    const res = rollbackAppliedFix(record, rbDir);
    assert.equal(res.success, false);
    assert.match(res.error || '', /modified independently/);
  });

  it('rejects path traversal in applyProposedFix and rollbackAppliedFix', () => {
    const safeDir = path.join(testRoot, 'safe-zone');
    fs.mkdirSync(safeDir, { recursive: true });

    const outsideFile = path.join(os.tmpdir(), `firstpr-outside-${Date.now()}.txt`);
    fs.writeFileSync(outsideFile, 'secret', 'utf8');

    const fix = {
      id: 'fix-trav',
      issueId: 'iss-t',
      title: 'Attack',
      description: '',
      targetFilePath: outsideFile,
      relativeFilePath: '../../outside.txt',
      originalContent: 'secret',
      originalContentHash: require('crypto').createHash('sha256').update('secret').digest('hex'),
      patchedContent: 'hacked',
      unifiedDiff: '',
      canSafelyApply: true,
      safetyNotes: [],
    };

    const res = applyProposedFix(fix, safeDir);
    assert.equal(res.success, false);
    assert.match(res.error || '', /outside workspace/i);

    fs.rmSync(outsideFile, { force: true });
  });
});
