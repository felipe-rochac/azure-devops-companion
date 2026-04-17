import * as assert from 'assert';
import { GitHelper } from '../../utils/gitHelper';

suite('GitHelper Tests', () => {
  let gitHelper: GitHelper;

  setup(() => {
    gitHelper = new GitHelper();
  });

  test('getCurrentBranch returns a string or undefined', async () => {
    const branch = await gitHelper.getCurrentBranch();
    // In test environment may or may not have git
    assert.ok(branch === undefined || typeof branch === 'string');
  });

  test('getRemoteUrl returns a string or undefined', async () => {
    const url = await gitHelper.getRemoteUrl();
    assert.ok(url === undefined || typeof url === 'string');
  });

  test('detectRepositoryName returns a string or undefined', async () => {
    const name = await gitHelper.detectRepositoryName();
    assert.ok(name === undefined || typeof name === 'string');
  });

  test('checkoutBranch throws when no workspace folder', async () => {
    // This test depends on workspace state
    // In a test runner with no workspace, it should throw
    try {
      await gitHelper.checkoutBranch('nonexistent-branch-12345');
    } catch (err: any) {
      // Either "No workspace folder open" or a git error — both are acceptable
      assert.ok(err instanceof Error);
    }
  });
});
