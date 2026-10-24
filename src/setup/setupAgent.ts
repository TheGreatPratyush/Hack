import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FirstPrSetupPlan, SetupStep } from '../llm';
import {
  SetupExecutionSession,
  StepExecutionResult,
  StepPreflightCheck,
  StepRiskLevel
} from './types';

const MAX_STREAM_BUFFER_BYTES = 100 * 1024; // 100 KB per stream
const DEFAULT_TIMEOUT_MS = 180 * 1000; // 180 seconds

// Forbidden destructive or dangerous binaries
const FORBIDDEN_BINARIES = new Set([
  'rm',
  'unlink',
  'mkfs',
  'dd',
  'fdisk',
  'shutdown',
  'reboot',
  'poweroff',
  'wget',
  'curl',
  'chmod',
  'chown',
  'sudo',
  'su',
  'useradd',
  'userdel',
  'crontab',
  'iptables',
  'systemctl',
  'launchctl',
  'nc',
  'netcat',
  'eval'
]);

// Prohibited shell wrappers that can evaluate arbitrary shell scripts
const FORBIDDEN_SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'ksh', 'csh', 'fish']);

// Shell metacharacters regex
const SHELL_METACHARS_REGEX = /[;&|<>$`\n\r]/;

export interface ExecuteStepOptions {
  userApproved: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (data: string) => void;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

/**
 * Validates a single setup step against security policies and directory containment.
 */
export function validateStepForExecution(repoRoot: string, step: SetupStep): StepPreflightCheck {
  const warnings: string[] = [];
  const stepId = step.id;
  const executable = step.executable.trim();
  const args = step.args || [];

  // 1. Verify executable against shell injection
  if (SHELL_METACHARS_REGEX.test(executable)) {
    return {
      stepId,
      executable,
      args,
      resolvedCwd: repoRoot,
      riskLevel: 'critical_rejected',
      warnings,
      isAllowed: false,
      rejectionReason: `Executable contains forbidden shell metacharacters: '${executable}'`
    };
  }

  // 2. Verify executable against blacklist
  const baseExec = path.basename(executable).toLowerCase();
  if (FORBIDDEN_BINARIES.has(baseExec)) {
    return {
      stepId,
      executable,
      args,
      resolvedCwd: repoRoot,
      riskLevel: 'critical_rejected',
      warnings,
      isAllowed: false,
      rejectionReason: `Executable '${baseExec}' is classified as dangerous or destructive and cannot be executed.`
    };
  }

  // 3. Prohibit direct raw shell interpreters executing scripts
  if (FORBIDDEN_SHELL_WRAPPERS.has(baseExec)) {
    return {
      stepId,
      executable,
      args,
      resolvedCwd: repoRoot,
      riskLevel: 'critical_rejected',
      warnings,
      isAllowed: false,
      rejectionReason: `Invoking shell interpreter '${baseExec}' directly is prohibited. Execute project tools directly without shell wrappers.`
    };
  }

  // 4. Prohibit arbitrary inline code evaluation
  if (
    (baseExec === 'node' && args.includes('-e')) ||
    ((baseExec === 'python' || baseExec === 'python3') && args.includes('-c'))
  ) {
    return {
      stepId,
      executable,
      args,
      resolvedCwd: repoRoot,
      riskLevel: 'critical_rejected',
      warnings,
      isAllowed: false,
      rejectionReason: `Inline arbitrary code execution (-e / -c) with '${baseExec}' is prohibited.`
    };
  }

  // 5. Working directory resolution and symlink escape verification
  let realRepo: string;
  try {
    realRepo = fs.realpathSync(path.resolve(repoRoot));
  } catch (err: unknown) {
    return {
      stepId,
      executable,
      args,
      resolvedCwd: repoRoot,
      riskLevel: 'critical_rejected',
      warnings,
      isAllowed: false,
      rejectionReason: `Repository root does not exist or cannot be resolved: ${repoRoot}`
    };
  }

  const relativeCwd = step.cwd && step.cwd.trim() ? step.cwd.trim() : '.';
  const targetDir = path.resolve(realRepo, relativeCwd);

  if (!fs.existsSync(targetDir)) {
    return {
      stepId,
      executable,
      args,
      resolvedCwd: targetDir,
      riskLevel: 'critical_rejected',
      warnings,
      isAllowed: false,
      rejectionReason: `Working directory does not exist: '${relativeCwd}' (resolved to ${targetDir})`
    };
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(targetDir);
  } catch (err: unknown) {
    return {
      stepId,
      executable,
      args,
      resolvedCwd: targetDir,
      riskLevel: 'critical_rejected',
      warnings,
      isAllowed: false,
      rejectionReason: `Failed to resolve real path for working directory: ${targetDir}`
    };
  }

  // Check that realTarget is within realRepo
  const isContained = realTarget === realRepo || realTarget.startsWith(realRepo + path.sep);
  if (!isContained) {
    return {
      stepId,
      executable,
      args,
      resolvedCwd: realTarget,
      riskLevel: 'critical_rejected',
      warnings,
      isAllowed: false,
      rejectionReason: `Working directory '${relativeCwd}' escapes repository root via symlink or directory traversal.`
    };
  }

  // 6. Risk classification
  let riskLevel: StepRiskLevel = 'medium';

  const isInstallCmd =
    (['npm', 'pnpm', 'yarn', 'bun'].includes(baseExec) && args.some(a => ['install', 'i', 'add', 'ci'].includes(a))) ||
    (['pip', 'pip3', 'poetry'].includes(baseExec) && args.some(a => ['install', 'add'].includes(a))) ||
    (baseExec === 'bundle' && args.some(a => ['install', 'update'].includes(a)));

  const isBuildAutomation = ['make', 'cmake', 'ninja'].includes(baseExec);

  if (isInstallCmd) {
    riskLevel = 'high';
    warnings.push(
      `Package manager '${baseExec}' will download packages from external registry and may execute lifecycle postinstall scripts.`
    );
  } else if (isBuildAutomation) {
    riskLevel = 'high';
    warnings.push(`Build tool '${baseExec}' executes target recipes defined in repository makefiles.`);
  } else if (args.some(a => ['--version', '-v', 'status', 'list', 'check'].includes(a))) {
    riskLevel = 'low';
  }

  return {
    stepId,
    executable,
    args,
    resolvedCwd: realTarget,
    riskLevel,
    warnings,
    isAllowed: true
  };
}

/**
 * SetupExecutionAgent coordinates safe step-by-step repository onboarding execution.
 */
export class SetupExecutionAgent {
  private readonly repoRoot: string;
  private readonly plan: FirstPrSetupPlan;
  private readonly session: SetupExecutionSession;

  constructor(repoRoot: string, plan: FirstPrSetupPlan) {
    this.repoRoot = path.resolve(repoRoot);
    this.plan = plan;
    this.session = {
      repositoryRoot: this.repoRoot,
      plan: this.plan,
      results: new Map<string, StepExecutionResult>(),
      isComplete: false
    };
  }

  public getPlan(): FirstPrSetupPlan {
    return this.plan;
  }

  public getSession(): SetupExecutionSession {
    return this.session;
  }

  public getPreflightCheck(stepId: string): StepPreflightCheck {
    const step = this.findStep(stepId);
    if (!step) {
      return {
        stepId,
        executable: '',
        args: [],
        resolvedCwd: this.repoRoot,
        riskLevel: 'critical_rejected',
        warnings: [],
        isAllowed: false,
        rejectionReason: `Step '${stepId}' not found in setup plan.`
      };
    }
    return validateStepForExecution(this.repoRoot, step);
  }

  private findStep(stepId: string): SetupStep | undefined {
    return (
      this.plan.steps.find(s => s.id === stepId) ||
      (this.plan.verificationSteps && this.plan.verificationSteps.find(s => s.id === stepId))
    );
  }

  /**
   * Executes a single setup step with explicit user approval gating, bounded output, timeouts, and recovery suggestions.
   */
  public async executeStep(
    stepId: string,
    options: ExecuteStepOptions
  ): Promise<StepExecutionResult> {
    const step = this.findStep(stepId);
    if (!step) {
      const result: StepExecutionResult = {
        stepId,
        title: 'Unknown step',
        executable: '',
        args: [],
        cwd: this.repoRoot,
        status: 'error',
        exitCode: null,
        stdout: '',
        stderr: `Step '${stepId}' was not found in setup plan.`,
        durationMs: 0,
        explanation: 'Step missing from plan.'
      };
      this.session.results.set(stepId, result);
      return result;
    }

    // 1. Explicit user approval requirement
    if (!options.userApproved) {
      const result: StepExecutionResult = {
        stepId,
        title: step.title,
        executable: step.executable,
        args: step.args,
        cwd: step.cwd || '.',
        status: 'rejected',
        exitCode: null,
        stdout: '',
        stderr: 'User did not approve execution of this step.',
        durationMs: 0,
        explanation: 'Step was skipped or rejected by the developer.'
      };
      this.session.results.set(stepId, result);
      return result;
    }

    // 2. Pre-flight security validation
    const preflight = validateStepForExecution(this.repoRoot, step);
    if (!preflight.isAllowed) {
      const result: StepExecutionResult = {
        stepId,
        title: step.title,
        executable: step.executable,
        args: step.args,
        cwd: step.cwd || '.',
        status: 'error',
        exitCode: null,
        stdout: '',
        stderr: preflight.rejectionReason || 'Step rejected by security policy.',
        durationMs: 0,
        explanation: `Execution rejected: ${preflight.rejectionReason}`
      };
      this.session.results.set(stepId, result);
      return result;
    }

    // 3. Execute process safely with spawn (shell: false)
    const timeoutMs = options.timeoutMs || (step.timeoutSeconds ? step.timeoutSeconds * 1000 : DEFAULT_TIMEOUT_MS);
    const startTime = Date.now();

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let isStdoutTruncated = false;
    let isStderrTruncated = false;
    let isTimedOut = false;
    let isCancelled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let childProc: ChildProcess | null = null;

    const abortHandler = () => {
      isCancelled = true;
      if (childProc) {
        killProcessTree(childProc);
      }
    };

    if (options.signal) {
      if (options.signal.aborted) {
        const result: StepExecutionResult = {
          stepId,
          title: step.title,
          executable: step.executable,
          args: step.args,
          cwd: preflight.resolvedCwd,
          status: 'cancelled',
          exitCode: null,
          stdout: '',
          stderr: 'Operation was cancelled before execution started.',
          durationMs: 0,
          explanation: 'Step execution cancelled.'
        };
        this.session.results.set(stepId, result);
        return result;
      }
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const execPromise = new Promise<{ exitCode: number | null }>((resolve) => {
      try {
        childProc = spawn(step.executable, step.args, {
          cwd: preflight.resolvedCwd,
          shell: false,
          env: {
            ...process.env,
            ...(step.env || {})
          }
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        stderrBuffer = `Failed to spawn process '${step.executable}': ${msg}`;
        resolve({ exitCode: 1 });
        return;
      }

      timeoutHandle = setTimeout(() => {
        isTimedOut = true;
        if (childProc) {
          killProcessTree(childProc);
        }
      }, timeoutMs);

      if (childProc.stdout) {
        childProc.stdout.on('data', (chunk: Buffer) => {
          const str = chunk.toString();
          if (options.onProgress) {
            options.onProgress(str);
          }
          if (options.onStdout) {
            options.onStdout(str);
          }
          if (stdoutBuffer.length + str.length <= MAX_STREAM_BUFFER_BYTES) {
            stdoutBuffer += str;
          } else if (!isStdoutTruncated) {
            const remaining = MAX_STREAM_BUFFER_BYTES - stdoutBuffer.length;
            if (remaining > 0) {
              stdoutBuffer += str.slice(0, remaining);
            }
            stdoutBuffer += '\n... [stdout truncated at 100 KB limit]';
            isStdoutTruncated = true;
          }
        });
      }

      if (childProc.stderr) {
        childProc.stderr.on('data', (chunk: Buffer) => {
          const str = chunk.toString();
          if (options.onProgress) {
            options.onProgress(str);
          }
          if (options.onStderr) {
            options.onStderr(str);
          }
          if (stderrBuffer.length + str.length <= MAX_STREAM_BUFFER_BYTES) {
            stderrBuffer += str;
          } else if (!isStderrTruncated) {
            const remaining = MAX_STREAM_BUFFER_BYTES - stderrBuffer.length;
            if (remaining > 0) {
              stderrBuffer += str.slice(0, remaining);
            }
            stderrBuffer += '\n... [stderr truncated at 100 KB limit]';
            isStderrTruncated = true;
          }
        });
      }

      childProc.on('error', (err: Error) => {
        stderrBuffer += `\nProcess error: ${err.message}`;
        resolve({ exitCode: 1 });
      });

      childProc.on('close', (code: number | null) => {
        resolve({ exitCode: code });
      });
    });

    const { exitCode } = await execPromise;
    const durationMs = Date.now() - startTime;

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }

    let status: StepExecutionResult['status'] = 'completed';
    let explanation = `Step completed successfully with exit code 0.`;
    let suggestedRecoveryStep: SetupStep | undefined = undefined;
    let recoveryExplanation: string | undefined = undefined;

    if (isCancelled) {
      status = 'cancelled';
      explanation = 'Execution was cancelled by the developer.';
    } else if (isTimedOut) {
      status = 'timed_out';
      explanation = `Execution exceeded timeout of ${timeoutMs / 1000}s and was terminated.`;
    } else if (exitCode !== 0) {
      status = 'failed';
      explanation = `Command exited with non-zero code ${exitCode}.`;

      // Check if plan offers a fallback step
      if (step.fallbackStepId) {
        const fallback = this.findStep(step.fallbackStepId);
        if (fallback) {
          // Re-validate the fallback step
          const fallbackPreflight = validateStepForExecution(this.repoRoot, fallback);
          if (fallbackPreflight.isAllowed) {
            suggestedRecoveryStep = fallback;
            recoveryExplanation = `Primary step failed. Proposed fallback step: '${fallback.title}' (${fallback.executable} ${fallback.args.join(' ')}). Requires fresh user approval to execute.`;
          }
        }
      }
    }

    const result: StepExecutionResult = {
      stepId,
      title: step.title,
      executable: step.executable,
      args: step.args,
      cwd: preflight.resolvedCwd,
      status,
      exitCode,
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      durationMs,
      explanation,
      ...(suggestedRecoveryStep ? { suggestedRecoveryStep } : {}),
      ...(recoveryExplanation ? { recoveryExplanation } : {})
    };

    this.session.results.set(stepId, result);

    // Update overall session completion state
    // A step is considered satisfied if it completed, or if its fallback completed
    this.session.isComplete = this.plan.steps.every(s => {
      const res = this.session.results.get(s.id);
      if (res && res.status === 'completed') {
        return true;
      }
      if (s.fallbackStepId) {
        const fallbackRes = this.session.results.get(s.fallbackStepId);
        if (fallbackRes && fallbackRes.status === 'completed') {
          return true;
        }
      }
      return false;
    });

    return result;
  }
}

/**
 * Gracefully terminates a child process.
 */
function killProcessTree(proc: ChildProcess): void {
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      try {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch {
        // Ignored
      }
    }, 2000);
  } catch {
    // Ignored
  }
}
