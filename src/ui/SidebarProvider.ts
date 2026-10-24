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

export class FirstPRSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'firstpr.sidebarView';
  private _view?: vscode.WebviewView;
  private _isBusy = false;
  private _abortController: AbortController | null = null;
  private _activeDestPath: string | null = null;
  private _lastInspection: ProjectInspection | null = null;

  public get activeDestPath(): string | null {
    return this._activeDestPath;
  }

  public get currentView(): vscode.WebviewView | undefined {
    return this._view;
  }

  public get lastInspection(): ProjectInspection | null {
    return this._lastInspection;
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
        case 'clear':
          this._handleReset();
          break;
      }
    });
  }

  private async _handleStartWorkflow(rawUrl: string): Promise<void> {
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

    // 1. Validate URL
    const validation: ValidationResult = validateGitHubUrl(rawUrl);
    if (!validation.isValid) {
      this._isBusy = false;
      this._postToWebview({ command: 'error', message: validation.error });
      return;
    }

    // 2. Verify Git Availability
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

    // 3. Workspace Destination Selection
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

    // 4. Check if Destination Already Exists
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

    // 5. Fresh Clone
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

      // Automatically inspect project after successful clone
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
        timeoutMs: 180 * 1000, // 3 minutes for install
        onStdout: (chunk) => {
          this._postToWebview({ command: 'checkStream', stream: 'stdout', chunk });
        },
        onStderr: (chunk) => {
          this._postToWebview({ command: 'checkStream', stream: 'stderr', chunk });
        },
      });

      this._isBusy = false;
      this._abortController = null;

      // Re-inspect to update dependency status
      const reInspection = inspectProject(this._activeDestPath);
      this._lastInspection = reInspection;

      this._postToWebview({
        command: 'checkFinished',
        result,
        inspection: reInspection,
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

      this._isBusy = false;
      this._abortController = null;

      this._postToWebview({
        command: 'checkFinished',
        result,
        inspection: this._lastInspection,
      });
    } catch (err: unknown) {
      this._isBusy = false;
      this._abortController = null;
      const msg = err instanceof Error ? err.message : String(err);
      this._postToWebview({ command: 'error', message: msg });
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
    .tag.warn {
      background: #cca700;
      color: #000;
    }
    .tag.ok {
      background: #28a745;
      color: #fff;
    }
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
      margin-top: 8px;
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

  <!-- Project Inspection & Check Runner Card -->
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

  <!-- Check Result Card -->
  <div id="result-card" class="card">
    <div class="stage-title" id="result-title">Check Result</div>
    <div class="tag-row" id="result-tags"></div>
    <div id="result-explanation" style="margin-top:6px;font-size:11px;line-height:1.4;"></div>
    <div class="section-subtitle">Terminal Output:</div>
    <div id="result-output" class="log-box"></div>
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
    const inspectionTitle = document.getElementById('inspection-title');
    const inspectionBanner = document.getElementById('inspection-banner');
    const inspectionPath = document.getElementById('inspection-path');
    const inspectionTags = document.getElementById('inspection-tags');
    const depWarning = document.getElementById('dep-warning');
    const installDepsBtn = document.getElementById('install-deps-btn');
    const checksBtnGroup = document.getElementById('checks-btn-group');
    const missingChecksNote = document.getElementById('missing-checks-note');
    const openVsCodeBtn = document.getElementById('open-vscode-btn');

    const resultCard = document.getElementById('result-card');
    const resultTitle = document.getElementById('result-title');
    const resultTags = document.getElementById('result-tags');
    const resultExplanation = document.getElementById('result-explanation');
    const resultOutput = document.getElementById('result-output');

    const errorCard = document.getElementById('error-card');
    const errorMessage = document.getElementById('error-message');

    let currentDestPath = '';
    let currentInspection = null;

    function hideAllCards() {
      progressCard.classList.remove('active');
      promptCard.classList.remove('active');
      inspectionCard.classList.remove('active');
      resultCard.classList.remove('active');
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

    function renderInspection(banner, destPath, insp) {
      currentDestPath = destPath;
      currentInspection = insp;

      inspectionBanner.textContent = banner;
      inspectionPath.textContent = destPath;

      // Tags
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

      // Check Buttons
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

      // Missing checks
      if (insp.missingChecks && insp.missingChecks.length > 0) {
        missingChecksNote.textContent = 'Missing standard scripts: ' + insp.missingChecks.join(', ');
      } else {
        missingChecksNote.textContent = '';
      }

      inspectionCard.classList.add('active');
    }

    function renderCheckResult(result) {
      resultCard.className = 'card active ' + (result.status === 'passed' ? 'success' : (result.status === 'failed' ? 'error' : 'info'));
      resultTitle.textContent = 'Check: ' + (result.checkName || 'Execution');

      resultTags.innerHTML =
        '<span class="tag ' + (result.status === 'passed' ? 'ok' : 'warn') + '">Status: ' + escapeHtml(result.status.toUpperCase()) + '</span>' +
        '<span class="tag">Exit Code: ' + (result.exitCode !== null ? result.exitCode : 'N/A') + '</span>' +
        '<span class="tag">' + Math.round(result.durationMs || 0) + 'ms</span>';

      resultExplanation.textContent = result.explanation || '';

      const output = (result.stdout ? result.stdout : '') + (result.stderr ? (result.stdout ? '\n--- STDERR ---\n' : '') + result.stderr : '');
      resultOutput.textContent = output.trim() || '(No output recorded)';
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
          stageDetail.textContent = msg.chunk ? msg.chunk.trim().split('\n').pop() : '';
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
          renderCheckResult(msg.result);
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
