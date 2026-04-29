import * as vscode from 'vscode';
import { AzureDevOpsApi, WorkItemSummary } from '../api/azureDevOpsApi';
import { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { GitHelper } from '../utils/gitHelper';
import { formatCommentContent } from '../utils/commentFormatter';
import { PRCommentController } from './prCommentController';
import { inferLinkedWorkItemIds } from '../utils/workItemHelper';

/**
 * Content provider for viewing Azure DevOps Companion PR file contents via virtual documents.
 * Registers the `ado-pr` scheme so VS Code can open diffs.
 */
export class ADOFileContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private api: AzureDevOpsApi) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // URI format: ado-pr://{repoId}/{path}?ref={commitOrBranch}&type={commit|branch}
    const repoId = uri.authority;
    const filePath = uri.path;
    const params = new URLSearchParams(uri.query);
    const ref = params.get('ref') ?? '';
    const type = params.get('type') ?? 'commit';

    try {
      if (type === 'branch') {
        return await this.api.getFileContentByBranch(repoId, filePath, ref);
      } else {
        return await this.api.getFileContent(repoId, filePath, ref);
      }
    } catch {
      return `// Unable to load file content for ${filePath} at ${ref}`;
    }
  }
}

export class PRDetailPanel {
  static currentPanel: PRDetailPanel | undefined;
  private static _outputChannel: vscode.OutputChannel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _changedFiles: Array<{ path: string; changeType: string; originalPath?: string }> = [];
  private _linkedWorkItems: WorkItemSummary[] = [];

  private static log(msg: string) {
    const line = `[PRDetailPanel] ${msg}`;
    PRDetailPanel._outputChannel?.appendLine(line);
    console.log(line);
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    pr: GitPullRequest,
    api: AzureDevOpsApi,
    gitHelper?: GitHelper,
    commentController?: PRCommentController,
    outputChannel?: vscode.OutputChannel
  ) {
    if (outputChannel) { PRDetailPanel._outputChannel = outputChannel; }
    PRDetailPanel.log(`createOrShow called for PR #${pr.pullRequestId}`);
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (PRDetailPanel.currentPanel) {
      PRDetailPanel.currentPanel._panel.reveal(column);
      PRDetailPanel.currentPanel.update(pr, api, gitHelper, commentController);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'azureDevOpsPRDetail',
      `PR #${pr.pullRequestId}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
      }
    );

    PRDetailPanel.currentPanel = new PRDetailPanel(panel, pr, api, gitHelper, commentController);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private pr: GitPullRequest,
    private api: AzureDevOpsApi,
    private gitHelper?: GitHelper,
    private commentController?: PRCommentController
  ) {
    this._panel = panel;
    if (commentController) {
      commentController.setPR(pr);
    }
    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        PRDetailPanel.log(`Received webview message: ${JSON.stringify(message)}`);
        switch (message.command) {
          case 'webviewLog':
            PRDetailPanel.log(`[Webview] ${message.text}`);
            return;
          case 'webviewError':
            PRDetailPanel.log(`[Webview ERROR] ${message.text}`);
            return;
          case 'addComment':
            await this.handleAddComment(message.content);
            break;
          case 'openInBrowser':
            await this.handleOpenInBrowser();
            break;
          case 'refresh':
            await this._update();
            break;
          case 'openDiff':
            await this.handleOpenDiff(message.index);
            break;
          case 'openAllDiffs':
            await this.handleOpenAllDiffs();
            break;
          case 'reviewWithCopilot':
            await this.handleReviewWithCopilot(message.customPrompt, message.agent);
            break;
          case 'vote':
            await this.handleVote(message.vote);
            break;
          case 'resolveThread':
            await this.handleResolveThread(message.threadId);
            break;
          case 'reactivateThread':
            await this.handleReactivateThread(message.threadId);
            break;
          case 'replyToThread':
            await this.handleReplyToThread(message.threadId, message.content);
            break;
          case 'openWorkItem':
            await this.handleOpenWorkItem(message.workItemId);
            break;
          case 'setWorkItemState':
            await this.handleSetWorkItemState(message.workItemId);
            break;
          case 'addWorkItemNote':
            await this.handleAddWorkItemNote(message.workItemId);
            break;
          case 'assignWorkItemToMe':
            await this.handleAssignWorkItemToMe(message.workItemId);
            break;
        }
      },
      null,
      this._disposables
    );
  }

  async refresh() {
    await this._update();
  }

  async update(pr: GitPullRequest, api: AzureDevOpsApi, gitHelper?: GitHelper, commentController?: PRCommentController) {
    this.pr = pr;
    this.api = api;
    if (gitHelper) { this.gitHelper = gitHelper; }
    if (commentController) {
      this.commentController = commentController;
      commentController.setPR(pr);
    }
    await this._update();
  }

  private async handleOpenInBrowser() {
    const linked = this.pr._links?.web?.href;
    if (linked) {
      await vscode.env.openExternal(vscode.Uri.parse(linked));
      return;
    }

    const config = vscode.workspace.getConfiguration('azureDevOpsPR');
    const orgUrl = config.get<string>('organizationUrl', '').trim().replace(/\/$/, '');
    const project = this.pr.repository?.project?.name || config.get<string>('project', '').trim();
    const repo = this.pr.repository?.name;
    const prId = this.pr.pullRequestId;
    if (!orgUrl || !project || !repo || !prId) {
      vscode.window.showWarningMessage('Unable to determine PR URL.');
      return;
    }

    const url = `${orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${prId}`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private async handleOpenDiff(index: number) {
    const file = this._changedFiles[index];
    if (!file) { return; }

    const repoId = this.pr.repository?.id;
    if (!repoId) { return; }

    const sourceBranch = this.pr.sourceRefName?.replace('refs/heads/', '') ?? '';
    const targetBranch = this.pr.targetRefName?.replace('refs/heads/', '') ?? '';
    const filePath = file.path.startsWith('/') ? file.path : `/${file.path}`;

    if (file.changeType === 'add') {
      const sourceUri = vscode.Uri.parse(`ado-pr://${repoId}${filePath}?ref=${encodeURIComponent(sourceBranch)}&type=branch`);
      await vscode.window.showTextDocument(sourceUri, { preview: true });
    } else if (file.changeType === 'delete') {
      const targetUri = vscode.Uri.parse(`ado-pr://${repoId}${filePath}?ref=${encodeURIComponent(targetBranch)}&type=branch`);
      await vscode.window.showTextDocument(targetUri, { preview: true });
    } else {
      const origPath = file.originalPath ?? file.path;
      const origFilePath = origPath.startsWith('/') ? origPath : `/${origPath}`;
      const targetUri = vscode.Uri.parse(`ado-pr://${repoId}${origFilePath}?ref=${encodeURIComponent(targetBranch)}&type=branch`);
      const sourceUri = vscode.Uri.parse(`ado-pr://${repoId}${filePath}?ref=${encodeURIComponent(sourceBranch)}&type=branch`);
      const fileName = filePath.split('/').pop() ?? filePath;
      await vscode.commands.executeCommand('vscode.diff', targetUri, sourceUri, `${fileName} (${targetBranch} ↔ ${sourceBranch})`, { preview: true });
    }
  }

  private async handleOpenAllDiffs() {
    for (let i = 0; i < this._changedFiles.length; i++) {
      await this.handleOpenDiff(i);
    }
  }

  private async handleReviewWithCopilot(customPrompt?: string, agentMode?: string) {
    const branchName = this.pr.sourceRefName?.replace('refs/heads/', '');
    if (!branchName) {
      vscode.window.showErrorMessage('Cannot determine source branch for this PR.');
      this._panel.webview.postMessage({ command: 'reviewStatus', status: 'error' });
      return;
    }

    if (!this.gitHelper) {
      vscode.window.showErrorMessage('Git helper not available.');
      this._panel.webview.postMessage({ command: 'reviewStatus', status: 'error' });
      return;
    }

    const confirm = await vscode.window.showInformationMessage(
      `This will checkout branch "${branchName}" and open all ${this._changedFiles.length} changed files so Copilot can review them.\n\nAny uncommitted changes will need to be stashed first.`,
      { modal: true },
      'Checkout & Open Files'
    );
    if (confirm !== 'Checkout & Open Files') {
      this._panel.webview.postMessage({ command: 'reviewStatus', status: 'error' });
      return;
    }

    try {
      this._panel.webview.postMessage({ command: 'reviewStatus', status: 'checking-out' });
      await this.gitHelper.checkoutBranch(branchName);

      // Find the workspace folder root
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open.');
        this._panel.webview.postMessage({ command: 'reviewStatus', status: 'error' });
        return;
      }
      const rootUri = workspaceFolders[0].uri;

      // Open each changed file on disk
      const openedFiles: string[] = [];
      for (const file of this._changedFiles) {
        if (file.changeType === 'delete') { continue; }
        const filePath = file.path.startsWith('/') ? file.path.substring(1) : file.path;
        const fileUri = vscode.Uri.joinPath(rootUri, filePath);
        try {
          await vscode.workspace.fs.stat(fileUri); // verify it exists
          await vscode.window.showTextDocument(fileUri, { preview: false, preserveFocus: true });
          openedFiles.push(filePath);
        } catch {
          // File may not exist locally (e.g. in a different repo root)
        }
      }

      this._panel.webview.postMessage({ command: 'reviewStatus', status: 'ready' });

      // Build a focused Copilot review prompt scoped to the changed files
      const fileList = openedFiles.map(f => `- ${f}`).join('\n');
      const prTitle = this.pr.title ?? 'Untitled PR';
      const prDesc = this.pr.description?.substring(0, 500) ?? '';

      const defaultPrompt = [
        `Review the following pull request changes for errors, bugs, typos, and mistakes ONLY. Do NOT suggest style improvements, refactoring, or enhancements.`,
        ``,
        `For each issue found, apply the fix directly to the file. Only fix actual bugs, errors, typos, and mistakes — do not refactor or change style.`,
        `After applying all fixes, provide a summary of what was changed and why.`,
        `If no issues are found, say "No bugs, errors, typos, or mistakes found."`,
      ].join('\n');

      const userPrompt = customPrompt?.trim() || defaultPrompt;

      const contextBlock = [
        `PR: "${prTitle}"`,
        prDesc ? `Description: ${prDesc}` : '',
        ``,
        `Changed files:`,
        fileList,
      ].filter(l => l !== undefined).join('\n');

      const fullPrompt = `${userPrompt}\n\n${contextBlock}`;
      const mode = agentMode || 'agent';

      // Always copy prompt to clipboard as a reliable fallback
      await vscode.env.clipboard.writeText(fullPrompt);

      // Try to open Copilot Chat and pre-fill the prompt
      // The chat.open command accepts { query, isPartialQuery } but
      // agent mode selection is not directly supported via command args.
      // We open chat with the prompt pre-filled; the user can switch modes in the chat UI.
      try {
        const query = mode === 'ask' ? `@workspace ${fullPrompt}` : fullPrompt;
        await vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: false });
      } catch {
        try {
          await vscode.commands.executeCommand('workbench.action.chat.open');
        } catch {
          // Chat not available at all
        }
      }

      vscode.window.showInformationMessage(
        `✅ Opened ${openedFiles.length} files and sent prompt to Copilot Chat. Prompt is also in your clipboard (Ctrl+V) if needed.`
      );
    } catch (err: any) {
      this._panel.webview.postMessage({ command: 'reviewStatus', status: 'error' });
      vscode.window.showErrorMessage(`Failed to checkout: ${err?.message ?? err}`);
    }
  }

  private async handleAddComment(content: string) {
    if (!content?.trim()) {
      return;
    }
    try {
      const repoId = this.pr.repository?.id!;
      const prId = this.pr.pullRequestId!;
      await this.api.addComment(repoId, prId, content);
      await this._update(); // Refresh threads
      this._panel.webview.postMessage({ command: 'commentAdded' });
    } catch (err: any) {
      this._panel.webview.postMessage({
        command: 'error',
        message: `Failed to add comment: ${err?.message ?? err}`,
      });
    }
  }

  private async handleVote(vote: number) {
    try {
      await this.api.votePullRequest(this.pr, vote);
      const labels: Record<number, string> = {
        10: 'Approved', 5: 'Approved with suggestions',
        0: 'Vote reset', [-5]: 'Waiting for author', [-10]: 'Rejected',
      };
      vscode.window.showInformationMessage(`Vote: ${labels[vote] ?? vote}`);
      // Re-fetch PR to get updated reviewer data
      const repoId = this.pr.repository?.id;
      const prId = this.pr.pullRequestId;
      if (repoId && prId) {
        this.pr = await this.api.getPullRequest(repoId, prId);
      }
      await this._update();
    } catch (err: any) {
      this._panel.webview.postMessage({
        command: 'error',
        message: `Vote failed: ${err?.message ?? err}`,
      });
    }
  }

  private async handleResolveThread(threadId: number) {
    try {
      const repoId = this.pr.repository?.id!;
      const prId = this.pr.pullRequestId!;
      await this.api.updateThreadStatus(repoId, prId, threadId, 2);
      await this._update();
    } catch (err: any) {
      this._panel.webview.postMessage({
        command: 'error',
        message: `Failed to resolve thread: ${err?.message ?? err}`,
      });
    }
  }

  private async handleReactivateThread(threadId: number) {
    try {
      const repoId = this.pr.repository?.id!;
      const prId = this.pr.pullRequestId!;
      await this.api.updateThreadStatus(repoId, prId, threadId, 1);
      await this._update();
    } catch (err: any) {
      this._panel.webview.postMessage({
        command: 'error',
        message: `Failed to reactivate thread: ${err?.message ?? err}`,
      });
    }
  }

  private async handleReplyToThread(threadId: number, content: string) {
    if (!content?.trim()) { return; }
    try {
      const repoId = this.pr.repository?.id!;
      const prId = this.pr.pullRequestId!;
      await this.api.replyToThread(repoId, prId, threadId, content);
      await this._update();
    } catch (err: any) {
      this._panel.webview.postMessage({
        command: 'error',
        message: `Failed to reply: ${err?.message ?? err}`,
      });
    }
  }

  private async handleOpenWorkItem(workItemId: number) {
    const workItem = this._linkedWorkItems.find((item) => item.id === workItemId);
    if (!workItem?.url) {
      vscode.window.showWarningMessage(`Unable to determine URL for work item #${workItemId}.`);
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(workItem.url));
  }

  private async handleSetWorkItemState(workItemId: number) {
    const workItem = this._linkedWorkItems.find((item) => item.id === workItemId);
    if (!workItem) { return; }

    const states = [...new Set([workItem.state, 'New', 'Active', 'Resolved', 'Closed', 'Done', 'Removed'].filter(Boolean))];
    const picked = await vscode.window.showQuickPick(states.map((state) => ({ label: state })), {
      placeHolder: `Set state for work item #${workItem.id}`,
    });
    if (!picked) { return; }

    try {
      await this.api.updateWorkItemState(workItem.id, picked.label, workItem.projectName);
      await this._update();
    } catch (err: any) {
      this._panel.webview.postMessage({
        command: 'error',
        message: `Failed to update work item state: ${err?.message ?? err}`,
      });
    }
  }

  private async handleAddWorkItemNote(workItemId: number) {
    const workItem = this._linkedWorkItems.find((item) => item.id === workItemId);
    if (!workItem) { return; }

    const note = await vscode.window.showInputBox({
      prompt: `Add a note to work item #${workItem.id}`,
      placeHolder: 'Progress update, blocker, or implementation note',
      validateInput: (value) => value.trim() ? null : 'Note cannot be empty',
    });
    if (!note) { return; }

    try {
      await this.api.addWorkItemNote(workItem.id, note, workItem.projectName);
      await this._update();
    } catch (err: any) {
      this._panel.webview.postMessage({
        command: 'error',
        message: `Failed to add work item note: ${err?.message ?? err}`,
      });
    }
  }

  private async handleAssignWorkItemToMe(workItemId: number) {
    const workItem = this._linkedWorkItems.find((item) => item.id === workItemId);
    if (!workItem) { return; }

    try {
      await this.api.assignWorkItemToCurrentUser(workItem.id, workItem.projectName);
      await this._update();
    } catch (err: any) {
      this._panel.webview.postMessage({
        command: 'error',
        message: `Failed to assign work item: ${err?.message ?? err}`,
      });
    }
  }

  private async _update() {
    this._panel.title = `PR #${this.pr.pullRequestId}`;

    // Fetch threads
    let threads: any[] = [];
    try {
      const repoId = this.pr.repository?.id;
      const prId = this.pr.pullRequestId;
      if (repoId && prId) {
        threads = await this.api.getPRThreads(repoId, prId);
      }
    } catch {
      // Threads are optional
    }

    // Fetch changed files via iterations
    let changedFiles: Array<{ path: string; changeType: string; originalPath?: string }> = [];
    try {
      const repoId = this.pr.repository?.id;
      const prId = this.pr.pullRequestId;
      if (repoId && prId) {
        const iterations = await this.api.getPRIterations(repoId, prId);
        if (iterations.length > 0) {
          const lastIteration = iterations[iterations.length - 1];
          const changes = await this.api.getPRIterationChanges(repoId, prId, lastIteration.id!);
          const changeTypeMap: Record<number, string> = {
            1: 'add', 2: 'edit', 4: 'encoding', 8: 'rename',
            16: 'delete', 32: 'undelete', 64: 'branch', 128: 'merge',
            256: 'lock', 512: 'rollback', 1024: 'sourceRename', 2048: 'targetRename',
          };
          changedFiles = changes.map((c: any) => {
            const changeType = changeTypeMap[c.changeType as number] ?? 'edit';
            const pathCandidates = changeType === 'delete'
              ? [c.sourceServerItem, c.item?.path, c.targetServerItem, c.item?.url]
              : [c.item?.path, c.targetServerItem, c.sourceServerItem, c.item?.url];
            const resolvedPath = pathCandidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? 'unknown';

            return {
              path: resolvedPath,
              changeType,
              originalPath: c.sourceServerItem,
            };
          });
        }
      }
    } catch {
      // Changed files are optional
    }
    this._changedFiles = changedFiles;

    let linkedWorkItems: WorkItemSummary[] = [];
    try {
      const linkedIds = inferLinkedWorkItemIds({
        branchName: this.pr.sourceRefName?.replace('refs/heads/', ''),
        title: this.pr.title ?? '',
        description: this.pr.description ?? '',
      });
      if (linkedIds.length > 0) {
        linkedWorkItems = await this.api.getWorkItems(linkedIds, this.pr.repository?.project?.name);
      }
    } catch {
      // Linked work items are optional.
    }
    this._linkedWorkItems = linkedWorkItems;

    // Fetch current user ID for vote display
    let currentUserId: string | undefined;
    try {
      currentUserId = await this.api.getCurrentUserId();
    } catch {
      // Optional
    }

    // Fetch merge conflicts if needed
    let conflicts: any[] = [];
    try {
      const repoId = this.pr.repository?.id;
      const prId = this.pr.pullRequestId;
      if (repoId && prId && (this.pr as any).mergeStatus === 2) {
        conflicts = await this.api.getPRConflicts(repoId, prId);
      }
    } catch {
      // Optional
    }

    PRDetailPanel.log(`Setting webview HTML. Files: ${changedFiles.length}, Threads: ${threads.length}`);
    this._panel.webview.html = this.getHtml(this.pr, threads, changedFiles, currentUserId, conflicts, linkedWorkItems);
    PRDetailPanel.log('Webview HTML set successfully');
  }

  private getHtml(pr: GitPullRequest, threads: any[], changedFiles: Array<{ path: string; changeType: string; originalPath?: string }>, currentUserId?: string, conflicts?: any[], linkedWorkItems: WorkItemSummary[] = []): string {
    const sourceBranch = pr.sourceRefName?.replace('refs/heads/', '') ?? '';
    const targetBranch = pr.targetRefName?.replace('refs/heads/', '') ?? '';
    const author = pr.createdBy?.displayName ?? 'Unknown';
    const created = pr.creationDate ? new Date(pr.creationDate).toLocaleDateString() : '';
    const isDraft = pr.isDraft ? '<span class="badge draft">Draft</span>' : '';
    const description = pr.description
      ? this.renderCommentHtml(pr.description)
      : '<em>No description provided.</em>';

    const reviewerHtml = (pr.reviewers ?? [])
      .map(r => {
        const voteClass = r.vote && r.vote >= 10 ? 'approved' : r.vote && r.vote <= -10 ? 'rejected' : 'pending';
        const voteIcon = r.vote && r.vote >= 10 ? '✅' : r.vote && r.vote <= -10 ? '❌' : '⏳';
        return `<li class="reviewer ${voteClass}">${voteIcon} ${this.esc(r.displayName ?? '')}</li>`;
      })
      .join('');

    // Vote info
    const currentVote = currentUserId
      ? (pr.reviewers ?? []).find(r => r.id === currentUserId)?.vote ?? 0
      : 0;
    const mergeStatus = (pr as any).mergeStatus ?? 0;
    const mergeStatusMap: Record<number, string> = { 0: '', 1: '⏳ Checking...', 2: '⚠️ Has Conflicts', 3: '✅ Can Merge', 4: '❌ Rejected by Policy', 5: '❌ Merge Failure' };
    const mergeStatusLabel = mergeStatusMap[mergeStatus] ?? '';
    const conflictsList = conflicts ?? [];
    const conflictsHtml = conflictsList.length > 0
      ? conflictsList.map((c: any) => `<div class="conflict-row">⚠️ ${this.esc(c.conflictPath ?? c.sourceFilePath ?? 'Unknown')}</div>`).join('')
      : mergeStatus === 2
        ? '<p>Merge conflicts detected. Resolve them in Azure DevOps or locally.</p>'
        : '<p class="no-comments">No merge conflicts detected.</p>';

    // Enhanced threads with file context, replies, resolve
    const allCommentThreads = threads.filter(t => t.comments?.some((c: any) => c.commentType !== 0));
    const activeThreads = threads.filter(t => t.status === 1 && t.comments?.length > 0);
    const activeThreadCount = activeThreads.length;
    const threadsHtml = allCommentThreads.length === 0
      ? '<p class="no-comments">No comment threads.</p>'
      : allCommentThreads.map(thread => {
          const threadId = thread.id ?? 0;
          const isActive = thread.status === 1;
          const isResolved = [2, 3, 4].includes(thread.status);
          const fp = thread.threadContext?.filePath;
          const ln = thread.threadContext?.rightFileStart?.line ?? thread.threadContext?.leftFileStart?.line;
          const fileCtx = fp
            ? `<div class="thread-file-ctx">📄 ${this.esc(fp)}${ln ? ':' + ln : ''}</div>`
            : '';
          const statusLabel = isResolved ? '✅ Resolved' : isActive ? '💬 Active' : '⏳';
          const statusCls = isResolved ? 'thread-resolved' : isActive ? 'thread-active' : '';
          const comments = (thread.comments ?? [])
            .filter((c: any) => c.commentType !== 0)
            .map((c: any) => `
              <div class="comment">
                <strong>${this.esc(c.author?.displayName ?? 'Unknown')}</strong>
                <span class="comment-date">${c.publishedDate ? new Date(c.publishedDate).toLocaleString() : ''}</span>
                <div class="comment-body">${this.renderCommentHtml(c.content ?? '')}</div>
              </div>`).join('');
          const threadAction = isActive
            ? `<button class="btn-sm btn-secondary" onclick="resolveThread(${threadId})">✅ Resolve</button>`
            : isResolved
            ? `<button class="btn-sm btn-secondary" onclick="reactivateThread(${threadId})">🔄 Reactivate</button>`
            : '';
          return `<div class="thread ${statusCls}">
            <div class="thread-header">${fileCtx}<span class="thread-status">${statusLabel}</span>${threadAction}</div>
            ${comments}
            <div class="reply-box">
              <textarea class="reply-input" id="reply-${threadId}" placeholder="Reply..." rows="2"></textarea>
              <div class="reply-actions">
                <button class="btn-sm btn-primary" onclick="replyToThread(${threadId})">Reply</button>
                <button class="btn-sm btn-secondary" onclick="insertSuggestion(${threadId})">💡 Suggest</button>
              </div>
            </div>
          </div>`;
        }).join('');

    const changeIcons: Record<string, string> = {
      add: '🟢', edit: '🟡', delete: '🔴', rename: '🔵', merge: '🟣', sourceRename: '🔵', targetRename: '🔵',
    };
    const filesHtml = changedFiles.length === 0
      ? '<p class="no-comments">No file changes found.</p>'
      : `<div class="file-actions-bar">
           <button class="btn-secondary btn-sm" onclick="openAllDiffs()">Open All Diffs</button>
           <span class="file-count">${changedFiles.length} file${changedFiles.length !== 1 ? 's' : ''} changed</span>
         </div>` +
        changedFiles.map((f, i) => {
          const icon = changeIcons[f.changeType] ?? '🟡';
          const name = f.path.split('/').pop() ?? f.path;
          const dir = f.path.substring(0, f.path.length - name.length);
          return `<div class="file-row" onclick="openDiff(${i})">
            <span class="file-icon">${icon}</span>
            <span class="file-name">${this.esc(name)}</span>
            <span class="file-path">${this.esc(dir)}</span>
            <span class="file-type badge-${f.changeType}">${this.esc(f.changeType)}</span>
          </div>`;
        }).join('');

    const workItemsHtml = linkedWorkItems.length === 0
      ? '<p class="no-comments">No linked work items detected from the source branch, PR title, or description.</p>'
      : `<div class="work-item-list">${linkedWorkItems.map((workItem) => `
          <div class="work-item-row">
            <div class="work-item-main">
              <div class="work-item-title">#${workItem.id} ${this.esc(workItem.title)}</div>
              <div class="work-item-meta">${this.esc(workItem.type)} • ${this.esc(workItem.state)}${workItem.assignedTo ? ' • ' + this.esc(workItem.assignedTo) : ''}</div>
            </div>
            <div class="work-item-actions">
              <button class="btn-sm btn-secondary" onclick="openWorkItem(${workItem.id})">Open</button>
              <button class="btn-sm btn-secondary" onclick="setWorkItemState(${workItem.id})">State</button>
              <button class="btn-sm btn-secondary" onclick="assignWorkItemToMe(${workItem.id})">Assign to Me</button>
              <button class="btn-sm btn-secondary" onclick="addWorkItemNote(${workItem.id})">Add Note</button>
            </div>
          </div>`).join('')}</div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>PR #${pr.pullRequestId}</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; max-width: 960px; }
    h1 { font-size: 1.4em; margin-bottom: 4px; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 16px; }
    .badge { padding: 2px 8px; border-radius: 4px; font-size: 0.8em; font-weight: bold; }
    .draft { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .branch-flow { display: flex; align-items: center; gap: 8px; background: var(--vscode-editor-inactiveSelectionBackground); padding: 8px 12px; border-radius: 4px; margin-bottom: 16px; font-family: monospace; }
    .arrow { color: var(--vscode-descriptionForeground); }
    section { margin-bottom: 24px; }
    h2 { font-size: 1.1em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-bottom: 12px; }
    .description { background: var(--vscode-editor-inactiveSelectionBackground); padding: 12px; border-radius: 4px; line-height: 1.6; overflow-wrap: anywhere; word-break: break-word; }
    ul.reviewers { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
    ul.reviewers li { padding: 4px 10px; border-radius: 4px; font-size: 0.9em; background: var(--vscode-editor-inactiveSelectionBackground); }
    .thread { background: var(--vscode-editor-inactiveSelectionBackground); border-left: 3px solid var(--vscode-focusBorder); padding: 10px 14px; margin-bottom: 12px; border-radius: 0 4px 4px 0; }
    .comment { margin-bottom: 8px; }
    .comment strong { margin-right: 6px; }
    .comment-date { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    .comment-body { margin: 4px 0 0; line-height: 1.5; overflow-wrap: anywhere; word-break: break-word; }
    .comment-body p { margin: 0 0 8px 0; }
    .comment-body p:last-child { margin-bottom: 0; }
    .comment-body a { color: var(--vscode-textLink-foreground); text-decoration: underline; overflow-wrap: anywhere; }
    .comment-body .inline-code { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 0.92em; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 1px 4px; border-radius: 3px; }
    .comment-body .md-list { margin: 6px 0 10px 20px; padding: 0; }
    .comment-body .md-list li { margin: 2px 0; }
    .comment-body .md-heading { margin: 10px 0 6px 0; font-weight: 600; }
    .comment-body .md-heading.h4 { font-size: 1.02em; }
    .comment-body .md-heading.h5 { font-size: 0.96em; }
    .comment-body pre { margin: 8px 0; padding: 10px; border-radius: 4px; background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-panel-border); overflow-x: auto; }
    .comment-body pre.suggestion { border-left: 3px solid var(--vscode-testing-iconPassed, #28a745); }
    .comment-body code { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 0.92em; white-space: pre; }
    .comment-body .suggestion-label { display: inline-block; margin: 4px 0 2px 0; font-size: 0.78em; font-weight: 600; color: var(--vscode-testing-iconPassed, #28a745); text-transform: uppercase; }
    .description a { color: var(--vscode-textLink-foreground); text-decoration: underline; overflow-wrap: anywhere; }
    .description .inline-code { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 0.92em; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 1px 4px; border-radius: 3px; }
    .description .md-list { margin: 6px 0 10px 20px; padding: 0; }
    .description .md-list li { margin: 2px 0; }
    .description .md-heading { margin: 10px 0 6px 0; font-weight: 600; }
    .description .md-heading.h4 { font-size: 1.02em; }
    .description .md-heading.h5 { font-size: 0.96em; }
    .description pre { margin: 8px 0; padding: 10px; border-radius: 4px; background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-panel-border); overflow-x: auto; }
    .description pre.suggestion { border-left: 3px solid var(--vscode-testing-iconPassed, #28a745); }
    .description code { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 0.92em; white-space: pre; }
    .description .suggestion-label { display: inline-block; margin: 4px 0 2px 0; font-size: 0.78em; font-weight: 600; color: var(--vscode-testing-iconPassed, #28a745); text-transform: uppercase; }
    .no-comments { color: var(--vscode-descriptionForeground); font-style: italic; }
    .actions { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    button { padding: 6px 14px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; font-size: 0.9em; font-family: inherit; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-sm { padding: 3px 10px; font-size: 0.85em; }
    .btn-copilot { background: #6f42c1; color: #fff; border-color: #6f42c1; }
    .btn-copilot:hover { background: #5a32a3; }
    .btn-copilot:disabled { opacity: 0.6; cursor: not-allowed; }
    .copilot-status { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-left: 8px; }
    textarea { width: 100%; min-height: 80px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px; font-family: inherit; font-size: inherit; box-sizing: border-box; resize: vertical; }
    .error { color: var(--vscode-errorForeground); margin-top: 8px; }
    .file-actions-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .file-count { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    .file-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
    .file-row:hover { background: var(--vscode-list-hoverBackground); }
    .file-icon { width: 18px; text-align: center; flex-shrink: 0; }
    .file-name { font-weight: 500; white-space: nowrap; }
    .file-path { color: var(--vscode-descriptionForeground); font-size: 0.85em; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .file-type { font-size: 0.75em; padding: 1px 6px; border-radius: 3px; text-transform: uppercase; font-weight: 600; }
    .badge-add { background: rgba(40,167,69,0.15); color: #28a745; }
    .badge-edit { background: rgba(255,193,7,0.15); color: #e6a800; }
    .badge-delete { background: rgba(220,53,69,0.15); color: #dc3545; }
    .badge-rename { background: rgba(0,120,212,0.15); color: #0078d4; }
    .badge-merge { background: rgba(128,0,128,0.15); color: #800080; }
    .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 16px; }
    .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; font-weight: 500; color: var(--vscode-descriptionForeground); }
    .tab:hover { color: var(--vscode-foreground); }
    .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .vote-section { background: var(--vscode-editor-inactiveSelectionBackground); padding: 12px; border-radius: 4px; margin-bottom: 16px; }
    .vote-current { font-size: 0.9em; margin-bottom: 8px; }
    .vote-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
    .btn-vote { padding: 4px 12px; border-radius: 4px; font-size: 0.85em; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid transparent; }
    .btn-vote:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-vote.selected { border-color: var(--vscode-focusBorder); font-weight: 600; }
    .thread-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
    .thread-file-ctx { font-family: monospace; font-size: 0.85em; color: var(--vscode-textLink-foreground); }
    .thread-status { font-size: 0.85em; font-weight: 500; }
    .thread-resolved { opacity: 0.7; border-left-color: var(--vscode-testing-iconPassed, #28a745); }
    .thread-active { border-left-color: var(--vscode-focusBorder); }
    .reply-box { margin-top: 8px; border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
    .reply-input { width: 100%; min-height: 50px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 6px; font-family: inherit; font-size: inherit; box-sizing: border-box; resize: vertical; }
    .reply-actions { display: flex; gap: 6px; margin-top: 4px; }
    .conflict-row { padding: 6px 10px; border-radius: 4px; margin-bottom: 4px; background: rgba(220,53,69,0.08); }
    .merge-status { padding: 10px; border-radius: 4px; margin-bottom: 12px; font-weight: 500; }
    .merge-ok { background: rgba(40,167,69,0.1); color: #28a745; }
    .merge-conflict { background: rgba(220,53,69,0.1); color: #dc3545; }
    .merge-unknown { background: var(--vscode-editor-inactiveSelectionBackground); }
    .work-item-list { display: flex; flex-direction: column; gap: 10px; }
    .work-item-row { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 10px 12px; border-radius: 4px; background: var(--vscode-editor-inactiveSelectionBackground); }
    .work-item-main { min-width: 0; }
    .work-item-title { font-weight: 600; overflow-wrap: anywhere; }
    .work-item-meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 2px; }
    .work-item-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  </style>
</head>
<body>
  <div id="wv-debug"></div>
  <h1>${isDraft} PR #${pr.pullRequestId}: ${this.esc(pr.title ?? '')}</h1>
  <div class="meta">by <strong>${this.esc(author)}</strong> · ${created}</div>

  <div class="branch-flow">
    <span>📌 ${this.esc(sourceBranch)}</span>
    <span class="arrow">→</span>
    <span>🎯 ${this.esc(targetBranch)}</span>
  </div>

  <div class="actions">
    <button class="btn-primary" onclick="openInBrowser()">🔗 Open in Browser</button>
    <button class="btn-secondary" onclick="refresh()">🔄 Refresh</button>
    <button class="btn-copilot" onclick="reviewWithCopilot()" id="btnCopilot">🤖 Review with Copilot</button>
    <button class="btn-secondary" onclick="toggleCopilotPrompt()" id="btnTogglePrompt" title="Customize the Copilot review prompt">⚙️</button>
  </div>

  <div id="copilotPromptSection" style="margin-bottom:16px;">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
      <label for="copilotAgent" style="font-size:0.9em;font-weight:500;">Mode:</label>
      <select id="copilotAgent" style="background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:4px 8px;font-size:0.9em;font-family:inherit;">
        <option value="agent" selected>Agent (can apply fixes)</option>
        <option value="ask">Ask (@workspace, read-only)</option>
        <option value="none">None (just open chat)</option>
      </select>
    </div>
    <textarea id="copilotPrompt" placeholder="Customize your Copilot review prompt..." style="width:100%;min-height:120px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:8px;font-family:inherit;font-size:inherit;box-sizing:border-box;resize:vertical;"></textarea>
    <div style="display:flex;gap:6px;margin-top:6px;">
      <button class="btn-secondary" onclick="resetCopilotPrompt()" style="font-size:0.85em;">↺ Reset to Default</button>
      <span style="font-size:0.8em;color:var(--vscode-descriptionForeground);align-self:center;">Leave empty to use the default prompt. File list is always appended automatically.</span>
    </div>
  </div>

  <div class="vote-section">
    <div class="vote-current">Your vote: <strong>${currentVote === 10 ? '✅ Approved' : currentVote === 5 ? '👍 w/ Suggestions' : currentVote === -5 ? '⏳ Waiting' : currentVote === -10 ? '❌ Rejected' : 'None'}</strong></div>
    <div class="vote-buttons">
      <button class="btn-vote${currentVote === 10 ? ' selected' : ''}" onclick="vote(10)">✅ Approve</button>
      <button class="btn-vote${currentVote === 5 ? ' selected' : ''}" onclick="vote(5)">👍 w/ Suggestions</button>
      <button class="btn-vote${currentVote === -5 ? ' selected' : ''}" onclick="vote(-5)">⏳ Wait for Author</button>
      <button class="btn-vote${currentVote === -10 ? ' selected' : ''}" onclick="vote(-10)">❌ Reject</button>
      <button class="btn-vote" onclick="vote(0)">↩ Reset</button>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="files" onclick="switchTab('files')">📁 Files (${changedFiles.length})</div>
    <div class="tab" data-tab="overview" onclick="switchTab('overview')">📋 Overview</div>
    <div class="tab" data-tab="comments" onclick="switchTab('comments')">💬 Comments (${allCommentThreads.length})</div>
    <div class="tab" data-tab="conflicts" onclick="switchTab('conflicts')">⚠️ Merge ${mergeStatusLabel ? '(' + mergeStatusLabel + ')' : 'Status'}</div>
  </div>

  <div id="tab-files" class="tab-content active">
    <section>${filesHtml}</section>
  </div>

  <div id="tab-overview" class="tab-content">
    <section>
      <h2>Description</h2>
      <div class="description">${description}</div>
    </section>
    <section>
      <h2>Work Items</h2>
      ${workItemsHtml}
    </section>
    ${reviewerHtml ? `<section><h2>Reviewers</h2><ul class="reviewers">${reviewerHtml}</ul></section>` : ''}
  </div>

  <div id="tab-comments" class="tab-content">
    <section>
      <h2>💬 Threads (${allCommentThreads.length}) · Active: ${activeThreadCount}</h2>
      ${threadsHtml}
      <h2 style="margin-top:24px">Add General Comment</h2>
      <div>
        <textarea id="commentInput" placeholder="Add a general comment..."></textarea>
        <div id="errorMsg" class="error" style="display:none"></div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button class="btn-primary" onclick="submitComment()">Add Comment</button>
          <button class="btn-secondary" onclick="insertGeneralSuggestion()">💡 Suggest Code</button>
        </div>
      </div>
    </section>
  </div>

  <div id="tab-conflicts" class="tab-content">
    <section>
      <h2>Merge Status</h2>
      <div class="merge-status ${mergeStatus === 3 ? 'merge-ok' : mergeStatus === 2 ? 'merge-conflict' : 'merge-unknown'}">
        ${mergeStatusLabel || '✅ No issues detected'}
      </div>
      ${mergeStatus === 2 ? '<h2>Conflict Files</h2>' + conflictsHtml : ''}
    </section>
  </div>

  <script>
    /* ---- Debug infrastructure ---- */
    var _debugLog = [];
    function wvLog(msg) {
      var ts = new Date().toISOString().substr(11,12);
      var entry = '[' + ts + '] ' + msg;
      _debugLog.push(entry);
      console.log('[PRDetail Webview]', msg);
      try { vscode.postMessage({ command: 'webviewLog', text: msg }); } catch(e) {}
    }
    function wvError(msg) {
      var ts = new Date().toISOString().substr(11,12);
      var entry = '[' + ts + '] ERROR: ' + msg;
      _debugLog.push(entry);
      console.error('[PRDetail Webview]', msg);
      try { vscode.postMessage({ command: 'webviewError', text: msg }); } catch(e) {}
      /* Show error visually in the panel */
      var errDiv = document.createElement('div');
      errDiv.style.cssText = 'background:#dc3545;color:#fff;padding:8px 12px;margin:4px 0;border-radius:4px;font-family:monospace;font-size:0.82em;white-space:pre-wrap;';
      errDiv.textContent = entry;
      var container = document.getElementById('wv-debug');
      if (container) { container.appendChild(errDiv); }
      else { document.body.insertBefore(errDiv, document.body.firstChild); }
    }

    window.onerror = function(msg, url, line, col, error) {
      wvError('Uncaught: ' + msg + ' (line ' + line + ', col ' + col + ')');
      return false;
    };
    window.onunhandledrejection = function(event) {
      wvError('Unhandled promise rejection: ' + (event.reason || event));
    };

    var vscode;
    try {
      vscode = acquireVsCodeApi();
      wvLog('acquireVsCodeApi succeeded');
    } catch(e) {
      wvError('acquireVsCodeApi failed: ' + e.message);
    }

    function switchTab(id) {
      wvLog('switchTab: ' + id);
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-' + id).classList.add('active');
      document.querySelector('.tab[data-tab="' + id + '"]').classList.add('active');
    }

    function openInBrowser() { wvLog('openInBrowser clicked'); vscode.postMessage({ command: 'openInBrowser' }); }
    function refresh() { wvLog('refresh clicked'); vscode.postMessage({ command: 'refresh' }); }
    function openDiff(index) { wvLog('openDiff clicked: ' + index); vscode.postMessage({ command: 'openDiff', index }); }
    function openAllDiffs() { wvLog('openAllDiffs clicked'); vscode.postMessage({ command: 'openAllDiffs' }); }
    var defaultCopilotPrompt = 'Review the following pull request changes for errors, bugs, typos, and mistakes ONLY. Do NOT suggest style improvements, refactoring, or enhancements.' + String.fromCharCode(10) + String.fromCharCode(10) + 'For each issue found, apply the fix directly to the file. Only fix actual bugs, errors, typos, and mistakes \\u2014 do not refactor or change style.' + String.fromCharCode(10) + 'After applying all fixes, provide a summary of what was changed and why.' + String.fromCharCode(10) + 'If no issues are found, say "No bugs, errors, typos, or mistakes found."';

    function toggleCopilotPrompt() {
      var section = document.getElementById('copilotPromptSection');
      section.style.display = section.style.display === 'none' ? 'block' : 'none';
    }

    function resetCopilotPrompt() {
      wvLog('resetCopilotPrompt clicked');
      document.getElementById('copilotPrompt').value = defaultCopilotPrompt;
    }

    function reviewWithCopilot() {
      wvLog('reviewWithCopilot clicked');
      var btn = document.getElementById('btnCopilot');
      btn.disabled = true;
      btn.textContent = '⏳ Checking out...';
      var customPrompt = (document.getElementById('copilotPrompt').value || '').trim();
      var agent = document.getElementById('copilotAgent').value;
      wvLog('Sending reviewWithCopilot message. Agent: ' + agent + ', promptLen: ' + customPrompt.length);
      vscode.postMessage({ command: 'reviewWithCopilot', customPrompt: customPrompt, agent: agent });
    }

    function openWorkItem(workItemId) { wvLog('openWorkItem: ' + workItemId); vscode.postMessage({ command: 'openWorkItem', workItemId }); }
    function setWorkItemState(workItemId) { wvLog('setWorkItemState: ' + workItemId); vscode.postMessage({ command: 'setWorkItemState', workItemId }); }
    function addWorkItemNote(workItemId) { wvLog('addWorkItemNote: ' + workItemId); vscode.postMessage({ command: 'addWorkItemNote', workItemId }); }
    function assignWorkItemToMe(workItemId) { wvLog('assignWorkItemToMe: ' + workItemId); vscode.postMessage({ command: 'assignWorkItemToMe', workItemId }); }

    function submitComment() {
      wvLog('submitComment clicked');
      const input = document.getElementById('commentInput');
      const content = input.value.trim();
      if (!content) { return; }
      vscode.postMessage({ command: 'addComment', content });
      input.disabled = true;
    }

    function vote(v) {
      wvLog('vote: ' + v);
      vscode.postMessage({ command: 'vote', vote: v });
    }

    function resolveThread(threadId) {
      wvLog('resolveThread: ' + threadId);
      vscode.postMessage({ command: 'resolveThread', threadId: threadId });
    }

    function reactivateThread(threadId) {
      wvLog('reactivateThread: ' + threadId);
      vscode.postMessage({ command: 'reactivateThread', threadId: threadId });
    }

    function replyToThread(threadId) {
      var ta = document.getElementById('reply-' + threadId);
      var content = ta.value.trim();
      if (!content) { return; }
      vscode.postMessage({ command: 'replyToThread', threadId: threadId, content: content });
      ta.value = '';
    }

    function insertSuggestion(threadId) {
      var ta = document.getElementById('reply-' + threadId);
      var bt = String.fromCharCode(96);
      ta.value += bt+bt+bt + 'suggestion' + String.fromCharCode(10) + '// replacement code here' + String.fromCharCode(10) + bt+bt+bt;
      ta.focus();
    }

    function insertGeneralSuggestion() {
      var ta = document.getElementById('commentInput');
      var bt = String.fromCharCode(96);
      ta.value += bt+bt+bt + 'suggestion' + String.fromCharCode(10) + '// replacement code here' + String.fromCharCode(10) + bt+bt+bt;
      ta.focus();
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      wvLog('Received message from extension: ' + JSON.stringify(msg));
      if (msg.command === 'commentAdded') {
        document.getElementById('commentInput').value = '';
        document.getElementById('commentInput').disabled = false;
      }
      if (msg.command === 'error') {
        const err = document.getElementById('errorMsg');
        err.textContent = msg.message;
        err.style.display = 'block';
        document.getElementById('commentInput').disabled = false;
      }
      if (msg.command === 'reviewStatus') {
        wvLog('reviewStatus: ' + msg.status);
        var btn = document.getElementById('btnCopilot');
        if (msg.status === 'ready') {
          btn.disabled = false;
          btn.textContent = '✅ Copilot Ready';
        } else if (msg.status === 'error') {
          btn.disabled = false;
          btn.textContent = '🤖 Review with Copilot';
        }
      }
    });

    /* ---- Init complete ---- */
    wvLog('All functions defined. Webview script init complete.');
  </script>
</body>
</html>`;
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private renderCommentHtml(rawContent: string): string {
    const content = this.removeAssistantNoise(formatCommentContent(rawContent));
    if (!content) {
      return '';
    }

    const fenceRegex = /```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
    const parts: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    const renderText = (text: string): string => this.renderMarkdownText(text);

    while ((match = fenceRegex.exec(content)) !== null) {
      const before = content.slice(lastIndex, match.index);
      const beforeHtml = renderText(before);
      if (beforeHtml) {
        parts.push(beforeHtml);
      }

      const language = (match[1] ?? '').toLowerCase();
      const code = match[2] ?? '';
      if (language === 'suggestion') {
        parts.push('<div class="suggestion-label">Code Suggestion</div>');
        parts.push(`<pre class="suggestion"><code>${this.esc(code)}</code></pre>`);
      } else {
        parts.push(`<pre><code>${this.esc(code)}</code></pre>`);
      }

      lastIndex = match.index + match[0].length;
    }

    const after = content.slice(lastIndex);
    const afterHtml = renderText(after);
    if (afterHtml) {
      parts.push(afterHtml);
    }

    return parts.join('');
  }

  private removeAssistantNoise(content: string): string {
    const lines = content.split('\n');
    const kept = lines.filter((line) => {
      const t = line.trim();
      if (!t) { return true; }
      return !(
        /^Rate this:$/i.test(t) ||
        /^Useful\s*\(https?:\/\//i.test(t) ||
        /^Not useful\s*\(https?:\/\//i.test(t) ||
        /^Questions:\s*PRAssistant Support\s*\(https?:\/\//i.test(t) ||
        /^AI-generated content may be incorrect\.?$/i.test(t) ||
        /^View PR assistant info and skills$/i.test(t)
      );
    });
    return kept.join('\n').trim();
  }

  private renderMarkdownText(text: string): string {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const html: string[] = [];
    let paragraph: string[] = [];
    let listItems: string[] = [];

    const flushParagraph = () => {
      if (paragraph.length === 0) { return; }
      const joined = paragraph.join('\n').trim();
      if (joined) {
        html.push(`<p>${this.formatInlineMarkdown(joined).replace(/\n/g, '<br>')}</p>`);
      }
      paragraph = [];
    };

    const flushList = () => {
      if (listItems.length === 0) { return; }
      html.push(`<ul class="md-list">${listItems.map((item) => `<li>${this.formatInlineMarkdown(item)}</li>`).join('')}</ul>`);
      listItems = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      const trimmed = line.trim();

      if (!trimmed) {
        flushParagraph();
        flushList();
        continue;
      }

      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushParagraph();
        flushList();
        const level = Math.min(6, headingMatch[1].length);
        html.push(`<div class="md-heading h${level}">${this.formatInlineMarkdown(headingMatch[2])}</div>`);
        continue;
      }

      const bulletMatch = line.match(/^\s*-\s+(.+)$/);
      if (bulletMatch) {
        flushParagraph();
        listItems.push(bulletMatch[1]);
        continue;
      }

      if (/^Code Suggestion$/i.test(trimmed)) {
        flushParagraph();
        flushList();
        html.push('<div class="suggestion-label">Code Suggestion</div>');
        continue;
      }

      paragraph.push(line);
    }

    flushParagraph();
    flushList();
    return html.join('');
  }

  private formatInlineMarkdown(text: string): string {
    let out = this.esc(text);
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    return out;
  }

  dispose() {
    PRDetailPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}
