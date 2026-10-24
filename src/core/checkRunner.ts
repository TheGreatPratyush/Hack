import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';

export interface RunCheckOptions {
  cwd: string;
  checkType: 'test' | 'build' | 'lint' | 'typecheck' | 'install';
  scriptName?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  allowedScripts?: Record<string, string>;
}

export interface CheckResult {
  checkName: string;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  status: 'passed' | 'failed' | 'cancelled' | 'timed_out' | 'error';
  stdout: string;
  stderr: string;
  durationMs: number;
  explanation: string;
}

const DEFAULT_CHECK_TIMEOUT_MS = 60 * 1000; // 60 seconds
const MAX_STREAM_BUFFER_BYTES = 100 * 1024; // 100 KB

const SCRIPT_NAME_REGEX = /^[a-zA-Z0-9_.:-]+$/;

/**
 * Validates a script name against injection characters.
 */
export function isValidScriptName(scriptName: string): boolean {
  if (!scriptName || typeof scriptName !== 'string') {
    return false;
  }
  return SCRIPT_NAME_REGEX.test(scriptName.trim());
}

/**
 * Executes an approved npm check safely inside cwd using child_process.spawn.
 */
export async function executeCheck(options: RunCheckOptions): Promise<CheckResult> {
  const {
    cwd,
    checkType,
    scriptName,
    signal,
    timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
    onStdout,
    onStderr,
    allowedScripts,
  } = options;

  const startTime = Date.now();

  // Validate working directory
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return {
      checkName: checkType,
      command: 'npm',
      args: [],
      cwd: cwd || '',
      exitCode: null,
      status: 'error',
      stdout: '',
      stderr: `Invalid working directory: "${cwd}". Directory does not exist.`,
      durationMs: 0,
      explanation: 'Execution halted: working directory does not exist.',
    };
  }

  // Determine arguments safely
  let args: string[];
  let checkName: string;

  if (checkType === 'install') {
    checkName = 'install dependencies';
    // Use --ignore-scripts or regular install? Standard npm install, with explicit notice
    args = ['install'];
  } else if (checkType === 'test' && (!scriptName || scriptName === 'test')) {
    checkName = 'test';
    args = ['test'];
  } else {
    const targetScript = scriptName || checkType;
    if (!isValidScriptName(targetScript)) {
      return {
        checkName: targetScript,
        command: 'npm',
        args: [],
        cwd,
        exitCode: null,
        status: 'error',
        stdout: '',
        stderr: `Security rejection: Script name "${targetScript}" contains invalid characters.`,
        durationMs: 0,
        explanation: 'Execution halted: Script name failed safety validation.',
      };
    }

    if (allowedScripts && !allowedScripts[targetScript]) {
      return {
        checkName: targetScript,
        command: 'npm',
        args: [],
        cwd,
        exitCode: null,
        status: 'error',
        stdout: '',
        stderr: `Script "${targetScript}" is not defined in the project's package.json scripts.`,
        durationMs: 0,
        explanation: `Execution halted: Script "${targetScript}" does not exist in package.json.`,
      };
    }

    checkName = targetScript;
    args = ['run', targetScript];
  }

  // Check pre-aborted signal
  if (signal?.aborted) {
    return {
      checkName,
      command: 'npm',
      args,
      cwd,
      exitCode: null,
      status: 'cancelled',
      stdout: '',
      stderr: 'Execution cancelled by user before process spawned.',
      durationMs: 0,
      explanation: 'The check was cancelled before starting.',
    };
  }

  return new Promise<CheckResult>((resolve) => {
    let proc: ChildProcess;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let resolved = false;
    let timer: NodeJS.Timeout | null = null;

    const appendStdout = (chunk: string) => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > MAX_STREAM_BUFFER_BYTES) {
        stdoutBuffer = stdoutBuffer.slice(-MAX_STREAM_BUFFER_BYTES);
      }
      if (onStdout) {
        onStdout(chunk);
      }
    };

    const appendStderr = (chunk: string) => {
      stderrBuffer += chunk;
      if (stderrBuffer.length > MAX_STREAM_BUFFER_BYTES) {
        stderrBuffer = stderrBuffer.slice(-MAX_STREAM_BUFFER_BYTES);
      }
      if (onStderr) {
        onStderr(chunk);
      }
    };

    const killProcess = (sig: NodeJS.Signals = 'SIGTERM') => {
      if (proc && !proc.killed) {
        try {
          proc.kill(sig);
        } catch {
          // ignore
        }
      }
    };

    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;

    try {
      proc = spawn('npm', args, {
        cwd,
        env: cleanEnv,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return resolve({
        checkName,
        command: 'npm',
        args,
        cwd,
        exitCode: null,
        status: 'error',
        stdout: '',
        stderr: `Failed to spawn npm process: ${msg}`,
        durationMs: Date.now() - startTime,
        explanation: `Unable to spawn process: ${msg}`,
      });
    }

    const abortHandler = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (timer) {
        clearTimeout(timer);
      }
      killProcess('SIGTERM');
      setTimeout(() => killProcess('SIGKILL'), 500);

      resolve({
        checkName,
        command: 'npm',
        args,
        cwd,
        exitCode: null,
        status: 'cancelled',
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        durationMs: Date.now() - startTime,
        explanation: 'Check execution was cancelled by user.',
      });
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    timer = setTimeout(() => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
      killProcess('SIGTERM');
      setTimeout(() => killProcess('SIGKILL'), 500);

      resolve({
        checkName,
        command: 'npm',
        args,
        cwd,
        exitCode: null,
        status: 'timed_out',
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        durationMs: Date.now() - startTime,
        explanation: `Check timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
      });
    }, timeoutMs);

    proc.stdout?.on('data', (data) => {
      appendStdout(data.toString());
    });

    proc.stderr?.on('data', (data) => {
      appendStderr(data.toString());
    });

    proc.on('error', (err) => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }

      resolve({
        checkName,
        command: 'npm',
        args,
        cwd,
        exitCode: null,
        status: 'error',
        stdout: stdoutBuffer,
        stderr: stderrBuffer + (stderrBuffer ? '\n' : '') + err.message,
        durationMs: Date.now() - startTime,
        explanation: `Execution failed with system error: ${err.message}`,
      });
    });

    proc.on('close', (code) => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }

      const durationMs = Date.now() - startTime;

      if (code === 0) {
        resolve({
          checkName,
          command: 'npm',
          args,
          cwd,
          exitCode: 0,
          status: 'passed',
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          durationMs,
          explanation: `Command "npm ${args.join(' ')}" completed successfully (exit code 0). Note: Passing checks indicate the test suite ran without error, but do not guarantee absence of other bugs.`,
        });
      } else {
        resolve({
          checkName,
          command: 'npm',
          args,
          cwd,
          exitCode: code,
          status: 'failed',
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          durationMs,
          explanation: `Command "npm ${args.join(' ')}" failed with exit code ${code}. Check the output below for error details.`,
        });
      }
    });
  });
}
