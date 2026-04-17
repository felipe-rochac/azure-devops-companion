import * as vscode from 'vscode';
import { AuthManager } from './utils/authManager';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Azure DevOps PR');
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
  const api = new AzureDevOpsApi(authManager);
  const gitHelper = new GitHelper();

  // Lazy-load non-critical modules after core commands are already registered.
  const { PullRequestProvider } = await import('./providers/pullRequestProvider');
  const { PipelineProvider } = await import('./providers/pipelineProvider');
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

  // --- Tree View Providers ---
  const prProvider = new PullRequestProvider(api, gitHelper);
  const pipelineProvider = new PipelineProvider(api);

  // --- Restore saved filters ---
  interface SavedFilters {
    prProject?: string;
    prRepo?: string;
    prRepoName?: string;
    pipelineProject?: string;
    pipelineRepo?: string;
    pipelineRepoName?: string;
  }
  const savedFilters = context.globalState.get<SavedFilters>('filters', {});
  if (savedFilters.prProject) { prProvider.setProject(savedFilters.prProject); }
  if (savedFilters.prRepo) { prProvider.setRepository(savedFilters.prRepo, savedFilters.prRepoName); }
  if (savedFilters.pipelineProject) { pipelineProvider.setProject(savedFilters.pipelineProject); }
  if (savedFilters.pipelineRepo) { pipelineProvider.setRepository(savedFilters.pipelineRepo, savedFilters.pipelineRepoName); }

  const startupConfig = vscode.workspace.getConfiguration('azureDevOpsPR');
  const autoDetectFromWorkspace = startupConfig.get<boolean>('autoDetectFromWorkspace', true);

  // Auto-detect project/repo from current workspace remote when filters are not set.
  if (autoDetectFromWorkspace && !savedFilters.prProject && !savedFilters.pipelineProject) {
    try {
      const ctx = await gitHelper.detectAzureDevOpsContext();
      if (ctx?.projectName) {
        prProvider.setProject(ctx.projectName);
        pipelineProvider.setProject(ctx.projectName);
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

  function saveFilters() {
    const filters: SavedFilters = {
      prProject: prProvider.getSelectedProject(),
      prRepo: prProvider.getSelectedRepo(),
      prRepoName: prProvider.getSelectedRepoName(),
      pipelineProject: pipelineProvider.getSelectedProject(),
      pipelineRepo: pipelineProvider.getSelectedRepo(),
      pipelineRepoName: pipelineProvider.getSelectedRepoName(),
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

  // Restore view titles from saved filters
  function buildTitle(base: string, project?: string, repoName?: string): string {
    const parts = [project, repoName].filter(Boolean);
    return parts.length ? `${base} (${parts.join(' / ')})` : base;
  }
  prTreeView.title = buildTitle('Pull Requests', savedFilters.prProject, savedFilters.prRepoName);
  pipelineTreeView.title = buildTitle('Pipelines', savedFilters.pipelineProject, savedFilters.pipelineRepoName);

  // If auto-detection updated filters, reflect that in titles.
  prTreeView.title = buildTitle('Pull Requests', prProvider.getSelectedProject(), prProvider.getSelectedRepoName());
  pipelineTreeView.title = buildTitle('Pipelines', pipelineProvider.getSelectedProject(), pipelineProvider.getSelectedRepoName());

  context.subscriptions.push(prTreeView, pipelineTreeView);

  // --- Update auth context ---
  async function updateAuthContext() {
    try {
      const isAuthenticated = await authManager.isAuthenticated();
      await vscode.commands.executeCommand(
        'setContext',
        'azureDevOpsPR.authenticated',
        isAuthenticated
      );
      output.appendLine(`Authenticated: ${isAuthenticated}`);
      if (isAuthenticated) {
        prProvider.refresh();
        pipelineProvider.refresh();
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
      PipelineDashboardPanel.createOrShow(context.extensionUri, api, pipelineProvider.getSelectedProject(), pipelineProvider.getSelectedRepo(), pipelineProvider.getSelectedRepoName());
    }),

    vscode.commands.registerCommand('azureDevOpsPR.openPipelineBuild', (item: any) => {
      if (!item?.build) { return; }
      const build = item.build;
      PipelineDashboardPanel.createOrShowForBuild(context.extensionUri, api, {
        id: build.id!,
        buildNumber: build.buildNumber ?? '',
        definitionName: build.definition?.name ?? 'Pipeline',
        project: build.project?.name || pipelineProvider.getSelectedProject(),
      }, pipelineProvider.getSelectedRepo(), pipelineProvider.getSelectedRepoName());
    }),

    vscode.commands.registerCommand('azureDevOpsPR.openPipelineBuildInBrowser', (item: any) => {
      const url = buildBuildBrowserUrl(item);
      if (!url) {
        vscode.window.showWarningMessage('Unable to determine pipeline run URL for this item.');
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(url));
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
        const label = project ? `Pull Requests (${project})` : 'Pull Requests';
        prTreeView.title = label;
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
        const label = project ? `Pipelines (${project})` : 'Pipelines';
        pipelineTreeView.title = label;
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

  // Step 3: PAT (password field - never shown in plain text)
  const pat = await vscode.window.showInputBox({
    prompt: 'Enter your Personal Access Token (PAT)',
    placeHolder: 'Paste your PAT here...',
    password: true, // Masks input
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v || v.trim().length < 10) {
        return 'PAT appears too short. Make sure you copied it correctly.';
      }
      return null;
    },
  });

  if (!pat) {
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

  // Save PAT securely using VS Code SecretStorage (OS keychain)
  await authManager.saveCredentials(pat.trim());

  vscode.window.showInformationMessage(
    '✅ Azure DevOps connected! Your PAT is stored securely in the system keychain.'
  );
}

export function deactivate() {
  // Cleanup handled by context.subscriptions
}
