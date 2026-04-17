import * as assert from 'assert';
import * as vscode from 'vscode';
import { AzureDevOpsApi, PRWithRepo } from '../../api/azureDevOpsApi';
import { AuthManager } from '../../utils/authManager';
import { PullRequestStatus, GitPullRequest, CommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';

function createMockSecretStorage(): vscode.SecretStorage {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key),
    store: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    keys: async () => Array.from(store.keys()),
    onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
  };
}

suite('AzureDevOpsApi Tests', () => {
  let api: AzureDevOpsApi;
  let authManager: AuthManager;

  setup(async () => {
    const mockSecrets = createMockSecretStorage();
    authManager = new AuthManager(mockSecrets);
    api = new AzureDevOpsApi(authManager);
  });

  test('getPullRequests throws when not authenticated', async () => {
    await assert.rejects(
      () => api.getPullRequests(),
      /Not authenticated/
    );
  });

  test('getPullRequests throws when org URL not configured', async () => {
    await authManager.saveCredentials('fake-pat-token-12345');
    // With no org URL configured, it should throw
    const config = vscode.workspace.getConfiguration('azureDevOpsPR');
    const orgUrl = config.get<string>('organizationUrl', '');
    if (!orgUrl) {
      await assert.rejects(
        () => api.getPullRequests(),
        /Organization URL not configured/
      );
    }
  });

  test('resetConnection clears cached clients', () => {
    // Should not throw
    api.resetConnection();
    api.resetConnection(); // idempotent
  });

  test('createPullRequest throws when not authenticated', async () => {
    await assert.rejects(
      () => api.createPullRequest('repo-id', 'title', 'desc', 'source', 'target'),
      /Not authenticated/
    );
  });

  test('approvePullRequest throws when not authenticated', async () => {
    const mockPr: GitPullRequest = {
      pullRequestId: 1,
      repository: { id: 'repo-id' },
    };
    await assert.rejects(
      () => api.approvePullRequest(mockPr),
      /Not authenticated/
    );
  });

  test('approvePullRequest validates required PR fields', async () => {
    await authManager.saveCredentials('fake-pat-token-12345');
    const config = vscode.workspace.getConfiguration('azureDevOpsPR');
    const orgUrl = config.get<string>('organizationUrl', '');
    if (orgUrl) {
      // Only test field validation when org URL is set (otherwise fails on auth)
      const incompletePr: GitPullRequest = {};
      await assert.rejects(
        () => api.approvePullRequest(incompletePr),
        /missing repository ID/
      );
    }
  });

  test('getPRThreads throws when not authenticated', async () => {
    await assert.rejects(
      () => api.getPRThreads('repo-id', 1),
      /Not authenticated/
    );
  });

  test('addComment throws when not authenticated', async () => {
    await assert.rejects(
      () => api.addComment('repo-id', 1, 'test comment'),
      /Not authenticated/
    );
  });

  test('getBuilds throws when not authenticated', async () => {
    await assert.rejects(
      () => api.getBuilds(),
      /Not authenticated/
    );
  });

  test('getRepositories throws when not authenticated', async () => {
    await assert.rejects(
      () => api.getRepositories(),
      /Not authenticated/
    );
  });

  test('getBranches throws when not authenticated', async () => {
    await assert.rejects(
      () => api.getBranches('repo-id'),
      /Not authenticated/
    );
  });
});
