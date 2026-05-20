import * as azdev from 'azure-devops-node-api';
import * as GitApi from 'azure-devops-node-api/GitApi';
import * as BuildApi from 'azure-devops-node-api/BuildApi';
import * as ReleaseApi from 'azure-devops-node-api/ReleaseApi';
import * as WorkItemTrackingApi from 'azure-devops-node-api/WorkItemTrackingApi';
import { GitPullRequest, GitPullRequestSearchCriteria, PullRequestStatus, Comment, CommentThread, GitPullRequestChange, GitPullRequestIteration } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { Build, BuildDefinitionReference, BuildQueryOrder, BuildStatus, Timeline, YamlProcess } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { Release, ReleaseDefinition, ReleaseStartMetadata } from 'azure-devops-node-api/interfaces/ReleaseInterfaces';
import { WorkItem, Wiql } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import { JsonPatchOperation } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { AuthManager } from '../utils/authManager';
import * as vscode from 'vscode';

const yaml = require('js-yaml');

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;
const SILENT_REFRESH_TOAST_COOLDOWN_MS = 5 * 60 * 1000;

export interface PRWithRepo extends GitPullRequest {
  repositoryName?: string;
}

export interface WorkItemSummary {
  id: number;
  title: string;
  state: string;
  type: string;
  assignedTo?: string;
  createdDate?: string;
  changedDate?: string;
  projectName?: string;
  url: string;
}

export interface CurrentUserIdentity {
  id: string;
  displayName?: string;
}

export interface PipelineInputDefinition {
  name: string;
  label: string;
  defaultValue: string;
  type: string;
  required: boolean;
  options?: Record<string, string>;
}

export interface PipelineParameterMetadata {
  variables: { name: string; value: string; allowOverride: boolean }[];
  inputs: PipelineInputDefinition[];
}

export class AzureDevOpsApi {
  private connection: azdev.WebApi | undefined;
  private gitClient: GitApi.IGitApi | undefined;
  private buildClient: BuildApi.IBuildApi | undefined;
  private releaseClient: ReleaseApi.IReleaseApi | undefined;
  private workItemClient: WorkItemTrackingApi.IWorkItemTrackingApi | undefined;
  private accessToken: string | undefined;
  private lastSilentRefreshToastAt = 0;

  constructor(private readonly authManager: AuthManager) {}

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Request timed out')), REQUEST_TIMEOUT_MS)
          ),
        ]);
      } catch (err: any) {
        lastError = err;
        const status = err?.statusCode ?? err?.status ?? err?.result?.statusCode;
        const typeKey = (err?.result?.typeKey ?? err?.typeKey ?? '').toLowerCase();
        const msg = (err?.message ?? '').toLowerCase();

        // Token/session expiry: try to renew credentials once, then retry.
        if (status === 401 || typeKey.includes('unauthorized')) {
          const refreshed = await this.tryRefreshCredentials(attempt);
          if (refreshed) {
            continue;
          }
          throw new Error('Authentication expired. Please sign in again to Azure DevOps.');
        }

        // Don't retry known non-transient issues
        if (status === 403 || status === 404 || typeKey.includes('doesnotexist')) {
          throw err;
        }
        // Retry on: server errors (5xx), rate limiting (429), timeouts, network errors
        const isRetryable = status >= 500 || status === 429 ||
          msg.includes('timed out') || msg.includes('econnreset') ||
          msg.includes('econnrefused') || msg.includes('socket hang up');
        if (attempt < MAX_RETRIES && isRetryable) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  private async tryRefreshCredentials(attempt: number): Promise<boolean> {
    if (attempt >= MAX_RETRIES) {
      return false;
    }

    try {
      const silent = await this.authManager.refreshAccessTokenSilently();
      if (silent) {
        this.resetConnection();
        this.notifySilentRefresh();
        return true;
      }

      const interactive = await this.authManager.refreshAccessTokenInteractive();
      if (interactive) {
        this.resetConnection();
        return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  private notifySilentRefresh(): void {
    const now = Date.now();
    if (now - this.lastSilentRefreshToastAt < SILENT_REFRESH_TOAST_COOLDOWN_MS) {
      return;
    }
    this.lastSilentRefreshToastAt = now;
    void vscode.window.showInformationMessage('Azure DevOps session refreshed automatically.');
  }

  /**
   * Reset connection (e.g., after config change)
   */
  resetConnection() {
    this.connection = undefined;
    this.gitClient = undefined;
    this.buildClient = undefined;
    this.releaseClient = undefined;
    this.workItemClient = undefined;
    this.accessToken = undefined;
  }

  private getConfig() {
    const config = vscode.workspace.getConfiguration('azureDevOpsPR');
    const orgUrl = config.get<string>('organizationUrl', '').trim().replace(/\/$/, '');
    const project = config.get<string>('project', '').trim();
    return { orgUrl, project };
  }

  private async getConnection(): Promise<azdev.WebApi> {
    const token = await this.authManager.getAccessToken();
    if (!token) {
      throw new Error('Not authenticated. Please sign in to Azure DevOps.');
    }

    const { orgUrl } = this.getConfig();
    if (!orgUrl) {
      throw new Error('Organization URL not configured. Please run "Sign In to Azure DevOps".');
    }

    if (this.connection && this.accessToken === token) {
      return this.connection;
    }

    // Use OAuth bearer token acquired via Microsoft Entra sign-in.
    const authHandler = azdev.getBearerHandler(token);
    this.connection = new azdev.WebApi(orgUrl, authHandler);
    this.accessToken = token;
    this.gitClient = undefined;
    this.buildClient = undefined;
    this.workItemClient = undefined;

    return this.connection;
  }

  private async getGitClient(): Promise<GitApi.IGitApi> {
    if (this.gitClient) {
      return this.gitClient;
    }
    const conn = await this.getConnection();
    this.gitClient = await conn.getGitApi();
    return this.gitClient;
  }

  private async getBuildClient(): Promise<BuildApi.IBuildApi> {
    if (this.buildClient) {
      return this.buildClient;
    }
    const conn = await this.getConnection();
    this.buildClient = await conn.getBuildApi();
    return this.buildClient;
  }

  private async getReleaseClient(): Promise<ReleaseApi.IReleaseApi> {
    if (this.releaseClient) {
      return this.releaseClient;
    }
    const conn = await this.getConnection();
    this.releaseClient = await conn.getReleaseApi();
    return this.releaseClient;
  }

  private async getWorkItemClient(): Promise<WorkItemTrackingApi.IWorkItemTrackingApi> {
    if (this.workItemClient) {
      return this.workItemClient;
    }
    const conn = await this.getConnection();
    this.workItemClient = await conn.getWorkItemTrackingApi();
    return this.workItemClient;
  }

  /**
   * Fetch pull requests for the configured project.
   */
  async getPullRequests(status: PullRequestStatus = PullRequestStatus.Active, projectName?: string, repositoryId?: string): Promise<PRWithRepo[]> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const project = projectName || this.getConfig().project;
      const config = vscode.workspace.getConfiguration('azureDevOpsPR');
      const showDrafts = config.get<boolean>('showDrafts', true);
      const defaultRepo = repositoryId || config.get<string>('defaultRepository', '').trim();

      const criteria: GitPullRequestSearchCriteria = { status };

      let prs: GitPullRequest[] = [];

      if (defaultRepo) {
        prs = await git.getPullRequests(defaultRepo, criteria, project) ?? [];
      } else {
        const repos = await git.getRepositories(project);
        const allPrs = await Promise.all(
          (repos ?? []).map(repo =>
            git.getPullRequests(repo.id!, criteria, project)
              .then(list => (list ?? []).map(pr => ({ ...pr, repositoryName: repo.name })))
              .catch(() => [] as PRWithRepo[])
          )
        );
        prs = allPrs.flat();
      }

      if (!showDrafts) {
        prs = prs.filter(pr => !pr.isDraft);
      }

      return prs as PRWithRepo[];
    });
  }

  /**
   * Fetch a single PR by ID.
   */
  async getPullRequest(repositoryId: string, pullRequestId: number): Promise<GitPullRequest> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();
      return await git.getPullRequest(repositoryId, pullRequestId, project);
    });
  }

  /**
   * Create a new pull request.
   */
  async createPullRequest(
    repositoryId: string,
    title: string,
    description: string,
    sourceBranch: string,
    targetBranch: string,
    isDraft: boolean = false
  ): Promise<GitPullRequest> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();

      const pr: GitPullRequest = {
        title,
        description,
        sourceRefName: `refs/heads/${sourceBranch}`,
        targetRefName: `refs/heads/${targetBranch}`,
        isDraft,
      };

      return await git.createPullRequest(pr, repositoryId, project);
    });
  }

  /**
   * Approve a pull request.
   */
  async approvePullRequest(pr: GitPullRequest): Promise<void> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();
      const conn = await this.getConnection();
      
      // Vote: 10 = approved, 5 = approved with suggestions, 0 = no vote, -5 = waiting, -10 = rejected
      const reviewer = { vote: 10 };
      const repoId = pr.repository?.id;
      const prId = pr.pullRequestId;

      if (!repoId || !prId) {
        throw new Error('Pull request is missing repository ID or PR ID');
      }

      const connectionData = await conn.connect();
      const userId = connectionData.authenticatedUser?.id;

      if (!userId) {
        throw new Error('Could not determine current user ID');
      }

      await git.createPullRequestReviewer(reviewer, repoId, prId, userId, project);
    });
  }

  /**
   * Get threads (comments) for a PR.
   */
  async getPRThreads(repositoryId: string, pullRequestId: number): Promise<CommentThread[]> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();
      return await git.getThreads(repositoryId, pullRequestId, project) ?? [];
    });
  }

  /**
   * Add a comment to a PR thread.
   */
  async addComment(
    repositoryId: string,
    pullRequestId: number,
    content: string
  ): Promise<CommentThread> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();

      const thread: CommentThread = {
        comments: [{ content, commentType: 1 }],
        status: 1, // Active
      };

      return await git.createThread(thread, repositoryId, pullRequestId, project);
    });
  }

  /**
   * Get recent builds / pipeline runs.
   */
  async getBuilds(top: number = 100, projectName?: string, repositoryId?: string): Promise<Build[]> {
    return this.withRetry(async () => {
      const build = await this.getBuildClient();
      const project = projectName || this.getConfig().project;
      return await build.getBuilds(
        project, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, BuildStatus.All, undefined, undefined, undefined, top, undefined,
        undefined, undefined, undefined, undefined, undefined,
        repositoryId, repositoryId ? 'TfsGit' : undefined
      ) ?? [];
    });
  }

  /**
   * Get list of repositories in the project.
   */
  async getRepositories(projectName?: string) {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const project = projectName || this.getConfig().project;
      return await git.getRepositories(project) ?? [];
    });
  }

  /**
   * Get branches for a repository.
   */
  async getBranches(repositoryId: string) {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();
      return await git.getBranches(repositoryId, project) ?? [];
    });
  }

  /**
   * Get pipeline definitions for a project.
   */
  async getPipelineDefinitions(projectName?: string, repositoryId?: string, top: number = 100): Promise<BuildDefinitionReference[]> {
    return this.withRetry(async () => {
      const build = await this.getBuildClient();
      const project = projectName || this.getConfig().project;
      const repoType = repositoryId ? 'TfsGit' : undefined;
      return await build.getDefinitions(
        project,
        undefined, // name
        repositoryId,
        repoType,
        undefined, // queryOrder
        top,
        undefined, // continuationToken
        undefined, // minMetricsTime
        undefined, // definitionIds
        undefined, // path
        undefined, // builtAfter
        undefined, // notBuiltAfter
        undefined, // includeAllProperties
        true,      // includeLatestBuilds
      ) ?? [];
    });
  }

  /**
   * Get builds for a specific pipeline definition, optionally filtered by project.
   */
  async getBuildsForDefinition(definitionId: number, projectName?: string, top: number = 20): Promise<Build[]> {
    return this.withRetry(async () => {
      const build = await this.getBuildClient();
      const project = projectName || this.getConfig().project;
      return await build.getBuilds(
        project,
        [definitionId],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        top,
        undefined,
        undefined,
        undefined,
        BuildQueryOrder.QueueTimeDescending
      ) ?? [];
    });
  }

  /**
   * Get build timeline (stages, jobs, steps) for a specific build.
   */
  async getBuildTimeline(buildId: number, projectName?: string): Promise<Timeline | null> {
    return this.withRetry(async () => {
      const build = await this.getBuildClient();
      const project = projectName || this.getConfig().project;
      return await build.getBuildTimeline(project, buildId) ?? null;
    });
  }

  /**
   * Get a build definition with full details (variables, process parameters).
   */
  async getBuildDefinition(definitionId: number, projectName?: string) {
    return this.withRetry(async () => {
      const build = await this.getBuildClient();
      const project = projectName || this.getConfig().project;
      return await build.getDefinition(project, definitionId);
    });
  }

  /**
   * Queue (trigger) a new build for a pipeline definition.
   */
  async queueBuild(definitionId: number, sourceBranch?: string, projectName?: string, parameters?: Record<string, string>, templateParameters?: Record<string, string>): Promise<Build> {
    return this.withRetry(async () => {
      const build = await this.getBuildClient();
      const project = projectName || this.getConfig().project;
      const buildToQueue: Build = {
        definition: { id: definitionId },
        sourceBranch: sourceBranch ? `refs/heads/${sourceBranch}` : undefined,
        parameters: parameters ? JSON.stringify(parameters) : undefined,
        templateParameters: templateParameters,
      };
      return await build.queueBuild(buildToQueue, project);
    });
  }

  async getPipelineParameterMetadata(definitionId: number, projectName?: string): Promise<PipelineParameterMetadata> {
    return this.withRetry(async () => {
      const def = await this.getBuildDefinition(definitionId, projectName);
      const variables: { name: string; value: string; allowOverride: boolean }[] = [];

      if (def.variables) {
        for (const [name, value] of Object.entries(def.variables)) {
          if (value.allowOverride && !value.isSecret) {
            variables.push({ name, value: value.value ?? '', allowOverride: true });
          }
        }
      }

      const inputs: PipelineInputDefinition[] = [];
      if (def.processParameters?.inputs) {
        for (const input of def.processParameters.inputs) {
          inputs.push({
            name: input.name ?? '',
            label: input.label ?? input.name ?? '',
            defaultValue: input.defaultValue ?? '',
            type: input.type ?? 'string',
            required: input.required ?? false,
            options: input.options,
          });
        }
      }

      if (inputs.length > 0) {
        return { variables, inputs };
      }

      const yamlInputs = await this.getYamlRuntimeParameters(def, projectName);
      return { variables, inputs: yamlInputs };
    });
  }

  private async getYamlRuntimeParameters(definition: any, projectName?: string): Promise<PipelineInputDefinition[]> {
    const process = definition.process as YamlProcess | undefined;
    const yamlFilename = process?.yamlFilename;
    const repositoryId = definition.repository?.id;
    const defaultBranch = definition.repository?.defaultBranch;

    if (!yamlFilename || !repositoryId || !defaultBranch) {
      return [];
    }

    const branchName = String(defaultBranch).replace(/^refs\/heads\//, '');
    const yamlText = await this.getFileContentByBranch(repositoryId, yamlFilename, branchName || String(defaultBranch));
    const parsed = yaml.load(yamlText) as any;
    const parameters = parsed?.parameters;
    if (!parameters) {
      return [];
    }

    return this.normalizeYamlParameters(parameters);
  }

  private normalizeYamlParameters(parameters: any): PipelineInputDefinition[] {
    if (Array.isArray(parameters)) {
      return parameters
        .map((parameter) => this.normalizeYamlParameterEntry(parameter))
        .filter((parameter): parameter is PipelineInputDefinition => Boolean(parameter));
    }

    if (parameters && typeof parameters === 'object') {
      return Object.entries(parameters).map(([name, value]) => ({
        name,
        label: name,
        defaultValue: this.stringifyYamlDefault(value),
        type: this.inferYamlType(value),
        required: false,
      }));
    }

    return [];
  }

  private normalizeYamlParameterEntry(parameter: any): PipelineInputDefinition | undefined {
    if (!parameter || typeof parameter !== 'object' || !parameter.name) {
      return undefined;
    }

    const values = Array.isArray(parameter.values) ? parameter.values : [];
    const options = values.length > 0
      ? Object.fromEntries(values.map((value: any) => {
          const text = this.stringifyYamlDefault(value);
          return [text, text];
        }))
      : undefined;

    return {
      name: String(parameter.name),
      label: String(parameter.displayName ?? parameter.name),
      defaultValue: this.stringifyYamlDefault(parameter.default),
      type: String(parameter.type ?? (values.length > 0 ? 'pickList' : this.inferYamlType(parameter.default))),
      required: parameter.default === undefined,
      options,
    };
  }

  private stringifyYamlDefault(value: any): string {
    if (value === undefined || value === null) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return JSON.stringify(value);
  }

  private inferYamlType(value: any): string {
    if (typeof value === 'boolean') {
      return 'boolean';
    }
    if (typeof value === 'number') {
      return 'number';
    }
    return 'string';
  }

  /**
   * Get release definitions for a project.
   */
  async getReleaseDefinitions(projectName?: string, top: number = 100): Promise<ReleaseDefinition[]> {
    return this.withRetry(async () => {
      const release = await this.getReleaseClient();
      const project = projectName || this.getConfig().project;
      return await release.getReleaseDefinitions(project, undefined, undefined, undefined, undefined, top) ?? [];
    });
  }

  /**
   * Get a single release definition with full details (including artifacts).
   */
  async getReleaseDefinition(definitionId: number, projectName?: string): Promise<ReleaseDefinition> {
    return this.withRetry(async () => {
      const release = await this.getReleaseClient();
      const project = projectName || this.getConfig().project;
      return await release.getReleaseDefinition(project, definitionId);
    });
  }

  /**
   * Get recent releases, optionally filtered by definition.
   */
  async getReleases(projectName?: string, definitionId?: number, top: number = 20): Promise<Release[]> {
    return this.withRetry(async () => {
      const release = await this.getReleaseClient();
      const project = projectName || this.getConfig().project;
      return await release.getReleases(project, definitionId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, top) ?? [];
    });
  }

  /**
   * Create (trigger) a new release for a given release definition.
   */
  async createRelease(definitionId: number, description?: string, projectName?: string, artifacts?: { alias: string; version?: string; branch?: string }[]): Promise<Release> {
    return this.withRetry(async () => {
      const release = await this.getReleaseClient();
      const project = projectName || this.getConfig().project;
      const metadata: ReleaseStartMetadata = {
        definitionId,
        description: description || undefined,
        artifacts: artifacts?.map(a => ({
          alias: a.alias,
          instanceReference: {
            name: a.version || undefined,
            sourceBranch: a.branch || undefined,
          },
        })),
      };
      return await release.createRelease(metadata, project);
    });
  }

  /**
   * List projects in the organization.
   */
  async getProjects(): Promise<{ id: string; name: string }[]> {
    return this.withRetry(async () => {
      const conn = await this.getConnection();
      const coreApi = await conn.getCoreApi();
      const projects = await coreApi.getProjects();
      return (projects ?? []).map(p => ({ id: p.id!, name: p.name! }));
    });
  }

  async queryAssignedWorkItems(projectName?: string, top: number = 20): Promise<WorkItemSummary[]> {
    return this.withRetry(async () => {
      const workItems = await this.getWorkItemClient();
      const project = projectName || this.getConfig().project;
      const whereClauses = [`[System.AssignedTo] = @Me`];
      if (project) {
        whereClauses.push(`[System.TeamProject] = '${project.replace(/'/g, "''")}'`);
      }

      const wiql: Wiql = {
        query: `SELECT [System.Id] FROM WorkItems WHERE ${whereClauses.join(' AND ')} ORDER BY [System.ChangedDate] DESC`,
      };

      const result = await workItems.queryByWiql(wiql, undefined, false, top);
      const ids = (result.workItems ?? []).map((item) => item.id).filter((id): id is number => typeof id === 'number');
      if (ids.length === 0) {
        return [];
      }
      return await this.getWorkItems(ids, project || undefined);
    });
  }

  async getWorkItems(ids: number[], projectName?: string): Promise<WorkItemSummary[]> {
    const uniqueIds = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
    if (uniqueIds.length === 0) {
      return [];
    }

    return this.withRetry(async () => {
      const workItems = await this.getWorkItemClient();
      const project = projectName || this.getConfig().project || undefined;
      const items = await workItems.getWorkItems(
        uniqueIds,
        [
          'System.Id',
          'System.Title',
          'System.State',
          'System.WorkItemType',
          'System.AssignedTo',
          'System.ChangedDate',
          'System.TeamProject',
        ],
        undefined,
        undefined,
        undefined,
        project
      ) ?? [];

      const byId = new Map<number, WorkItemSummary>();
      for (const item of items) {
        const summary = this.toWorkItemSummary(item, project);
        if (summary) {
          byId.set(summary.id, summary);
        }
      }

      return uniqueIds.map((id) => byId.get(id)).filter((item): item is WorkItemSummary => Boolean(item));
    });
  }

  async createTaskWorkItem(title: string, description?: string, projectName?: string): Promise<WorkItemSummary> {
    return this.withRetry(async () => {
      const workItems = await this.getWorkItemClient();
      const project = projectName || this.getConfig().project;
      if (!project) {
        throw new Error('Project name is required to create a work item.');
      }

      const document: JsonPatchOperation[] = [
        { op: 0, path: '/fields/System.Title', value: title.trim() },
      ];
      if (description?.trim()) {
        document.push({ op: 0, path: '/fields/System.Description', value: description.trim() });
      }

      const created = await workItems.createWorkItem(
        { 'Content-Type': 'application/json-patch+json' },
        document as any,
        project,
        'Task'
      );

      const summary = this.toWorkItemSummary(created, project);
      if (!summary) {
        throw new Error('Work item was created but could not be parsed.');
      }
      return summary;
    });
  }

  async updateWorkItemState(id: number, state: string, projectName?: string): Promise<WorkItemSummary> {
    return this.updateWorkItemFields(id, [{ op: 0, path: '/fields/System.State', value: state }], projectName);
  }

  async addWorkItemNote(id: number, note: string, projectName?: string): Promise<WorkItemSummary> {
    return this.updateWorkItemFields(id, [{ op: 0, path: '/fields/System.History', value: note.trim() }], projectName);
  }

  async assignWorkItemToCurrentUser(id: number, projectName?: string): Promise<WorkItemSummary> {
    const currentUser = await this.getCurrentUserIdentity();
    const assignee = currentUser.displayName;
    if (!assignee) {
      throw new Error('Could not determine the current user name for assignment.');
    }
    return this.updateWorkItemFields(id, [{ op: 0, path: '/fields/System.AssignedTo', value: assignee }], projectName);
  }

  async getCurrentUserIdentity(): Promise<CurrentUserIdentity> {
    const conn = await this.getConnection();
    const connectionData = await conn.connect();
    const user = connectionData.authenticatedUser;
    const userId = user?.id;
    if (!userId) {
      throw new Error('Could not determine current user identity');
    }
    return {
      id: userId,
      displayName: user?.customDisplayName || user?.providerDisplayName,
    };
  }

  /**
   * Get PR iterations (each push to the PR creates an iteration).
   */
  async getPRIterations(repositoryId: string, pullRequestId: number): Promise<GitPullRequestIteration[]> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();
      return await git.getPullRequestIterations(repositoryId, pullRequestId, project) ?? [];
    });
  }

  /**
   * Get changes (files) for a specific PR iteration.
   */
  async getPRIterationChanges(repositoryId: string, pullRequestId: number, iterationId: number): Promise<GitPullRequestChange[]> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();
      const result = await git.getPullRequestIterationChanges(repositoryId, pullRequestId, iterationId, project);
      return (result?.changeEntries ?? []) as GitPullRequestChange[];
    });
  }

  /**
   * Get raw file content from a repository at a specific commit.
   */
  async getFileContent(repositoryId: string, path: string, commitOrBranch: string): Promise<string> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();
      const stream = await git.getItemContent(repositoryId, path, project, undefined, undefined, undefined, undefined, undefined, { version: commitOrBranch, versionType: 2 /* commit */ });
      return await this.streamToString(stream);
    });
  }

  /**
   * Get file content from a specific branch by name.
   */
  async getFileContentByBranch(repositoryId: string, path: string, branchName: string): Promise<string> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();
      const stream = await git.getItemContent(repositoryId, path, project, undefined, undefined, undefined, undefined, undefined, { version: branchName, versionType: 0 /* branch */ });
      return await this.streamToString(stream);
    });
  }

  private streamToString(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  }

  /**
   * Vote on a pull request.
   * vote: 10=approved, 5=approved with suggestions, 0=no vote, -5=waiting for author, -10=rejected
   */
  async votePullRequest(pr: GitPullRequest, vote: number): Promise<void> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();
      const conn = await this.getConnection();

      const repoId = pr.repository?.id;
      const prId = pr.pullRequestId;
      if (!repoId || !prId) {
        throw new Error('Pull request is missing repository ID or PR ID');
      }

      const connectionData = await conn.connect();
      const userId = connectionData.authenticatedUser?.id;
      if (!userId) {
        throw new Error('Could not determine current user ID');
      }

      await git.createPullRequestReviewer({ vote }, repoId, prId, userId, project);
    });
  }

  /**
   * Create an inline comment thread on a specific file and line.
   */
  async createInlineThread(
    repositoryId: string,
    pullRequestId: number,
    content: string,
    filePath: string,
    line: number,
    endLine?: number
  ): Promise<CommentThread> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();

      const thread: CommentThread = {
        comments: [{ content, commentType: 1 }],
        threadContext: {
          filePath,
          rightFileStart: { line, offset: 1 },
          rightFileEnd: { line: endLine ?? line, offset: 1 },
        },
        status: 1,
      };

      return await git.createThread(thread, repositoryId, pullRequestId, project);
    });
  }

  /**
   * Reply to an existing comment thread.
   */
  async replyToThread(
    repositoryId: string,
    pullRequestId: number,
    threadId: number,
    content: string
  ): Promise<Comment> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();
      const comment: Comment = { content, commentType: 1 };
      return await git.createComment(comment, repositoryId, pullRequestId, threadId, project);
    });
  }

  /**
   * Update a comment thread's status.
   * status: 1=active, 2=fixed, 3=wontFix, 4=closed, 5=byDesign, 6=pending
   */
  async updateThreadStatus(
    repositoryId: string,
    pullRequestId: number,
    threadId: number,
    status: number
  ): Promise<void> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();
      await git.updateThread({ status } as CommentThread, repositoryId, pullRequestId, threadId, project);
    });
  }

  /**
   * Get merge conflicts for a pull request.
   */
  async getPRConflicts(repositoryId: string, pullRequestId: number): Promise<any[]> {
    return this.withRetry(async () => {
      const git = await this.getGitClient();
      const { project } = this.getConfig();
      try {
        return await (git as any).getPullRequestConflicts(repositoryId, pullRequestId, project) ?? [];
      } catch {
        return [];
      }
    });
  }

  /**
   * Get the current authenticated user's ID.
   */
  async getCurrentUserId(): Promise<string> {
    return (await this.getCurrentUserIdentity()).id;
  }

  private async updateWorkItemFields(id: number, document: JsonPatchOperation[], projectName?: string): Promise<WorkItemSummary> {
    return this.withRetry(async () => {
      const workItems = await this.getWorkItemClient();
      const project = projectName || this.getConfig().project || undefined;
      const updated = await workItems.updateWorkItem(
        { 'Content-Type': 'application/json-patch+json' },
        document as any,
        id,
        project
      );

      const summary = this.toWorkItemSummary(updated, project);
      if (!summary) {
        throw new Error('Work item was updated but could not be parsed.');
      }
      return summary;
    });
  }

  private toWorkItemSummary(workItem: WorkItem, projectName?: string): WorkItemSummary | undefined {
    const id = workItem.id;
    if (!id) {
      return undefined;
    }

    const fields = workItem.fields ?? {};
    const assignedToField = fields['System.AssignedTo'];
    const assignedTo = typeof assignedToField === 'string'
      ? assignedToField
      : assignedToField?.displayName || assignedToField?.uniqueName;
    const project = fields['System.TeamProject'] || projectName || this.getConfig().project;
    const orgUrl = this.getConfig().orgUrl;

    return {
      id,
      title: fields['System.Title'] ?? `Work Item ${id}`,
      state: fields['System.State'] ?? 'Unknown',
      type: fields['System.WorkItemType'] ?? 'Work Item',
      assignedTo,
      createdDate: fields['System.CreatedDate'],
      changedDate: fields['System.ChangedDate'],
      projectName: project,
      url: `${orgUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}`,
    };
  }
}
