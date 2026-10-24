import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { inspectProject } from '../core/projectInspector';
import { executeCheck } from '../core/checkRunner';
import { diagnoseCheckResult } from '../diagnostics/diagnosticEngine';

describe('demoPipeline — Reproducible Demonstration Scenario', () => {
  const demoPath = path.resolve(__dirname, '../../fixtures/demo-calc');

  it('demonstrates end-to-end inspection, execution, failure capture, and evidence diagnosis', async () => {
    // 1. Inspect demo repository
    const inspection = inspectProject(demoPath);
    assert.equal(inspection.isNodeProject, true);
    assert.equal(inspection.packageName, 'firstpr-demo-calc');
    assert.ok(inspection.availableChecks.test);

    // 2. Execute approved check
    const checkResult = await executeCheck({
      cwd: demoPath,
      checkType: 'test',
      timeoutMs: 10000,
      allowedScripts: inspection.scripts,
    });

    assert.equal(checkResult.status, 'failed');
    assert.equal(checkResult.exitCode, 1);
    assert.ok(checkResult.stderr.includes('AssertionError') || checkResult.stdout.includes('AssertionError'));

    // 3. Diagnose the failure with evidence
    const report = diagnoseCheckResult(checkResult);
    assert.equal(report.hasIssues, true);
    assert.equal(report.issues.length, 1);

    const issue = report.issues[0];
    assert.equal(issue.category, 'test_assertion_failure');
    assert.equal(issue.evidenceQuality, 'Strong evidence');
    assert.match(issue.title, /Test Assertion/);
    assert.ok(issue.location?.relativePath.includes('test/calc.test.js'));
    assert.match(issue.observedEvidence, /AssertionError/);
    assert.match(issue.likelyExplanation, /Hypothesis:/);
    assert.match(issue.recommendedAction, /Open test\/calc\.test\.js/);
  });
});
