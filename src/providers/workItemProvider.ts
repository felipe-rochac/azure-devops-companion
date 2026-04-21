import * as vscode from 'vscode';
import { AzureDevOpsApi, WorkItemSummary } from '../api/azureDevOpsApi';
import { GitHelper } from '../utils/gitHelper';
import { extractWorkItemIdsFromBranch } from '../utils/workItemHelper';

class WorkItemSection extends vscode.TreeItem {
  constructor(public readonly label: string, public readonly items: WorkItemSummary[]) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'workItemSection';
    this.description = `${items.length}`;
  }
}

export class WorkItemTreeItem extends vscode.TreeItem {
  constructor(public readonly workItem: WorkItemSummary) {
    super(`#${workItem.id} ${workItem.title}`, vscode.TreeItemCollapsibleState.None);

    this.contextValue = 'workItem';
    this.description = [workItem.state, workItem.assignedTo].filter(Boolean).join(' • ');
    this.tooltip = this.buildTooltip();
    this.iconPath = this.getIcon();
    this.command = {
      command: 'azureDevOpsPR.openWorkItemInBrowser',
      title: 'Open Work Item',
      arguments: [this],
    };
  }

  private buildTooltip(): string {
    return [
      `${this.workItem.type} #${this.workItem.id}`,
      this.workItem.title,
      `State: ${this.workItem.state}`,
      this.workItem.assignedTo ? `Assigned to: ${this.workItem.assignedTo}` : undefined,
    ].filter(Boolean).join('\n');
  }

  private getIcon(): vscode.ThemeIcon {
    const state = this.workItem.state.toLowerCase();
    if (state.includes('closed') || state.includes('done') || state.includes('resolved')) {
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    }
    if (state.includes('active') || state.includes('committed') || state.includes('in progress')) {
      return new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('notificationsInfoIcon.foreground'));
    }
    return new vscode.ThemeIcon('issues');
  }
}

export class WorkItemProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private selectedProject: string | undefined;
  private _statusFilter: Set<string> = new Set();
  private _lastKnownStatuses: Set<string> = new Set();

  constructor(
    private readonly api: AzureDevOpsApi,
    private readonly gitHelper: GitHelper
  ) {}

  setStatusFilter(statuses: string[]): void {
    this._statusFilter = new Set(statuses.map(s => s.toLowerCase()));
    this.refresh();
  }

  getStatusFilter(): string[] {
    return [...this._statusFilter];
  }

  getAvailableStatuses(): string[] {
    return [...this._lastKnownStatuses].sort();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setProject(project: string | undefined): void {
    this.selectedProject = project;
    this.refresh();
  }

  getSelectedProject(): string | undefined {
    return this.selectedProject;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element instanceof WorkItemSection) {
      return element.items.map((item) => new WorkItemTreeItem(item));
    }

    const project = this.selectedProject;

    try {
      const [assignedToMe, branchName] = await Promise.all([
        this.api.queryAssignedWorkItems(project, 20),
        this.gitHelper.getCurrentBranch(),
      ]);

      const branchIds = extractWorkItemIdsFromBranch(branchName);
      const branchItems = branchIds.length > 0
        ? await this.api.getWorkItems(branchIds, project)
        : [];

      // Track all distinct statuses seen for filter UI
      const allItems = [...assignedToMe, ...branchItems];
      allItems.forEach(i => this._lastKnownStatuses.add(i.state));

      // Apply status filter if active
      const filterItems = (items: WorkItemSummary[]) =>
        this._statusFilter.size === 0
          ? items
          : items.filter(i => this._statusFilter.has(i.state.toLowerCase()));

      const sections: vscode.TreeItem[] = [];
      const filteredAssigned = filterItems(assignedToMe);
      const filteredBranch = filterItems(branchItems);

      if (this._statusFilter.size > 0) {
        const label = [...this._statusFilter].map(s => s[0].toUpperCase() + s.slice(1)).join(', ');
        const filterNote = new vscode.TreeItem(`Filtering: ${label}`);
        filterNote.iconPath = new vscode.ThemeIcon('filter');
        filterNote.contextValue = 'workItemFilterActive';
        sections.push(filterNote);
      }

      if (filteredAssigned.length > 0) {
        sections.push(new WorkItemSection('Assigned to Me', filteredAssigned));
      }
      if (filteredBranch.length > 0) {
        sections.push(new WorkItemSection('From Current Branch', filteredBranch));
      }

      if (sections.length === 0 || (sections.length === 1 && sections[0].contextValue === 'workItemFilterActive')) {
        const empty = new vscode.TreeItem(
          this._statusFilter.size > 0 ? 'No items match the active status filter' : 'No work items found'
        );
        empty.iconPath = new vscode.ThemeIcon('info');
        empty.tooltip = branchName
          ? `No assigned work items or branch-linked work items found for ${branchName}.`
          : 'No assigned work items found.';
        return [empty];
      }

      return sections;
    } catch (err: any) {
      const errorItem = new vscode.TreeItem('Failed to load work items');
      errorItem.iconPath = new vscode.ThemeIcon('error');
      errorItem.tooltip = err?.message ?? String(err);
      return [errorItem];
    }
  }
}
