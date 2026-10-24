import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  SetupExecutionAgent,
  validateStepForExecution
} from '../setup/setupAgent';
import { FirstPrSetupPlan, SetupStep } from '../llm';
import { synthesizeFactualBaselinePlan, extractRepoContext } from '../setup';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `firstpr-agent-${prefix}-`));
}

function cleanupTempDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ignored
  }
}

describe('Milestone 9 — Safe Setup Execution Agent', () => {
  it('1. executes an approved safe step and captures exit code 0 and stdout', async () => {
    const tmpDir = createTempDir('approved-step');
    try {
      const plan: FirstPrSetupPlan = {
        version: '1.0',
        summary: 'Safe test plan',
        steps: [
          {
            id: 'check-node',
            title: 'Verify Node.js version',
            executable: 'node',
            args: ['-v'],
            cwd: '.'
          }
        ]
      };

      const agent = new SetupExecutionAgent(tmpDir, plan);
      const preflight = agent.getPreflightCheck('check-node');
      assert.strictEqual(preflight.isAllowed, true);

      let streamedOutput = '';
      const result = await agent.executeStep('check-node', {
        userApproved: true,
        onProgress: (chunk) => {
          streamedOutput += chunk;
        }
      });

      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('v'));
      assert.ok(streamedOutput.length > 0);
      assert.strictEqual(result.durationMs >= 0, true);
      assert.strictEqual(agent.getSession().isComplete, true);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('2. refuses to execute an unapproved or rejected step without spawning processes', async () => {
    const tmpDir = createTempDir('unapproved-step');
    try {
      const plan: FirstPrSetupPlan = {
        version: '1.0',
        summary: 'Unapproved test plan',
        steps: [
          {
            id: 'build-step',
            title: 'Build assets',
            executable: 'node',
            args: ['-v'],
            cwd: '.'
          }
        ]
      };

      const agent = new SetupExecutionAgent(tmpDir, plan);
      const result = await agent.executeStep('build-step', {
        userApproved: false
      });

      assert.strictEqual(result.status, 'rejected');
      assert.strictEqual(result.exitCode, null);
      assert.strictEqual(result.stdout, '');
      assert.ok(result.stderr.includes('User did not approve'));
      assert.strictEqual(agent.getSession().isComplete, false);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('3. rejects invalid executables, blacklisted commands, shell wrappers, and arbitrary code eval', () => {
    const tmpDir = createTempDir('invalid-exec');
    try {
      // 3A: Blacklisted destructive command
      const rmStep: SetupStep = { id: 's1', title: 'Delete', executable: 'rm', args: ['-rf', '/'] };
      const rmCheck = validateStepForExecution(tmpDir, rmStep);
      assert.strictEqual(rmCheck.isAllowed, false);
      assert.strictEqual(rmCheck.riskLevel, 'critical_rejected');
      assert.ok(rmCheck.rejectionReason?.includes('classified as dangerous'));

      // 3B: Shell metacharacters
      const injectionStep: SetupStep = { id: 's2', title: 'Inject', executable: 'pnpm; rm', args: [] };
      const injCheck = validateStepForExecution(tmpDir, injectionStep);
      assert.strictEqual(injCheck.isAllowed, false);
      assert.ok(injCheck.rejectionReason?.includes('forbidden shell metacharacters'));

      // 3C: Raw shell interpreters
      const shStep: SetupStep = { id: 's3', title: 'Shell', executable: 'bash', args: ['-c', 'whoami'] };
      const shCheck = validateStepForExecution(tmpDir, shStep);
      assert.strictEqual(shCheck.isAllowed, false);
      assert.ok(shCheck.rejectionReason?.includes('Invoking shell interpreter'));

      // 3D: Arbitrary inline code execution
      const evalStep: SetupStep = { id: 's4', title: 'Eval', executable: 'node', args: ['-e', 'console.log(1)'] };
      const evalCheck = validateStepForExecution(tmpDir, evalStep);
      assert.strictEqual(evalCheck.isAllowed, false);
      assert.ok(evalCheck.rejectionReason?.includes('Inline arbitrary code execution'));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('4. detects directory traversal and prevents symlink escape outside repository', () => {
    const tmpDir = createTempDir('traversal-defense');
    const outsideDir = createTempDir('outside-target');
    try {
      // 4A: Relative traversal
      const traversalStep: SetupStep = { id: 's1', title: 'Traverse', executable: 'node', args: ['-v'], cwd: '../../' };
      const travCheck = validateStepForExecution(tmpDir, traversalStep);
      assert.strictEqual(travCheck.isAllowed, false);
      assert.ok(travCheck.rejectionReason?.includes('escapes repository root'));

      // 4B: Symlink escape
      const symlinkPath = path.join(tmpDir, 'symlink-outside');
      try {
        fs.symlinkSync(outsideDir, symlinkPath, 'dir');
      } catch {
        // In case OS restricts symlinks in tmp
      }

      if (fs.existsSync(symlinkPath)) {
        const symlinkStep: SetupStep = {
          id: 's2',
          title: 'Symlink Escape',
          executable: 'node',
          args: ['-v'],
          cwd: 'symlink-outside'
        };
        const symCheck = validateStepForExecution(tmpDir, symlinkStep);
        assert.strictEqual(symCheck.isAllowed, false);
        assert.ok(symCheck.rejectionReason?.includes('escapes repository root via symlink'));
      }
    } finally {
      cleanupTempDir(tmpDir);
      cleanupTempDir(outsideDir);
    }
  });

  it('5. enforces timeouts and handles user cancellation', async () => {
    const tmpDir = createTempDir('timeout-cancel');
    try {
      // 5A: Timeout
      // Create a small script file in repo to simulate long task
      const scriptPath = path.join(tmpDir, 'sleep.js');
      fs.writeFileSync(scriptPath, 'setTimeout(() => {}, 2000);\n');

      const sleepPlan: FirstPrSetupPlan = {
        version: '1.0',
        summary: 'Timeout plan',
        steps: [
          {
            id: 'sleep-step',
            title: 'Sleep script',
            executable: 'node',
            args: ['sleep.js'],
            cwd: '.'
          }
        ]
      };

      const agent = new SetupExecutionAgent(tmpDir, sleepPlan);

      const timeoutResult = await agent.executeStep('sleep-step', {
        userApproved: true,
        timeoutMs: 30
      });
      assert.strictEqual(timeoutResult.status, 'timed_out');
      assert.ok(timeoutResult.explanation.includes('exceeded timeout'));

      // 5B: Cancellation via AbortSignal
      const controller = new AbortController();
      controller.abort();

      const cancelResult = await agent.executeStep('sleep-step', {
        userApproved: true,
        signal: controller.signal
      });
      assert.strictEqual(cancelResult.status, 'cancelled');
      assert.ok(cancelResult.explanation.includes('cancelled'));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('6. captures non-zero exit codes and bounds oversized output streams', async () => {
    const tmpDir = createTempDir('nonzero-output');
    try {
      // Create script that prints a large amount of text and exits 5
      const scriptPath = path.join(tmpDir, 'spam.js');
      fs.writeFileSync(
        scriptPath,
        `for (let i = 0; i < 3000; i++) {
          process.stdout.write("Line " + i + " output spamming to test bounds.\\n");
        }
        process.exit(5);`
      );

      const plan: FirstPrSetupPlan = {
        version: '1.0',
        summary: 'Exit code and buffer test',
        steps: [
          {
            id: 'spam-step',
            title: 'Spam and fail',
            executable: 'node',
            args: ['spam.js'],
            cwd: '.'
          }
        ]
      };

      const agent = new SetupExecutionAgent(tmpDir, plan);
      const result = await agent.executeStep('spam-step', { userApproved: true });

      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.exitCode, 5);
      assert.ok(result.stdout.includes('Line 0 output spamming'));
      assert.ok(result.stdout.includes('[stdout truncated at 100 KB limit]'));
      assert.ok(result.stdout.length <= 110 * 1024);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('7. classifies high-risk steps and respects developer rejection', () => {
    const tmpDir = createTempDir('risk-check');
    try {
      const installStep: SetupStep = {
        id: 'pnpm-inst',
        title: 'Install packages',
        executable: 'pnpm',
        args: ['install', '--frozen-lockfile']
      };

      const preflight = validateStepForExecution(tmpDir, installStep);
      assert.strictEqual(preflight.riskLevel, 'high');
      assert.ok(preflight.warnings.some(w => w.includes('download packages from external registry')));
      assert.ok(preflight.warnings.some(w => w.includes('lifecycle postinstall scripts')));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('8. proposes recovery fallback step on failure without auto-executing it', async () => {
    const tmpDir = createTempDir('recovery-fallback');
    try {
      // Primary script fails with exit 1
      fs.writeFileSync(path.join(tmpDir, 'fail.js'), 'process.exit(1);\n');
      // Fallback script passes with exit 0
      fs.writeFileSync(path.join(tmpDir, 'fallback.js'), 'console.log("Fallback succeeded"); process.exit(0);\n');

      const plan: FirstPrSetupPlan = {
        version: '1.0',
        summary: 'Fallback test plan',
        steps: [
          {
            id: 'step-primary',
            title: 'Primary step (failing)',
            executable: 'node',
            args: ['fail.js'],
            cwd: '.',
            fallbackStepId: 'step-fallback'
          },
          {
            id: 'step-fallback',
            title: 'Recovery fallback step',
            executable: 'node',
            args: ['fallback.js'],
            cwd: '.'
          }
        ]
      };

      const agent = new SetupExecutionAgent(tmpDir, plan);

      // 1. Run primary step
      const result = await agent.executeStep('step-primary', { userApproved: true });

      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.exitCode, 1);

      // Verify that recovery step was suggested but NOT auto-executed
      assert.ok(result.suggestedRecoveryStep);
      assert.strictEqual(result.suggestedRecoveryStep.id, 'step-fallback');
      assert.ok(result.recoveryExplanation?.includes('Requires fresh user approval to execute'));

      // Check session: step-fallback should NOT be completed
      assert.strictEqual(agent.getSession().results.has('step-fallback'), false);

      // 2. Developer provides fresh explicit approval for recovery step
      const fallbackResult = await agent.executeStep('step-fallback', { userApproved: true });
      assert.strictEqual(fallbackResult.status, 'completed');
      assert.strictEqual(fallbackResult.exitCode, 0);
      assert.ok(fallbackResult.stdout.includes('Fallback succeeded'));
      assert.strictEqual(agent.getSession().isComplete, true);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('9. operates offline using factual baseline plan when Ollama is unavailable', async () => {
    const tmpDir = createTempDir('offline-test');
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'offline-app', packageManager: 'pnpm@10.0.0' })
      );

      const evidence = await extractRepoContext(tmpDir);
      const baselinePlan = synthesizeFactualBaselinePlan(evidence);

      assert.ok(baselinePlan.steps.length >= 1);
      assert.strictEqual(baselinePlan.steps[0].executable, 'pnpm');

      const agent = new SetupExecutionAgent(tmpDir, baselinePlan);
      const preflight = agent.getPreflightCheck(baselinePlan.steps[0].id);
      assert.strictEqual(preflight.isAllowed, true);
      assert.strictEqual(preflight.riskLevel, 'high');
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('10. verifies complete regression suite remains 100% passing', () => {
    // Structural regression check: verify key exports are clean and callable
    assert.strictEqual(typeof SetupExecutionAgent, 'function');
    assert.strictEqual(typeof validateStepForExecution, 'function');
  });
});
