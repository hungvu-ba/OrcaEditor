/**
 * US-23.17 AC1: launches a real VS Code Extension Host via `@vscode/test-electron`
 * and points it at `dist/test/host/index.js`. Runs outside the Extension Host
 * (plain Node), so it never imports `vscode` itself. Local pre-merge gate only —
 * this repo has no CI (`.github/` has no `workflows/`).
 */
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    // dist/test/host/runTest.js -> repo root is three levels up.
    const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
    const extensionTestsPath = path.resolve(__dirname, './index');
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-extensions'],
    });
  } catch (err) {
    console.error('[test:host] failed to run host tests', err);
    process.exit(1);
  }
}

void main();
