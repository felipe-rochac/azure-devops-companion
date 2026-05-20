import * as vscode from 'vscode';

const AUTH_DISABLED_KEY = 'azureDevOpsPR.oauth.disabled';
const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';
const MICROSOFT_PROVIDER_ID = 'microsoft';

/**
 * AuthManager handles Microsoft Entra authentication via VS Code's
 * built-in Microsoft auth provider.
 *
 * Access tokens are managed by the VS Code auth provider. This class stores
 * only an extension-level disconnect flag in SecretStorage.
 */
export class AuthManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * Start interactive sign-in to acquire an Azure DevOps access token.
   */
  async signInInteractive(): Promise<void> {
    await this.setDisconnected(false);
    const session = await this.getSession(true);
    if (!session?.accessToken) {
      throw new Error('Sign in failed. Could not acquire an Azure DevOps access token.');
    }
  }

  /**
   * Retrieve the current Azure DevOps access token from VS Code auth session.
   */
  async getAccessToken(): Promise<string | undefined> {
    if (await this.isDisconnected()) {
      return undefined;
    }

    const session = await this.getSession(false);
    return session?.accessToken;
  }

  /**
   * Try to refresh the access token without forcing sign-in UI.
   */
  async refreshAccessTokenSilently(): Promise<string | undefined> {
    if (await this.isDisconnected()) {
      return undefined;
    }
    const session = await this.getSession(false);
    return session?.accessToken;
  }

  /**
   * Force re-authentication when the current session can no longer be refreshed.
   */
  async refreshAccessTokenInteractive(): Promise<string | undefined> {
    if (await this.isDisconnected()) {
      return undefined;
    }
    const session = await this.getSession(true);
    return session?.accessToken;
  }

  /**
   * Check if user is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    const token = await this.getAccessToken();
    return !!token;
  }

  /**
   * Disconnect the extension from Azure DevOps.
   */
  async clearCredentials(): Promise<void> {
    await this.setDisconnected(true);
  }

  private async getSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
    return vscode.authentication.getSession(
      MICROSOFT_PROVIDER_ID,
      [ADO_SCOPE],
      { createIfNone }
    );
  }

  private async isDisconnected(): Promise<boolean> {
    return (await this.secrets.get(AUTH_DISABLED_KEY)) === 'true';
  }

  private async setDisconnected(disconnected: boolean): Promise<void> {
    if (disconnected) {
      await this.secrets.store(AUTH_DISABLED_KEY, 'true');
      return;
    }
    await this.secrets.delete(AUTH_DISABLED_KEY);
  }
}
