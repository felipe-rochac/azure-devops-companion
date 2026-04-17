import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Starting tests...');

  test('Extension should be present', () => {
    assert.ok(vscode.extensions.getExtension('kyrone.azure-devops-pr'));
  });

  test('Commands should be registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    const expectedCommands = [
      'azureDevOpsPR.signIn',
      'azureDevOpsPR.signOut',
      'azureDevOpsPR.refresh',
      'azureDevOpsPR.createPR',
      'azureDevOpsPR.openPR',
      'azureDevOpsPR.checkoutBranch',
      'azureDevOpsPR.approvePR',
      'azureDevOpsPR.configurePAT',
      'azureDevOpsPR.openPipelineDashboard',
      'azureDevOpsPR.openPipelineBuild',
      'azureDevOpsPR.openPipelineBuildInBrowser',
      'azureDevOpsPR.selectPRProject',
      'azureDevOpsPR.selectPipelineProject',
      'azureDevOpsPR.selectPRRepo',
      'azureDevOpsPR.selectPipelineRepo',
    ];
    for (const cmd of expectedCommands) {
      assert.ok(commands.includes(cmd), `Command "${cmd}" should be registered`);
    }
  });

  test('Configuration should have default values', () => {
    const config = vscode.workspace.getConfiguration('azureDevOpsPR');
    assert.strictEqual(config.get('showDrafts'), true);
    assert.strictEqual(config.get('autoRefreshInterval'), 300);
    assert.strictEqual(config.get('organizationUrl'), '');
  });
});
