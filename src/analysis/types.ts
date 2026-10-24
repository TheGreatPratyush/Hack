import { CheckResult } from '../core/checkRunner';
import { ProposedFix, FixRollbackRecord, RollbackResult } from '../fixes/fixEngine';

export type FailureClassification =
  | 'environment_tooling'
  | 'dependency_config'
  | 'test_assertion'
  | 'source_code_defect'
  | 'unknown';

export interface DiagnosticLocationRef {
  relativePath: string;
  line?: number;
  column?: number;
}

export interface StructuredModelDiagnosis {
  failureClassification: FailureClassification;
  observedEvidence: string;
  likelyExplanation: string;
  confidenceScore: number;
  isPlausibleSourceDefect: boolean;
  supportingLocations: DiagnosticLocationRef[];
  recommendedNextStep: string;
  proposedPatchSnippet?: {
    relativePath: string;
    originalSnippet: string;
    replacementSnippet: string;
  };
}

export interface ValidatedDiagnosisResult {
  isValid: boolean;
  classification: FailureClassification;
  diagnosis?: StructuredModelDiagnosis;
  isOfflineFallback: boolean;
  validationErrors: string[];
  proposedFix?: ProposedFix | null;
  explanation: string;
}

export interface DiagnosisVerificationResult {
  verified: boolean;
  initialExitCode: number | null;
  verifiedExitCode: number | null;
  checkResult: CheckResult;
  explanation: string;
  rollbackRecord?: FixRollbackRecord;
}

export { ProposedFix, FixRollbackRecord, RollbackResult };
