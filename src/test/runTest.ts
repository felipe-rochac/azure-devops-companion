import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { runTests } from '@vscode/test-electron';

/**
 * On Windows, convert a path to its 8.3 short form to avoid issues
 * with spaces in paths (e.g. "OneDrive - Microsoft") that break
 * the VS Code extension host's module resolution.
 */
function getShortPath(p: string): string {
  if (process.platform !== 'win32') {
    return p;
  }
  try {
    // cmd /c for %I in ("long path") do @echo %~sI
    const result = execSync(`cmd /c for %I in ("${p}") do @echo %~sI`, { encoding: 'utf8' });
    return result.trim() || p;
  } catch {
    return p;
  }
}

async function main() {
  try {
    const extensionDevelopmentPath = getShortPath(path.resolve(__dirname, '../../'));
    const extensionTestsPath = getShortPath(path.resolve(__dirname, './suite/index'));

    // Use temp dirs without spaces to avoid path-splitting issues.
    const tmpDir = path.join(os.tmpdir(), 'azdevops-pr-test');
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        '--user-data-dir', path.join(tmpDir, 'user-data'),
        '--extensions-dir', path.join(tmpDir, 'extensions'),
        '--disable-other-extensions',
      ],
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();
