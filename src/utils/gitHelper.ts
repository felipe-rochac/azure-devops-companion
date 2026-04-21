import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as path from 'path';

/**
 * GitHelper provides git operations using the VS Code Git extension API.
 * Falls back to shell commands if the extension API is unavailable.
 */
export class GitHelper {
  private getWorkspacePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * Get the current git branch name.
   */
  async getCurrentBranch(): Promise<string | undefined> {
    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
      if (gitExtension) {
        const api = gitExtension.getAPI(1);
        const repo = api.repositories[0];
        if (repo) {
          return repo.state.HEAD?.name;
        }
      }
    } catch {
      // Fall through to shell command
    }

    try {
      const cwd = this.getWorkspacePath();
      if (!cwd) { return undefined; }
      const result = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' });
      return result.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Checkout a branch, fetching it from remote if needed.
   */
  async checkoutBranch(branchName: string): Promise<void> {
    const cwd = this.getWorkspacePath();
    if (!cwd) {
      throw new Error('No workspace folder open');
    }

    // First try the VS Code Git extension
    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
      if (gitExtension) {
        const api = gitExtension.getAPI(1);
        const repo = api.repositories[0];
        if (repo) {
          await repo.checkout(branchName);
          vscode.window.showInformationMessage(`✅ Switched to branch "${branchName}"`);
          return;
        }
      }
    } catch {
      // Fall through to terminal
    }

    // Fall back to running git in terminal (visible to user)
    const terminal = vscode.window.createTerminal({
      name: 'Azure DevOps Companion',
      cwd,
    });
    terminal.show();
    terminal.sendText(`git fetch origin ${branchName} && git checkout ${branchName}`);
  }

  /**
   * Get the Azure DevOps remote URL for the current workspace.
   */
  async getRemoteUrl(): Promise<string | undefined> {
    const cwd = this.getWorkspacePath();
    if (!cwd) { return undefined; }

    try {
      const result = execSync('git remote get-url origin', { cwd, encoding: 'utf8' });
      const url = result.trim();
      // Check if it's an Azure DevOps URL
      if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) {
        return url;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Try to detect the repository name from the git remote.
   */
  async detectRepositoryName(): Promise<string | undefined> {
    const context = await this.detectAzureDevOpsContext();
    return context?.repoName;
  }

  /**
   * Detect Azure DevOps project/repository from origin URL.
   */
  async detectAzureDevOpsContext(): Promise<{ projectName?: string; repoName?: string } | undefined> {
    const remoteUrl = await this.getRemoteUrl();
    if (!remoteUrl) { return undefined; }

    // Parse URL formats:
    // https://dev.azure.com/org/project/_git/repo
    // https://org.visualstudio.com/project/_git/repo
    // git@ssh.dev.azure.com:v3/org/project/repo
    let match = remoteUrl.match(/https?:\/\/dev\.azure\.com\/[^/]+\/([^/]+)\/_git\/([^/\s]+)/i);
    if (match) {
      return {
        projectName: decodeURIComponent(match[1]),
        repoName: decodeURIComponent(match[2].replace(/\.git$/i, '')),
      };
    }

    match = remoteUrl.match(/https?:\/\/[^/.]+\.visualstudio\.com\/([^/]+)\/_git\/([^/\s]+)/i);
    if (match) {
      return {
        projectName: decodeURIComponent(match[1]),
        repoName: decodeURIComponent(match[2].replace(/\.git$/i, '')),
      };
    }

    match = remoteUrl.match(/git@ssh\.dev\.azure\.com:v3\/[^/]+\/([^/]+)\/([^/\s]+)/i);
    if (match) {
      return {
        projectName: decodeURIComponent(match[1]),
        repoName: decodeURIComponent(match[2].replace(/\.git$/i, '')),
      };
    }

    return undefined;
  }
}
