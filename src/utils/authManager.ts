import * as vscode from 'vscode';

const PAT_SECRET_KEY = 'azureDevOpsPR.pat';

/**
 * AuthManager handles PAT storage using VS Code's SecretStorage API.
 *
 * SecretStorage is backed by:
 * - macOS: Keychain
 * - Windows: Windows Credential Manager
 * - Linux: libsecret / GNOME Keyring
 *
 * PATs are NEVER stored in plain text, settings.json, or workspace files.
 */
export class AuthManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * Save PAT securely. The PAT is stored in OS keychain via SecretStorage.
   */
  async saveCredentials(pat: string): Promise<void> {
    if (!pat || pat.trim().length === 0) {
      throw new Error('PAT cannot be empty');
    }
    await this.secrets.store(PAT_SECRET_KEY, pat.trim());
  }

  /**
   * Retrieve the stored PAT. Returns undefined if not set.
   */
  async getPAT(): Promise<string | undefined> {
    return await this.secrets.get(PAT_SECRET_KEY);
  }

  /**
   * Check if user is authenticated (has a stored PAT).
   */
  async isAuthenticated(): Promise<boolean> {
    const pat = await this.getPAT();
    return !!pat && pat.length > 0;
  }

  /**
   * Remove stored credentials.
   */
  async clearCredentials(): Promise<void> {
    await this.secrets.delete(PAT_SECRET_KEY);
  }
}
