import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { diagnoseCheckResult, truncateEvidence } from '../diagnostics/diagnosticEngine';
import { CheckResult } from '../core/checkRunner';

describe('diagnosticEngine', () => {
  const baseResult: CheckResult = {
    checkName: 'test',
    command: 'npm',
    args: ['test'],
    cwd: '/workspace/my-repo',
    exitCode: 1,
    status: 'failed',
    stdout: '',
    stderr: '',
    durationMs: 450,
    explanation: 'Command failed',
  };

  it('diagnoses clean passing checks accurately without inventing bugs', () => {
    const report = diagnoseCheckResult({
      ...baseResult,
      exitCode: 0,
      status: 'passed',
      stdout: 'All 15 tests passed cleanly.',
    });

    assert.equal(report.hasIssues, false);
    assert.equal(report.issues.length, 1);
    assert.equal(report.issues[0].category, 'clean_pass');
    assert.equal(report.issues[0].evidenceQuality, 'Strong evidence');
    assert.match(report.issues[0].likelyExplanation, /do not guarantee absence of bugs/);
  });

  it('diagnoses TypeScript compile errors with file, line, col, and TS code', () => {
    const tsOutput = `
src/calc.ts:24:9 - error TS2322: Type 'string' is not assignable to type 'number'.

24   const total: number = "100";
           ~~~~~
Found 1 error in src/calc.ts:24
`;
    const report = diagnoseCheckResult({
      ...baseResult,
      checkName: 'build',
      args: ['run', 'build'],
      stderr: tsOutput,
    });

    assert.equal(report.hasIssues, true);
    assert.equal(report.issues.length, 1);
    const issue = report.issues[0];
    assert.equal(issue.category, 'typescript_compile_error');
    assert.equal(issue.evidenceQuality, 'Strong evidence');
    assert.equal(issue.location?.relativePath, 'src/calc.ts');
    assert.equal(issue.location?.line, 24);
    assert.equal(issue.location?.column, 9);
    assert.match(issue.title, /TS2322/);
    assert.match(issue.observedEvidence, /Type 'string' is not assignable/);
    assert.match(issue.likelyExplanation, /type incompatibility/i);
    assert.match(issue.recommendedAction, /Open src\/calc\.ts at line 24/);
  });

  it('diagnoses multiple TypeScript compile errors up to cap', () => {
    const multiTsOutput = `
src/a.ts:10:2 - error TS2304: Cannot find name 'foo'.
src/b.ts:20:5 - error TS2322: Type 'number' is not assignable to type 'string'.
`;
    const report = diagnoseCheckResult({
      ...baseResult,
      stderr: multiTsOutput,
    });

    assert.equal(report.issues.length, 2);
    assert.equal(report.issues[0].location?.relativePath, 'src/a.ts');
    assert.equal(report.issues[1].location?.relativePath, 'src/b.ts');
  });

  it('diagnoses missing external npm dependencies', () => {
    const missingDepOutput = `
Error: Cannot find module 'axios'
Require stack:
- /workspace/my-repo/src/api.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)
    at /workspace/my-repo/src/api.js:5:1
`;
    const report = diagnoseCheckResult({
      ...baseResult,
      stderr: missingDepOutput,
    });

    assert.equal(report.hasIssues, true);
    const issue = report.issues[0];
    assert.equal(issue.category, 'missing_dependency');
    assert.match(issue.title, /axios/);
    assert.match(issue.likelyExplanation, /is not installed in node_modules/i);
    assert.match(issue.recommendedAction, /npm install axios/i);
    assert.equal(issue.location?.relativePath, 'src/api.js');
    assert.equal(issue.location?.line, 5);
  });

  it('diagnoses missing relative file imports', () => {
    const missingRelOutput = `
Error: Cannot find module './missingHelper'
Require stack:
- /workspace/my-repo/src/main.js
`;
    const report = diagnoseCheckResult({
      ...baseResult,
      stderr: missingRelOutput,
    });

    assert.equal(report.hasIssues, true);
    const issue = report.issues[0];
    assert.equal(issue.category, 'missing_dependency');
    assert.match(issue.likelyExplanation, /local module import failed/i);
  });

  it('diagnoses test assertion failures with test name and stack location', () => {
    const testFailOutput = `
▶ discountEngine
  ✖ calculateDiscount should return numeric percentage (12.4ms)
    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    + actual - expected
    + '20%'
    - 0.2
        at TestContext.<anonymous> (/workspace/my-repo/test/discount.test.js:18:12)
        at Test.run (node:internal/test_runner/test:1054:7)
`;
    const report = diagnoseCheckResult({
      ...baseResult,
      stdout: testFailOutput,
    });

    assert.equal(report.hasIssues, true);
    const issue = report.issues[0];
    assert.equal(issue.category, 'test_assertion_failure');
    assert.match(issue.title, /calculateDiscount should return numeric percentage/);
    assert.equal(issue.location?.relativePath, 'test/discount.test.js');
    assert.equal(issue.location?.line, 18);
    assert.match(issue.likelyExplanation, /Hypothesis:/);
    assert.match(issue.recommendedAction, /Open test\/discount\.discount.test.js|Open test\/discount\.test\.js/);
  });

  it('diagnoses syntax errors without crashing', () => {
    const syntaxOutput = `
/workspace/my-repo/src/broken.js:12
  const x = ;
            ^
SyntaxError: Unexpected token ';'
`;
    const report = diagnoseCheckResult({
      ...baseResult,
      stderr: syntaxOutput,
    });

    assert.equal(report.hasIssues, true);
    const issue = report.issues[0];
    assert.equal(issue.category, 'syntax_error');
    assert.match(issue.title, /Unexpected token/);
    assert.equal(issue.location?.relativePath, 'src/broken.js');
    assert.equal(issue.location?.line, 12);
  });

  it('handles cancellation status honestly', () => {
    const report = diagnoseCheckResult({
      ...baseResult,
      status: 'cancelled',
      exitCode: null,
    });

    assert.equal(report.hasIssues, true);
    assert.match(report.issues[0].title, /Cancelled/);
  });

  it('handles timeout status honestly', () => {
    const report = diagnoseCheckResult({
      ...baseResult,
      status: 'timed_out',
      exitCode: null,
      durationMs: 60000,
    });

    assert.equal(report.hasIssues, true);
    assert.match(report.issues[0].title, /Timed Out/);
    assert.match(report.issues[0].recommendedAction, /watch/);
  });

  it('handles unknown failures honestly without inventing file or line', () => {
    const unknownOutput = `
Some arbitrary third-party build tool crashed mysteriously.
Fatal: Process terminated abnormally.
`;
    const report = diagnoseCheckResult({
      ...baseResult,
      exitCode: 137,
      stderr: unknownOutput,
    });

    assert.equal(report.hasIssues, true);
    const issue = report.issues[0];
    assert.equal(issue.category, 'unknown_failure');
    assert.equal(issue.evidenceQuality, 'Insufficient evidence');
    assert.equal(issue.location, undefined); // Does NOT invent file or line
    assert.match(issue.likelyExplanation, /Root cause is currently unconfirmed/);
  });

  it('bounds and truncates large evidence snippets', () => {
    const hugeText = 'A'.repeat(5000);
    const truncated = truncateEvidence(hugeText, 500);
    assert.ok(truncated.length < 600);
    assert.match(truncated, /evidence truncated/);
  });
});
