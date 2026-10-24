import * as vscode from 'vscode';
import { validateGitHubUrl, ValidationResult } from '../core/urlValidator';
import {
  getRepoDestination,
  checkDestination,
  ensureParentDirectory,
} from '../core/workspaceManager';
import { checkGitAvailable, cloneRepository } from '../core/gitService';
import { inspectProject, ProjectInspection } from '../core/projectInspector';
import { executeCheck, CheckResult } from '../core/checkRunner';
import { diagnoseCheckResult, DiagnosticReport } from '../diagnostics/diagnosticEngine';
import {
  proposeFixForIssue,
  applyProposedFix,
  rollbackAppliedFix,
  ProposedFix,
  FixRollbackRecord,
} from '../fixes/fixEngine';
import {
  preflightTargetRepo,
  createAndCheckoutBranch,
  commitVerifiedFix,
  generatePullRequestDetails,
  checkGhCli,
  createPullRequestWithGh,
  buildBranchName,
  PullRequestDetails,
} from '../git/prService';

export class FirstPRSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'firstpr.sidebarView';
  private _view?: vscode.WebviewView;
  private _isBusy = false;
  private _abortController: AbortController | null = null;
  private _activeDestPath: string | null = null;
  private _lastRepoUrl: string = '';
  private _lastInspection: ProjectInspection | null = null;
  private _lastDiagnosticReport: DiagnosticReport | null = null;
  private _activeProposedFix: ProposedFix | null = null;
  private _lastRollbackRecord: FixRollbackRecord | null = null;
  private _lastCheckType: 'test' | 'build' | 'lint' | 'typecheck' = 'test';
  private _lastScriptName?: string;
  private _currentPrDetails: PullRequestDetails | null = null;
  private _activeBranchName: string = '';

  public get activeDestPath(): string | null {
    return this._activeDestPath;
  }

  public get currentPrDetails(): PullRequestDetails | null {
    return this._currentPrDetails;
  }

  public get activeBranchName(): string {
    return this._activeBranchName;
  }

  public get currentView(): vscode.WebviewView | undefined {
    return this._view;
  }

  public get lastInspection(): ProjectInspection | null {
    return this._lastInspection;
  }

  public get lastDiagnosticReport(): DiagnosticReport | null {
    return this._lastDiagnosticReport;
  }

  public get activeProposedFix(): ProposedFix | null {
    return this._activeProposedFix;
  }

  public get lastRollbackRecord(): FixRollbackRecord | null {
    return this._lastRollbackRecord;
  }

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'submitUrl':
          await this._handleStartWorkflow(message.url);
          break;
        case 'confirmReuse':
          await this._handleConfirmReuse(message.destPath);
          break;
        case 'cancelActiveOperation':
          this._handleCancelActiveOperation();
          break;
        case 'openInVsCode':
          await this._handleOpenFolder(message.path || this._activeDestPath);
          break;
        case 'runCheck':
          await this._handleRunCheck(message.checkType, message.scriptName);
          break;
        case 'installDependencies':
          await this._handleInstallDependencies();
          break;
        case 'applyAndVerifyFix':
          await this._handleApplyAndVerifyFix();
          break;
        case 'rollbackFix':
          await this._handleRollbackFix();
          break;
        case 'preparePullRequest':
          await this._handlePreparePullRequest();
          break;
        case 'createBranchAndStage':
          await this._handleCreateBranchAndStage(message.branchName);
          break;
        case 'commitVerifiedFix':
          await this._handleCommitVerifiedFix(message.title, message.body);
          break;
        case 'createGhPr':
          await this._handleCreateGhPr(message.title, message.body, message.base, message.head);
          break;
        case 'openExternalUrl':
          await this._handleOpenExternalUrl(message.url);
          break;
        case 'clear':
          this._handleReset();
          break;
      }
    });
  }

  private async _handleStartWorkflow(rawUrl: string): Promise<void> {
    this._lastRepoUrl = (rawUrl || '').trim();
    if (this._isBusy) {
      this._postToWebview({
        command: 'error',
        message: 'An operation is already in progress. Please wait or cancel it.',
      });
      return;
    }

    this._isBusy = true;
    this._postToWebview({
      command: 'stageUpdate',
      stage: 'validating',
      detail: 'Validating repository URL...',
    });

    const validation: ValidationResult = validateGitHubUrl(rawUrl);
    if (!validation.isValid) {
      this._isBusy = false;
      this._postToWebview({ command: 'error', message: validation.error });
      return;
    }

    this._postToWebview({
      command: 'stageUpdate',
      stage: 'checking_prereqs',
      detail: 'Verifying Git installation...',
    });

    const git = await checkGitAvailable();
    if (!git.available) {
      this._isBusy = false;
      this._postToWebview({
        command: 'error',
        message: git.error || 'Git executable not found in system PATH. Git is required to clone repositories.',
      });
      return;
    }

    this._postToWebview({
      command: 'stageUpdate',
      stage: 'preparing_workspace',
      detail: 'Selecting safe workspace destination...',
    });

    let destPath: string;
    try {
      destPath = getRepoDestination(validation.owner, validation.repo);
      this._activeDestPath = destPath;
    } catch (err: unknown) {
      this._isBusy = false;
      const msg = err instanceof Error ? err.message : String(err);
      this._postToWebview({ command: 'error', message: msg });
      return;
    }

    const check = checkDestination(destPath);
    if (check.exists) {
      this._isBusy = false;
      if (check.isValidGitRepo) {
        this._postToWebview({
          command: 'promptReuse',
          destPath,
          message: 'The repository already exists locally. Would you like to reuse this existing repository or cancel?',
        });
        return;
      } else {
        this._postToWebview({
          command: 'error',
          message: `Destination directory "${destPath}" already exists and is not a valid Git repository. FirstPR will not overwrite it.`,
        });
        return;
      }
    }

    await this._executeClone(validation.normalizedUrl, destPath);
  }

  private async _executeClone(url: string, destPath: string): Promise<void> {
    ensureParentDirectory(destPath);
    this._abortController = new AbortController();

    this._postToWebview({
      command: 'stageUpdate',
      stage: 'cloning',
      detail: 'Cloning repository from GitHub...',
      cancellable: true,
    });

    try {
      await cloneRepository({
        url,
        destPath,
        signal: this._abortController.signal,
        onProgress: (progressMsg) => {
          this._postToWebview({
            command: 'progressUpdate',
            detail: progressMsg,
          });
        },
      });

      this._isBusy = false;
      this._abortController = null;

      await this._handleInspectAndPresent(destPath, 'Repository cloned successfully.');
    } catch (err: unknown) {
      this._isBusy = false;
      this._abortController = null;
      const msg = err instanceof Error ? err.message : String(err);
      this._postToWebview({
        command: 'error',
        message: msg,
      });
    }
  }

  private async _handleConfirmReuse(destPath: string): Promise<void> {
    if (!destPath) {
      return;
    }
    const check = checkDestination(destPath);
    if (!check.exists || !check.isValidGitRepo) {
      this._postToWebview({
        command: 'error',
        message: 'The selected folder is no longer a valid Git repository.',
      });
      return;
    }

    this._activeDestPath = destPath;
    this._isBusy = false;
    await this._handleInspectAndPresent(destPath, 'Reusing existing local repository.');
  }

  private async _handleInspectAndPresent(destPath: string, bannerMessage: string): Promise<void> {
    const inspection = inspectProject(destPath);
    this._lastInspection = inspection;

    this._postToWebview({
      command: 'inspectionComplete',
      bannerMessage,
      destPath,
      inspection,
    });
  }

  private async _handleInstallDependencies(): Promise<void> {
    if (!this._activeDestPath) {
      this._postToWebview({ command: 'error', message: 'No active repository destination.' });
      return;
    }
    if (this._isBusy) {
      this._postToWebview({ command: 'error', message: 'An operation is currently running.' });
      return;
    }

    this._isBusy = true;
    this._abortController = new AbortController();

    this._postToWebview({
      command: 'stageUpdate',
      stage: 'installing',
      detail: 'Running "npm install" with user permission...',
      cancellable: true,
    });

    try {
      const result = await executeCheck({
        cwd: this._activeDestPath,
        checkType: 'install',
        signal: this._abortController.signal,
        timeoutMs: 180 * 1000,
        onStdout: (chunk) => {
          this._postToWebview({ command: 'checkStream', stream: 'stdout', chunk });
        },
        onStderr: (chunk) => {
          this._postToWebview({ command: 'checkStream', stream: 'stderr', chunk });
        },
      });

      const diagnosticReport = diagnoseCheckResult(result);
      this._lastDiagnosticReport = diagnosticReport;

      this._isBusy = false;
      this._abortController = null;

      const reInspection = inspectProject(this._activeDestPath);
      this._lastInspection = reInspection;

      this._postToWebview({
        command: 'checkFinished',
        result,
        inspection: reInspection,
        diagnosticReport,
        proposedFix: null,
      });
    } catch (err: unknown) {
      this._isBusy = false;
      this._abortController = null;
      const msg = err instanceof Error ? err.message : String(err);
      this._postToWebview({ command: 'error', message: msg });
    }
  }

  private async _handleRunCheck(
    checkType: 'test' | 'build' | 'lint' | 'typecheck',
    scriptName?: string
  ): Promise<void> {
    if (!this._activeDestPath) {
      this._postToWebview({ command: 'error', message: 'No active repository selected.' });
      return;
    }
    if (this._isBusy) {
      this._postToWebview({ command: 'error', message: 'Another operation is already in progress.' });
      return;
    }

    this._lastCheckType = checkType;
    this._lastScriptName = scriptName;

    const inspection = this._lastInspection || inspectProject(this._activeDestPath);
    this._lastInspection = inspection;

    this._isBusy = true;
    this._abortController = new AbortController();

    const targetName = scriptName || checkType;
    this._postToWebview({
      command: 'stageUpdate',
      stage: 'running_check',
      detail: `Executing check "${targetName}"...`,
      cancellable: true,
    });

    try {
      const result: CheckResult = await executeCheck({
        cwd: this._activeDestPath,
        checkType,
        scriptName: targetName,
        signal: this._abortController.signal,
        timeoutMs: 90 * 1000,
        allowedScripts: inspection.scripts,
        onStdout: (chunk) => {
          this._postToWebview({ command: 'checkStream', stream: 'stdout', chunk });
        },
        onStderr: (chunk) => {
          this._postToWebview({ command: 'checkStream', stream: 'stderr', chunk });
        },
      });

      const diagnosticReport = diagnoseCheckResult(result);
      this._lastDiagnosticReport = diagnosticReport;

      // Look for a deterministically supported fix proposal for the first failed issue
      let proposedFix: ProposedFix | null = null;
      if (diagnosticReport.hasIssues) {
        for (const issue of diagnosticReport.issues) {
          const fix = proposeFixForIssue(issue, this._activeDestPath);
          if (fix) {
            proposedFix = fix;
            break;
          }
        }
      }
      this._activeProposedFix = proposedFix;

      this._isBusy = false;
      this._abortController = null;

      this._postToWebview({
        command: 'checkFinished',
        result,
        inspection: this._lastInspection,
        diagnosticReport,
        proposedFix,
      });
    } catch (err: unknown) {
      this._isBusy = false;
      this._abortController = null;
      const msg = err instanceof Error ? err.message : String(err);
      this._postToWebview({ command: 'error', message: msg });
    }
  }

  private async _handleApplyAndVerifyFix(): Promise<void> {
    if (!this._activeDestPath || !this._activeProposedFix) {
      this._postToWebview({ command: 'error', message: 'No active proposed fix to apply.' });
      return;
    }
    if (this._isBusy) {
      this._postToWebview({ command: 'error', message: 'Another operation is in progress.' });
      return;
    }

    this._isBusy = true;
    this._postToWebview({
      command: 'stageUpdate',
      stage: 'applying_patch',
      detail: `Applying approved fix to ${this._activeProposedFix.relativeFilePath}...`,
    });

    // 1. Safely apply patch to disk
    const applyRes = applyProposedFix(this._activeProposedFix, this._activeDestPath);
    if (!applyRes.success || !applyRes.rollbackRecord) {
      this._isBusy = false;
      this._postToWebview({
        command: 'error',
        message: applyRes.error || 'Failed to apply patch.',
      });
      return;
    }

    this._lastRollbackRecord = applyRes.rollbackRecord;

    // 2. Re-run the specific check that failed originally
    this._postToWebview({
      command: 'stageUpdate',
      stage: 'reverifying',
      detail: `Re-running "${this._lastScriptName || this._lastCheckType}" to verify fix...`,
      cancellable: true,
    });

    this._abortController = new AbortController();

    try {
      const recheckResult: CheckResult = await executeCheck({
        cwd: this._activeDestPath,
        checkType: this._lastCheckType,
        scriptName: this._lastScriptName,
        signal: this._abortController.signal,
        timeoutMs: 90 * 1000,
        allowedScripts: this._lastInspection?.scripts,
      });

      const recheckDiagnosis = diagnoseCheckResult(recheckResult);
      this._lastDiagnosticReport = recheckDiagnosis;
      this._isBusy = false;
      this._abortController = null;

      this._postToWebview({
        command: 'reverificationComplete',
        recheckResult,
        recheckDiagnosis,
        rollbackAvailable: true,
        fixApplied: true,
        appliedFixTitle: this._activeProposedFix.title,
      });
    } catch (err: unknown) {
      this._isBusy = false;
      this._abortController = null;
      const msg = err instanceof Error ? err.message : String(err);
      this._postToWebview({ command: 'error', message: `Re-verification error: ${msg}` });
    }
  }

  private async _handleRollbackFix(): Promise<void> {
    if (!this._activeDestPath || !this._lastRollbackRecord) {
      this._postToWebview({ command: 'error', message: 'No rollback record available.' });
      return;
    }

    const res = rollbackAppliedFix(this._lastRollbackRecord, this._activeDestPath);
    if (!res.success) {
      this._postToWebview({
        command: 'error',
        message: res.error || 'Rollback failed.',
      });
      return;
    }

    this._lastRollbackRecord = null;
    this._activeProposedFix = null;

    vscode.window.showInformationMessage('FirstPR: Rolled back applied patch successfully.');

    // Re-run check to return to baseline state
    await this._handleRunCheck(this._lastCheckType, this._lastScriptName);
  }

  private async _handlePreparePullRequest(): Promise<void> {
    if (!this._activeDestPath || !this._activeProposedFix) {
      this._postToWebview({
        command: 'error',
        message: 'No active repository destination or verified fix available.',
      });
      return;
    }

    const preflight = await preflightTargetRepo(this._activeDestPath, [
      this._activeProposedFix.relativeFilePath,
    ]);

    const ghCli = await checkGhCli();

    const branchSlug = this._activeProposedFix.title;
    const proposedBranchName = buildBranchName(branchSlug);

    const baseBranch = preflight.currentBranch || 'main';
    const issueTitle = this._lastDiagnosticReport?.issues[0]?.title || this._activeProposedFix.title;
    const checkCommand = `npm run ${this._lastScriptName || this._lastCheckType}`;

    const prDetails = generatePullRequestDetails({
      repoUrl: this._lastRepoUrl || 'https://github.com/repository',
      baseBranch,
      featureBranch: proposedBranchName,
      issueTitle,
      fixTitle: this._activeProposedFix.title,
      checkCommand,
      relativeFilePath: this._activeProposedFix.relativeFilePath,
    });

    this._currentPrDetails = prDetails;

    this._postToWebview({
      command: 'prWorkflowReady',
      preflight,
      ghCli,
      proposedBranchName,
      prDetails,
      targetFile: this._activeProposedFix.relativeFilePath,
    });
  }

  private async _handleCreateBranchAndStage(branchName: string): Promise<void> {
    if (!this._activeDestPath || !this._activeProposedFix) {
      this._postToWebview({ command: 'error', message: 'No active repository destination.' });
      return;
    }

    const branchRes = await createAndCheckoutBranch(this._activeDestPath, branchName);
    if (!branchRes.success) {
      this._postToWebview({
        command: 'error',
        message: branchRes.error || `Failed to create branch "${branchName}".`,
      });
      return;
    }

    this._activeBranchName = branchName;

    const preflight = await preflightTargetRepo(this._activeDestPath, [
      this._activeProposedFix.relativeFilePath,
    ]);

    const issueTitle = this._lastDiagnosticReport?.issues[0]?.title || this._activeProposedFix.title;
    const checkCommand = `npm run ${this._lastScriptName || this._lastCheckType}`;

    const prDetails = generatePullRequestDetails({
      repoUrl: this._lastRepoUrl || 'https://github.com/repository',
      baseBranch: branchRes.previousBranch || 'main',
      featureBranch: branchName,
      issueTitle,
      fixTitle: this._activeProposedFix.title,
      checkCommand,
      relativeFilePath: this._activeProposedFix.relativeFilePath,
    });
    this._currentPrDetails = prDetails;

    this._postToWebview({
      command: 'branchCreatedAndStaged',
      branchRes,
      preflight,
      prDetails,
      targetFile: this._activeProposedFix.relativeFilePath,
    });
  }

  private async _handleCommitVerifiedFix(title: string, body: string): Promise<void> {
    if (!this._activeDestPath || !this._activeProposedFix) {
      this._postToWebview({ command: 'error', message: 'No active repository destination.' });
      return;
    }

    const commitRes = await commitVerifiedFix(
      this._activeDestPath,
      [this._activeProposedFix.relativeFilePath],
      { title, body }
    );

    if (!commitRes.success) {
      this._postToWebview({
        command: 'error',
        message: commitRes.error || 'Failed to create commit in target repository.',
      });
      return;
    }

    const issueTitle = this._lastDiagnosticReport?.issues[0]?.title || this._activeProposedFix.title;
    const checkCommand = `npm run ${this._lastScriptName || this._lastCheckType}`;

    const prDetails = generatePullRequestDetails({
      repoUrl: this._lastRepoUrl || 'https://github.com/repository',
      baseBranch: 'main',
      featureBranch: this._activeBranchName || commitRes.branch || 'firstpr/fix',
      issueTitle,
      fixTitle: this._activeProposedFix.title,
      checkCommand,
      relativeFilePath: this._activeProposedFix.relativeFilePath,
      commitHash: commitRes.commitHash,
    });
    this._currentPrDetails = prDetails;

    const ghCli = await checkGhCli();

    this._postToWebview({
      command: 'commitSuccess',
      commitRes,
      prDetails,
      ghCli,
    });
  }

  private async _handleCreateGhPr(
    title: string,
    body: string,
    base: string,
    head: string
  ): Promise<void> {
    if (!this._activeDestPath) {
      this._postToWebview({ command: 'error', message: 'No active repository destination.' });
      return;
    }

    this._postToWebview({
      command: 'stageUpdate',
      stage: 'creating_pr',
      detail: 'Creating pull request with GitHub CLI (gh)...',
    });

    const res = await createPullRequestWithGh({
      cwd: this._activeDestPath,
      title,
      body,
      base: base || 'main',
      head: head || this._activeBranchName,
    });

    this._postToWebview({
      command: 'ghPrCreated',
      result: res,
    });
  }

  private async _handleOpenExternalUrl(rawUrl: string): Promise<void> {
    try {
      if (rawUrl) {
        await vscode.env.openExternal(vscode.Uri.parse(rawUrl));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to open URL: ${msg}`);
    }
  }

  private _handleCancelActiveOperation(): void {
    if (this._abortController) {
      this._postToWebview({
        command: 'progressUpdate',
        detail: 'Cancelling operation and terminating child processes...',
      });
      this._abortController.abort();
    }
  }

  private async _handleOpenFolder(folderPath: string | null): Promise<void> {
    if (!folderPath) {
      return;
    }
    try {
      const uri = vscode.Uri.file(folderPath);
      await vscode.commands.executeCommand('vscode.openFolder', uri, false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to open folder: ${msg}`);
    }
  }

  private _handleReset(): void {
    if (this._isBusy && this._abortController) {
      this._abortController.abort();
    }
    this._isBusy = false;
    this._abortController = null;
    this._activeDestPath = null;
    this._lastInspection = null;
    this._lastDiagnosticReport = null;
    this._activeProposedFix = null;
    this._lastRollbackRecord = null;
    this._postToWebview({ command: 'reset' });
  }

  private _postToWebview(message: unknown): void {
    this._view?.webview.postMessage(message);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FirstPR</title>
  <style>
    :root {
      --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      padding: 14px 12px;
      font-family: var(--vscode-font-family, var(--font-family));
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      line-height: 1.4;
    }
    .header {
      margin-bottom: 14px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, #333));
      padding-bottom: 10px;
    }
    .title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .title-badge {
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 0.5px;
      color: var(--vscode-foreground);
    }
    .version-tag {
      font-size: 10px;
      padding: 2px 5px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .description {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .form-group { margin-bottom: 12px; }
    label {
      display: block;
      margin-bottom: 6px;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-input-placeholderForeground);
    }
    .input-wrapper { display: flex; flex-direction: column; gap: 8px; }
    input[type="text"] {
      width: 100%;
      padding: 7px 9px;
      border: 1px solid var(--vscode-input-border, transparent);
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-size: 12px;
      border-radius: 2px;
      outline: none;
    }
    input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
    input[type="text"]::placeholder {
      color: var(--vscode-input-placeholderForeground);
      opacity: 0.8;
    }
    .actions { display: flex; gap: 6px; }
    button {
      padding: 6px 10px;
      font-size: 12px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      font-weight: 500;
    }
    .primary-btn {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      flex: 1;
    }
    .primary-btn:hover:not(:disabled) {
      background-color: var(--vscode-button-hoverBackground);
    }
    .secondary-btn {
      background-color: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
    }
    .secondary-btn:hover:not(:disabled) {
      background-color: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
    .success-btn {
      background-color: #28a745;
      color: #ffffff;
    }
    .success-btn:hover:not(:disabled) {
      background-color: #218838;
    }
    .danger-btn {
      background-color: var(--vscode-errorForeground, #d9534f);
      color: #ffffff;
    }
    .check-btn {
      background-color: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
      border: 1px solid var(--vscode-widget-border, #444);
      padding: 5px 8px;
      font-size: 11px;
    }
    .check-btn:hover:not(:disabled) {
      background-color: var(--vscode-button-hoverBackground);
      color: var(--vscode-button-foreground);
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Cards */
    .card {
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 3px;
      display: none;
      font-size: 12px;
    }
    .card.active { display: block; }
    .card.info {
      background-color: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.1));
      border: 1px solid var(--vscode-widget-border, #444);
    }
    .card.error {
      background-color: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.15));
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      color: var(--vscode-foreground);
    }
    .card.success {
      background-color: var(--vscode-inputValidation-infoBackground, rgba(0, 122, 204, 0.15));
      border: 1px solid var(--vscode-inputValidation-infoBorder, #007acc);
      color: var(--vscode-foreground);
    }
    .card.prompt {
      background-color: var(--vscode-inputValidation-warningBackground, rgba(255, 165, 0, 0.15));
      border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
      color: var(--vscode-foreground);
    }

    .stage-title {
      font-weight: 600;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .stage-detail {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      word-break: break-all;
    }
    .spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-progressBar-background, #007acc);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .tag-row {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin: 8px 0;
    }
    .tag {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-weight: 600;
    }
    .tag.warn { background: #cca700; color: #000; }
    .tag.ok { background: #28a745; color: #fff; }
    .tag.quality-strong { background: var(--vscode-inputValidation-infoBorder, #007acc); color: #fff; }
    .tag.quality-possible { background: #cca700; color: #000; }
    .tag.quality-insufficient { background: #555; color: #ddd; }

    .path-pill {
      margin-top: 6px;
      padding: 5px 7px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25));
      border-radius: 2px;
      word-break: break-all;
      border: 1px solid var(--vscode-widget-border, #333);
    }
    .btn-group {
      margin-top: 10px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .log-box {
      margin-top: 6px;
      padding: 8px;
      background: var(--vscode-terminal-background, #000);
      color: var(--vscode-terminal-foreground, #ccc);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      border-radius: 3px;
      max-height: 180px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      border: 1px solid var(--vscode-widget-border, #333);
    }
    .section-subtitle {
      font-size: 11px;
      font-weight: 600;
      margin-top: 10px;
      margin-bottom: 4px;
      color: var(--vscode-foreground);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .notice-box {
      margin-top: 8px;
      padding: 8px 10px;
      background: var(--vscode-inputValidation-warningBackground, rgba(255, 165, 0, 0.12));
      border-left: 3px solid #cca700;
      font-size: 11px;
      line-height: 1.35;
    }

    /* Diagnostics & Issue Cards */
    .issue-card {
      margin-top: 10px;
      padding: 10px;
      background: var(--vscode-editor-background, rgba(0,0,0,0.2));
      border: 1px solid var(--vscode-widget-border, #444);
      border-left: 4px solid var(--vscode-inputValidation-errorBorder, #be1100);
      border-radius: 3px;
    }
    .issue-card.clean_pass { border-left: 4px solid #28a745; }
    .issue-card.warning { border-left: 4px solid #cca700; }
    .issue-header {
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 4px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 6px;
    }
    .issue-location {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      color: var(--vscode-textLink-foreground, #3794ff);
      margin-bottom: 6px;
      display: inline-block;
    }
    .issue-field { margin-top: 8px; }
    .field-title {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
    }
    .field-content { font-size: 11px; line-height: 1.4; }
    .evidence-block {
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25));
      padding: 6px 8px;
      border-radius: 2px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
      white-space: pre-wrap;
      word-break: break-all;
      border: 1px solid var(--vscode-widget-border, #333);
      max-height: 140px;
      overflow-y: auto;
    }

    /* Diff Preview Card */
    .diff-card {
      margin-top: 12px;
      padding: 12px;
      border-radius: 4px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-inputValidation-infoBorder, #007acc);
    }
    .diff-viewer {
      margin-top: 6px;
      padding: 8px;
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.3));
      border: 1px solid var(--vscode-widget-border, #333);
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      white-space: pre;
      overflow-x: auto;
      max-height: 160px;
    }
    .diff-line-del {
      color: var(--vscode-diffEditor-removedTextForeground, #ff7b72);
      background: rgba(255, 0, 0, 0.15);
      display: block;
    }
    .diff-line-add {
      color: var(--vscode-diffEditor-insertedTextForeground, #7ee787);
      background: rgba(0, 255, 0, 0.15);
      display: block;
    }
    .diff-line-ctx { color: var(--vscode-descriptionForeground); display: block; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-row">
      <span class="title-badge">FirstPR</span>
      <span class="version-tag">MVP</span>
    </div>
    <div class="description">Guided, local-first open-source onboarding and diagnostics.</div>
  </div>

  <div class="form-group">
    <label for="repo-url">GitHub Repository URL</label>
    <div class="input-wrapper">
      <input
        type="text"
        id="repo-url"
        placeholder="https://github.com/owner/repository"
        autocomplete="off"
        spellcheck="false"
      />
      <div class="actions">
        <button id="submit-btn" class="primary-btn">Start Onboarding</button>
        <button id="clear-btn" class="secondary-btn" title="Clear">Clear</button>
      </div>
    </div>
  </div>

  <!-- Progress View -->
  <div id="progress-card" class="card info">
    <div class="stage-title">
      <span class="spinner"></span>
      <span id="stage-text">Processing...</span>
    </div>
    <div id="stage-detail" class="stage-detail"></div>
    <div id="progress-actions" class="btn-group" style="display:none;">
      <button id="cancel-active-btn" class="danger-btn">Cancel Operation</button>
    </div>
  </div>

  <!-- Prompt Reuse Existing Repo Card -->
  <div id="prompt-card" class="card prompt">
    <div class="stage-title">Repository Exists</div>
    <div id="prompt-message" class="stage-detail"></div>
    <div id="prompt-path" class="path-pill"></div>
    <div class="btn-group">
      <button id="confirm-reuse-btn" class="primary-btn">Reuse Existing</button>
      <button id="cancel-reuse-btn" class="secondary-btn">Cancel</button>
    </div>
  </div>

  <!-- Project Inspection Card -->
  <div id="inspection-card" class="card info">
    <div class="stage-title" id="inspection-title">Repository Ready</div>
    <div id="inspection-banner" class="stage-detail"></div>
    <div id="inspection-path" class="path-pill"></div>

    <div class="tag-row" id="inspection-tags"></div>

    <div id="dep-warning" class="notice-box" style="display:none;">
      <strong>Dependencies missing:</strong> <code>node_modules</code> not found. Project checks will likely fail.
      <div style="margin-top:6px;">
        <button id="install-deps-btn" class="secondary-btn" style="width:100%;">Install Dependencies (npm install)</button>
      </div>
      <div style="font-size:10px;margin-top:4px;color:var(--vscode-descriptionForeground);">
        Note: Dependency installation executes lifecycle scripts.
      </div>
    </div>

    <div class="section-subtitle">Run Project Checks (Approval Required)</div>
    <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px;">
      Project scripts execute code locally. Select an approved check to run:
    </div>

    <div class="btn-group" id="checks-btn-group"></div>

    <div id="missing-checks-note" style="margin-top:8px;font-size:11px;color:var(--vscode-descriptionForeground);"></div>

    <div class="btn-group" style="margin-top:12px;">
      <button id="open-vscode-btn" class="secondary-btn" style="width:100%;">Open in VS Code</button>
    </div>
  </div>

  <!-- Proposed Fix & Diff Preview Card -->
  <div id="fix-preview-card" class="diff-card" style="display:none;">
    <div class="stage-title" style="color:var(--vscode-inputValidation-infoBorder, #007acc);">
      Proposed Fix Available
    </div>
    <div id="fix-title" style="font-weight:600;margin-top:4px;"></div>
    <div id="fix-desc" style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px;"></div>
    <div id="fix-file" class="issue-location" style="margin-top:6px;"></div>

    <div class="section-subtitle">Unified Diff Preview:</div>
    <div id="diff-box" class="diff-viewer"></div>

    <div id="fix-safety-notes" class="notice-box" style="margin-top:8px;font-size:10.5px;"></div>

    <div class="btn-group" style="margin-top:10px;">
      <button id="apply-fix-btn" class="success-btn" style="width:100%;">
        Approve & Apply Fix (Re-verifies Check)
      </button>
    </div>
  </div>

  <!-- Re-verification Outcome Card -->
  <div id="reverification-card" class="card" style="display:none;">
    <div class="stage-title" id="reverif-title">Verification Outcome</div>
    <div id="reverif-message" class="stage-detail"></div>
    <div class="btn-group" style="margin-top:8px;">
      <button id="prep-pr-btn" class="primary-btn" style="flex:2;display:none;">Prepare Pull Request</button>
      <button id="rollback-btn" class="secondary-btn" style="flex:1;">Rollback Patch</button>
    </div>
  </div>

  <!-- Pull Request Preparation Card -->
  <div id="pr-card" class="card info" style="display:none;">
    <div class="stage-title" style="color:var(--vscode-inputValidation-infoBorder, #007acc);">
      Pull Request Preparation
    </div>
    <div id="pr-preflight-info" class="notice-box" style="margin-top:6px;font-size:11px;"></div>

    <div class="section-subtitle" style="margin-top:8px;">1. Target Feature Branch</div>
    <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:4px;">
      Create isolated branch in target repository:
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px;">
      <input type="text" id="pr-branch-input" style="flex:1;padding:5px 8px;font-size:12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;" spellcheck="false" />
      <button id="create-branch-btn" class="primary-btn" style="white-space:nowrap;">Create Branch</button>
    </div>
    <div id="pr-branch-status" style="font-size:11px;margin-bottom:8px;"></div>

    <div id="pr-commit-section" style="display:none;">
      <div class="section-subtitle">2. Verified Commit</div>
      <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px;">
        Staging approved fix file: <code id="pr-staged-file" style="color:var(--vscode-textPreformat-foreground);"></code>
      </div>
      <div style="margin-bottom:6px;">
        <label style="font-size:11px;font-weight:600;display:block;margin-bottom:2px;">Commit Title</label>
        <input type="text" id="pr-commit-title" style="width:100%;padding:5px 8px;font-size:12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;" spellcheck="false" />
      </div>
      <div style="margin-bottom:8px;">
        <label style="font-size:11px;font-weight:600;display:block;margin-bottom:2px;">Commit Message Body</label>
        <textarea id="pr-commit-body" rows="4" style="width:100%;padding:5px 8px;font-size:11px;font-family:monospace;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;"></textarea>
      </div>
      <button id="commit-btn" class="success-btn" style="width:100%;margin-bottom:10px;">Commit Verified Changes</button>
    </div>

    <div id="pr-ready-section" style="display:none;">
      <div class="section-subtitle" style="color:var(--vscode-testing-iconPassed, #4ec9b0);">
        ✓ Fix Committed Locally
      </div>
      <div id="pr-commit-hash-pill" class="path-pill" style="margin-bottom:8px;"></div>

      <div class="btn-group" style="flex-direction:column;gap:6px;">
        <button id="open-compare-url-btn" class="primary-btn" style="width:100%;">
          Open Pull Request on GitHub
        </button>
        <button id="create-gh-cli-btn" class="secondary-btn" style="width:100%;display:none;">
          Create PR via GitHub CLI (gh)
        </button>
      </div>

      <div id="gh-cli-status-msg" style="font-size:11px;margin-top:6px;color:var(--vscode-descriptionForeground);"></div>
    </div>
  </div>

  <!-- Diagnostics & Issue Cards Container -->
  <div id="diagnostics-card" class="card active" style="display:none;">
    <div class="stage-title" id="diagnostics-header">Diagnostic Findings</div>
    <div id="diagnostics-summary" class="stage-detail" style="margin-bottom:8px;"></div>
    <div id="issues-list"></div>

    <!-- Toggle Raw Terminal Log -->
    <div style="margin-top:10px;">
      <button id="toggle-log-btn" class="secondary-btn" style="width:100%;font-size:11px;">Show Full Terminal Output</button>
      <div id="raw-log-container" style="display:none;margin-top:6px;">
        <div id="raw-log-box" class="log-box"></div>
      </div>
    </div>
  </div>

  <!-- Error Card -->
  <div id="error-card" class="card error">
    <div class="stage-title">Error</div>
    <div id="error-message" class="stage-detail"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('repo-url');
    const submitBtn = document.getElementById('submit-btn');
    const clearBtn = document.getElementById('clear-btn');

    const progressCard = document.getElementById('progress-card');
    const stageText = document.getElementById('stage-text');
    const stageDetail = document.getElementById('stage-detail');
    const progressActions = document.getElementById('progress-actions');
    const cancelActiveBtn = document.getElementById('cancel-active-btn');

    const promptCard = document.getElementById('prompt-card');
    const promptMessage = document.getElementById('prompt-message');
    const promptPath = document.getElementById('prompt-path');
    const confirmReuseBtn = document.getElementById('confirm-reuse-btn');
    const cancelReuseBtn = document.getElementById('cancel-reuse-btn');

    const inspectionCard = document.getElementById('inspection-card');
    const inspectionBanner = document.getElementById('inspection-banner');
    const inspectionPath = document.getElementById('inspection-path');
    const inspectionTags = document.getElementById('inspection-tags');
    const depWarning = document.getElementById('dep-warning');
    const installDepsBtn = document.getElementById('install-deps-btn');
    const checksBtnGroup = document.getElementById('checks-btn-group');
    const missingChecksNote = document.getElementById('missing-checks-note');
    const openVsCodeBtn = document.getElementById('open-vscode-btn');

    const fixPreviewCard = document.getElementById('fix-preview-card');
    const fixTitle = document.getElementById('fix-title');
    const fixDesc = document.getElementById('fix-desc');
    const fixFile = document.getElementById('fix-file');
    const diffBox = document.getElementById('diff-box');
    const fixSafetyNotes = document.getElementById('fix-safety-notes');
    const applyFixBtn = document.getElementById('apply-fix-btn');

    const reverificationCard = document.getElementById('reverification-card');
    const reverifTitle = document.getElementById('reverif-title');
    const reverifMessage = document.getElementById('reverif-message');
    const prepPrBtn = document.getElementById('prep-pr-btn');
    const rollbackBtn = document.getElementById('rollback-btn');

    const prCard = document.getElementById('pr-card');
    const prPreflightInfo = document.getElementById('pr-preflight-info');
    const prBranchInput = document.getElementById('pr-branch-input');
    const createBranchBtn = document.getElementById('create-branch-btn');
    const prBranchStatus = document.getElementById('pr-branch-status');
    const prCommitSection = document.getElementById('pr-commit-section');
    const prStagedFile = document.getElementById('pr-staged-file');
    const prCommitTitle = document.getElementById('pr-commit-title');
    const prCommitBody = document.getElementById('pr-commit-body');
    const commitBtn = document.getElementById('commit-btn');
    const prReadySection = document.getElementById('pr-ready-section');
    const prCommitHashPill = document.getElementById('pr-commit-hash-pill');
    const openCompareUrlBtn = document.getElementById('open-compare-url-btn');
    const createGhCliBtn = document.getElementById('create-gh-cli-btn');
    const ghCliStatusMsg = document.getElementById('gh-cli-status-msg');

    let currentCompareUrl = '';
    let currentPrDetails = null;

    const diagnosticsCard = document.getElementById('diagnostics-card');
    const diagnosticsHeader = document.getElementById('diagnostics-header');
    const diagnosticsSummary = document.getElementById('diagnostics-summary');
    const issuesList = document.getElementById('issues-list');
    const toggleLogBtn = document.getElementById('toggle-log-btn');
    const rawLogContainer = document.getElementById('raw-log-container');
    const rawLogBox = document.getElementById('raw-log-box');

    const errorCard = document.getElementById('error-card');
    const errorMessage = document.getElementById('error-message');

    let currentDestPath = '';
    let currentInspection = null;
    let isLogVisible = false;

    function hideAllCards() {
      progressCard.classList.remove('active');
      promptCard.classList.remove('active');
      inspectionCard.classList.remove('active');
      fixPreviewCard.style.display = 'none';
      reverificationCard.style.display = 'none';
      prCard.style.display = 'none';
      diagnosticsCard.style.display = 'none';
      errorCard.classList.remove('active');
    }

    function setBusy(isBusy) {
      input.disabled = isBusy;
      submitBtn.disabled = isBusy;
      clearBtn.disabled = isBusy;
    }

    function submit() {
      const val = (input.value || '').trim();
      if (!val) {
        hideAllCards();
        errorMessage.textContent = 'Please enter a GitHub repository URL.';
        errorCard.classList.add('active');
        input.focus();
        return;
      }
      hideAllCards();
      setBusy(true);
      stageText.textContent = 'Validating repository URL...';
      stageDetail.textContent = val;
      progressActions.style.display = 'none';
      progressCard.classList.add('active');

      vscode.postMessage({
        command: 'submitUrl',
        url: val
      });
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });

    submitBtn.addEventListener('click', submit);

    clearBtn.addEventListener('click', () => {
      input.value = '';
      hideAllCards();
      setBusy(false);
      currentDestPath = '';
      currentInspection = null;
      vscode.postMessage({ command: 'clear' });
      input.focus();
    });

    cancelActiveBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'cancelActiveOperation' });
    });

    confirmReuseBtn.addEventListener('click', () => {
      promptCard.classList.remove('active');
      vscode.postMessage({
        command: 'confirmReuse',
        destPath: currentDestPath
      });
    });

    cancelReuseBtn.addEventListener('click', () => {
      hideAllCards();
      setBusy(false);
      currentDestPath = '';
      vscode.postMessage({ command: 'clear' });
    });

    openVsCodeBtn.addEventListener('click', () => {
      if (currentDestPath) {
        vscode.postMessage({
          command: 'openInVsCode',
          path: currentDestPath
        });
      }
    });

    installDepsBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'installDependencies' });
    });

    toggleLogBtn.addEventListener('click', () => {
      isLogVisible = !isLogVisible;
      rawLogContainer.style.display = isLogVisible ? 'block' : 'none';
      toggleLogBtn.textContent = isLogVisible ? 'Hide Full Terminal Output' : 'Show Full Terminal Output';
    });

    applyFixBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'applyAndVerifyFix' });
    });

    rollbackBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'rollbackFix' });
    });

    prepPrBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'preparePullRequest' });
    });

    createBranchBtn.addEventListener('click', () => {
      const branch = (prBranchInput.value || '').trim();
      if (!branch) {
        prBranchStatus.textContent = 'Please enter a valid branch name.';
        prBranchStatus.style.color = 'var(--vscode-inputValidation-errorBorder)';
        return;
      }
      prBranchStatus.textContent = 'Creating branch and verifying repository state...';
      prBranchStatus.style.color = 'var(--vscode-descriptionForeground)';
      vscode.postMessage({ command: 'createBranchAndStage', branchName: branch });
    });

    commitBtn.addEventListener('click', () => {
      const title = (prCommitTitle.value || '').trim();
      const body = (prCommitBody.value || '').trim();
      if (!title) {
        alert('Please enter a commit title.');
        return;
      }
      vscode.postMessage({ command: 'commitVerifiedFix', title, body });
    });

    openCompareUrlBtn.addEventListener('click', () => {
      if (currentCompareUrl) {
        vscode.postMessage({ command: 'openExternalUrl', url: currentCompareUrl });
      }
    });

    createGhCliBtn.addEventListener('click', () => {
      if (!currentPrDetails) return;
      vscode.postMessage({
        command: 'createGhPr',
        title: (prCommitTitle.value || '').trim(),
        body: (prCommitBody.value || '').trim(),
        base: currentPrDetails.baseBranch,
        head: currentPrDetails.headBranch,
      });
    });

    function renderInspection(banner, destPath, insp) {
      currentDestPath = destPath;
      currentInspection = insp;

      inspectionBanner.textContent = banner;
      inspectionPath.textContent = destPath;

      inspectionTags.innerHTML = '';
      if (insp.packageName) {
        inspectionTags.innerHTML += '<span class="tag">' + escapeHtml(insp.packageName) + (insp.version ? ' v' + escapeHtml(insp.version) : '') + '</span>';
      }
      if (insp.hasTsConfig) {
        inspectionTags.innerHTML += '<span class="tag">TypeScript</span>';
      }
      if (insp.lockfile && insp.lockfile !== 'none') {
        inspectionTags.innerHTML += '<span class="tag">Lock: ' + escapeHtml(insp.lockfile) + '</span>';
      }
      if (insp.dependenciesInstalled) {
        inspectionTags.innerHTML += '<span class="tag ok">Dependencies: Installed</span>';
        depWarning.style.display = 'none';
      } else {
        inspectionTags.innerHTML += '<span class="tag warn">Dependencies: Missing</span>';
        depWarning.style.display = 'block';
      }

      checksBtnGroup.innerHTML = '';
      const checks = insp.availableChecks || {};
      const checkKeys = Object.keys(checks);

      if (checkKeys.length === 0) {
        checksBtnGroup.innerHTML = '<div style="font-size:11px;color:var(--vscode-descriptionForeground);">No test, build, or lint scripts detected in package.json.</div>';
      } else {
        checkKeys.forEach(chk => {
          const btn = document.createElement('button');
          btn.className = 'check-btn';
          btn.textContent = 'Run ' + chk.toUpperCase() + ' (' + escapeHtml(checks[chk]) + ')';
          btn.addEventListener('click', () => {
            vscode.postMessage({
              command: 'runCheck',
              checkType: chk,
              scriptName: chk
            });
          });
          checksBtnGroup.appendChild(btn);
        });
      }

      if (insp.missingChecks && insp.missingChecks.length > 0) {
        missingChecksNote.textContent = 'Missing standard scripts: ' + insp.missingChecks.join(', ');
      } else {
        missingChecksNote.textContent = '';
      }

      inspectionCard.classList.add('active');
    }

    function renderDiffPreview(fix) {
      if (!fix) {
        fixPreviewCard.style.display = 'none';
        return;
      }
      fixTitle.textContent = fix.title;
      fixDesc.textContent = fix.description;
      fixFile.textContent = 'Target: ' + fix.relativeFilePath;

      // Color-code diff lines
      const lines = (fix.unifiedDiff || '').split('\\n');
      let coloredDiff = '';
      lines.forEach(l => {
        if (l.startsWith('+') && !l.startsWith('+++')) {
          coloredDiff += '<span class="diff-line-add">' + escapeHtml(l) + '</span>';
        } else if (l.startsWith('-') && !l.startsWith('---')) {
          coloredDiff += '<span class="diff-line-del">' + escapeHtml(l) + '</span>';
        } else {
          coloredDiff += '<span class="diff-line-ctx">' + escapeHtml(l) + '</span>';
        }
      });
      diffBox.innerHTML = coloredDiff;

      const notes = fix.safetyNotes || [];
      fixSafetyNotes.innerHTML = '<strong>Safety Guarantees:</strong> ' + escapeHtml(notes.join(' '));
      fixPreviewCard.style.display = 'block';
    }

    function renderDiagnosticReport(report, result) {
      diagnosticsCard.style.display = 'block';
      diagnosticsHeader.textContent = report.hasIssues ? 'Diagnostic Findings' : 'Check Passed Cleanly';
      diagnosticsSummary.textContent = report.summary;

      issuesList.innerHTML = '';
      (report.issues || []).forEach(issue => {
        const card = document.createElement('div');
        const isClean = issue.category === 'clean_pass';
        card.className = 'issue-card ' + (isClean ? 'clean_pass' : (issue.severity === 'warning' ? 'warning' : ''));

        let qualityClass = 'tag quality-strong';
        if (issue.evidenceQuality === 'Possible explanation') qualityClass = 'tag quality-possible';
        if (issue.evidenceQuality === 'Insufficient evidence') qualityClass = 'tag quality-insufficient';

        let locHtml = '';
        if (issue.location) {
          locHtml = '<div class="issue-location">Location: <strong>' + escapeHtml(issue.location.relativePath) +
                    (issue.location.line ? ':' + issue.location.line : '') +
                    (issue.location.column ? ':' + issue.location.column : '') + '</strong></div>';
        }

        card.innerHTML =
          '<div class="issue-header">' +
            '<div>' + escapeHtml(issue.title) + '</div>' +
            '<span class="' + qualityClass + '">' + escapeHtml(issue.evidenceQuality) + '</span>' +
          '</div>' +
          locHtml +
          '<div class="issue-field">' +
            '<div class="field-title">1. What Failed? (Observed Evidence)</div>' +
            '<div class="evidence-block">' + escapeHtml(issue.observedEvidence) + '</div>' +
          '</div>' +
          '<div class="issue-field">' +
            '<div class="field-title">2. Why It Likely Failed (Hypothesis)</div>' +
            '<div class="field-content">' + escapeHtml(issue.likelyExplanation) + '</div>' +
          '</div>' +
          '<div class="issue-field">' +
            '<div class="field-title">3. Recommended Next Step</div>' +
            '<div class="field-content">' + escapeHtml(issue.recommendedAction) + '</div>' +
          '</div>';

        issuesList.appendChild(card);
      });

      const output = (result.stdout ? result.stdout : '') + (result.stderr ? (result.stdout ? '\\n--- STDERR ---\\n' : '') + result.stderr : '');
      rawLogBox.textContent = output.trim() || '(No terminal output)';
      toggleLogBtn.textContent = 'Show Full Terminal Output (' + (result.command || 'npm') + ', exit ' + (result.exitCode !== null ? result.exitCode : 'N/A') + ')';
    }

    function escapeHtml(str) {
      return (str || '').replace(/[&<>"']/g, function(m) {
        switch(m) {
          case '&': return '&amp;';
          case '<': return '&lt;';
          case '>': return '&gt;';
          case '"': return '&quot;';
          case "'": return '&#39;';
          default: return m;
        }
      });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.command) {
        case 'stageUpdate': {
          hideAllCards();
          stageText.textContent = msg.detail || 'Working...';
          stageDetail.textContent = '';
          progressActions.style.display = msg.cancellable ? 'block' : 'none';
          progressCard.classList.add('active');
          break;
        }

        case 'progressUpdate': {
          if (msg.detail) {
            stageDetail.textContent = msg.detail;
          }
          break;
        }

        case 'checkStream': {
          stageDetail.textContent = msg.chunk ? msg.chunk.trim().split('\\n').pop() : '';
          break;
        }

        case 'promptReuse': {
          hideAllCards();
          setBusy(false);
          currentDestPath = msg.destPath;
          promptMessage.textContent = msg.message;
          promptPath.textContent = msg.destPath;
          promptCard.classList.add('active');
          break;
        }

        case 'inspectionComplete': {
          hideAllCards();
          setBusy(false);
          renderInspection(msg.bannerMessage, msg.destPath, msg.inspection);
          break;
        }

        case 'checkFinished': {
          hideAllCards();
          setBusy(false);
          if (msg.inspection) {
            renderInspection('Repository Ready', currentDestPath, msg.inspection);
          }
          if (msg.diagnosticReport && msg.result) {
            renderDiagnosticReport(msg.diagnosticReport, msg.result);
          }
          renderDiffPreview(msg.proposedFix);
          break;
        }

        case 'reverificationComplete': {
          hideAllCards();
          setBusy(false);
          if (currentInspection) {
            renderInspection('Repository Ready', currentDestPath, currentInspection);
          }
          const isPassed = msg.recheckResult.exitCode === 0;
          reverificationCard.className = 'card active ' + (isPassed ? 'success' : 'error');
          reverifTitle.textContent = isPassed ? 'Fix Verified Successfully' : 'Re-verification Failed';
          reverifMessage.textContent = isPassed
            ? 'Applied patch "' + escapeHtml(msg.appliedFixTitle || '') + '" resolved the issue! All checks exited with code 0.'
            : 'Check failed again with exit code ' + msg.recheckResult.exitCode + '. You can rollback below.';
          prepPrBtn.style.display = isPassed ? 'block' : 'none';
          reverificationCard.style.display = 'block';

          if (msg.recheckDiagnosis && msg.recheckResult) {
            renderDiagnosticReport(msg.recheckDiagnosis, msg.recheckResult);
          }
          break;
        }

        case 'prWorkflowReady': {
          prCard.style.display = 'block';
          prCommitSection.style.display = 'none';
          prReadySection.style.display = 'none';

          if (msg.preflight.hasUnrelatedChanges) {
            prPreflightInfo.innerHTML =
              '<span style="color:var(--vscode-inputValidation-warningBorder, #cca700);">⚠️ Warning:</span> Target repository has unrelated uncommitted changes (' +
              escapeHtml(msg.preflight.unrelatedFiles.join(', ')) + '). FirstPR will <strong>strictly stage only</strong> the verified fix file (' +
              escapeHtml(msg.targetFile) + ') to protect your work.';
          } else {
            prPreflightInfo.innerHTML =
              '<span style="color:var(--vscode-testing-iconPassed, #4ec9b0);">✓ Clean repository state.</span> Current branch: <strong>' +
              escapeHtml(msg.preflight.currentBranch || 'HEAD') + '</strong>.';
          }

          prBranchInput.value = msg.proposedBranchName;
          prBranchStatus.textContent = '';
          prStagedFile.textContent = msg.targetFile;
          prCommitTitle.value = msg.prDetails.title;
          prCommitBody.value = msg.prDetails.body;
          currentPrDetails = msg.prDetails;
          currentCompareUrl = msg.prDetails.compareUrl;
          break;
        }

        case 'branchCreatedAndStaged': {
          prBranchStatus.textContent = '✓ Active branch: ' + msg.branchRes.branchName;
          prBranchStatus.style.color = 'var(--vscode-testing-iconPassed, #4ec9b0)';
          prCommitSection.style.display = 'block';
          prCommitTitle.value = msg.prDetails.title;
          prCommitBody.value = msg.prDetails.body;
          currentPrDetails = msg.prDetails;
          currentCompareUrl = msg.prDetails.compareUrl;
          break;
        }

        case 'commitSuccess': {
          prCommitSection.style.display = 'none';
          prReadySection.style.display = 'block';
          prCommitHashPill.textContent = 'Commit: ' + (msg.commitRes.shortHash || msg.commitRes.commitHash || 'HEAD') + ' on ' + (msg.commitRes.branch || '');
          currentCompareUrl = msg.prDetails.compareUrl;
          currentPrDetails = msg.prDetails;

          if (msg.ghCli && msg.ghCli.authenticated) {
            createGhCliBtn.style.display = 'block';
            ghCliStatusMsg.textContent = 'GitHub CLI detected and authenticated' + (msg.ghCli.account ? ' (' + msg.ghCli.account + ')' : '') + '.';
          } else {
            createGhCliBtn.style.display = 'none';
            ghCliStatusMsg.textContent = 'GitHub Compare link ready for one-click browser submission.';
          }
          break;
        }

        case 'ghPrCreated': {
          if (msg.result.success) {
            ghCliStatusMsg.innerHTML = '<span style="color:var(--vscode-testing-iconPassed, #4ec9b0);">✓ Pull Request created:</span> <a href="' + escapeHtml(msg.result.url) + '" style="color:var(--vscode-textLink-foreground);">' + escapeHtml(msg.result.url) + '</a>';
          } else {
            ghCliStatusMsg.textContent = 'GitHub CLI notice: ' + (msg.result.error || 'Could not create PR automatically.');
          }
          break;
        }

        case 'error': {
          hideAllCards();
          setBusy(false);
          errorMessage.textContent = msg.message || 'An error occurred.';
          errorCard.classList.add('active');
          break;
        }

        case 'reset': {
          hideAllCards();
          setBusy(false);
          currentDestPath = '';
          currentInspection = null;
          break;
        }
      }
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
