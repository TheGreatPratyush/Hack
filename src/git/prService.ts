import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface GitPreflightCheck {
  isGitRepo: boolean;
  currentBranch: string;
  isDetached: boolean;
  hasUnrelatedChanges: boolean;
  unrelatedFiles: string[];
  allowedModifiedFiles: string[];
  cleanForCommit: boolean;
  error?: string;
}

export interface BranchCreationResult {
  success: boolean;
  branchName: string;
  previousBranch?: string;
  alreadyExisted?: boolean;
  error?: string;
}

export interface CommitResult {
  success: boolean;
  commitHash?: string;
  shortHash?: string;
  branch?: string;
  stagedFiles: string[];
  commitMessage: {
    title: string;
    body: string;
  };
  error?: string;
}

export interface PullRequestDetails {
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  compareUrl: string;
}

export interface GhCliStatus {
  installed: boolean;
  authenticated: boolean;
  account?: string;
  error?: string;
}

export interface GhPrCreateResult {
  success: boolean;
  url?: string;
  error?: string;
}

/**
 * Executes a Git command safely using strict argument array and no shell.
 */
export async function runGit(
  args: string[],
  cwd: string,
  timeoutMs = 15000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    // Strip recursive test context to protect subtests
    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;

    const proc = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve({
          code: 124,
          stdout,
          stderr: (stderr + '\nCommand timed out').trim(),
        });
      }
    }, timeoutMs);

    proc.stdout.on('data', (c) => {
      stdout += c.toString();
    });

    proc.stderr.on('data', (c) => {
      stderr += c.toString();
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          code: 1,
          stdout,
          stderr: `Failed to execute git: ${err.message}`,
        });
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          stdout: stdout.replace(/^[\r\n]+|[\r\n]+$/g, ''),
          stderr: stderr.replace(/^[\r\n]+|[\r\n]+$/g, ''),
        });
      }
    });
  });
}

/**
 * Sanitizes an issue or fix title into a safe branch slug.
 */
export function sanitizeBranchSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'fix-issue';
}

/**
 * Validates a Git branch name for safety and git-ref compliance.
 */
export function isValidBranchName(branchName: string): boolean {
  if (!branchName || typeof branchName !== 'string') {
    return false;
  }
  const trimmed = branchName.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    return false;
  }
  // Disallow control characters and spaces
  if (/[\x00-\x1F\x7F\s]/.test(trimmed)) {
    return false;
  }
  // Disallow forbidden git ref symbols: ~ ^ : ? * [ \ @{ ..
  if (/[~^:?*\[\\@]/.test(trimmed)) {
    return false;
  }
  if (trimmed.includes('..') || trimmed.includes('@{')) {
    return false;
  }
  // Disallow starting or ending with / or . or ending with .lock
  if (trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.startsWith('.') || trimmed.endsWith('.')) {
    return false;
  }
  if (trimmed.endsWith('.lock')) {
    return false;
  }
  // Safe characters only: a-zA-Z0-9, dash, underscore, slash, dot
  return /^[a-zA-Z0-9_./-]+$/.test(trimmed);
}

/**
 * Constructs a FirstPR branch name given a slug.
 */
export function buildBranchName(slug: string): string {
  const clean = sanitizeBranchSlug(slug);
  return `firstpr/${clean}`;
}

/**
 * Runs preflight inspection on the target repository.
 * Detects whether the repository is clean, current branch, and flags unrelated changes.
 */
export async function preflightTargetRepo(
  repoPath: string,
  allowedFiles: string[] = []
): Promise<GitPreflightCheck> {
  if (!fs.existsSync(repoPath)) {
    return {
      isGitRepo: false,
      currentBranch: '',
      isDetached: false,
      hasUnrelatedChanges: false,
      unrelatedFiles: [],
      allowedModifiedFiles: [],
      cleanForCommit: false,
      error: `Directory does not exist: ${repoPath}`,
    };
  }

  // 1. Verify it is inside a Git work tree
  const checkTree = await runGit(['rev-parse', '--is-inside-work-tree'], repoPath);
  if (checkTree.code !== 0 || checkTree.stdout !== 'true') {
    return {
      isGitRepo: false,
      currentBranch: '',
      isDetached: false,
      hasUnrelatedChanges: false,
      unrelatedFiles: [],
      allowedModifiedFiles: [],
      cleanForCommit: false,
      error: 'Target folder is not a valid Git repository.',
    };
  }

  // 2. Determine current branch and detached HEAD status
  let currentBranch = '';
  let isDetached = false;
  const branchCheck = await runGit(['symbolic-ref', '--short', 'HEAD'], repoPath);
  if (branchCheck.code === 0 && branchCheck.stdout) {
    currentBranch = branchCheck.stdout;
  } else {
    // Possibly detached HEAD
    const headHash = await runGit(['rev-parse', '--short', 'HEAD'], repoPath);
    currentBranch = headHash.stdout || 'HEAD';
    isDetached = true;
  }

  // 3. Inspect git status for uncommitted changes
  const statusRes = await runGit(['status', '--porcelain'], repoPath);
  if (statusRes.code !== 0) {
    return {
      isGitRepo: true,
      currentBranch,
      isDetached,
      hasUnrelatedChanges: false,
      unrelatedFiles: [],
      allowedModifiedFiles: [],
      cleanForCommit: false,
      error: `Failed to inspect git status: ${statusRes.stderr}`,
    };
  }

  const normalizedAllowed = allowedFiles.map((f) => path.normalize(f).replace(/\\/g, '/'));
  const unrelatedFiles: string[] = [];
  const allowedModifiedFiles: string[] = [];

  const lines = statusRes.stdout.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    // Line format: XY <path> or XY <orig> -> <dest>
    const match = line.match(/^[ MADRCU?!]{1,2}\s+(.*)$/);
    let filePath = match ? match[1].trim() : line.slice(3).trim();
    if (filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ')[1].trim();
    }
    // Remove quotes if present
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }
    const normalizedPath = path.normalize(filePath).replace(/\\/g, '/');

    const isAllowed = normalizedAllowed.some(
      (allowed) => normalizedPath === allowed || normalizedPath.endsWith('/' + allowed)
    );

    if (isAllowed) {
      if (!allowedModifiedFiles.includes(normalizedPath)) {
        allowedModifiedFiles.push(normalizedPath);
      }
    } else {
      if (!unrelatedFiles.includes(normalizedPath)) {
        unrelatedFiles.push(normalizedPath);
      }
    }
  }

  const hasUnrelatedChanges = unrelatedFiles.length > 0;
  const cleanForCommit = !hasUnrelatedChanges && allowedModifiedFiles.length > 0;

  return {
    isGitRepo: true,
    currentBranch,
    isDetached,
    hasUnrelatedChanges,
    unrelatedFiles,
    allowedModifiedFiles,
    cleanForCommit,
  };
}

/**
 * Creates and checks out a dedicated FirstPR branch safely in the target repository.
 */
export async function createAndCheckoutBranch(
  repoPath: string,
  branchName: string
): Promise<BranchCreationResult> {
  if (!isValidBranchName(branchName)) {
    return {
      success: false,
      branchName,
      error: `Invalid branch name "${branchName}". Branch names must not contain forbidden characters.`,
    };
  }

  // Check current branch
  const pre = await preflightTargetRepo(repoPath);
  if (!pre.isGitRepo) {
    return {
      success: false,
      branchName,
      error: pre.error || 'Target directory is not a Git repository.',
    };
  }

  if (pre.currentBranch === branchName) {
    return {
      success: true,
      branchName,
      previousBranch: pre.currentBranch,
      alreadyExisted: true,
    };
  }

  // Check if branch already exists locally
  const checkExists = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], repoPath);
  const branchExists = checkExists.code === 0;

  if (branchExists) {
    // Switch to existing branch safely
    const switchRes = await runGit(['checkout', branchName], repoPath);
    if (switchRes.code !== 0) {
      return {
        success: false,
        branchName,
        previousBranch: pre.currentBranch,
        error: `Could not switch to existing branch "${branchName}": ${switchRes.stderr}`,
      };
    }
    return {
      success: true,
      branchName,
      previousBranch: pre.currentBranch,
      alreadyExisted: true,
    };
  }

  // Create and switch to new branch
  const createRes = await runGit(['checkout', '-b', branchName], repoPath);
  if (createRes.code !== 0) {
    return {
      success: false,
      branchName,
      previousBranch: pre.currentBranch,
      error: `Failed to create branch "${branchName}": ${createRes.stderr}`,
    };
  }

  return {
    success: true,
    branchName,
    previousBranch: pre.currentBranch,
    alreadyExisted: false,
  };
}

/**
 * Stages ONLY the explicitly specified files, verifies staged changes, and creates a git commit.
 * Strictly guarantees no unrelated files are committed.
 */
export async function commitVerifiedFix(
  repoPath: string,
  filesToStage: string[],
  commitMessage: { title: string; body: string }
): Promise<CommitResult> {
  if (!filesToStage || filesToStage.length === 0) {
    return {
      success: false,
      stagedFiles: [],
      commitMessage,
      error: 'No files specified to stage.',
    };
  }

  // 1. Verify all files are within repository path (traversal guard)
  const resolvedRepo = path.resolve(repoPath);
  for (const relFile of filesToStage) {
    const absPath = path.resolve(resolvedRepo, relFile);
    const rel = path.relative(resolvedRepo, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return {
        success: false,
        stagedFiles: [],
        commitMessage,
        error: `Security error: File "${relFile}" resolves outside target repository.`,
      };
    }
  }

  // 2. Stage only the specified files using explicit paths
  for (const relFile of filesToStage) {
    const addRes = await runGit(['add', '--', relFile], repoPath);
    if (addRes.code !== 0) {
      return {
        success: false,
        stagedFiles: [],
        commitMessage,
        error: `Failed to stage "${relFile}": ${addRes.stderr}`,
      };
    }
  }

  // 3. Verify staged diff - ensure NOTHING else is staged
  const diffCached = await runGit(['diff', '--cached', '--name-only'], repoPath);
  if (diffCached.code !== 0) {
    return {
      success: false,
      stagedFiles: [],
      commitMessage,
      error: `Failed to inspect staged changes: ${diffCached.stderr}`,
    };
  }

  const actuallyStaged = diffCached.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((f) => path.normalize(f).replace(/\\/g, '/'));

  if (actuallyStaged.length === 0) {
    return {
      success: false,
      stagedFiles: [],
      commitMessage,
      error: 'No changes staged to commit.',
    };
  }

  const normalizedAllowed = filesToStage.map((f) => path.normalize(f).replace(/\\/g, '/'));
  const unexpectedStaged = actuallyStaged.filter((f) => !normalizedAllowed.includes(f));

  if (unexpectedStaged.length > 0) {
    // Unstage to protect repository integrity
    await runGit(['reset', 'HEAD', '--', ...unexpectedStaged], repoPath);
    return {
      success: false,
      stagedFiles: actuallyStaged,
      commitMessage,
      error: `Safety abort: Unexpected files were staged (${unexpectedStaged.join(', ')}). Aborted commit to prevent accidental changes.`,
    };
  }

  // 4. Commit with title and body
  const combinedMessage = `${commitMessage.title.trim()}\n\n${commitMessage.body.trim()}`;
  const commitRes = await runGit(['commit', '-m', combinedMessage], repoPath);

  if (commitRes.code !== 0) {
    let errorMsg = commitRes.stderr || commitRes.stdout;
    if (errorMsg.includes('Please tell me who you are') || errorMsg.includes('user.name')) {
      errorMsg =
        'Git user identity not configured in target repository. Please run "git config user.name" and "git config user.email" before committing.';
    }
    return {
      success: false,
      stagedFiles: actuallyStaged,
      commitMessage,
      error: errorMsg,
    };
  }

  // 5. Query commit hash and branch
  const revRes = await runGit(['rev-parse', 'HEAD'], repoPath);
  const shortRes = await runGit(['rev-parse', '--short', 'HEAD'], repoPath);
  const branchRes = await runGit(['symbolic-ref', '--short', 'HEAD'], repoPath);

  return {
    success: true,
    commitHash: revRes.stdout || undefined,
    shortHash: shortRes.stdout || undefined,
    branch: branchRes.stdout || undefined,
    stagedFiles: actuallyStaged,
    commitMessage,
  };
}

/**
 * Extracts owner and repository name from GitHub HTTP or SSH URLs.
 */
export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  if (!repoUrl || typeof repoUrl !== 'string') {
    return null;
  }
  const trimmed = repoUrl.trim();
  // HTTPS format: https://github.com/owner/repo(.git)?
  const httpsMatch = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git|\/)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  // SSH format: git@github.com:owner/repo(.git)?
  const sshMatch = trimmed.match(/^git@github\.com:([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  return null;
}

/**
 * Generates structured Pull Request details and GitHub Compare URL.
 */
export function generatePullRequestDetails(params: {
  repoUrl: string;
  baseBranch: string;
  featureBranch: string;
  issueTitle: string;
  fixTitle: string;
  checkCommand: string;
  relativeFilePath: string;
  commitHash?: string;
}): PullRequestDetails {
  const { repoUrl, baseBranch, featureBranch, issueTitle, fixTitle, checkCommand, relativeFilePath, commitHash } =
    params;

  const parsed = parseGitHubRepo(repoUrl);
  const title = `fix: ${fixTitle}`;

  const body = [
    `## Summary`,
    `This pull request resolves an issue identified and verified locally with [FirstPR](https://github.com/TheGreatPratyush/Hack).`,
    ``,
    `### Diagnosis & Context`,
    `- **Issue:** ${issueTitle}`,
    `- **File Modified:** \`${relativeFilePath}\``,
    `- **Fix Applied:** ${fixTitle}`,
    ``,
    `### Local Verification`,
    `- **Command:** \`${checkCommand}\``,
    `- **Verification Status:** Passed (exit code 0) prior to commit.`,
    commitHash ? `- **Local Commit:** \`${commitHash}\`` : ``,
    ``,
    `---`,
    `*Generated safely by FirstPR — helping beginners contribute to open source with confidence.*`,
  ]
    .filter(Boolean)
    .join('\n');

  let compareUrl = '';
  if (parsed) {
    const encodedTitle = encodeURIComponent(title);
    const encodedBody = encodeURIComponent(body);
    compareUrl = `https://github.com/${parsed.owner}/${parsed.repo}/compare/${baseBranch}...${featureBranch}?expand=1&title=${encodedTitle}&body=${encodedBody}`;
  } else {
    compareUrl = `https://github.com/compare/${baseBranch}...${featureBranch}`;
  }

  return {
    title,
    body,
    baseBranch,
    headBranch: featureBranch,
    compareUrl,
  };
}

/**
 * Checks whether the GitHub CLI (gh) is installed and authenticated.
 */
export async function checkGhCli(): Promise<GhCliStatus> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;

    const proc = spawn('gh', ['--version'], {
      shell: false,
      windowsHide: true,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve({ installed: false, authenticated: false, error: 'gh check timed out' });
      }
    }, 4000);

    proc.stdout.on('data', (c) => (stdout += c.toString()));
    proc.stderr.on('data', (c) => (stderr += c.toString()));

    proc.on('error', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ installed: false, authenticated: false });
      }
    });

    proc.on('close', async (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (code !== 0) {
          resolve({ installed: false, authenticated: false });
          return;
        }

        // gh is installed, check auth status
        const authCheck = await checkGhAuth();
        resolve({
          installed: true,
          authenticated: authCheck.authenticated,
          account: authCheck.account,
          error: authCheck.error,
        });
      }
    });
  });
}

/**
 * Helper to check `gh auth status`.
 */
async function checkGhAuth(): Promise<{ authenticated: boolean; account?: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;

    const proc = spawn('gh', ['auth', 'status'], {
      shell: false,
      windowsHide: true,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve({ authenticated: false, error: 'gh auth check timed out' });
      }
    }, 4000);

    proc.stdout.on('data', (c) => (stdout += c.toString()));
    proc.stderr.on('data', (c) => (stderr += c.toString()));

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ authenticated: false, error: err.message });
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        const combined = `${stdout}\n${stderr}`;
        if (code === 0 || combined.includes('Logged in to github.com')) {
          const userMatch = combined.match(/Logged in to github\.com account ([a-zA-Z0-9_-]+)/);
          resolve({
            authenticated: true,
            account: userMatch ? userMatch[1] : undefined,
          });
        } else {
          resolve({
            authenticated: false,
            error: stderr || stdout || 'Not authenticated with GitHub CLI',
          });
        }
      }
    });
  });
}

/**
 * Creates a Pull Request using the GitHub CLI (gh pr create).
 */
export async function createPullRequestWithGh(params: {
  cwd: string;
  title: string;
  body: string;
  base: string;
  head: string;
}): Promise<GhPrCreateResult> {
  const { cwd, title, body, base, head } = params;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;

    const proc = spawn('gh', ['pr', 'create', '--title', title, '--body', body, '--base', base, '--head', head], {
      cwd,
      shell: false,
      windowsHide: true,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve({ success: false, error: 'gh pr create timed out' });
      }
    }, 30000);

    proc.stdout.on('data', (c) => (stdout += c.toString()));
    proc.stderr.on('data', (c) => (stderr += c.toString()));

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ success: false, error: `GitHub CLI error: ${err.message}` });
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (code === 0) {
          const prUrl = stdout.trim();
          resolve({ success: true, url: prUrl });
        } else {
          resolve({ success: false, error: stderr.trim() || stdout.trim() || `gh exited with code ${code}` });
        }
      }
    });
  });
}
