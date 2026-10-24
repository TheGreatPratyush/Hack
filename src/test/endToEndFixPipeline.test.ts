import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { inspectProject } from '../core/projectInspector';
import { executeCheck } from '../core/checkRunner';
import { diagnoseCheckResult } from '../diagnostics/diagnosticEngine';
import { proposeFixForIssue, applyProposedFix, rollbackAppliedFix } from '../fixes/fixEngine';

describe('endToEndFixPipeline — Complete Fix-and-Verify Workflow', () => {
  const scratchDemo = path.join(os.tmpdir(), `firstpr-demo-e2e-${Date.now()}`);

  before(() => {
    // Copy demo-calc fixture into an isolated scratch directory
    const sourceFixture = path.resolve(__dirname, '../../fixtures/demo-calc');
    fs.cpSync(sourceFixture, scratchDemo, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(scratchDemo, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('demonstrates failure capture, fix generation, user approval, verified re-check, and rollback', async () => {
    // 1. Inspect Project
    const inspection = inspectProject(scratchDemo);
    assert.equal(inspection.isNodeProject, true);
    assert.ok(inspection.availableChecks.test);

    // 2. Run initial check -> Fails with exit code 1
    const initialCheck = await executeCheck({
      cwd: scratchDemo,
      checkType: 'test',
      timeoutMs: 10000,
      allowedScripts: inspection.scripts,
    });

    assert.equal(initialCheck.status, 'failed');
    assert.equal(initialCheck.exitCode, 1);

    // 3. Diagnose failure
    const diagnosis = diagnoseCheckResult(initialCheck);
    assert.equal(diagnosis.hasIssues, true);
    assert.equal(diagnosis.issues[0].category, 'test_assertion_failure');

    // 4. Propose fix
    const proposedFix = proposeFixForIssue(diagnosis.issues[0], scratchDemo);
    assert.ok(proposedFix !== null);
    if (!proposedFix) return;

    assert.equal(proposedFix.canSafelyApply, true);
    assert.ok(proposedFix.unifiedDiff.includes('-  return `${price * (discountPercent / 100)}%`;'));
    assert.ok(proposedFix.unifiedDiff.includes('+  return price * (discountPercent / 100);'));

    // 5. Verify NO disk modification before explicit approval
    const calcPath = path.join(scratchDemo, 'src', 'calc.js');
    const contentBeforeApproval = fs.readFileSync(calcPath, 'utf8');
    assert.equal(contentBeforeApproval, proposedFix.originalContent);

    // 6. Apply approved fix
    const applyResult = applyProposedFix(proposedFix, scratchDemo);
    assert.equal(applyResult.success, true);
    assert.ok(applyResult.rollbackRecord !== undefined);

    // Verify disk content changed
    const contentAfterApproval = fs.readFileSync(calcPath, 'utf8');
    assert.equal(contentAfterApproval, proposedFix.patchedContent);

    // 7. Re-run check to verify -> Now passes with exit code 0!
    const recheckResult = await executeCheck({
      cwd: scratchDemo,
      checkType: 'test',
      timeoutMs: 10000,
      allowedScripts: inspection.scripts,
    });

    assert.equal(recheckResult.status, 'passed');
    assert.equal(recheckResult.exitCode, 0);

    // 8. Re-verification diagnosis confirms clean pass
    const recheckDiagnosis = diagnoseCheckResult(recheckResult);
    assert.equal(recheckDiagnosis.hasIssues, false);
    assert.equal(recheckDiagnosis.issues[0].category, 'clean_pass');

    // 9. Rollback fix safely
    const rollbackResult = rollbackAppliedFix(applyResult.rollbackRecord!, scratchDemo);
    assert.equal(rollbackResult.success, true);

    const contentAfterRollback = fs.readFileSync(calcPath, 'utf8');
    assert.equal(contentAfterRollback, proposedFix.originalContent);

    // 10. Re-check after rollback -> Fails again
    const checkAfterRollback = await executeCheck({
      cwd: scratchDemo,
      checkType: 'test',
      timeoutMs: 10000,
      allowedScripts: inspection.scripts,
    });
    assert.equal(checkAfterRollback.exitCode, 1);
  });
});
