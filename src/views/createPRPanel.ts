import * as vscode from 'vscode';
import { AzureDevOpsApi } from '../api/azureDevOpsApi';
import { GitHelper } from '../utils/gitHelper';

export class CreatePRPanel {
  static currentPanel: CreatePRPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  static async createOrShow(
    extensionUri: vscode.Uri,
    api: AzureDevOpsApi,
    gitHelper: GitHelper,
    currentBranch?: string
  ) {
    const column = vscode.ViewColumn.One;

    if (CreatePRPanel.currentPanel) {
      CreatePRPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'azureDevOpsCreatePR',
      'Create Pull Request',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    CreatePRPanel.currentPanel = new CreatePRPanel(panel, api, gitHelper, currentBranch);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private api: AzureDevOpsApi,
    private gitHelper: GitHelper,
    private currentBranch?: string
  ) {
    this._panel = panel;
    this._render();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === 'create') {
          await this.handleCreate(message);
        }
        if (message.command === 'cancel') {
          this.dispose();
        }
        if (message.command === 'loadRepos') {
          await this.loadRepos();
        }
      },
      null,
      this._disposables
    );
  }

  private async loadRepos() {
    try {
      const repos = await this.api.getRepositories();
      this._panel.webview.postMessage({ command: 'reposLoaded', repos: repos.map(r => ({ id: r.id, name: r.name })) });

      if (repos.length > 0) {
        const defaultRepo = repos[0];
        const branches = await this.api.getBranches(defaultRepo.id!);
        this._panel.webview.postMessage({ command: 'branchesLoaded', branches: branches.map(b => b.name) });
      }
    } catch (err: any) {
      this._panel.webview.postMessage({ command: 'error', message: err?.message ?? String(err) });
    }
  }

  private async handleCreate(message: any) {
    const { repositoryId, title, description, sourceBranch, targetBranch, isDraft } = message;

    if (!title?.trim()) {
      this._panel.webview.postMessage({ command: 'validationError', field: 'title', message: 'Title is required' });
      return;
    }

    if (!sourceBranch || !targetBranch) {
      this._panel.webview.postMessage({ command: 'validationError', field: 'branch', message: 'Source and target branches are required' });
      return;
    }

    if (sourceBranch === targetBranch) {
      this._panel.webview.postMessage({ command: 'validationError', field: 'branch', message: 'Source and target branches must be different' });
      return;
    }

    try {
      const pr = await this.api.createPullRequest(repositoryId, title, description, sourceBranch, targetBranch, isDraft);
      this._panel.webview.postMessage({ command: 'created', pullRequestId: pr.pullRequestId });
      vscode.window.showInformationMessage(`✅ PR #${pr.pullRequestId} created: "${title}"`, 'Open in Browser').then(action => {
        if (action === 'Open in Browser' && pr._links?.web?.href) {
          vscode.env.openExternal(vscode.Uri.parse(pr._links.web.href));
        }
      });
      setTimeout(() => this.dispose(), 2000);
    } catch (err: any) {
      this._panel.webview.postMessage({ command: 'error', message: `Failed to create PR: ${err?.message ?? err}` });
    }
  }

  private _render() {
    const currentBranch = this.currentBranch ?? '';
    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px; max-width: 700px; }
    h1 { font-size: 1.3em; margin-bottom: 20px; }
    .field { margin-bottom: 16px; }
    label { display: block; margin-bottom: 4px; font-weight: 500; }
    input, select, textarea { width: 100%; padding: 6px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; font-family: inherit; font-size: inherit; box-sizing: border-box; }
    textarea { min-height: 100px; resize: vertical; }
    .branch-row { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; }
    .arrow-label { text-align: center; color: var(--vscode-descriptionForeground); }
    .checkbox-row { display: flex; align-items: center; gap: 8px; }
    .checkbox-row input { width: auto; }
    .actions { display: flex; gap: 10px; margin-top: 20px; }
    button { padding: 7px 18px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; font-size: 0.9em; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .error { color: var(--vscode-errorForeground); font-size: 0.88em; margin-top: 4px; }
    .success { color: var(--vscode-testing-iconPassed); font-weight: bold; text-align: center; padding: 16px; }
    .loading { color: var(--vscode-descriptionForeground); font-style: italic; }
  </style>
</head>
<body>
  <h1>🔀 Create Pull Request</h1>

  <div class="field">
    <label for="repoSelect">Repository</label>
    <select id="repoSelect" onchange="onRepoChange()">
      <option value="">Loading repositories...</option>
    </select>
  </div>

  <div class="field">
    <label>Branches</label>
    <div class="branch-row">
      <select id="sourceBranch">
        <option value="${currentBranch}">${currentBranch || 'Loading...'}</option>
      </select>
      <div class="arrow-label">→</div>
      <select id="targetBranch">
        <option value="">Loading...</option>
      </select>
    </div>
    <div id="branchError" class="error" style="display:none"></div>
  </div>

  <div class="field">
    <label for="prTitle">Title <span style="color:var(--vscode-errorForeground)">*</span></label>
    <input type="text" id="prTitle" placeholder="Brief description of your changes">
    <div id="titleError" class="error" style="display:none"></div>
  </div>

  <div class="field">
    <label for="prDescription">Description</label>
    <textarea id="prDescription" placeholder="Describe the changes in this PR (optional)"></textarea>
  </div>

  <div class="field">
    <div class="checkbox-row">
      <input type="checkbox" id="isDraft">
      <label for="isDraft" style="margin:0">Create as Draft</label>
    </div>
  </div>

  <div id="globalError" class="error" style="display:none"></div>
  <div id="successMsg" class="success" style="display:none">✅ Pull request created!</div>

  <div class="actions">
    <button class="btn-primary" onclick="submitPR()">Create Pull Request</button>
    <button class="btn-secondary" onclick="cancel()">Cancel</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let repos = [];

    // Load repos on startup
    vscode.postMessage({ command: 'loadRepos' });

    function onRepoChange() {
      const repoId = document.getElementById('repoSelect').value;
      // Could trigger branch reload per repo if needed
    }

    function submitPR() {
      const title = document.getElementById('prTitle').value.trim();
      const description = document.getElementById('prDescription').value.trim();
      const sourceBranch = document.getElementById('sourceBranch').value;
      const targetBranch = document.getElementById('targetBranch').value;
      const isDraft = document.getElementById('isDraft').checked;
      const repositoryId = document.getElementById('repoSelect').value;

      document.getElementById('titleError').style.display = 'none';
      document.getElementById('branchError').style.display = 'none';
      document.getElementById('globalError').style.display = 'none';

      vscode.postMessage({ command: 'create', repositoryId, title, description, sourceBranch, targetBranch, isDraft });
    }

    function cancel() {
      vscode.postMessage({ command: 'cancel' });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      
      if (msg.command === 'reposLoaded') {
        const sel = document.getElementById('repoSelect');
        sel.innerHTML = msg.repos.map(r => \`<option value="\${r.id}">\${r.name}</option>\`).join('');
      }
      
      if (msg.command === 'branchesLoaded') {
        const branches = msg.branches ?? [];
        const source = document.getElementById('sourceBranch');
        const target = document.getElementById('targetBranch');
        const current = '${currentBranch}';

        source.innerHTML = branches.map(b => \`<option value="\${b}" \${b === current ? 'selected' : ''}>\${b}</option>\`).join('');
        const defaultTarget = branches.find(b => b === 'main' || b === 'master' || b === 'develop') ?? branches[0] ?? '';
        target.innerHTML = branches.map(b => \`<option value="\${b}" \${b === defaultTarget ? 'selected' : ''}>\${b}</option>\`).join('');
      }

      if (msg.command === 'validationError') {
        const field = msg.field === 'title' ? 'titleError' : 'branchError';
        const el = document.getElementById(field);
        el.textContent = msg.message;
        el.style.display = 'block';
      }

      if (msg.command === 'error') {
        const el = document.getElementById('globalError');
        el.textContent = msg.message;
        el.style.display = 'block';
      }

      if (msg.command === 'created') {
        document.getElementById('successMsg').style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
  }

  dispose() {
    CreatePRPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}
