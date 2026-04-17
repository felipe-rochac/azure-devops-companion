import * as assert from 'assert';
import * as vscode from 'vscode';
import { AuthManager } from '../../utils/authManager';

suite('AuthManager Tests', () => {
  let authManager: AuthManager;

  // Use a real extension context secret storage for integration-style tests
  suiteSetup(async () => {
    // We can get context from the extension itself in a real test run
    // For unit tests, we mock SecretStorage
    const mockSecrets = createMockSecretStorage();
    authManager = new AuthManager(mockSecrets);
  });

  test('isAuthenticated returns false when no PAT stored', async () => {
    const result = await authManager.isAuthenticated();
    assert.strictEqual(result, false);
  });

  test('saveCredentials and isAuthenticated', async () => {
    await authManager.saveCredentials('test-pat-12345');
    const result = await authManager.isAuthenticated();
    assert.strictEqual(result, true);
  });

  test('getPAT returns stored value', async () => {
    await authManager.saveCredentials('my-secret-pat');
    const pat = await authManager.getPAT();
    assert.strictEqual(pat, 'my-secret-pat');
  });

  test('clearCredentials removes PAT', async () => {
    await authManager.saveCredentials('some-pat');
    await authManager.clearCredentials();
    const result = await authManager.isAuthenticated();
    assert.strictEqual(result, false);
  });

  test('saveCredentials trims whitespace', async () => {
    await authManager.saveCredentials('  padded-pat  ');
    const pat = await authManager.getPAT();
    assert.strictEqual(pat, 'padded-pat');
  });

  test('saveCredentials throws on empty string', async () => {
    await assert.rejects(
      () => authManager.saveCredentials(''),
      /PAT cannot be empty/
    );
  });
});

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
