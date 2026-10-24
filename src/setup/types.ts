import { FirstPrSetupPlan } from '../llm';

export interface RepoFileEvidence {
  relativePath: string;
  content: string;
  sizeBytes: number;
  isTruncated: boolean;
  category: 'documentation' | 'manifest' | 'lockfile' | 'config' | 'instructions';
}

export interface DetectedRuntime {
  name: string;
  versionHint?: string;
  evidenceFile: string;
}

export interface DetectedPackageManager {
  name: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'pip' | 'poetry' | 'cargo';
  versionHint?: string;
  evidenceFile: string;
}

export interface ExtractedRepoEvidence {
  repositoryName: string;
  files: RepoFileEvidence[];
  detectedRuntimes: DetectedRuntime[];
  detectedPackageManagers: DetectedPackageManager[];
  hasConflictingManifests: boolean;
  excludedFiles: string[];
  warnings: string[];
}

export interface SetupGeneratorOptions {
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  allowFallbackToFactualBaseline?: boolean;
}

export interface SetupGuideResult {
  setupMarkdown: string;
  plan: FirstPrSetupPlan;
  evidence: ExtractedRepoEvidence;
  modelUsed: string;
  generatedAt: string;
  isFactualBaselineFallback?: boolean;
}
