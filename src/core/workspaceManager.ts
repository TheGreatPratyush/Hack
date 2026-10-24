import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export interface DestinationCheck {
  exists: boolean;
  isValidGitRepo: boolean;
  path: string;
}

/**
 * Returns the default base directory for FirstPR repositories: ~/FirstPR/repositories
 */
export function getFirstPrWorkspaceRoot(customHome?: string): string {
  const home = customHome || os.homedir();
  return path.join(home, 'FirstPR', 'repositories');
}

/**
 * Sanitizes owner and repo names to prevent path traversal or invalid directory characters.
 */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/**
 * Derives a safe destination directory path for a repository under the workspace root.
 * Ensures the destination remains strictly within the FirstPR workspace root.
 */
export function getRepoDestination(owner: string, repo: string, customRoot?: string): string {
  const root = customRoot || getFirstPrWorkspaceRoot();
  const safeOwner = sanitizeName(owner);
  const safeRepo = sanitizeName(repo);
  const dirName = `${safeOwner}-${safeRepo}`;
  const targetPath = path.resolve(root, dirName);

  // Path traversal guard
  const relative = path.relative(root, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Security Error: Computed repository path is outside the FirstPR workspace root.');
  }

  return targetPath;
}

/**
 * Checks if the destination directory exists and whether it contains a valid Git repository.
 */
export function checkDestination(destPath: string): DestinationCheck {
  try {
    if (!fs.existsSync(destPath)) {
      return { exists: false, isValidGitRepo: false, path: destPath };
    }

    const stat = fs.statSync(destPath);
    if (!stat.isDirectory()) {
      return { exists: true, isValidGitRepo: false, path: destPath };
    }

    const gitDir = path.join(destPath, '.git');
    const isGit = fs.existsSync(gitDir) && (fs.statSync(gitDir).isDirectory() || fs.statSync(gitDir).isFile());

    return {
      exists: true,
      isValidGitRepo: isGit,
      path: destPath,
    };
  } catch {
    return { exists: false, isValidGitRepo: false, path: destPath };
  }
}

/**
 * Ensures the parent directory for the destination exists safely.
 */
export function ensureParentDirectory(destPath: string): void {
  const parent = path.dirname(destPath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  }
}

/**
 * Cleans up an incomplete clone directory safely.
 * Only removes if it exists and strictly within the workspace root.
 */
export function cleanupIncompleteDirectory(destPath: string, workspaceRoot?: string): boolean {
  if (!destPath || typeof destPath !== 'string') {
    return false;
  }
  const root = workspaceRoot || getFirstPrWorkspaceRoot();
  const resolved = path.resolve(destPath);
  const resolvedRoot = path.resolve(root);

  // Refuse to delete anything outside or equal to workspace root
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  try {
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
