import * as fs from 'fs';
import * as path from 'path';
import {
  DetectedPackageManager,
  DetectedRuntime,
  ExtractedRepoEvidence,
  RepoFileEvidence
} from './types';

export interface ExtractContextOptions {
  maxPerFileSizeChars?: number;
  maxTotalContextChars?: number;
  maxFileSizeToReadBytes?: number;
}

const DEFAULT_MAX_PER_FILE_CHARS = 15 * 1024; // 15 KB
const DEFAULT_MAX_TOTAL_CONTEXT_CHARS = 60 * 1024; // 60 KB
const DEFAULT_MAX_FILE_SIZE_BYTES = 200 * 1024; // 200 KB

const SENSITIVE_FILE_REGEX = /^(\.env(\..+)?|.*token.*|.*secret.*|.*credential.*|.*\.pem|.*\.key|.*id_rsa.*|.*id_ed25519.*)$/i;
const BINARY_EXT_REGEX = /\.(png|jpg|jpeg|gif|ico|webp|pdf|zip|tar|gz|exe|dylib|so|bin|woff|woff2|lockb|mp4|mov)$/i;



const CANDIDATE_FILES: Array<{ relPath: string; category: RepoFileEvidence['category'] }> = [
  // Documentation
  { relPath: 'README.md', category: 'documentation' },
  { relPath: 'README', category: 'documentation' },
  { relPath: 'readme.markdown', category: 'documentation' },
  { relPath: 'README.rst', category: 'documentation' },
  { relPath: 'README.txt', category: 'documentation' },
  { relPath: 'CONTRIBUTING.md', category: 'documentation' },
  { relPath: 'CONTRIBUTING', category: 'documentation' },
  { relPath: 'DEVELOPMENT.md', category: 'documentation' },
  { relPath: 'INSTALL.md', category: 'documentation' },
  // Instructions
  { relPath: 'CLAUDE.md', category: 'instructions' },
  { relPath: 'AGENTS.md', category: 'instructions' },
  { relPath: 'AGENT.md', category: 'instructions' },
  { relPath: '.github/copilot-instructions.md', category: 'instructions' },
  { relPath: '.cursorrules', category: 'instructions' },
  // Manifests & Workspace
  { relPath: 'package.json', category: 'manifest' },
  { relPath: 'pnpm-workspace.yaml', category: 'manifest' },
  { relPath: 'lerna.json', category: 'manifest' },
  { relPath: 'turbo.json', category: 'manifest' },
  { relPath: 'requirements.txt', category: 'manifest' },
  { relPath: 'requirements-dev.txt', category: 'manifest' },
  { relPath: 'pyproject.toml', category: 'manifest' },
  { relPath: 'setup.py', category: 'manifest' },
  { relPath: 'setup.cfg', category: 'manifest' },
  { relPath: 'Pipfile', category: 'manifest' },
  // Lockfiles (metadata checked)
  { relPath: 'pnpm-lock.yaml', category: 'lockfile' },
  { relPath: 'yarn.lock', category: 'lockfile' },
  { relPath: 'package-lock.json', category: 'lockfile' },
  { relPath: 'poetry.lock', category: 'lockfile' },
  // Configs
  { relPath: 'Makefile', category: 'config' },
  { relPath: 'Dockerfile', category: 'config' },
  { relPath: 'docker-compose.yml', category: 'config' },
  { relPath: 'docker-compose.yaml', category: 'config' },
  { relPath: '.gitattributes', category: 'config' },
  { relPath: '.nvmrc', category: 'config' },
  { relPath: '.node-version', category: 'config' },
  { relPath: '.python-version', category: 'config' }
];

/**
 * Checks if a filename is sensitive.
 */
export function isSensitiveFile(filename: string): boolean {
  const base = path.basename(filename);
  return SENSITIVE_FILE_REGEX.test(base);
}

/**
 * Checks if a filename indicates binary / non-text format.
 */
export function isBinaryFile(filename: string): boolean {
  return BINARY_EXT_REGEX.test(filename);
}

/**
 * Extracts bounded repository context and detects runtimes/package managers.
 */
export async function extractRepoContext(
  repoRoot: string,
  options?: ExtractContextOptions
): Promise<ExtractedRepoEvidence> {
  const maxPerFile = options?.maxPerFileSizeChars || DEFAULT_MAX_PER_FILE_CHARS;
  const maxTotal = options?.maxTotalContextChars || DEFAULT_MAX_TOTAL_CONTEXT_CHARS;
  const maxReadBytes = options?.maxFileSizeToReadBytes || DEFAULT_MAX_FILE_SIZE_BYTES;

  let repoName = path.basename(path.resolve(repoRoot));
  const files: RepoFileEvidence[] = [];
  const excludedFiles: string[] = [];
  const warnings: string[] = [];

  let accumulatedChars = 0;

  for (const candidate of CANDIDATE_FILES) {
    if (accumulatedChars >= maxTotal) {
      warnings.push(`Context limit reached (${maxTotal} chars). Some candidate files were omitted.`);
      break;
    }

    const fullPath = path.join(repoRoot, candidate.relPath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    if (isSensitiveFile(candidate.relPath)) {
      excludedFiles.push(candidate.relPath);
      warnings.push(`Excluded sensitive file from context: ${candidate.relPath}`);
      continue;
    }

    if (isBinaryFile(candidate.relPath)) {
      excludedFiles.push(candidate.relPath);
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stats.size > maxReadBytes) {
      excludedFiles.push(candidate.relPath);
      warnings.push(
        `Omitted oversized file ${candidate.relPath} (${stats.size} bytes > ${maxReadBytes} bytes limit).`
      );
      continue;
    }

    try {
      let content = fs.readFileSync(fullPath, 'utf8');
      let isTruncated = false;

      // Special handling for lockfiles: only take first 30 lines to confirm presence & version
      if (candidate.category === 'lockfile') {
        const lines = content.split('\n').slice(0, 30);
        content = lines.join('\n') + (lines.length >= 30 ? '\n... [lockfile entries truncated]' : '');
        isTruncated = true;
      } else if (content.length > maxPerFile) {
        content = content.slice(0, maxPerFile) + '\n... [content truncated at limit]';
        isTruncated = true;
      }

      accumulatedChars += content.length;
      files.push({
        relativePath: candidate.relPath,
        content,
        sizeBytes: stats.size,
        isTruncated,
        category: candidate.category
      });
    } catch (err: unknown) {
      warnings.push(`Failed to read ${candidate.relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Try resolving cleaner repo name from package.json if present
  const pkgJson = files.find(f => f.relativePath === 'package.json');
  if (pkgJson) {
    try {
      const parsed = JSON.parse(pkgJson.content);
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        repoName = parsed.name.trim();
      }
    } catch {
      // Ignored
    }
  }

  // Detect runtimes & package managers from extracted evidence
  const { detectedRuntimes, detectedPackageManagers, hasConflictingManifests } =
    detectRuntimesAndPackageManagers(files, warnings);

  return {
    repositoryName: repoName,
    files,
    detectedRuntimes,
    detectedPackageManagers,
    hasConflictingManifests,
    excludedFiles,
    warnings
  };
}

/**
 * Analyzes extracted evidence to deterministically identify runtimes and package managers.
 */
function detectRuntimesAndPackageManagers(
  files: RepoFileEvidence[],
  warnings: string[]
): {
  detectedRuntimes: DetectedRuntime[];
  detectedPackageManagers: DetectedPackageManager[];
  hasConflictingManifests: boolean;
} {
  const fileMap = new Map<string, RepoFileEvidence>();
  for (const f of files) {
    fileMap.set(f.relativePath, f);
  }

  const detectedRuntimes: DetectedRuntime[] = [];
  const detectedPackageManagers: DetectedPackageManager[] = [];
  let hasConflictingManifests = false;

  // 1. Node.js runtime detection
  const pkgJsonFile = fileMap.get('package.json');
  const nvmrcFile = fileMap.get('.nvmrc');
  const nodeVersionFile = fileMap.get('.node-version');

  if (pkgJsonFile || nvmrcFile || nodeVersionFile) {
    let versionHint: string | undefined = undefined;
    let evidenceFile = 'package.json';

    if (nodeVersionFile) {
      versionHint = nodeVersionFile.content.trim().replace(/^v/i, '');
      evidenceFile = '.node-version';
    } else if (nvmrcFile) {
      versionHint = nvmrcFile.content.trim().replace(/^v/i, '');
      evidenceFile = '.nvmrc';
    } else if (pkgJsonFile) {
      try {
        const parsed = JSON.parse(pkgJsonFile.content);
        if (parsed.engines?.node) {
          versionHint = parsed.engines.node;
        }
      } catch {
        // Ignored
      }
    }

    detectedRuntimes.push({
      name: 'Node.js',
      ...(versionHint ? { versionHint } : {}),
      evidenceFile
    });
  }

  // 2. Python runtime detection
  const pyprojectFile = fileMap.get('pyproject.toml');
  const reqsFile = fileMap.get('requirements.txt');
  const reqsDevFile = fileMap.get('requirements-dev.txt');
  const setupPyFile = fileMap.get('setup.py');
  const pipfileFile = fileMap.get('Pipfile');
  const pyVersionFile = fileMap.get('.python-version');

  if (pyprojectFile || reqsFile || reqsDevFile || setupPyFile || pipfileFile || pyVersionFile) {
    let versionHint: string | undefined = undefined;
    let evidenceFile = 'requirements.txt';

    if (pyVersionFile) {
      versionHint = pyVersionFile.content.trim();
      evidenceFile = '.python-version';
    } else if (pyprojectFile) {
      evidenceFile = 'pyproject.toml';
      const match = pyprojectFile.content.match(/requires-python\s*=\s*["']([^"']+)["']/i);
      if (match) {
        versionHint = match[1];
      }
    } else if (pipfileFile) {
      evidenceFile = 'Pipfile';
    }

    detectedRuntimes.push({
      name: 'Python',
      ...(versionHint ? { versionHint } : {}),
      evidenceFile
    });
  }

  // 3. JavaScript / TypeScript Package Manager Detection
  const hasPnpmLock = fileMap.has('pnpm-lock.yaml');
  const hasYarnLock = fileMap.has('yarn.lock');
  const hasPackageLock = fileMap.has('package-lock.json');
  const hasPnpmWorkspace = fileMap.has('pnpm-workspace.yaml');

  let jsPmFromManifest: { name: 'pnpm' | 'npm' | 'yarn' | 'bun'; version?: string } | null = null;
  if (pkgJsonFile) {
    try {
      const parsed = JSON.parse(pkgJsonFile.content);
      if (typeof parsed.packageManager === 'string') {
        const [pmName, pmVer] = parsed.packageManager.split('@');
        if (['pnpm', 'npm', 'yarn', 'bun'].includes(pmName)) {
          jsPmFromManifest = { name: pmName as any, version: pmVer };
        }
      }
    } catch {
      // Ignored
    }
  }

  // Check for conflicting lockfiles
  const lockfileCount = [hasPnpmLock, hasYarnLock, hasPackageLock].filter(Boolean).length;
  if (lockfileCount > 1) {
    hasConflictingManifests = true;
    warnings.push(
      'Multiple conflicting JavaScript lockfiles detected (e.g. pnpm-lock.yaml vs package-lock.json). Preferring explicit manifest packageManager or pnpm-workspace.'
    );
  }

  if (jsPmFromManifest) {
    detectedPackageManagers.push({
      name: jsPmFromManifest.name,
      ...(jsPmFromManifest.version ? { versionHint: jsPmFromManifest.version } : {}),
      evidenceFile: 'package.json (packageManager field)'
    });
  } else if (hasPnpmLock || hasPnpmWorkspace) {
    detectedPackageManagers.push({
      name: 'pnpm',
      evidenceFile: hasPnpmLock ? 'pnpm-lock.yaml' : 'pnpm-workspace.yaml'
    });
  } else if (hasYarnLock) {
    detectedPackageManagers.push({
      name: 'yarn',
      evidenceFile: 'yarn.lock'
    });
  } else if (hasPackageLock) {
    detectedPackageManagers.push({
      name: 'npm',
      evidenceFile: 'package-lock.json'
    });
  } else if (pkgJsonFile) {
    detectedPackageManagers.push({
      name: 'npm',
      evidenceFile: 'package.json (default)'
    });
  }

  // 4. Python Package Manager Detection
  if (fileMap.has('poetry.lock')) {
    detectedPackageManagers.push({
      name: 'poetry',
      evidenceFile: 'poetry.lock'
    });
  } else if (pipfileFile) {
    detectedPackageManagers.push({
      name: 'pip',
      evidenceFile: 'Pipfile'
    });
  } else if (reqsFile || reqsDevFile || setupPyFile || pyprojectFile) {
    detectedPackageManagers.push({
      name: 'pip',
      evidenceFile: reqsFile ? 'requirements.txt' : 'pyproject.toml'
    });
  }

  return {
    detectedRuntimes,
    detectedPackageManagers,
    hasConflictingManifests
  };
}
