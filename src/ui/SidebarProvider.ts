import * as vscode from 'vscode';
import { validateGitHubUrl, ValidationResult } from '../core/urlValidator';
import {
  getRepoDestination,
  checkDestination,
  ensureParentDirectory,
} from '../core/workspaceManager';
import { checkGitAvailable, cloneRepository } from '../core/gitService';

export class FirstPRSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'firstpr.sidebarView';
  private _view?: vscode.WebviewView;
  private _isBusy = false;
  private _abortController: AbortController | null = null;
  private _activeDestPath: string | null = null;

  public get activeDestPath(): string | null {
    return this._activeDestPath;
  }

  public get currentView(): vscode.WebviewView | undefined {
    return this._view;
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
        case 'cancelClone':
          this._handleCancelClone();
          break;
        case 'openInVsCode':
          await this._handleOpenFolder(message.path);
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

    // 3. Workspace Preparation & Destination Selection
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
        // Offer choice to reuse existing repository or cancel
        this._postToWebview({
          command: 'promptReuse',
          destPath,
          message: `The repository already exists locally. Would you like to reuse this existing repository or cancel?`,
        });
        return;
      } else {
        this._postToWebview({
          command: 'error',
          message: `Destination directory "${destPath}" already exists and is not a valid Git repository. FirstPR will not overwrite it. Please remove or rename it manually.`,
        });
        return;
      }
    }

    // 5. Proceed with Fresh Clone
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

      this._postToWebview({
        command: 'cloneSuccess',
        destPath,
        message: 'Repository cloned successfully.',
      });
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

    this._isBusy = false;
    this._postToWebview({
      command: 'cloneSuccess',
      destPath,
      message: 'Reusing existing repository.',
    });
  }

  private _handleCancelClone(): void {
    if (this._abortController) {
      this._postToWebview({
        command: 'progressUpdate',
        detail: 'Cancelling clone and cleaning up...',
      });
      this._abortController.abort();
    }
  }

  private async _handleOpenFolder(folderPath: string): Promise<void> {
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
      margin-bottom: 16px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, #333));
      padding-bottom: 12px;
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
      flex: 1;
      padding: 7px 10px;
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
    }
    .primary-btn:hover:not(:disabled) {
      background-color: var(--vscode-button-hoverBackground);
    }
    .secondary-btn {
      background-color: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
      flex: 0 0 auto;
    }
    .secondary-btn:hover:not(:disabled) {
      background-color: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
    .danger-btn {
      background-color: var(--vscode-errorForeground, #d9534f);
      color: #ffffff;
      flex: 0 0 auto;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Progress & Status Cards */
    .card {
      margin-top: 14px;
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
      margin-bottom: 4px;
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
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .path-pill {
      margin-top: 8px;
      padding: 6px 8px;
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
      gap: 8px;
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
      <button id="cancel-clone-btn" class="danger-btn">Cancel Clone</button>
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

  <!-- Success Card -->
  <div id="success-card" class="card success">
    <div class="stage-title" id="success-title">Success</div>
    <div id="success-message" class="stage-detail"></div>
    <div id="success-path" class="path-pill"></div>
    <div class="btn-group">
      <button id="open-vscode-btn" class="primary-btn">Open in VS Code</button>
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
    const cancelCloneBtn = document.getElementById('cancel-clone-btn');

    const promptCard = document.getElementById('prompt-card');
    const promptMessage = document.getElementById('prompt-message');
    const promptPath = document.getElementById('prompt-path');
    const confirmReuseBtn = document.getElementById('confirm-reuse-btn');
    const cancelReuseBtn = document.getElementById('cancel-reuse-btn');

    const successCard = document.getElementById('success-card');
    const successTitle = document.getElementById('success-title');
    const successMessage = document.getElementById('success-message');
    const successPath = document.getElementById('success-path');
    const openVsCodeBtn = document.getElementById('open-vscode-btn');

    const errorCard = document.getElementById('error-card');
    const errorMessage = document.getElementById('error-message');

    let currentDestPath = '';

    function hideAllCards() {
      progressCard.classList.remove('active');
      promptCard.classList.remove('active');
      successCard.classList.remove('active');
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
      vscode.postMessage({ command: 'clear' });
      input.focus();
    });

    cancelCloneBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'cancelClone' });
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

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.command) {
        case 'stageUpdate': {
          hideAllCards();
          stageText.textContent = msg.detail || 'Working...';
          stageDetail.textContent = '';
          if (msg.cancellable) {
            progressActions.style.display = 'block';
          } else {
            progressActions.style.display = 'none';
          }
          progressCard.classList.add('active');
          break;
        }

        case 'progressUpdate': {
          if (msg.detail) {
            stageDetail.textContent = msg.detail;
          }
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

        case 'cloneSuccess': {
          hideAllCards();
          setBusy(false);
          currentDestPath = msg.destPath;
          successTitle.textContent = 'Repository Ready';
          successMessage.textContent = msg.message;
          successPath.textContent = msg.destPath;
          successCard.classList.add('active');
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
