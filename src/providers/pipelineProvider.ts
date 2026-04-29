import * as vscode from 'vscode';
import { AzureDevOpsApi } from '../api/azureDevOpsApi';
import { Build, BuildResult, BuildStatus } from 'azure-devops-node-api/interfaces/BuildInterfaces';

export class PipelineItem extends vscode.TreeItem {
  constructor(public readonly build: Build) {
    super(
      `${build.definition?.name ?? 'Pipeline'} #${build.buildNumber}`,
      vscode.TreeItemCollapsibleState.None
    );

    this.contextValue = 'pipelineBuild';
    this.description = this.buildDescription();
    this.tooltip = this.buildTooltip();
    this.iconPath = this.getIcon();

    this.command = {
      command: 'azureDevOpsPR.openPipelineBuild',
      title: 'Open Build in Dashboard',
      arguments: [this],
    };
  }

  private buildDescription(): string {
    const parts: string[] = [];
    const requester = this.build.requestedFor?.displayName;
    if (requester) {
      parts.push(requester);
    }

    if (this.build.startTime) {
      parts.push(`▶ ${this.formatShortDate(new Date(this.build.startTime))}`);
    }
    if (this.build.finishTime) {
      parts.push(`✓ ${this.formatShortDate(new Date(this.build.finishTime))}`);
    } else if (this.build.startTime) {
      parts.push('In progress');
    }

    return parts.join(' • ');
  }

  private buildTooltip(): string {
    const lines = [
      `${this.build.definition?.name} #${this.build.buildNumber}`,
      `Status: ${this.getStatusLabel()}`,
      `Branch: ${this.build.sourceBranch?.replace('refs/heads/', '') ?? 'N/A'}`,
    ];
    if (this.build.requestedFor?.displayName) {
      lines.push(`Triggered by: ${this.build.requestedFor.displayName}`);
    }
    if (this.build.startTime) {
      lines.push(`Triggered: ${new Date(this.build.startTime).toLocaleString()}`);
    }
    if (this.build.finishTime) {
      lines.push(`Completed: ${new Date(this.build.finishTime).toLocaleString()}`);
    }
    return lines.join('\n');
  }

  private getStatusLabel(): string {
    if (this.build.status === BuildStatus.InProgress) {
      return '⏳ Running';
    }
    switch (this.build.result) {
      case BuildResult.Succeeded: return '✅ Succeeded';
      case BuildResult.Failed: return '❌ Failed';
      case BuildResult.Canceled: return '🚫 Canceled';
      case BuildResult.PartiallySucceeded: return '⚠️ Partial';
      default: return '❓ Unknown';
    }
  }

  private getIcon(): vscode.ThemeIcon {
    if (this.build.status === BuildStatus.InProgress) {
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('notificationsInfoIcon.foreground'));
    }
    switch (this.build.result) {
      case BuildResult.Succeeded:
        return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
      case BuildResult.Failed:
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
      case BuildResult.Canceled:
        return new vscode.ThemeIcon('circle-slash');
      case BuildResult.PartiallySucceeded:
        return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }

  private timeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) { return `${seconds}s ago`; }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) { return `${minutes}m ago`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `${hours}h ago`; }
    return `${Math.floor(hours / 24)}d ago`;
  }

  private formatShortDate(date: Date): string {
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

export class PipelineProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private selectedProject: string | undefined;
  private selectedRepo: string | undefined;
  private selectedRepoName: string | undefined;
  private _statusFilter: Set<string> = new Set();
  private _lastKnownStatuses: Set<string> = new Set();

  constructor(private readonly api: AzureDevOpsApi) {}

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

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    try {
      const builds = await this.api.getBuilds(100, this.selectedProject, this.selectedRepo);
      builds.forEach((build) => this._lastKnownStatuses.add(this.classifyStatus(build)));

      const filteredBuilds = this._statusFilter.size === 0
        ? builds
        : builds.filter((build) => this._statusFilter.has(this.classifyStatus(build).toLowerCase()));

      if (filteredBuilds.length === 0) {
        const empty = new vscode.TreeItem(this._statusFilter.size > 0 ? 'No pipeline runs match the active status filter' : 'No recent pipeline runs');
        empty.iconPath = new vscode.ThemeIcon('info');
        return this._statusFilter.size > 0 ? [this.createFilterNote(), empty] : [empty];
      }

      const items = filteredBuilds.map((build) => new PipelineItem(build));
      return this._statusFilter.size > 0 ? [this.createFilterNote(), ...items] : items;
    } catch (err: any) {
      const errorItem = new vscode.TreeItem('Failed to load pipelines');
      errorItem.iconPath = new vscode.ThemeIcon('error');
      errorItem.tooltip = err?.message;
      return [errorItem];
    }
  }

  private classifyStatus(build: Build): string {
    if (build.status === BuildStatus.InProgress) {
      return 'Running';
    }
    switch (build.result) {
      case BuildResult.Succeeded:
        return 'Succeeded';
      case BuildResult.Failed:
        return 'Failed';
      case BuildResult.Canceled:
        return 'Canceled';
      case BuildResult.PartiallySucceeded:
        return 'Partial';
      default:
        return 'Unknown';
    }
  }

  private createFilterNote(): vscode.TreeItem {
    const label = [...this._statusFilter]
      .map((status) => status ? status[0].toUpperCase() + status.slice(1) : status)
      .join(', ');
    const filterNote = new vscode.TreeItem(`Filtering: ${label}`);
    filterNote.iconPath = new vscode.ThemeIcon('filter');
    filterNote.contextValue = 'pipelineFilterActive';
    return filterNote;
  }
}
