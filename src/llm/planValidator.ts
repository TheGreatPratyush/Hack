import * as path from 'path';
import { FirstPrSetupPlan, PlanValidationResult, SetupPrerequisite, SetupPrerequisiteType, SetupStep } from './types';

const SHELL_METACHAR_REGEX = /[;&|<>$`\n\r]/;
const SAFE_ID_REGEX = /^[a-zA-Z0-9_\-\.]+$/;
const SAFE_ENV_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ALLOWED_PREREQ_TYPES: Set<SetupPrerequisiteType> = new Set([
  'runtime',
  'packageManager',
  'tool',
  'environment',
  'service'
]);

/**
 * Validates a directory path to ensure it is strictly relative and contains no directory traversal.
 */
function isSafeRelativePath(dirPath: string): boolean {
  if (path.isAbsolute(dirPath)) {
    return false;
  }
  if (dirPath.startsWith('~')) {
    return false;
  }
  // Check for '..' path segments
  const segments = dirPath.split(/[/\\]/);
  if (segments.some(segment => segment === '..')) {
    return false;
  }
  const normalized = path.normalize(dirPath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return false;
  }
  return true;
}

/**
 * Validates a single setup step structure.
 */
function validateStep(
  rawStep: unknown,
  index: number,
  stepType: 'step' | 'verificationStep',
  errors: string[]
): SetupStep | null {
  if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
    errors.push(`${stepType}[${index}] must be a non-null object.`);
    return null;
  }

  const stepObj = rawStep as Record<string, unknown>;

  // id
  if (typeof stepObj.id !== 'string' || !stepObj.id.trim()) {
    errors.push(`${stepType}[${index}] missing required string field 'id'.`);
    return null;
  }
  const id = stepObj.id.trim();
  if (!SAFE_ID_REGEX.test(id) || id.length > 64) {
    errors.push(
      `${stepType}[${index}].id '${id}' must be alphanumeric with dashes/underscores/dots and at most 64 chars.`
    );
  }

  // title
  if (typeof stepObj.title !== 'string' || !stepObj.title.trim()) {
    errors.push(`${stepType}[${index}] (${id}) missing required string field 'title'.`);
  }
  const title = typeof stepObj.title === 'string' ? stepObj.title.trim() : '';
  if (title.length > 200) {
    errors.push(`${stepType}[${index}] (${id}).title exceeds maximum 200 characters.`);
  }

  // executable
  if (typeof stepObj.executable !== 'string' || !stepObj.executable.trim()) {
    errors.push(`${stepType}[${index}] (${id}) missing required string field 'executable'.`);
  }
  const executable = typeof stepObj.executable === 'string' ? stepObj.executable.trim() : '';
  if (executable.length > 128) {
    errors.push(`${stepType}[${index}] (${id}).executable exceeds maximum 128 characters.`);
  }
  if (SHELL_METACHAR_REGEX.test(executable)) {
    errors.push(
      `${stepType}[${index}] (${id}).executable contains forbidden shell metacharacters: '${executable}'.`
    );
  }

  // args
  if (!Array.isArray(stepObj.args)) {
    errors.push(
      `${stepType}[${index}] (${id}) 'args' must be an array of strings, received ${typeof stepObj.args}.`
    );
  } else {
    for (let i = 0; i < stepObj.args.length; i++) {
      const arg = stepObj.args[i];
      if (typeof arg !== 'string') {
        errors.push(`${stepType}[${index}] (${id}).args[${i}] must be a string.`);
      } else if (arg.length > 1000) {
        errors.push(`${stepType}[${index}] (${id}).args[${i}] exceeds maximum 1000 characters.`);
      }
    }
  }

  // cwd
  let cwd: string | undefined = undefined;
  if (stepObj.cwd !== undefined) {
    if (typeof stepObj.cwd !== 'string') {
      errors.push(`${stepType}[${index}] (${id}).cwd must be a string if provided.`);
    } else {
      const trimmedCwd = stepObj.cwd.trim();
      if (!isSafeRelativePath(trimmedCwd)) {
        errors.push(
          `${stepType}[${index}] (${id}).cwd '${trimmedCwd}' must be a relative path and cannot traverse outside repository.`
        );
      } else {
        cwd = trimmedCwd;
      }
    }
  }

  // env
  let env: Record<string, string> | undefined = undefined;
  if (stepObj.env !== undefined) {
    if (typeof stepObj.env !== 'object' || stepObj.env === null || Array.isArray(stepObj.env)) {
      errors.push(`${stepType}[${index}] (${id}).env must be a key-value record.`);
    } else {
      env = {};
      for (const [key, value] of Object.entries(stepObj.env)) {
        if (!SAFE_ENV_KEY_REGEX.test(key)) {
          errors.push(
            `${stepType}[${index}] (${id}).env key '${key}' contains invalid characters.`
          );
        }
        if (typeof value !== 'string') {
          errors.push(
            `${stepType}[${index}] (${id}).env['${key}'] must be a string value.`
          );
        } else if (value.length > 2000) {
          errors.push(
            `${stepType}[${index}] (${id}).env['${key}'] exceeds maximum length of 2000 characters.`
          );
        } else {
          env[key] = value;
        }
      }
    }
  }

  // timeoutSeconds
  let timeoutSeconds: number | undefined = undefined;
  if (stepObj.timeoutSeconds !== undefined) {
    if (
      typeof stepObj.timeoutSeconds !== 'number' ||
      !Number.isFinite(stepObj.timeoutSeconds) ||
      stepObj.timeoutSeconds <= 0 ||
      stepObj.timeoutSeconds > 3600
    ) {
      errors.push(
        `${stepType}[${index}] (${id}).timeoutSeconds must be a positive number up to 3600.`
      );
    } else {
      timeoutSeconds = stepObj.timeoutSeconds;
    }
  }

  // allowFailure
  let allowFailure: boolean | undefined = undefined;
  if (stepObj.allowFailure !== undefined) {
    if (typeof stepObj.allowFailure !== 'boolean') {
      errors.push(`${stepType}[${index}] (${id}).allowFailure must be a boolean.`);
    } else {
      allowFailure = stepObj.allowFailure;
    }
  }

  // fallbackStepId
  let fallbackStepId: string | undefined = undefined;
  if (stepObj.fallbackStepId !== undefined && stepObj.fallbackStepId !== null) {
    if (typeof stepObj.fallbackStepId !== 'string') {
      errors.push(`${stepType}[${index}] (${id}).fallbackStepId must be a string.`);
    } else {
      const trimmedFallback = stepObj.fallbackStepId.trim();
      if (trimmedFallback.length > 0) {
        if (trimmedFallback === id) {
          errors.push(`${stepType}[${index}] (${id}).fallbackStepId cannot reference itself.`);
        } else {
          fallbackStepId = trimmedFallback;
        }
      }
    }
  }

  return {
    id,
    title,
    executable,
    args: Array.isArray(stepObj.args)
      ? (stepObj.args.filter((a): a is string => typeof a === 'string') as string[])
      : [],
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(allowFailure !== undefined ? { allowFailure } : {}),
    ...(fallbackStepId !== undefined ? { fallbackStepId } : {})
  };
}

/**
 * Validates prerequisites.
 */
function validatePrerequisite(
  rawPrereq: unknown,
  index: number,
  errors: string[]
): SetupPrerequisite | null {
  if (!rawPrereq || typeof rawPrereq !== 'object' || Array.isArray(rawPrereq)) {
    errors.push(`prerequisites[${index}] must be a non-null object.`);
    return null;
  }
  const p = rawPrereq as Record<string, unknown>;

  if (typeof p.name !== 'string' || !p.name.trim()) {
    errors.push(`prerequisites[${index}] missing required string field 'name'.`);
  }
  const name = typeof p.name === 'string' ? p.name.trim() : '';

  if (typeof p.type !== 'string' || !ALLOWED_PREREQ_TYPES.has(p.type as SetupPrerequisiteType)) {
    errors.push(
      `prerequisites[${index}] invalid type '${p.type}'. Allowed: ${Array.from(ALLOWED_PREREQ_TYPES).join(', ')}.`
    );
  }
  const type = p.type as SetupPrerequisiteType;

  if (typeof p.required !== 'boolean') {
    errors.push(`prerequisites[${index}] 'required' must be a boolean.`);
  }
  const required = Boolean(p.required);

  let checkExecutable: string | undefined = undefined;
  if (p.checkExecutable !== undefined) {
    if (typeof p.checkExecutable !== 'string') {
      errors.push(`prerequisites[${index}].checkExecutable must be a string.`);
    } else {
      checkExecutable = p.checkExecutable.trim();
      if (SHELL_METACHAR_REGEX.test(checkExecutable)) {
        errors.push(
          `prerequisites[${index}].checkExecutable contains forbidden shell metacharacters: '${checkExecutable}'.`
        );
      }
    }
  }

  let checkArgs: string[] | undefined = undefined;
  if (p.checkArgs !== undefined) {
    if (!Array.isArray(p.checkArgs)) {
      errors.push(`prerequisites[${index}].checkArgs must be an array of strings.`);
    } else {
      checkArgs = p.checkArgs.filter((a): a is string => typeof a === 'string');
    }
  }

  let description: string | undefined = undefined;
  if (p.description !== undefined) {
    if (typeof p.description !== 'string') {
      errors.push(`prerequisites[${index}].description must be a string.`);
    } else {
      description = p.description.trim();
    }
  }

  return {
    name,
    type,
    required,
    ...(checkExecutable ? { checkExecutable } : {}),
    ...(checkArgs ? { checkArgs } : {}),
    ...(description ? { description } : {})
  };
}

/**
 * Checks for cyclic dependencies in fallbackStepId references.
 */
function detectFallbackCycles(steps: SetupStep[], errors: string[]): void {
  const stepMap = new Map<string, SetupStep>();
  for (const step of steps) {
    stepMap.set(step.id, step);
  }

  for (const step of steps) {
    if (!step.fallbackStepId) {
      continue;
    }

    if (!stepMap.has(step.fallbackStepId)) {
      errors.push(
        `Step '${step.id}' references nonexistent fallbackStepId '${step.fallbackStepId}'.`
      );
      continue;
    }

    // Follow the fallback chain to detect cycles
    const visited = new Set<string>([step.id]);
    let currentId: string | undefined = step.fallbackStepId;

    while (currentId) {
      if (visited.has(currentId)) {
        errors.push(
          `Cyclic fallback detected: step '${step.id}' leads back to '${currentId}' in fallback chain.`
        );
        break;
      }
      visited.add(currentId);
      const nextStep = stepMap.get(currentId);
      currentId = nextStep?.fallbackStepId;
    }
  }
}

/**
 * Strictly validates an untrusted object against the FirstPrSetupPlan contract.
 */
export function validateSetupPlan(data: unknown): PlanValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      isValid: false,
      errors: ['Setup plan payload must be a non-null object.']
    };
  }

  const obj = data as Record<string, unknown>;

  // version
  if (typeof obj.version !== 'string' || !obj.version.trim()) {
    errors.push("Missing or invalid required string field 'version'.");
  }
  const version = typeof obj.version === 'string' ? obj.version.trim() : '';

  // summary
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) {
    errors.push("Missing or invalid required string field 'summary'.");
  }
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (summary.length > 2000) {
    errors.push("Field 'summary' exceeds maximum length of 2000 characters.");
  }

  // repositoryName
  let repositoryName: string | undefined = undefined;
  if (obj.repositoryName !== undefined) {
    if (typeof obj.repositoryName !== 'string') {
      errors.push("Field 'repositoryName' must be a string if provided.");
    } else {
      repositoryName = obj.repositoryName.trim();
    }
  }

  // prerequisites
  let prerequisites: SetupPrerequisite[] | undefined = undefined;
  if (obj.prerequisites !== undefined) {
    if (!Array.isArray(obj.prerequisites)) {
      errors.push("Field 'prerequisites' must be an array.");
    } else {
      prerequisites = [];
      for (let i = 0; i < obj.prerequisites.length; i++) {
        const prereq = validatePrerequisite(obj.prerequisites[i], i, errors);
        if (prereq) {
          prerequisites.push(prereq);
        }
      }
    }
  }

  // steps
  if (!Array.isArray(obj.steps)) {
    errors.push("Missing or invalid required field 'steps': must be an array.");
    return { isValid: false, errors };
  }

  if (obj.steps.length === 0) {
    errors.push("Setup plan must contain at least one step in 'steps'.");
  }
  if (obj.steps.length > 50) {
    errors.push("Setup plan exceeds maximum step limit of 50 steps.");
  }

  const steps: SetupStep[] = [];
  const seenStepIds = new Set<string>();

  for (let i = 0; i < obj.steps.length; i++) {
    const validatedStep = validateStep(obj.steps[i], i, 'step', errors);
    if (validatedStep) {
      if (seenStepIds.has(validatedStep.id)) {
        errors.push(`Duplicate step ID '${validatedStep.id}' found in 'steps'.`);
      } else {
        seenStepIds.add(validatedStep.id);
      }
      steps.push(validatedStep);
    }
  }

  // verificationSteps (optional)
  let verificationSteps: SetupStep[] | undefined = undefined;
  if (obj.verificationSteps !== undefined) {
    if (!Array.isArray(obj.verificationSteps)) {
      errors.push("Field 'verificationSteps' must be an array if provided.");
    } else {
      verificationSteps = [];
      for (let i = 0; i < obj.verificationSteps.length; i++) {
        const validatedVStep = validateStep(
          obj.verificationSteps[i],
          i,
          'verificationStep',
          errors
        );
        if (validatedVStep) {
          if (seenStepIds.has(validatedVStep.id)) {
            errors.push(
              `Duplicate step ID '${validatedVStep.id}' found in 'verificationSteps' colliding with existing steps.`
            );
          } else {
            seenStepIds.add(validatedVStep.id);
          }
          verificationSteps.push(validatedVStep);
        }
      }
    }
  }

  // Check fallback cycle references across all steps
  const allSteps = [...steps, ...(verificationSteps || [])];
  detectFallbackCycles(allSteps, errors);

  if (errors.length > 0) {
    return {
      isValid: false,
      errors
    };
  }

  const plan: FirstPrSetupPlan = {
    version,
    summary,
    steps,
    ...(repositoryName ? { repositoryName } : {}),
    ...(prerequisites && prerequisites.length > 0 ? { prerequisites } : {}),
    ...(verificationSteps && verificationSteps.length > 0 ? { verificationSteps } : {})
  };

  return {
    isValid: true,
    plan,
    errors: []
  };
}
