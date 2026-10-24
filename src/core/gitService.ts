import { spawn, ChildProcess } from 'child_process';
import { cleanupIncompleteDirectory } from './workspaceManager';

export interface GitAvailability {
  available: boolean;
  version?: string;
  error?: string;
}

export interface CloneOptions {
  url: string;
  destPath: string;
  onProgress?: (stageMessage: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CloneResult {
  success: boolean;
  destPath: string;
  output: string;
}

const DEFAULT_CLONE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OUTPUT_BUFFER_BYTES = 100 * 1024; // 100 KB

/**
 * Checks whether Git is installed and available in the system PATH.
 */
export async function checkGitAvailable(): Promise<GitAvailability> {
  return new Promise((resolve) => {
    let resolved = false;
    let stdout = '';
    let stderr = '';

    const proc = spawn('git', ['--version'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve({
          available: false,
          error: 'Git availability check timed out after 5 seconds.',
        });
      }
    }, 5000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          available: false,
          error: `Git is not installed or not found in PATH: ${err.message}`,
        });
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        if (code === 0 && stdout.trim().length > 0) {
          resolve({
            available: true,
            version: stdout.trim(),
          });
        } else {
          resolve({
            available: false,
            error: stderr.trim() || `Git returned non-zero exit code (${code}).`,
          });
        }
      }
    });
  });
}

/**
 * Extracts a concise human-readable progress string from Git clone stderr stream.
 */
export function parseGitProgress(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  // Common Git progress messages:
  // "remote: Counting objects:  85% (17/20)"
  // "remote: Compressing objects: 100% (12/12)"
  // "Receiving objects:  45% (45/100), 12.00 KiB | 24.00 KiB/s"
  // "Resolving deltas: 100% (2/2)"
  // "Cloning into '...'..."
  if (trimmed.startsWith('remote: Counting objects:')) {
    return trimmed.replace('remote: ', '');
  }
  if (trimmed.startsWith('remote: Compressing objects:')) {
    return trimmed.replace('remote: ', '');
  }
  if (trimmed.startsWith('Receiving objects:')) {
    return trimmed;
  }
  if (trimmed.startsWith('Resolving deltas:')) {
    return trimmed;
  }
  if (trimmed.startsWith('Cloning into')) {
    return 'Initializing Git clone...';
  }
  return null;
}

/**
 * Clones a public Git repository into destPath safely using child_process.spawn.
 */
export async function cloneRepository(options: CloneOptions): Promise<CloneResult> {
  const { url, destPath, onProgress, signal, timeoutMs = DEFAULT_CLONE_TIMEOUT_MS } = options;

  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    let outputBuffer = '';
    let isTerminated = false;
    let timer: NodeJS.Timeout | null = null;

    const appendOutput = (text: string) => {
      outputBuffer += text;
      if (outputBuffer.length > MAX_OUTPUT_BUFFER_BYTES) {
        outputBuffer = outputBuffer.slice(-MAX_OUTPUT_BUFFER_BYTES);
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

    // Check cancellation before spawning
    if (signal?.aborted) {
      cleanupIncompleteDirectory(destPath);
      return reject(new Error('Clone cancelled by user before starting.'));
    }

    try {
      proc = spawn('git', ['clone', '--progress', url, destPath], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      cleanupIncompleteDirectory(destPath);
      const msg = err instanceof Error ? err.message : String(err);
      return reject(new Error(`Failed to spawn git process: ${msg}`));
    }

    // Abort handler
    const abortListener = () => {
      isTerminated = true;
      if (timer) {
        clearTimeout(timer);
      }
      killProcess('SIGTERM');
      setTimeout(() => killProcess('SIGKILL'), 500);
      cleanupIncompleteDirectory(destPath);
      reject(new Error('Clone operation was cancelled.'));
    };

    if (signal) {
      signal.addEventListener('abort', abortListener, { once: true });
    }

    // Timeout handler
    timer = setTimeout(() => {
      isTerminated = true;
      killProcess('SIGTERM');
      setTimeout(() => killProcess('SIGKILL'), 500);
      cleanupIncompleteDirectory(destPath);
      reject(new Error(`Clone operation timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);

    proc.stdout?.on('data', (data) => {
      const text = data.toString();
      appendOutput(text);
    });

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      appendOutput(text);

      // Git outputs progress updates to stderr
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        const parsed = parseGitProgress(line);
        if (parsed && onProgress) {
          onProgress(parsed);
        }
      }
    });

    proc.on('error', (err) => {
      if (isTerminated) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }
      cleanupIncompleteDirectory(destPath);
      reject(new Error(`Git execution failed: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (isTerminated) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }

      if (code === 0) {
        resolve({
          success: true,
          destPath,
          output: outputBuffer,
        });
      } else {
        // Safe cleanup of incomplete directory created by this failed clone
        cleanupIncompleteDirectory(destPath);

        let userFriendlyError = 'Git clone failed.';
        if (/Repository not found/i.test(outputBuffer)) {
          userFriendlyError = 'Repository not found or is private. Only public repositories can be cloned.';
        } else if (/Could not resolve host/i.test(outputBuffer) || /Connection refused/i.test(outputBuffer)) {
          userFriendlyError = 'Network error: Unable to connect to GitHub. Please check your internet connection.';
        } else if (/Permission denied/i.test(outputBuffer)) {
          userFriendlyError = 'Permission denied while accessing destination or repository.';
        } else if (/already exists and is not an empty directory/i.test(outputBuffer)) {
          userFriendlyError = 'Destination directory already exists and is not empty.';
        } else if (outputBuffer.trim()) {
          userFriendlyError = `Git clone failed (exit code ${code}): ${outputBuffer.trim().split('\n').pop()}`;
        }

        reject(new Error(userFriendlyError));
      }
    });
  });
}
