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
  name: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'pip' | 'poetry' | 'cargo' | 'bundler';
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

export type PrerequisiteStatus = 'satisfied' | 'missing' | 'incompatible' | 'misconfigured';

export interface PrerequisiteEvaluation {
  name: string;
  type: 'runtime' | 'packageManager' | 'database' | 'service' | 'config';
  requiredVersion?: string;
  installedVersion?: string;
  status: PrerequisiteStatus;
  isRequired: boolean;
  checkExecutable: string;
  checkArgs: string[];
  remediationRecommendation?: string;
  verificationMethod: string;
  details?: string;
}

export type OrchestratorState =
  | 'idle'
  | 'inspecting_repository'
  | 'checking_prerequisites'
  | 'planning_setup'
  | 'awaiting_approval'
  | 'executing_step'
  | 'verifying_installation'
  | 'installing_dependencies'
  | 'running_checks'
  | 'recovering_from_failure'
  | 'ready'
  | 'ready_with_limitations'
  | 'blocked';

export interface OrchestratedStep {
  id: string;
  title: string;
  stage: 'prerequisite' | 'dependency' | 'configuration' | 'verification' | 'recovery';
  whatItDoes: string;
  whyItIsNeeded: string;
  executable: string;
  args: string[];
  cwd: string;
  riskLevel: StepRiskLevel;
  expectedImpact: string;
  verificationMethod: string;
  isRequired: boolean;
  status: 'pending' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'skipped' | 'rejected';
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  errorDetails?: string;
  suggestedRecovery?: OrchestratedStep;
}

export interface SetupReadinessReport {
  verdict: 'ready' | 'ready_with_limitations' | 'blocked';
  summary: string;
  prerequisites: PrerequisiteEvaluation[];
  completedSteps: OrchestratedStep[];
  blockedReason?: string;
  limitations: string[];
  workingCapabilities: string[];
}

export interface OrchestratorSnapshot {
  state: OrchestratorState;
  prerequisites: PrerequisiteEvaluation[];
  steps: OrchestratedStep[];
  currentStepIndex: number;
  currentStep?: OrchestratedStep;
  readinessReport?: SetupReadinessReport;
  isBusy: boolean;
}

