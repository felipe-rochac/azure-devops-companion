import * as vscode from 'vscode';
import { AuthManager } from './utils/authManager';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Azure DevOps Companion');
  context.subscriptions.push(output);
  output.appendLine('Extension activating...');

  // Core auth service only — keep activation surface minimal.
  const authManager = new AuthManager(context.secrets);

  // When the PAT secret changes (saved or cleared), re-evaluate auth state.
  // setupExtension wires this up to the providers once they exist.
  let onPatChanged: (() => void) | undefined;
  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key === 'azureDevOpsPR.pat' && onPatChanged) {
        onPatChanged();
      }
    })
  );

  // Register the two entry-point commands IMMEDIATELY so clicking "Configure PAT"
  // in the welcome view always works, even before setupExtension completes.
  context.subscriptions.push(
    vscode.commands.registerCommand('azureDevOpsPR.configurePAT', async () => {
      output.appendLine('configurePAT command invoked');
      await configurePAT(authManager, output);
    }),
    vscode.commands.registerCommand('azureDevOpsPR.signIn', async () => {
      output.appendLine('signIn command invoked');
      await configurePAT(authManager, output);
    })
  );

  output.appendLine('Core commands registered. Starting async setup...');

  // Rest of setup is async but does NOT block command availability
  setupExtension(context, output, authManager, (cb) => { onPatChanged = cb; })
    .catch((err: any) => {
      const msg = `Setup error: ${err?.message ?? err}`;
      output.appendLine(msg);
      output.show(true);
    });
}

async function setupExtension(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  authManager: AuthManager,
  registerPatChangedCallback: (cb: () => void) => void
) {

  const { AzureDevOpsApi } = await import('./api/azureDevOpsApi');
  const { GitHelper } = await import('./utils/gitHelper');
  const { suggestWorkItemTitle } = await import('./utils/workItemHelper');
  const api = new AzureDevOpsApi(authManager);
  const gitHelper = new GitHelper();

  // Lazy-load non-critical modules after core commands are already registered.
  const { PullRequestProvider } = await import('./providers/pullRequestProvider');
  const { PipelineProvider } = await import('./providers/pipelineProvider');
  const { WorkItemProvider } = await import('./providers/workItemProvider');
  const { PRDetailPanel, ADOFileContentProvider } = await import('./views/prDetailPanel');
  const { CreatePRPanel } = await import('./views/createPRPanel');
  const { PipelineDashboardPanel } = await import('./views/pipelineDashboardPanel');
  const { PRCommentController } = await import('./views/prCommentController');

  function getOrgUrl(): string {
    return vscode.workspace.getConfiguration('azureDevOpsPR').get<string>('organizationUrl', '').trim().replace(/\/$/, '');
  }

  function getProjectName(): string {
    return vscode.workspace.getConfiguration('azureDevOpsPR').get<string>('project', '').trim();
  }

  function buildPrBrowserUrl(item: any): string | undefined {
    const linked = item?.pr?._links?.web?.href;
    if (linked) { return linked; }

    const org = getOrgUrl();
    const project = item?.pr?.repository?.project?.name || prProvider.getSelectedProject() || getProjectName();
    const repo = item?.pr?.repository?.name || item?.pr?.repositoryName;
    const prId = item?.pr?.pullRequestId;
    if (!org || !project || !repo || !prId) { return undefined; }
    return `${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${prId}`;
  }

  function buildBuildBrowserUrl(item: any): string | undefined {
    const build = item?.build ?? item;
    const org = getOrgUrl();
    const project = build?.project?.name || pipelineProvider.getSelectedProject() || getProjectName();
    const buildId = build?.id;

    // Prefer a deterministic build results URL. Some API web links point to
    // the generic _build page instead of the selected run.
    if (org && project && buildId) {
      return `${org}/${encodeURIComponent(project)}/_build/results?buildId=${buildId}&view=results`;
    }

    const linked = build?._links?.web?.href;
    if (linked) {
      // Some links are generic (_build). If buildId exists in query string,
      // normalize to a stable results URL.
      try {
        const parsed = vscode.Uri.parse(linked);
        const params = new URLSearchParams(parsed.query);
        const linkedBuildId = params.get('buildId');
        if (org && project && linkedBuildId) {
          return `${org}/${encodeURIComponent(project)}/_build/results?buildId=${linkedBuildId}&view=results`;
        }
      } catch {
        // ignore parse errors and fall back to linked value
      }
      return linked;
    }

    return undefined;
  }

  function buildWorkItemBrowserUrl(item: any): string | undefined {
    const workItem = item?.workItem ?? item;
    const workItemId = workItem?.id;
    const project = workItem?.projectName || workProvider.getSelectedProject() || prProvider.getSelectedProject() || pipelineProvider.getSelectedProject() || getProjectName();
    const org = getOrgUrl();
    if (!org || !project || !workItemId) {
      return workItem?.url;
    }
    return `${org}/${encodeURIComponent(project)}/_workitems/edit/${workItemId}`;
  }

  // --- Tree View Providers ---
  const prProvider = new PullRequestProvider(api, gitHelper);
  const pipelineProvider = new PipelineProvider(api);
  const workProvider = new WorkItemProvider(api, gitHelper);

  // --- Restore saved filters ---
  interface SavedFilters {
    prProject?: string;
    prRepo?: string;
    prRepoName?: string;
    pipelineProject?: string;
    pipelineRepo?: string;
    pipelineRepoName?: string;
    workProject?: string;
  }
  const savedFilters = context.globalState.get<SavedFilters>('filters', {});

  const startupConfig = vscode.workspace.getConfiguration('azureDevOpsPR');
  const autoDetectFromWorkspace = startupConfig.get<boolean>('autoDetectFromWorkspace', true);

  // Always auto-detect project/repo from the workspace git remote so panels
  // only load data for the current repository instead of the entire org.
  let autoDetected = false;
  if (autoDetectFromWorkspace) {
    try {
      const ctx = await gitHelper.detectAzureDevOpsContext();
      if (ctx?.projectName) {
        prProvider.setProject(ctx.projectName);
        pipelineProvider.setProject(ctx.projectName);
        workProvider.setProject(ctx.projectName);
        autoDetected = true;
      }

      if (ctx?.projectName && ctx?.repoName) {
        const repos = await api.getRepositories(ctx.projectName);
        const repo = repos.find(r => (r.name ?? '').toLowerCase() === ctx.repoName!.toLowerCase());
        if (repo?.id) {
          prProvider.setRepository(repo.id, repo.name);
          pipelineProvider.setRepository(repo.id, repo.name);
        }
      }
    } catch (err: any) {
      output.appendLine(`Auto-detect project/repo failed: ${err?.message ?? err}`);
    }
  }

  // Fall back to saved filters only when auto-detection did not succeed.
  if (!autoDetected) {
    if (savedFilters.prProject) { prProvider.setProject(savedFilters.prProject); }
    if (savedFilters.prRepo) { prProvider.setRepository(savedFilters.prRepo, savedFilters.prRepoName); }
    if (savedFilters.pipelineProject) { pipelineProvider.setProject(savedFilters.pipelineProject); }
    if (savedFilters.pipelineRepo) { pipelineProvider.setRepository(savedFilters.pipelineRepo, savedFilters.pipelineRepoName); }
    if (savedFilters.workProject) { workProvider.setProject(savedFilters.workProject); }
  }

  function saveFilters() {
    const filters: SavedFilters = {
      prProject: prProvider.getSelectedProject(),
      prRepo: prProvider.getSelectedRepo(),
      prRepoName: prProvider.getSelectedRepoName(),
      pipelineProject: pipelineProvider.getSelectedProject(),
      pipelineRepo: pipelineProvider.getSelectedRepo(),
      pipelineRepoName: pipelineProvider.getSelectedRepoName(),
      workProject: workProvider.getSelectedProject(),
    };
    context.globalState.update('filters', filters);
  }

  // --- Register virtual document provider for PR file diffs ---
  const adoContentProvider = new ADOFileContentProvider(api);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('ado-pr', adoContentProvider)
  );

  // --- PR Comment Controller for inline diff comments ---
  const prCommentController = new PRCommentController(api);
  context.subscriptions.push(
    prCommentController.getController(),
    { dispose: () => prCommentController.dispose() }
  );

  // --- Register Tree Views ---
  const prTreeView = vscode.window.createTreeView('azureDevOpsPR.pullRequests', {
    treeDataProvider: prProvider,
    showCollapseAll: true,
  });

  const pipelineTreeView = vscode.window.createTreeView('azureDevOpsPR.pipelines', {
    treeDataProvider: pipelineProvider,
  });

  const workTreeView = vscode.window.createTreeView('azureDevOpsPR.workItems', {
    treeDataProvider: workProvider,
    showCollapseAll: true,
  });

  // Restore view titles from saved filters
  function buildTitle(base: string, project?: string, repoName?: string): string {
    const parts = [project, repoName].filter(Boolean);
    return parts.length ? `${base} (${parts.join(' / ')})` : base;
  }
  prTreeView.title = buildTitle('Pull Requests', savedFilters.prProject, savedFilters.prRepoName);
  pipelineTreeView.title = buildTitle('Pipelines', savedFilters.pipelineProject, savedFilters.pipelineRepoName);
  workTreeView.title = buildTitle('My Work', savedFilters.workProject);

  // If auto-detection updated filters, reflect that in titles.
  prTreeView.title = buildTitle('Pull Requests', prProvider.getSelectedProject(), prProvider.getSelectedRepoName());
  pipelineTreeView.title = buildTitle('Pipelines', pipelineProvider.getSelectedProject(), pipelineProvider.getSelectedRepoName());
  workTreeView.title = buildTitle('My Work', workProvider.getSelectedProject());

  context.subscriptions.push(prTreeView, pipelineTreeView, workTreeView);

  // --- Update auth context ---
  async function updateAuthContext() {
    try {
      const isAuthenticated = await authManager.isAuthenticated();
      const workItemsEnabled = vscode.workspace.getConfiguration('azureDevOpsPR').get<boolean>('enableWorkItems', true);
      await vscode.commands.executeCommand(
        'setContext',
        'azureDevOpsPR.authenticated',
        isAuthenticated
      );
      await vscode.commands.executeCommand(
        'setContext',
        'azureDevOpsPR.workItemsEnabled',
        workItemsEnabled
      );
      output.appendLine(`Authenticated: ${isAuthenticated}`);
      if (isAuthenticated) {
        prProvider.refresh();
        pipelineProvider.refresh();
        if (workItemsEnabled) {
          workProvider.refresh();
        }
      }
    } catch (err: any) {
      output.appendLine(`updateAuthContext error: ${err?.message ?? err}`);
    }
  }

  // --- Auto-refresh ---
  const config = vscode.workspace.getConfiguration('azureDevOpsPR');
  const refreshInterval = Math.max(60, config.get<number>('autoRefreshInterval', 300)) * 1000;
  const autoRefreshTimer = setInterval(() => {
    prProvider.refresh();
    pipelineProvider.refresh();
    workProvider.refresh();
  }, refreshInterval);
  context.subscriptions.push({ dispose: () => clearInterval(autoRefreshTimer) });

  // --- Commands (registered BEFORE any awaits so they are always available) ---
  context.subscriptions.push(
    vscode.commands.registerCommand('azureDevOpsPR.signOut', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Sign out from Azure DevOps? Your PAT will be removed.',
        { modal: true },
        'Sign Out'
      );
      if (confirm === 'Sign Out') {
        await authManager.clearCredentials();
        await updateAuthContext();
        vscode.window.showInformationMessage('Signed out from Azure DevOps.');
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.refresh', () => {
      prProvider.refresh();
      pipelineProvider.refresh();
      workProvider.refresh();
    }),

    vscode.commands.registerCommand('azureDevOpsPR.openWorkItemInBrowser', (item: any) => {
      const url = buildWorkItemBrowserUrl(item);
      if (!url) {
        vscode.window.showWarningMessage('Unable to determine work item URL for this item.');
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand('azureDevOpsPR.createWorkItem', async () => {
      const branch = await gitHelper.getCurrentBranch();
      const selectedText = vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection)?.trim();
      const suggestedTitle = selectedText || suggestWorkItemTitle(branch);
      const title = await vscode.window.showInputBox({
        prompt: 'Enter a title for the new Task work item',
        placeHolder: 'Task title',
        value: suggestedTitle,
        validateInput: (value) => value.trim() ? null : 'Title is required',
      });
      if (!title) { return; }

      const description = await vscode.window.showInputBox({
        prompt: 'Optional description',
        placeHolder: 'Add more detail for the task',
      });

      try {
        const project = workProvider.getSelectedProject() || prProvider.getSelectedProject() || pipelineProvider.getSelectedProject() || getProjectName();
        const workItem = await api.createTaskWorkItem(title, description, project || undefined);
        workProvider.refresh();
        vscode.window.showInformationMessage(`Created Task #${workItem.id}: ${workItem.title}`);
        const url = buildWorkItemBrowserUrl(workItem);
        if (url) {
          const action = await vscode.window.showInformationMessage(`Open work item #${workItem.id} in browser?`, 'Open');
          if (action === 'Open') {
            vscode.env.openExternal(vscode.Uri.parse(url));
          }
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to create work item: ${err?.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.updateWorkItemState', async (item: any) => {
      const workItem = item?.workItem ?? item;
      if (!workItem?.id) { return; }

      const states = [...new Set([workItem.state, 'New', 'Active', 'Resolved', 'Closed', 'Done', 'Removed'].filter(Boolean))];
      const picked = await vscode.window.showQuickPick(states.map((state) => ({ label: state })), {
        placeHolder: `Set state for work item #${workItem.id}`,
      });
      if (!picked) { return; }

      try {
        await api.updateWorkItemState(workItem.id, picked.label, workItem.projectName);
        workProvider.refresh();
        if (PRDetailPanel.currentPanel) {
          await PRDetailPanel.currentPanel.refresh();
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to update work item state: ${err?.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.addWorkItemNote', async (item: any) => {
      const workItem = item?.workItem ?? item;
      if (!workItem?.id) { return; }

      const note = await vscode.window.showInputBox({
        prompt: `Add a note to work item #${workItem.id}`,
        placeHolder: 'Progress update, blocker, or implementation note',
        validateInput: (value) => value.trim() ? null : 'Note cannot be empty',
      });
      if (!note) { return; }

      try {
        await api.addWorkItemNote(workItem.id, note, workItem.projectName);
        workProvider.refresh();
        if (PRDetailPanel.currentPanel) {
          await PRDetailPanel.currentPanel.refresh();
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to add work item note: ${err?.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.assignWorkItemToMe', async (item: any) => {
      const workItem = item?.workItem ?? item;
      if (!workItem?.id) { return; }

      try {
        await api.assignWorkItemToCurrentUser(workItem.id, workItem.projectName);
        workProvider.refresh();
        if (PRDetailPanel.currentPanel) {
          await PRDetailPanel.currentPanel.refresh();
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to assign work item: ${err?.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.filterWorkItemStatus', async () => {
      const available = workProvider.getAvailableStatuses();
      const activeFilter = workProvider.getStatusFilter().map(s => s.toLowerCase());

      // If no items loaded yet, provide a common default list
      const statusOptions = (available.length > 0 ? available : ['New', 'Active', 'Resolved', 'Closed', 'Done', 'Removed'])
        .map(s => ({
          label: s,
          picked: activeFilter.length === 0 || activeFilter.includes(s.toLowerCase()),
        }));

      const picked = await vscode.window.showQuickPick(statusOptions, {
        placeHolder: 'Select statuses to show (deselect all to clear filter)',
        canPickMany: true,
        title: 'Filter Work Items by Status',
      });

      if (picked === undefined) { return; } // cancelled

      // If all statuses are selected (or the user cleared all), treat as "no filter"
      const allSelected = picked.length === statusOptions.length || picked.length === 0;
      workProvider.setStatusFilter(allSelected ? [] : picked.map(p => p.label));

      const filterCount = picked.length;
      if (allSelected) {
        vscode.window.showInformationMessage('Work item status filter cleared.');
      } else {
        vscode.window.showInformationMessage(`Showing work items with status: ${picked.map(p => p.label).join(', ')}`);
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.clearWorkItemStatusFilter', () => {
      workProvider.setStatusFilter([]);
      vscode.window.showInformationMessage('Work item status filter cleared.');
    }),

    vscode.commands.registerCommand('azureDevOpsPR.filterPRStatus', async () => {
      const available = prProvider.getAvailableStatuses();
      const activeFilter = prProvider.getStatusFilter().map((s) => s.toLowerCase());
      const statusOptions = (available.length > 0 ? available : ['Needs Review', 'Approved', 'Changes Requested', 'Draft'])
        .map((status) => ({
          label: status,
          picked: activeFilter.length === 0 || activeFilter.includes(status.toLowerCase()),
        }));

      const picked = await vscode.window.showQuickPick(statusOptions, {
        placeHolder: 'Select pull request statuses to show (deselect all to clear filter)',
        canPickMany: true,
        title: 'Filter Pull Requests by Status',
      });

      if (picked === undefined) { return; }
      const allSelected = picked.length === statusOptions.length || picked.length === 0;
      prProvider.setStatusFilter(allSelected ? [] : picked.map((item) => item.label));

      if (allSelected) {
        vscode.window.showInformationMessage('Pull request status filter cleared.');
      } else {
        vscode.window.showInformationMessage(`Showing pull requests with status: ${picked.map((item) => item.label).join(', ')}`);
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.clearPRStatusFilter', () => {
      prProvider.setStatusFilter([]);
      vscode.window.showInformationMessage('Pull request status filter cleared.');
    }),

    vscode.commands.registerCommand('azureDevOpsPR.filterPRUser', async () => {
      const availableUsers = prProvider.getAvailableUsers();
      if (availableUsers.length === 0) {
        vscode.window.showInformationMessage('No pull request authors available yet. Refresh pull requests and try again.');
        return;
      }

      const activeFilter = new Set(prProvider.getUserFilter().map((userId) => userId.toLowerCase()));
      const userOptions = availableUsers.map((user) => ({
        label: user.label,
        description: user.id,
        picked: activeFilter.size === 0 || activeFilter.has(user.id.toLowerCase()),
      }));

      const picked = await vscode.window.showQuickPick(userOptions, {
        placeHolder: 'Select pull request authors to show (deselect all to clear filter)',
        canPickMany: true,
        title: 'Filter Pull Requests by Author',
      });

      if (picked === undefined) { return; }
      const allSelected = picked.length === userOptions.length || picked.length === 0;
      const selectedIds = picked
        .map((item) => item.description)
        .filter((value): value is string => !!value);

      prProvider.setUserFilter(allSelected ? [] : selectedIds);

      if (allSelected) {
        vscode.window.showInformationMessage('Pull request author filter cleared.');
      } else {
        vscode.window.showInformationMessage(`Showing pull requests by: ${picked.map((item) => item.label).join(', ')}`);
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.clearPRUserFilter', () => {
      prProvider.setUserFilter([]);
      vscode.window.showInformationMessage('Pull request author filter cleared.');
    }),

    vscode.commands.registerCommand('azureDevOpsPR.filterPipelineStatus', async () => {
      const available = pipelineProvider.getAvailableStatuses();
      const activeFilter = pipelineProvider.getStatusFilter().map((s) => s.toLowerCase());
      const statusOptions = (available.length > 0 ? available : ['Running', 'Succeeded', 'Failed', 'Canceled', 'Partial', 'Unknown'])
        .map((status) => ({
          label: status,
          picked: activeFilter.length === 0 || activeFilter.includes(status.toLowerCase()),
        }));

      const picked = await vscode.window.showQuickPick(statusOptions, {
        placeHolder: 'Select pipeline statuses to show (deselect all to clear filter)',
        canPickMany: true,
        title: 'Filter Pipelines by Status',
      });

      if (picked === undefined) { return; }
      const allSelected = picked.length === statusOptions.length || picked.length === 0;
      pipelineProvider.setStatusFilter(allSelected ? [] : picked.map((item) => item.label));

      if (allSelected) {
        vscode.window.showInformationMessage('Pipeline status filter cleared.');
      } else {
        vscode.window.showInformationMessage(`Showing pipelines with status: ${picked.map((item) => item.label).join(', ')}`);
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.clearPipelineStatusFilter', () => {
      pipelineProvider.setStatusFilter([]);
      vscode.window.showInformationMessage('Pipeline status filter cleared.');
    }),

    vscode.commands.registerCommand('azureDevOpsPR.openPR', async (item) => {
      if (item?.pr) {
        PRDetailPanel.createOrShow(context.extensionUri, item.pr, api, gitHelper, prCommentController);
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.createPR', async () => {
      const branch = await gitHelper.getCurrentBranch();
      CreatePRPanel.createOrShow(context.extensionUri, api, gitHelper, branch);
    }),

    vscode.commands.registerCommand('azureDevOpsPR.checkoutBranch', async (item) => {
      if (!item?.pr) {
        return;
      }
      const branchName = item.pr.sourceRefName?.replace('refs/heads/', '');
      if (!branchName) {
        return;
      }

      // Check if workspace repo matches the PR repo
      const prRepoName = item.pr.repository?.name;
      const workspaceRepo = await gitHelper.detectRepositoryName();
      if (prRepoName && workspaceRepo && prRepoName.toLowerCase() !== workspaceRepo.toLowerCase()) {
        const action = await vscode.window.showWarningMessage(
          `Your workspace is on repo "${workspaceRepo}" but this PR is from repo "${prRepoName}". Checkout will likely fail.`,
          'Try Anyway', 'Cancel'
        );
        if (action !== 'Try Anyway') {
          return;
        }
      } else if (!workspaceRepo) {
        const action = await vscode.window.showWarningMessage(
          'Could not detect the workspace git repository. The checkout may fail if this is not the correct repo.',
          'Try Anyway', 'Cancel'
        );
        if (action !== 'Try Anyway') {
          return;
        }
      }

      const confirm = await vscode.window.showInformationMessage(
        `Checkout branch "${branchName}"?`,
        'Checkout'
      );
      if (confirm === 'Checkout') {
        try {
          await gitHelper.checkoutBranch(branchName);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to checkout branch: ${err?.message ?? err}`);
        }
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.approvePR', async (item) => {
      if (!item?.pr) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Approve PR #${item.pr.pullRequestId}: "${item.pr.title}"?`,
        { modal: true },
        'Approve'
      );
      if (confirm === 'Approve') {
        try {
          await api.approvePullRequest(item.pr);
          vscode.window.showInformationMessage(`✅ PR #${item.pr.pullRequestId} approved!`);
          prProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to approve PR: ${err}`);
        }
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.openPipelineDashboard', () => {
      PipelineDashboardPanel.createOrShow(context.extensionUri, api, pipelineProvider.getSelectedProject(), pipelineProvider.getSelectedRepo(), pipelineProvider.getSelectedRepoName(), context.globalState);
    }),

    vscode.commands.registerCommand('azureDevOpsPR.openPipelineBuild', (item: any) => {
      if (!item?.build) { return; }
      const build = item.build;
      PipelineDashboardPanel.createOrShowForBuild(context.extensionUri, api, {
        id: build.id!,
        buildNumber: build.buildNumber ?? '',
        definitionName: build.definition?.name ?? 'Pipeline',
        project: build.project?.name || pipelineProvider.getSelectedProject(),
      }, pipelineProvider.getSelectedRepo(), pipelineProvider.getSelectedRepoName(), context.globalState);
    }),

    vscode.commands.registerCommand('azureDevOpsPR.openPipelineBuildInBrowser', (item: any) => {
      const url = buildBuildBrowserUrl(item);
      if (!url) {
        vscode.window.showWarningMessage('Unable to determine pipeline run URL for this item.');
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand('azureDevOpsPR.copyImageName', async (item: any) => {
      const config = vscode.workspace.getConfiguration();
      let template: string = config.get('azureDevOpsPR.containerImageTemplate', '').trim();

      if (!template) {
        const action = await vscode.window.showWarningMessage(
          'No container image template configured. Set "azureDevOpsPR.containerImageTemplate" in settings.\n' +
          'Example: myregistry.azurecr.io/{definitionName}:{buildNumber}',
          'Open Settings'
        );
        if (action === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'azureDevOpsPR.containerImageTemplate');
        }
        return;
      }

      const build = item?.build ?? item;
      const buildNumber: string = build?.buildNumber ?? '';
      const definitionName: string = (build?.definition?.name ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '-');
      const branch: string = (build?.sourceBranch ?? '').replace(/^refs\/heads\//, '');
      const shortCommit: string = (build?.sourceVersion ?? '').substring(0, 8);

      const imageName = template
        .replace(/\{buildNumber\}/g, buildNumber)
        .replace(/\{definitionName\}/g, definitionName)
        .replace(/\{branch\}/g, branch)
        .replace(/\{shortCommit\}/g, shortCommit);

      await vscode.env.clipboard.writeText(imageName);
      vscode.window.showInformationMessage(`Copied: ${imageName}`);
    }),

    vscode.commands.registerCommand('azureDevOpsPR.openPRInBrowser', (item: any) => {
      const url = buildPrBrowserUrl(item);
      if (!url) {
        vscode.window.showWarningMessage('Unable to determine PR URL for this item.');
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    // --- Comment controller commands ---
    vscode.commands.registerCommand('azureDevOpsPR.createComment', (reply: vscode.CommentReply) => {
      prCommentController.createThread(reply);
    }),

    vscode.commands.registerCommand('azureDevOpsPR.replyComment', (reply: vscode.CommentReply) => {
      prCommentController.replyToThread(reply);
    }),

    vscode.commands.registerCommand('azureDevOpsPR.resolveComment', (thread: vscode.CommentThread) => {
      prCommentController.resolveThread(thread);
    }),

    vscode.commands.registerCommand('azureDevOpsPR.reactivateComment', (thread: vscode.CommentThread) => {
      prCommentController.reactivateThread(thread);
    }),

    vscode.commands.registerCommand('azureDevOpsPR.selectPRProject', async () => {
      try {
        const projects = await api.getProjects();
        const items: vscode.QuickPickItem[] = [
          { label: '$(close) Clear filter', description: 'Use default project from settings' },
          ...projects.map(p => ({
            label: p.name ?? '',
            description: p.name === prProvider.getSelectedProject() ? '(selected)' : '',
          })),
        ];
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a project to filter Pull Requests',
        });
        if (!picked) { return; }
        const project = picked.label.startsWith('$(close)') ? undefined : picked.label;
        prProvider.setProject(project);
        workProvider.setProject(project);
        const label = project ? `Pull Requests (${project})` : 'Pull Requests';
        prTreeView.title = label;
        workTreeView.title = buildTitle('My Work', project);
        saveFilters();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to load projects: ${err}`);
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.selectPipelineProject', async () => {
      try {
        const projects = await api.getProjects();
        const items: vscode.QuickPickItem[] = [
          { label: '$(close) Clear filter', description: 'Use default project from settings' },
          ...projects.map(p => ({
            label: p.name ?? '',
            description: p.name === pipelineProvider.getSelectedProject() ? '(selected)' : '',
          })),
        ];
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a project to filter Pipelines',
        });
        if (!picked) { return; }
        const project = picked.label.startsWith('$(close)') ? undefined : picked.label;
        pipelineProvider.setProject(project);
        workProvider.setProject(project);
        const label = project ? `Pipelines (${project})` : 'Pipelines';
        pipelineTreeView.title = label;
        workTreeView.title = buildTitle('My Work', project);
        saveFilters();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to load projects: ${err}`);
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.selectPRRepo', async () => {
      try {
        const project = prProvider.getSelectedProject();
        const repos = await api.getRepositories(project);
        const items: vscode.QuickPickItem[] = [
          { label: '$(close) Clear filter', description: 'Show PRs from all repositories' },
          ...repos.map(r => ({
            label: r.name ?? '',
            description: r.id === prProvider.getSelectedRepo() ? '(selected)' : '',
          })),
        ];
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a repository to filter Pull Requests',
        });
        if (!picked) { return; }
        if (picked.label.startsWith('$(close)')) {
          prProvider.setRepository(undefined);
        } else {
          const repo = repos.find(r => r.name === picked.label);
          prProvider.setRepository(repo?.id, repo?.name);
        }
        const parts = [project, prProvider.getSelectedRepoName()].filter(Boolean);
        prTreeView.title = parts.length ? `Pull Requests (${parts.join(' / ')})` : 'Pull Requests';
        saveFilters();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to load repositories: ${err}`);
      }
    }),

    vscode.commands.registerCommand('azureDevOpsPR.selectPipelineRepo', async () => {
      try {
        const project = pipelineProvider.getSelectedProject();
        const repos = await api.getRepositories(project);
        const items: vscode.QuickPickItem[] = [
          { label: '$(close) Clear filter', description: 'Show pipelines from all repositories' },
          ...repos.map(r => ({
            label: r.name ?? '',
            description: r.id === pipelineProvider.getSelectedRepo() ? '(selected)' : '',
          })),
        ];
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a repository to filter Pipelines',
        });
        if (!picked) { return; }
        if (picked.label.startsWith('$(close)')) {
          pipelineProvider.setRepository(undefined);
        } else {
          const repo = repos.find(r => r.name === picked.label);
          pipelineProvider.setRepository(repo?.id, repo?.name);
        }
        const parts = [project, pipelineProvider.getSelectedRepoName()].filter(Boolean);
        pipelineTreeView.title = parts.length ? `Pipelines (${parts.join(' / ')})` : 'Pipelines';
        saveFilters();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to load repositories: ${err}`);
      }
    })
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('azureDevOpsPR')) {
        api.resetConnection();
        prProvider.refresh();
        pipelineProvider.refresh();
        workProvider.refresh();
        updateAuthContext();
      }
    })
  );

  // Re-wire configurePAT & signIn to also refresh providers now that they're available
  registerPatChangedCallback(() => updateAuthContext());

  output.appendLine('All commands registered.');
  updateAuthContext();
}

async function configurePAT(authManager: AuthManager, output?: vscode.OutputChannel) {
  output?.appendLine('configurePAT: showing org URL input');
  // Step 1: Organization URL
  const orgUrl = await vscode.window.showInputBox({
    prompt: 'Enter your Azure DevOps organization URL',
    placeHolder: 'https://dev.azure.com/your-organization',
    value: vscode.workspace.getConfiguration('azureDevOpsPR').get('organizationUrl', ''),
    validateInput: (value) => {
      if (!value) {
        return 'Organization URL is required';
      }
      const pattern = /^https:\/\/(dev\.azure\.com\/[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+\.visualstudio\.com)\/?$/;
      return pattern.test(value) ? null : 'Invalid Azure DevOps URL format';
    },
  });

  if (!orgUrl) {
    return;
  }

  // Step 2: Project
  const project = await vscode.window.showInputBox({
    prompt: 'Enter your Azure DevOps project name',
    placeHolder: 'MyProject',
    value: vscode.workspace.getConfiguration('azureDevOpsPR').get('project', ''),
    validateInput: (v) => (v ? null : 'Project name is required'),
  });

  if (!project) {
    return;
  }

  // Save URL/project to settings (not secrets - these aren't sensitive)
  const config = vscode.workspace.getConfiguration('azureDevOpsPR');
  try {
    await config.update('organizationUrl', orgUrl.trim(), vscode.ConfigurationTarget.Global);
    await config.update('project', project.trim(), vscode.ConfigurationTarget.Global);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to save settings: ${err?.message ?? err}`);
    return;
  }

  // Sign in via Microsoft Entra (OAuth)
  try {
    await authManager.signInInteractive();
    vscode.window.showInformationMessage(
      '✅ Azure DevOps connected! Signed in via Microsoft account.'
    );
  } catch (err: any) {
    vscode.window.showErrorMessage(`Sign in failed: ${err?.message ?? err}`);
  }
}

export function deactivate() {
  // Cleanup handled by context.subscriptions
}
