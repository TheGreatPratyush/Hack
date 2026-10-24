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

export type StepRiskLevel = 'low' | 'medium' | 'high' | 'critical_rejected';

export interface StepPreflightCheck {
  stepId: string;
  executable: string;
  args: string[];
  resolvedCwd: string;
  riskLevel: StepRiskLevel;
  warnings: string[];
  isAllowed: boolean;
  rejectionReason?: string;
}

export type StepExecutionStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'rejected'
  | 'error';

export interface StepExecutionResult {
  stepId: string;
  title: string;
  executable: string;
  args: string[];
  cwd: string;
  status: StepExecutionStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  explanation: string;
  suggestedRecoveryStep?: import('../llm').SetupStep;
  recoveryExplanation?: string;
}

export interface SetupExecutionSession {
  repositoryRoot: string;
  plan: FirstPrSetupPlan;
  results: Map<string, StepExecutionResult>;
  activeStepId?: string;
  isComplete: boolean;
}
