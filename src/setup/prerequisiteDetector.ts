import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ExtractedRepoEvidence, PrerequisiteEvaluation, PrerequisiteStatus } from './types';

/**
 * Safely executes a binary to probe its installed status and version without shell interpretation.
 */
export function probeBinary(
  executable: string,
  args: string[] = ['--version'],
  cwd?: string
): { isFound: boolean; rawOutput: string; exitCode: number | null } {
  try {
    const res = spawnSync(executable, args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: 5000,
      shell: false
    });

    if (res.error) {
      return { isFound: false, rawOutput: res.error.message, exitCode: null };
    }

    const output = (res.stdout || '') + (res.stderr || '');
    return {
      isFound: res.status === 0 || output.length > 0,
      rawOutput: output.trim(),
      exitCode: res.status
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isFound: false, rawOutput: msg, exitCode: null };
  }
}

/**
 * Extracts semver-like version string from CLI version output.
 */
export function extractVersion(output: string): string | undefined {
  // Matches e.g. "v22.23.1", "1.22.19", "2.6.10p210", "Python 3.10.12", "ruby 4.0.2"
  const m = output.match(/(\d+\.\d+(?:\.\d+)?(?:[a-zA-Z0-9_\-\.]+)?)/);
  return m ? m[1] : undefined;
}

/**
 * Compares semver prefix to verify basic compatibility without full semver library overhead.
 */
export function isVersionCompatible(installed: string, required: string): boolean {
  const cleanReq = required.replace(/^[>=<^~v\s]+/, '').trim();
  const cleanInst = installed.replace(/^v/, '').trim();

  // If required is a minimum (e.g. >= 18), compare major versions
  if (required.startsWith('>=') || required.startsWith('^')) {
    const reqMajor = parseInt(cleanReq.split('.')[0], 10);
    const instMajor = parseInt(cleanInst.split('.')[0], 10);
    if (!isNaN(reqMajor) && !isNaN(instMajor)) {
      return instMajor >= reqMajor;
    }
  }

  // If exact or tight prefix (e.g. 4.0.2 vs 2.6.10), major version must match
  const reqMajor = cleanReq.split('.')[0];
  const instMajor = cleanInst.split('.')[0];
  if (reqMajor && instMajor) {
    return reqMajor === instMajor;
  }

  return true;
}

/**
 * Evaluates host environment against extracted repository evidence.
 */
export async function evaluatePrerequisites(
  repoRoot: string,
  evidence: ExtractedRepoEvidence
): Promise<PrerequisiteEvaluation[]> {
  const results: PrerequisiteEvaluation[] = [];

  // 1. Node.js Runtime (if Node detected or package.json present)
  const nodeRuntime = evidence.detectedRuntimes.find(r => r.name === 'Node.js');
  if (nodeRuntime || fs.existsSync(path.join(repoRoot, 'package.json'))) {
    const probe = probeBinary('node', ['--version'], repoRoot);
    const installedVersion = probe.isFound ? extractVersion(probe.rawOutput) : undefined;
    const requiredVersion = nodeRuntime?.versionHint || '>=18.0.0';

    let status: PrerequisiteStatus = 'missing';
    if (probe.isFound && installedVersion) {
      status = isVersionCompatible(installedVersion, requiredVersion) ? 'satisfied' : 'incompatible';
    }

    results.push({
      name: 'node',
      type: 'runtime',
      requiredVersion,
      installedVersion,
      status,
      isRequired: true,
      checkExecutable: 'node',
      checkArgs: ['--version'],
      remediationRecommendation:
        status === 'missing'
          ? 'Install Node.js via nvm (`nvm install --lts`), fnm, or official package.'
          : status === 'incompatible'
          ? `Switch Node.js to match ${requiredVersion} using nvm or fnm.`
          : undefined,
      verificationMethod: 'node --version',
      details: probe.rawOutput || 'node command not found on host'
    });
  }

  // 2. Package Manager (pnpm, yarn, npm, bun)
  const pm = evidence.detectedPackageManagers.find(p => ['yarn', 'pnpm', 'bun', 'npm'].includes(p.name));
  const pmName = pm ? pm.name : 'npm';
  if (pmName !== 'npm') {
    const probe = probeBinary(pmName, ['--version'], repoRoot);
    const installedVersion = probe.isFound ? extractVersion(probe.rawOutput) : undefined;
    const requiredVersion = pm?.versionHint;

    let status: PrerequisiteStatus = 'missing';
    if (probe.isFound && installedVersion) {
      status = requiredVersion && !isVersionCompatible(installedVersion, requiredVersion)
        ? 'incompatible'
        : 'satisfied';
    }

    results.push({
      name: pmName,
      type: 'packageManager',
      requiredVersion,
      installedVersion,
      status,
      isRequired: true,
      checkExecutable: pmName,
      checkArgs: ['--version'],
      remediationRecommendation:
        status === 'missing'
          ? `Enable ${pmName} via Corepack (\`corepack enable ${pmName}\`) or install via npm (\`npm install -g ${pmName}\`).`
          : status === 'incompatible'
          ? `Update ${pmName} to ${requiredVersion} via Corepack.`
          : undefined,
      verificationMethod: `${pmName} --version`,
      details: probe.rawOutput || `${pmName} not found`
    });
  }

  // 3. Ruby & Bundler (if Ruby detected)
  const rubyRuntime = evidence.detectedRuntimes.find(r => r.name === 'Ruby');
  const hasBundler = evidence.detectedPackageManagers.some(p => p.name === 'bundler');
  if (rubyRuntime || hasBundler) {
    // Check Ruby
    const rubyProbe = probeBinary('ruby', ['-v'], repoRoot);
    const installedRuby = rubyProbe.isFound ? extractVersion(rubyProbe.rawOutput) : undefined;
    const requiredRuby = rubyRuntime?.versionHint;

    let rubyStatus: PrerequisiteStatus = 'missing';
    if (rubyProbe.isFound && installedRuby) {
      rubyStatus = requiredRuby && !isVersionCompatible(installedRuby, requiredRuby)
        ? 'incompatible'
        : 'satisfied';
    }

    results.push({
      name: 'ruby',
      type: 'runtime',
      requiredVersion: requiredRuby,
      installedVersion: installedRuby,
      status: rubyStatus,
      isRequired: true,
      checkExecutable: 'ruby',
      checkArgs: ['-v'],
      remediationRecommendation:
        rubyStatus === 'missing'
          ? 'Install Ruby using a version manager like rbenv (`rbenv install 3.x`) or asdf.'
          : rubyStatus === 'incompatible'
          ? `Host has Ruby ${installedRuby}, but repository requires ${requiredRuby}. Use rbenv or Docker Compose to match.`
          : undefined,
      verificationMethod: 'ruby -v',
      details: rubyProbe.rawOutput || 'ruby executable not found'
    });

    // Check Bundler
    const bundleProbe = probeBinary('bundle', ['-v'], repoRoot);
    const installedBundler = bundleProbe.isFound ? extractVersion(bundleProbe.rawOutput) : undefined;
    const bundlerStatus: PrerequisiteStatus = bundleProbe.isFound ? 'satisfied' : 'missing';

    results.push({
      name: 'bundler',
      type: 'packageManager',
      requiredVersion: '>=2.0.0',
      installedVersion: installedBundler,
      status: bundlerStatus,
      isRequired: true,
      checkExecutable: 'bundle',
      checkArgs: ['-v'],
      remediationRecommendation:
        bundlerStatus === 'missing'
          ? 'Install Bundler via `gem install bundler` inside the target Ruby environment.'
          : undefined,
      verificationMethod: 'bundle -v',
      details: bundleProbe.rawOutput || 'bundle executable not found'
    });
  }

  // 4. Python (if Python detected)
  const pythonRuntime = evidence.detectedRuntimes.find(r => r.name === 'Python');
  if (pythonRuntime) {
    const pyProbe = probeBinary('python3', ['--version'], repoRoot);
    const installedPy = pyProbe.isFound ? extractVersion(pyProbe.rawOutput) : undefined;
    const requiredPy = pythonRuntime.versionHint;

    let pyStatus: PrerequisiteStatus = 'missing';
    if (pyProbe.isFound && installedPy) {
      pyStatus = requiredPy && !isVersionCompatible(installedPy, requiredPy) ? 'incompatible' : 'satisfied';
    }

    results.push({
      name: 'python3',
      type: 'runtime',
      requiredVersion: requiredPy,
      installedVersion: installedPy,
      status: pyStatus,
      isRequired: true,
      checkExecutable: 'python3',
      checkArgs: ['--version'],
      remediationRecommendation:
        pyStatus === 'missing'
          ? 'Install Python 3 via pyenv or official distribution.'
          : pyStatus === 'incompatible'
          ? `Switch Python version to match ${requiredPy} using pyenv.`
          : undefined,
      verificationMethod: 'python3 --version',
      details: pyProbe.rawOutput || 'python3 not found'
    });
  }

  // 5. Database / Configuration (e.g. database.yml)
  const dbExamplePath = path.join(repoRoot, 'config', 'database.example.yml');
  const dbActualPath = path.join(repoRoot, 'config', 'database.yml');
  if (fs.existsSync(dbExamplePath)) {
    const isConfigured = fs.existsSync(dbActualPath);
    results.push({
      name: 'database_config',
      type: 'config',
      status: isConfigured ? 'satisfied' : 'missing',
      isRequired: false,
      checkExecutable: 'test',
      checkArgs: ['-f', 'config/database.yml'],
      remediationRecommendation: isConfigured
        ? undefined
        : 'Copy template database configuration: `cp config/database.example.yml config/database.yml`',
      verificationMethod: 'Check config/database.yml exists',
      details: isConfigured ? 'config/database.yml present' : 'config/database.yml missing (example exists)'
    });
  }

  // 6. Docker / Container Services (if docker-compose.yml present)
  if (fs.existsSync(path.join(repoRoot, 'docker-compose.yml'))) {
    const dockerProbe = probeBinary('docker', ['--version'], repoRoot);
    const installedDocker = dockerProbe.isFound ? extractVersion(dockerProbe.rawOutput) : undefined;
    results.push({
      name: 'docker',
      type: 'service',
      installedVersion: installedDocker,
      status: dockerProbe.isFound ? 'satisfied' : 'missing',
      isRequired: false,
      checkExecutable: 'docker',
      checkArgs: ['--version'],
      remediationRecommendation: dockerProbe.isFound
        ? undefined
        : 'Docker is optional for local development or can be used for containerized services (`docker compose up -d`).',
      verificationMethod: 'docker --version',
      details: dockerProbe.rawOutput || 'docker not installed'
    });
  }

  return results;
}
