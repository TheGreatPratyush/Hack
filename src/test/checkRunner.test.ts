import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { executeCheck, isValidScriptName } from '../core/checkRunner';

describe('checkRunner', () => {
  const testRoot = path.join(os.tmpdir(), `firstpr-runner-test-${Date.now()}`);

  before(() => {
    fs.mkdirSync(testRoot, { recursive: true });
    // Write a test package.json with controlled scripts
    fs.writeFileSync(
      path.join(testRoot, 'package.json'),
      JSON.stringify({
        name: 'test-sandbox',
        scripts: {
          test: 'node -e "console.log(\'all tests passed\'); process.exit(0)"',
          fail: 'node -e "console.error(\'assertion failure\'); process.exit(2)"',
          slow: 'node -e "setTimeout(() => console.log(\'done\'), 5000)"',
        },
      })
    );
  });

  after(() => {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('validates script names against command injection characters', () => {
    assert.equal(isValidScriptName('test'), true);
    assert.equal(isValidScriptName('build:prod'), true);
    assert.equal(isValidScriptName('type-check.all'), true);
    assert.equal(isValidScriptName('test; rm -rf /'), false);
    assert.equal(isValidScriptName('test && malicious'), false);
    assert.equal(isValidScriptName('test`cat /etc/passwd`'), false);
    assert.equal(isValidScriptName(''), false);
  });

  it('rejects invalid or nonexistent working directory', async () => {
    const res = await executeCheck({
      cwd: path.join(testRoot, 'nonexistent-directory'),
      checkType: 'test',
    });
    assert.equal(res.status, 'error');
    assert.equal(res.exitCode, null);
    assert.match(res.stderr, /does not exist/i);
  });

  it('rejects scripts not defined in allowedScripts', async () => {
    const res = await executeCheck({
      cwd: testRoot,
      checkType: 'build',
      scriptName: 'nonexistent-script',
      allowedScripts: { test: 'node ...' },
    });
    assert.equal(res.status, 'error');
    assert.match(res.stderr, /is not defined in the project's package.json/i);
  });

  it('rejects script names with injection characters', async () => {
    const res = await executeCheck({
      cwd: testRoot,
      checkType: 'build',
      scriptName: 'test; whoami',
      allowedScripts: { 'test; whoami': 'echo bad' },
    });
    assert.equal(res.status, 'error');
    assert.match(res.stderr, /contains invalid characters/i);
    assert.match(res.explanation, /failed safety validation/i);
  });

  it('executes a passing script and captures exit code 0', async () => {
    const res = await executeCheck({
      cwd: testRoot,
      checkType: 'test',
      timeoutMs: 10000,
      allowedScripts: { test: 'node ...' },
    });

    assert.equal(res.status, 'passed');
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /all tests passed/);
    assert.match(res.explanation, /exit code 0/);
  });

  it('executes a failing script and captures nonzero exit code', async () => {
    const res = await executeCheck({
      cwd: testRoot,
      checkType: 'build',
      scriptName: 'fail',
      timeoutMs: 10000,
      allowedScripts: { fail: 'node ...' },
    });

    assert.equal(res.status, 'failed');
    assert.equal(res.exitCode, 2);
    assert.match(res.stderr, /assertion failure/);
    assert.match(res.explanation, /exit code 2/);
  });

  it('handles cancellation signal before or during execution', async () => {
    const controller = new AbortController();
    controller.abort();

    const res = await executeCheck({
      cwd: testRoot,
      checkType: 'test',
      signal: controller.signal,
    });

    assert.equal(res.status, 'cancelled');
    assert.equal(res.exitCode, null);
    assert.match(res.explanation, /cancelled/i);
  });

  it('handles execution timeout', async () => {
    const res = await executeCheck({
      cwd: testRoot,
      checkType: 'build',
      scriptName: 'slow',
      timeoutMs: 500, // 500ms timeout on a 5s script
      allowedScripts: { slow: 'node ...' },
    });

    assert.equal(res.status, 'timed_out');
    assert.equal(res.exitCode, null);
    assert.match(res.explanation, /timed out/i);
  });
});
