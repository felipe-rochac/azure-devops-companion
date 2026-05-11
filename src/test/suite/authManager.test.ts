import * as assert from 'assert';
import * as vscode from 'vscode';
import { AuthManager } from '../../utils/authManager';

suite('AuthManager Tests', () => {
  let authManager: AuthManager;
  let getSessionStub: (createIfNone: boolean) => vscode.AuthenticationSession | undefined;
  let originalGetSession: typeof vscode.authentication.getSession;

  suiteSetup(async () => {
    originalGetSession = vscode.authentication.getSession;
  });

  setup(async () => {
    getSessionStub = () => undefined;
    (vscode.authentication as any).getSession = async (_providerId: string, _scopes: string[], options: { createIfNone?: boolean }) => {
      return getSessionStub(!!options?.createIfNone);
    };

    const mockSecrets = createMockSecretStorage();
    authManager = new AuthManager(mockSecrets);
  });

  teardown(() => {
    (vscode.authentication as any).getSession = originalGetSession;
  });

  test('isAuthenticated returns false when no session exists', async () => {
    const result = await authManager.isAuthenticated();
    assert.strictEqual(result, false);
  });

  test('signInInteractive enables authenticated state when session is returned', async () => {
    getSessionStub = (createIfNone) => createIfNone ? createMockSession('token-1') : undefined;

    await authManager.signInInteractive();

    getSessionStub = () => createMockSession('token-1');
    const result = await authManager.isAuthenticated();
    assert.strictEqual(result, true);
  });

  test('getAccessToken returns current access token', async () => {
    getSessionStub = () => createMockSession('token-abc');
    const token = await authManager.getAccessToken();
    assert.strictEqual(token, 'token-abc');
  });

  test('clearCredentials disconnects extension auth', async () => {
    getSessionStub = () => createMockSession('token-xyz');
    await authManager.clearCredentials();

    const result = await authManager.isAuthenticated();
    assert.strictEqual(result, false);
  });

  test('signInInteractive throws when no token can be acquired', async () => {
    getSessionStub = () => undefined;
    await assert.rejects(
      () => authManager.signInInteractive(),
      /Sign in failed/
    );
  });
});

function createMockSession(accessToken: string): vscode.AuthenticationSession {
  return {
    id: 'session-id',
    accessToken,
    account: {
      id: 'account-id',
      label: 'Test User',
    },
    scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
  };
}

/**
 * In-memory mock for vscode.SecretStorage — no OS keychain needed in tests.
 */
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
