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
    return `${author}${repo}${draft}`;
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

    if (this.pullRequests.length === 0) {
      const emptyItem = new vscode.TreeItem(
        'No active pull requests',
        vscode.TreeItemCollapsibleState.None
      );
      emptyItem.iconPath = new vscode.ThemeIcon('info');
      return [emptyItem];
    }

    // Group by: Mine, Needs Review, All Others
    const currentBranch = await this.gitHelper.getCurrentBranch();

    const mine: PRWithRepo[] = [];
    const needsReview: PRWithRepo[] = [];
    const others: PRWithRepo[] = [];

    // We can't easily get the current user without an extra API call, 
    // so group by branch match vs others
    for (const pr of this.pullRequests) {
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
      return this.pullRequests.map(
        pr => new PullRequestItem(pr, vscode.TreeItemCollapsibleState.None)
      );
    }

    return sections;
  }
}
