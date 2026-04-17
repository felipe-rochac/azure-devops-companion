import * as assert from 'assert';
import * as vscode from 'vscode';
import { PullRequestProvider, PullRequestItem, PRSectionItem } from '../../providers/pullRequestProvider';
import { PipelineProvider, PipelineItem } from '../../providers/pipelineProvider';
import { PRWithRepo } from '../../api/azureDevOpsApi';
import { BuildResult, BuildStatus } from 'azure-devops-node-api/interfaces/BuildInterfaces';

suite('PullRequestItem Tests', () => {
  function makePR(overrides: Partial<PRWithRepo> = {}): PRWithRepo {
    return {
      pullRequestId: 42,
      title: 'Test PR',
      createdBy: { displayName: 'Test User' },
      sourceRefName: 'refs/heads/feature/test',
      targetRefName: 'refs/heads/main',
      isDraft: false,
      reviewers: [],
      repositoryName: 'my-repo',
      ...overrides,
    };
  }

  test('displays PR number and title', () => {
    const item = new PullRequestItem(makePR(), vscode.TreeItemCollapsibleState.None);
    assert.strictEqual(item.label, '#42 Test PR');
  });

  test('shows draft indicator in description', () => {
    const item = new PullRequestItem(makePR({ isDraft: true }), vscode.TreeItemCollapsibleState.None);
    assert.ok(item.description?.toString().includes('Draft'));
  });

  test('shows author in description', () => {
    const item = new PullRequestItem(makePR(), vscode.TreeItemCollapsibleState.None);
    assert.ok(item.description?.toString().includes('Test User'));
  });

  test('shows repository name in description', () => {
    const item = new PullRequestItem(makePR(), vscode.TreeItemCollapsibleState.None);
    assert.ok(item.description?.toString().includes('my-repo'));
  });

  test('contextValue is pullRequest', () => {
    const item = new PullRequestItem(makePR(), vscode.TreeItemCollapsibleState.None);
    assert.strictEqual(item.contextValue, 'pullRequest');
  });

  test('has command to open PR', () => {
    const item = new PullRequestItem(makePR(), vscode.TreeItemCollapsibleState.None);
    assert.strictEqual(item.command?.command, 'azureDevOpsPR.openPR');
  });

  test('tooltip includes branch information', () => {
    const item = new PullRequestItem(makePR(), vscode.TreeItemCollapsibleState.None);
    const tooltip = item.tooltip as string;
    assert.ok(tooltip.includes('feature/test'));
    assert.ok(tooltip.includes('main'));
  });

  test('shows draft icon for draft PRs', () => {
    const item = new PullRequestItem(makePR({ isDraft: true }), vscode.TreeItemCollapsibleState.None);
    assert.ok(item.iconPath instanceof vscode.ThemeIcon);
    assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'git-pull-request-draft');
  });

  test('shows approved icon when reviewer approved', () => {
    const item = new PullRequestItem(
      makePR({ reviewers: [{ vote: 10, displayName: 'Reviewer' }] }),
      vscode.TreeItemCollapsibleState.None
    );
    assert.ok(item.iconPath instanceof vscode.ThemeIcon);
    assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'git-pull-request');
  });

  test('shows rejected icon when reviewer rejected', () => {
    const item = new PullRequestItem(
      makePR({ reviewers: [{ vote: -10, displayName: 'Reviewer' }] }),
      vscode.TreeItemCollapsibleState.None
    );
    assert.ok(item.iconPath instanceof vscode.ThemeIcon);
    assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'git-pull-request-closed');
  });
});

suite('PRSectionItem Tests', () => {
  test('displays label and count', () => {
    const prs: PRWithRepo[] = [
      { pullRequestId: 1, title: 'PR 1' },
      { pullRequestId: 2, title: 'PR 2' },
    ];
    const section = new PRSectionItem('My PRs', prs);
    assert.strictEqual(section.label, 'My PRs');
    assert.strictEqual(section.description, '2');
    assert.strictEqual(section.contextValue, 'prSection');
  });
});

suite('PipelineItem Tests', () => {
  test('displays pipeline name and build number', () => {
    const item = new PipelineItem({
      definition: { name: 'CI Pipeline' },
      buildNumber: '20260414.1',
      status: BuildStatus.Completed,
      result: BuildResult.Succeeded,
    });
    assert.strictEqual(item.label, 'CI Pipeline #20260414.1');
  });

  test('shows succeeded icon for successful build', () => {
    const item = new PipelineItem({
      definition: { name: 'CI' },
      buildNumber: '1',
      status: BuildStatus.Completed,
      result: BuildResult.Succeeded,
    });
    assert.ok(item.iconPath instanceof vscode.ThemeIcon);
    assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'pass');
  });

  test('shows error icon for failed build', () => {
    const item = new PipelineItem({
      definition: { name: 'CI' },
      buildNumber: '1',
      status: BuildStatus.Completed,
      result: BuildResult.Failed,
    });
    assert.ok(item.iconPath instanceof vscode.ThemeIcon);
    assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'error');
  });

  test('shows spinning icon for in-progress build', () => {
    const item = new PipelineItem({
      definition: { name: 'CI' },
      buildNumber: '1',
      status: BuildStatus.InProgress,
    });
    assert.ok(item.iconPath instanceof vscode.ThemeIcon);
    assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'sync~spin');
  });

  test('shows requester in description', () => {
    const item = new PipelineItem({
      definition: { name: 'CI' },
      buildNumber: '1',
      status: BuildStatus.Completed,
      result: BuildResult.Succeeded,
      requestedFor: { displayName: 'Alice' },
    });
    assert.ok(item.description?.toString().includes('Alice'));
  });

  test('shows "In progress" for running builds', () => {
    const item = new PipelineItem({
      definition: { name: 'CI' },
      buildNumber: '1',
      status: BuildStatus.InProgress,
      startTime: new Date(),
    });
    assert.ok(item.description?.toString().includes('In progress'));
  });

  test('click opens build in dashboard', () => {
    const item = new PipelineItem({
      definition: { name: 'CI' },
      buildNumber: '1',
      status: BuildStatus.Completed,
      result: BuildResult.Succeeded,
      _links: { web: { href: 'https://dev.azure.com/org/project/_build/results?buildId=1' } },
    });
    assert.strictEqual(item.command?.command, 'azureDevOpsPR.openPipelineBuild');
  });

  test('tooltip includes branch info', () => {
    const item = new PipelineItem({
      definition: { name: 'CI' },
      buildNumber: '1',
      status: BuildStatus.Completed,
      result: BuildResult.Succeeded,
      sourceBranch: 'refs/heads/main',
    });
    const tooltip = item.tooltip as string;
    assert.ok(tooltip.includes('main'));
  });
});

suite('Provider Project Filtering', () => {
  // These tests verify the project selection API on the provider classes.
  // We can't call getChildren without a real API, but we can test state management.

  test('PullRequestProvider stores selected project', () => {
    // PullRequestProvider requires api and gitHelper — use null stubs since we only test setProject/getSelectedProject
    const provider = new PullRequestProvider(null as any, null as any);
    assert.strictEqual(provider.getSelectedProject(), undefined);

    provider.setProject('ProjectA');
    assert.strictEqual(provider.getSelectedProject(), 'ProjectA');

    provider.setProject(undefined);
    assert.strictEqual(provider.getSelectedProject(), undefined);
  });

  test('PipelineProvider stores selected project', () => {
    const provider = new PipelineProvider(null as any);
    assert.strictEqual(provider.getSelectedProject(), undefined);

    provider.setProject('ProjectB');
    assert.strictEqual(provider.getSelectedProject(), 'ProjectB');

    provider.setProject(undefined);
    assert.strictEqual(provider.getSelectedProject(), undefined);
  });

  test('PullRequestProvider fires change event on setProject', () => {
    const provider = new PullRequestProvider(null as any, null as any);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setProject('MyProject');
    assert.ok(fired, 'onDidChangeTreeData should fire when project changes');
  });

  test('PipelineProvider fires change event on setProject', () => {
    const provider = new PipelineProvider(null as any);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setProject('MyProject');
    assert.ok(fired, 'onDidChangeTreeData should fire when project changes');
  });

  test('PullRequestProvider stores selected repository', () => {
    const provider = new PullRequestProvider(null as any, null as any);
    assert.strictEqual(provider.getSelectedRepo(), undefined);

    provider.setRepository('repo-id-1', 'my-repo');
    assert.strictEqual(provider.getSelectedRepo(), 'repo-id-1');
    assert.strictEqual(provider.getSelectedRepoName(), 'my-repo');

    provider.setRepository(undefined);
    assert.strictEqual(provider.getSelectedRepo(), undefined);
    assert.strictEqual(provider.getSelectedRepoName(), undefined);
  });

  test('PipelineProvider stores selected repository', () => {
    const provider = new PipelineProvider(null as any);
    assert.strictEqual(provider.getSelectedRepo(), undefined);

    provider.setRepository('repo-id-2', 'other-repo');
    assert.strictEqual(provider.getSelectedRepo(), 'repo-id-2');
    assert.strictEqual(provider.getSelectedRepoName(), 'other-repo');

    provider.setRepository(undefined);
    assert.strictEqual(provider.getSelectedRepo(), undefined);
  });

  test('setProject clears repository selection', () => {
    const provider = new PullRequestProvider(null as any, null as any);
    provider.setRepository('repo-id', 'my-repo');
    assert.strictEqual(provider.getSelectedRepo(), 'repo-id');

    provider.setProject('NewProject');
    assert.strictEqual(provider.getSelectedRepo(), undefined);
    assert.strictEqual(provider.getSelectedRepoName(), undefined);
  });
});
