/**
 * Provider-independent LLM interfaces and structured setup plan types for FirstPR.
 */

export type SetupPrerequisiteType =
  | 'runtime'
  | 'packageManager'
  | 'tool'
  | 'environment'
  | 'service';

export interface SetupPrerequisite {
  name: string;
  type: SetupPrerequisiteType;
  checkExecutable?: string;
  checkArgs?: string[];
  required: boolean;
  description?: string;
}

export interface SetupStep {
  id: string;
  title: string;
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  allowFailure?: boolean;
  fallbackStepId?: string;
}

export interface FirstPrSetupPlan {
  version: string;
  repositoryName?: string;
  summary: string;
  prerequisites?: SetupPrerequisite[];
  steps: SetupStep[];
  verificationSteps?: SetupStep[];
}

export interface PlanValidationResult {
  isValid: boolean;
  plan?: FirstPrSetupPlan;
  errors: string[];
}

export type LlmErrorCode =
  | 'CONNECTION_REFUSED'
  | 'MODEL_NOT_FOUND'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_RESPONSE'
  | 'VALIDATION_FAILED'
  | 'HTTP_ERROR'
  | 'PAYLOAD_TOO_LARGE';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly statusCode?: number;
  readonly details?: string[];

  constructor(message: string, code: LlmErrorCode, options?: { statusCode?: number; details?: string[]; cause?: unknown }) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.statusCode = options?.statusCode;
    this.details = options?.details;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

export interface LlmGenerateOptions {
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface LlmHealthCheckResult {
  available: boolean;
  provider: string;
  endpoint: string;
  models: string[];
  error?: string;
}

export interface LlmClient {
  readonly providerName: string;
  checkHealth(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<LlmHealthCheckResult>;
  listModels(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string[]>;
  generateSetupPlan(prompt: string, options?: LlmGenerateOptions): Promise<FirstPrSetupPlan>;
}
