import * as vscode from 'vscode';
import { AzureDevOpsApi, PRWithRepo } from '../api/azureDevOpsApi';
import { GitHelper } from '../utils/gitHelper';
import { PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';

export class PullRequestItem extends vscode.TreeItem {
  constructor(
    public readonly pr: PRWithRepo,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(`#${pr.pullRequestId} ${pr.title}`, collapsibleState);

    this.contextValue = 'pullRequest';
    this.tooltip = this.buildTooltip();
    this.description = this.buildDescription();
    this.iconPath = this.getIcon();

    // Open PR in browser on click
    this.command = {
      command: 'azureDevOpsPR.openPR',
      title: 'Open Pull Request',
      arguments: [this],
    };
  }

  private buildTooltip(): string {
    const parts = [
      `PR #${this.pr.pullRequestId}: ${this.pr.title}`,
      `Author: ${this.pr.createdBy?.displayName ?? 'Unknown'}`,
      `Source: ${this.pr.sourceRefName?.replace('refs/heads/', '')}`,
      `Target: ${this.pr.targetRefName?.replace('refs/heads/', '')}`,
    ];
    if (this.pr.creationDate) {
      parts.push(`Created: ${new Date(this.pr.creationDate).toLocaleString()}`);
    }
    if (this.pr.isDraft) {
      parts.push('📝 Draft');
    }
    if (this.pr.repositoryName) {
      parts.push(`Repo: ${this.pr.repositoryName}`);
    }
    return parts.join('\n');
  }

  private buildDescription(): string {
    const author = this.pr.createdBy?.displayName ?? '';
    const repo = this.pr.repositoryName ? ` • ${this.pr.repositoryName}` : '';
    const draft = this.pr.isDraft ? ' • Draft' : '';
    const created = this.pr.creationDate ? ` • ${this.formatShortDate(new Date(this.pr.creationDate))}` : '';
    return `${author}${repo}${draft}${created}`;
  }

  private formatShortDate(date: Date): string {
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  private getIcon(): vscode.ThemeIcon {
    if (this.pr.isDraft) {
      return new vscode.ThemeIcon('git-pull-request-draft', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
    }
    const reviewerVotes = this.pr.reviewers?.map(r => r.vote ?? 0) ?? [];
    const hasApproval = reviewerVotes.some(v => v >= 10);
    const hasRejection = reviewerVotes.some(v => v <= -10);

    if (hasRejection) {
      return new vscode.ThemeIcon('git-pull-request-closed', new vscode.ThemeColor('errorForeground'));
    }
    if (hasApproval) {
      return new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('testing.iconPassed'));
    }
    return new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('notificationsInfoIcon.foreground'));
  }
}

export class PRSectionItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly prs: PRWithRepo[],
    public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded
  ) {
    super(label, collapsibleState);
    this.contextValue = 'prSection';
    this.description = `${prs.length}`;
  }
}

export class PullRequestProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private pullRequests: PRWithRepo[] = [];
  private loading = false;
  private error: string | undefined;
  private selectedProject: string | undefined;
  private selectedRepo: string | undefined;
  private selectedRepoName: string | undefined;
  private _statusFilter: Set<string> = new Set();
  private _lastKnownStatuses: Set<string> = new Set();
  private _userFilter: Set<string> = new Set();
  private _lastKnownUsers: Map<string, string> = new Map();

  constructor(
    private readonly api: AzureDevOpsApi,
    private readonly gitHelper: GitHelper
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setProject(project: string | undefined): void {
    this.selectedProject = project;
    this.selectedRepo = undefined;
    this.selectedRepoName = undefined;
    this.refresh();
  }

  getSelectedProject(): string | undefined {
    return this.selectedProject;
  }

  setRepository(repoId: string | undefined, repoName?: string): void {
    this.selectedRepo = repoId;
    this.selectedRepoName = repoName;
    this.refresh();
  }

  getSelectedRepo(): string | undefined {
    return this.selectedRepo;
  }

  getSelectedRepoName(): string | undefined {
    return this.selectedRepoName;
  }

  setStatusFilter(statuses: string[]): void {
    this._statusFilter = new Set(statuses.map((status) => status.toLowerCase()));
    this.refresh();
  }

  getStatusFilter(): string[] {
    return [...this._statusFilter];
  }

  getAvailableStatuses(): string[] {
    return [...this._lastKnownStatuses].sort();
  }

  setUserFilter(userIds: string[]): void {
    this._userFilter = new Set(userIds.map((userId) => userId.toLowerCase()));
    this.refresh();
  }

  getUserFilter(): string[] {
    return [...this._userFilter];
  }

  getAvailableUsers(): Array<{ id: string; label: string }> {
    return [...this._lastKnownUsers.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element instanceof PRSectionItem) {
      return element.prs.map(
        pr => new PullRequestItem(pr, vscode.TreeItemCollapsibleState.None)
      );
    }

    if (element) {
      return [];
    }

    // Root level: load PRs
    try {
      this.pullRequests = await this.api.getPullRequests(PullRequestStatus.Active, this.selectedProject, this.selectedRepo);
      this.pullRequests.forEach((pr) => {
        this._lastKnownStatuses.add(this.classifyStatus(pr));
        const userId = this.getUserId(pr);
        if (userId) {
          this._lastKnownUsers.set(userId, pr.createdBy?.displayName ?? 'Unknown');
        }
      });
    } catch (err: any) {
      const errorItem = new vscode.TreeItem(
        'Failed to load pull requests',
        vscode.TreeItemCollapsibleState.None
      );
      errorItem.iconPath = new vscode.ThemeIcon('error');
      errorItem.tooltip = err?.message ?? String(err);
      errorItem.command = {
        command: 'azureDevOpsPR.configurePAT',
        title: 'Configure',
      };
      return [errorItem];
    }

    const filteredPullRequests = this.pullRequests
      .filter((pr) => this._statusFilter.size === 0 || this._statusFilter.has(this.classifyStatus(pr).toLowerCase()))
      .filter((pr) => this._userFilter.size === 0 || this._userFilter.has(this.getUserId(pr)));

    if (filteredPullRequests.length === 0) {
      const emptyItem = new vscode.TreeItem(
        this.hasActiveFilter() ? 'No pull requests match the active filters' : 'No active pull requests',
        vscode.TreeItemCollapsibleState.None
      );
      emptyItem.iconPath = new vscode.ThemeIcon('info');
      return this.hasActiveFilter() ? [this.createFilterNote(), emptyItem] : [emptyItem];
    }

    // Group by: Mine, Needs Review, All Others
    const currentBranch = await this.gitHelper.getCurrentBranch();

    const mine: PRWithRepo[] = [];
    const needsReview: PRWithRepo[] = [];
    const others: PRWithRepo[] = [];

    // We can't easily get the current user without an extra API call, 
    // so group by branch match vs others
    for (const pr of filteredPullRequests) {
      const sourceBranch = pr.sourceRefName?.replace('refs/heads/', '');
      if (sourceBranch === currentBranch) {
        mine.push(pr);
      } else if ((pr.reviewers?.length ?? 0) > 0) {
        needsReview.push(pr);
      } else {
        others.push(pr);
      }
    }

    const sections: vscode.TreeItem[] = [];

    if (mine.length > 0) {
      sections.push(new PRSectionItem('My Pull Requests', mine));
    }
    if (needsReview.length > 0) {
      sections.push(new PRSectionItem('Needs Review', needsReview));
    }
    if (others.length > 0) {
      sections.push(new PRSectionItem('All Pull Requests', others));
    }

    // If only one section, show flat list
    if (sections.length === 1) {
      const flatItems = filteredPullRequests.map(
        pr => new PullRequestItem(pr, vscode.TreeItemCollapsibleState.None)
      );
      return this.hasActiveFilter() ? [this.createFilterNote(), ...flatItems] : flatItems;
    }

    return this.hasActiveFilter() ? [this.createFilterNote(), ...sections] : sections;
  }

  private classifyStatus(pr: PRWithRepo): string {
    if (pr.isDraft) {
      return 'Draft';
    }

    const reviewerVotes = pr.reviewers?.map((reviewer) => reviewer.vote ?? 0) ?? [];
    if (reviewerVotes.some((vote) => vote <= -10)) {
      return 'Changes Requested';
    }
    if (reviewerVotes.some((vote) => vote >= 10)) {
      return 'Approved';
    }
    return 'Needs Review';
  }

  private createFilterNote(): vscode.TreeItem {
    const parts: string[] = [];

    if (this._statusFilter.size > 0) {
      const statusLabel = [...this._statusFilter]
        .map((status) => status.split(' ').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(' '))
        .join(', ');
      parts.push(`Status: ${statusLabel}`);
    }

    if (this._userFilter.size > 0) {
      const userLabel = [...this._userFilter]
        .map((userId) => this._lastKnownUsers.get(userId) ?? userId)
        .join(', ');
      parts.push(`Author: ${userLabel}`);
    }

    const filterNote = new vscode.TreeItem(`Filtering: ${parts.join(' | ')}`, vscode.TreeItemCollapsibleState.None);
    filterNote.iconPath = new vscode.ThemeIcon('filter');
    filterNote.contextValue = 'prFilterActive';
    return filterNote;
  }

  private getUserId(pr: PRWithRepo): string {
    return (pr.createdBy?.id ?? pr.createdBy?.uniqueName ?? '').toLowerCase();
  }

  private hasActiveFilter(): boolean {
    return this._statusFilter.size > 0 || this._userFilter.size > 0;
  }
}
