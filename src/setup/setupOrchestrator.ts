import * as path from 'path';
import { extractRepoContext } from './contextExtractor';
import { evaluatePrerequisites } from './prerequisiteDetector';
import { generateSetupGuide } from './setupGenerator';
import { SetupExecutionAgent } from './setupAgent';
import {
  ExtractedRepoEvidence,
  OrchestratedStep,
  OrchestratorSnapshot,
  OrchestratorState,
  PrerequisiteEvaluation,
  SetupReadinessReport
} from './types';
import { LlmClient } from '../llm';

export interface SetupOrchestratorOptions {
  llmClient?: LlmClient | null;
  signal?: AbortSignal;
  onStateChange?: (snapshot: OrchestratorSnapshot) => void;
  onStreamOutput?: (stepId: string, stream: 'stdout' | 'stderr', chunk: string) => void;
}

export class SetupOrchestrator {
  private _state: OrchestratorState = 'idle';
  private _evidence: ExtractedRepoEvidence | null = null;
  private _prerequisites: PrerequisiteEvaluation[] = [];
  private _steps: OrchestratedStep[] = [];
  private _currentStepIndex: number = 0;
  private _readinessReport: SetupReadinessReport | null = null;
  private _isBusy: boolean = false;
  private _agent: SetupExecutionAgent | null = null;
  private _abortController: AbortController | null = null;

  constructor(
    public readonly repoRoot: string,
    private readonly _options?: SetupOrchestratorOptions
  ) {}

  public get state(): OrchestratorState {
    return this._state;
  }

  public get prerequisites(): PrerequisiteEvaluation[] {
    return [...this._prerequisites];
  }

  public get steps(): OrchestratedStep[] {
    return [...this._steps];
  }

  public get currentStep(): OrchestratedStep | undefined {
    return this._steps[this._currentStepIndex];
  }

  public get isBusy(): boolean {
    return this._isBusy;
  }

  public get readinessReport(): SetupReadinessReport | null {
    return this._readinessReport;
  }

  public getSnapshot(): OrchestratorSnapshot {
    return {
      state: this._state,
      prerequisites: this.prerequisites,
      steps: this.steps,
      currentStepIndex: this._currentStepIndex,
      currentStep: this.currentStep,
      readinessReport: this._readinessReport || undefined,
      isBusy: this._isBusy
    };
  }

  private _notify(): void {
    if (this._options?.onStateChange) {
      this._options.onStateChange(this.getSnapshot());
    }
  }

  /**
   * Initializes the orchestration workflow: inspects repo, checks host prerequisites, and synthesizes ordered steps.
   */
  public async initialize(): Promise<OrchestratorSnapshot> {
    this._isBusy = true;
    this._state = 'inspecting_repository';
    this._notify();

    try {
      // 1. Extract context
      this._evidence = await extractRepoContext(this.repoRoot);

      // 2. Evaluate host prerequisites
      this._state = 'checking_prerequisites';
      this._notify();
      this._prerequisites = await evaluatePrerequisites(this.repoRoot, this._evidence);

      // 3. Generate setup runbook
      this._state = 'planning_setup';
      this._notify();

      const guideResult = await generateSetupGuide(this.repoRoot, this._options?.llmClient, {
        allowFallbackToFactualBaseline: true
      });

      this._agent = new SetupExecutionAgent(this.repoRoot, guideResult.plan);

      // 4. Construct orchestrated steps
      this._steps = this._buildOrchestratedSteps(guideResult.plan);
      this._currentStepIndex = 0;

      // Check if there are blocking missing prerequisites that prevent execution
      const blockingPrereq = this._prerequisites.find(p => p.isRequired && p.status === 'missing');
      if (blockingPrereq) {
        this._state = 'blocked';
        this._readinessReport = this._buildReadinessReport('blocked', `Blocking prerequisite missing: ${blockingPrereq.name}`);
      } else if (this._steps.length > 0) {
        this._state = 'awaiting_approval';
        this._steps[0].status = 'awaiting_approval';
      } else {
        this._state = 'ready';
        this._readinessReport = this._buildReadinessReport('ready', 'All prerequisites satisfied; no setup steps required.');
      }
    } catch (err: unknown) {
      this._state = 'blocked';
      const msg = err instanceof Error ? err.message : String(err);
      this._readinessReport = this._buildReadinessReport('blocked', `Orchestrator initialization failed: ${msg}`);
    } finally {
      this._isBusy = false;
      this._notify();
    }

    return this.getSnapshot();
  }

  /**
   * Approves and executes the current active step.
   */
  public async approveAndExecuteCurrentStep(): Promise<OrchestratedStep> {
    const step = this.currentStep;
    if (!step) {
      throw new Error('No active step to execute.');
    }
    if (this._isBusy) {
      throw new Error('An operation is already in progress.');
    }

    this._isBusy = true;
    this._state = step.stage === 'dependency' ? 'installing_dependencies' : 'executing_step';
    step.status = 'running';
    this._notify();

    this._abortController = new AbortController();

    try {
      if (!this._agent) {
        this._agent = new SetupExecutionAgent(this.repoRoot, {
          version: '1.0',
          repositoryName: path.basename(this.repoRoot),
          summary: 'Fallback execution session',
          steps: [
            {
              id: step.id,
              title: step.title,
              executable: step.executable,
              args: step.args,
              cwd: step.cwd
            }
          ]
        });
      }

      const execResult = await this._agent.executeStep(step.id, {
        userApproved: true,
        signal: this._abortController.signal,
        onStdout: chunk => {
          step.stdout = (step.stdout || '') + chunk;
          if (this._options?.onStreamOutput) {
            this._options.onStreamOutput(step.id, 'stdout', chunk);
          }
        },
        onStderr: chunk => {
          step.stderr = (step.stderr || '') + chunk;
          if (this._options?.onStreamOutput) {
            this._options.onStreamOutput(step.id, 'stderr', chunk);
          }
        }
      });

      step.exitCode = execResult.exitCode;
      step.durationMs = execResult.durationMs;

      if (execResult.status === 'completed' && execResult.exitCode === 0) {
        // Step succeeded -> Post-execution verification
        this._state = 'verifying_installation';
        this._notify();

        step.status = 'completed';

        // Advance to next step
        this._currentStepIndex++;
        if (this._currentStepIndex < this._steps.length) {
          this._state = 'awaiting_approval';
          this._steps[this._currentStepIndex].status = 'awaiting_approval';
        } else {
          // All steps completed!
          this._finalizeReadiness();
        }
      } else {
        // Step failed
        step.status = 'failed';
        step.errorDetails = execResult.stderr || execResult.stdout || 'Process returned non-zero exit code.';
        this._state = 'recovering_from_failure';

        // Suggest recovery step if available
        if (execResult.suggestedRecoveryStep) {
          step.suggestedRecovery = {
            id: execResult.suggestedRecoveryStep.id,
            title: execResult.suggestedRecoveryStep.title,
            stage: 'recovery',
            whatItDoes: `Alternative recovery: ${execResult.suggestedRecoveryStep.title}`,
            whyItIsNeeded: execResult.recoveryExplanation || 'Automated fallback to recover from step failure.',
            executable: execResult.suggestedRecoveryStep.executable,
            args: execResult.suggestedRecoveryStep.args,
            cwd: execResult.suggestedRecoveryStep.cwd || '.',
            riskLevel: 'medium',
            expectedImpact: 'Applies fallback setup procedure',
            verificationMethod: 'Re-run subsequent verification',
            isRequired: step.isRequired,
            status: 'pending'
          };
        }
      }
    } catch (err: unknown) {
      step.status = 'failed';
      step.errorDetails = err instanceof Error ? err.message : String(err);
      this._state = 'recovering_from_failure';
    } finally {
      this._isBusy = false;
      this._abortController = null;
      this._notify();
    }

    return step;
  }

  /**
   * Rejects the current step without spawning any process.
   */
  public rejectCurrentStep(): OrchestratedStep {
    const step = this.currentStep;
    if (!step) {
      throw new Error('No active step to reject.');
    }

    step.status = 'rejected';
    step.exitCode = null;
    step.errorDetails = 'Execution was rejected by user.';

    if (step.isRequired) {
      this._state = 'blocked';
      this._readinessReport = this._buildReadinessReport('blocked', `Required step '${step.title}' was rejected by user.`);
    } else {
      // Optional step rejected -> advance to next
      this._currentStepIndex++;
      if (this._currentStepIndex < this._steps.length) {
        this._state = 'awaiting_approval';
        this._steps[this._currentStepIndex].status = 'awaiting_approval';
      } else {
        this._finalizeReadiness();
      }
    }

    this._notify();
    return step;
  }

  /**
   * Skips the current step if optional.
   */
  public skipCurrentStep(): OrchestratedStep {
    const step = this.currentStep;
    if (!step) {
      throw new Error('No active step to skip.');
    }

    step.status = 'skipped';
    this._currentStepIndex++;

    if (this._currentStepIndex < this._steps.length) {
      this._state = 'awaiting_approval';
      this._steps[this._currentStepIndex].status = 'awaiting_approval';
    } else {
      this._finalizeReadiness();
    }

    this._notify();
    return step;
  }

  /**
   * Retries the current failed step.
   */
  public retryCurrentStep(): void {
    const step = this.currentStep;
    if (!step) {
      throw new Error('No step to retry.');
    }
    step.status = 'awaiting_approval';
    this._state = 'awaiting_approval';
    this._notify();
  }

  /**
   * Resumes workflow after a failure using the suggested recovery step.
   */
  public applyRecoveryStep(): void {
    const step = this.currentStep;
    if (!step || !step.suggestedRecovery) {
      throw new Error('No recovery step available.');
    }

    // Replace current step with recovery step and queue it for approval
    this._steps.splice(this._currentStepIndex, 1, step.suggestedRecovery);
    this._steps[this._currentStepIndex].status = 'awaiting_approval';
    this._state = 'awaiting_approval';
    this._notify();
  }

  /**
   * Evaluates final readiness and sets appropriate verdict.
   */
  private _finalizeReadiness(): void {
    const hasIncompatibleOrMissing = this._prerequisites.some(p => p.status === 'incompatible' || p.status === 'missing');
    const hasSkipped = this._steps.some(s => s.status === 'skipped');
    const allStrictlyCompleted = this._steps.every(s => s.status === 'completed');

    if (allStrictlyCompleted && !hasIncompatibleOrMissing) {
      this._state = 'ready';
      this._readinessReport = this._buildReadinessReport('ready', 'Setup completed successfully. All dependencies and checks verified.');
    } else {
      this._state = 'ready_with_limitations';
      const reason = hasSkipped
        ? 'Setup completed with limitations: some setup steps were skipped by developer.'
        : 'Setup completed for supported runtimes, but some environment requirements remain unmet or external.';
      this._readinessReport = this._buildReadinessReport('ready_with_limitations', reason);
    }
  }

  private _buildReadinessReport(
    verdict: 'ready' | 'ready_with_limitations' | 'blocked',
    summary: string
  ): SetupReadinessReport {
    const limitations: string[] = [];
    const workingCapabilities: string[] = [];

    for (const prereq of this._prerequisites) {
      if (prereq.status === 'satisfied') {
        workingCapabilities.push(`${prereq.name} runtime/tool (${prereq.installedVersion || 'installed'})`);
      } else if (prereq.status === 'incompatible') {
        limitations.push(
          `${prereq.name} version mismatch (installed: ${prereq.installedVersion}, required: ${prereq.requiredVersion}). ${prereq.remediationRecommendation || ''}`
        );
      } else if (prereq.status === 'missing') {
        limitations.push(
          `${prereq.name} is missing on host. ${prereq.remediationRecommendation || ''}`
        );
      }
    }

    const completed = this._steps.filter(s => s.status === 'completed');
    if (completed.length > 0) {
      workingCapabilities.push(`Completed setup steps: ${completed.map(s => s.title).join(', ')}`);
    }

    return {
      verdict,
      summary,
      prerequisites: this.prerequisites,
      completedSteps: completed,
      limitations,
      workingCapabilities,
      blockedReason: verdict === 'blocked' ? summary : undefined
    };
  }

  private _buildOrchestratedSteps(plan: import('../llm').FirstPrSetupPlan): OrchestratedStep[] {
    const steps: OrchestratedStep[] = [];

    // Map plan steps into OrchestratedSteps with explicit metadata
    for (const s of plan.steps) {
      const isInstall = ['npm', 'pnpm', 'yarn', 'bundle', 'pip', 'poetry'].includes(s.executable);
      steps.push({
        id: s.id,
        title: s.title,
        stage: isInstall ? 'dependency' : 'configuration',
        whatItDoes: `Executes \`${s.executable} ${s.args.join(' ')}\` in \`${s.cwd || '.'}\``,
        whyItIsNeeded: `Required to configure project dependencies and build artifacts according to ${s.title}.`,
        executable: s.executable,
        args: s.args,
        cwd: s.cwd || '.',
        riskLevel: isInstall ? 'high' : 'medium',
        expectedImpact: isInstall
          ? 'Installs packages and dependencies into the workspace.'
          : 'Configures project settings.',
        verificationMethod: `Runs with non-zero exit code detection and output inspection.`,
        isRequired: !s.allowFailure,
        status: 'pending'
      });
    }

    // Append verification steps
    if (plan.verificationSteps) {
      for (const vs of plan.verificationSteps) {
        steps.push({
          id: vs.id,
          title: vs.title,
          stage: 'verification',
          whatItDoes: `Executes verification command \`${vs.executable} ${vs.args.join(' ')}\``,
          whyItIsNeeded: `Verifies that project build and test harnesses succeed without errors.`,
          executable: vs.executable,
          args: vs.args,
          cwd: vs.cwd || '.',
          riskLevel: 'low',
          expectedImpact: 'Reads and executes project verification suite (no permanent modifications).',
          verificationMethod: `Exit code 0 confirms suite passes.`,
          isRequired: true,
          status: 'pending'
        });
      }
    }

    return steps;
  }
}
