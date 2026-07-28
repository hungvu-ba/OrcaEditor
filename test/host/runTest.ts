/**
 * US-23.17 AC1: launches a real VS Code Extension Host via `@vscode/test-electron`
 * and points it at `dist/test/host/index.js`. Runs outside the Extension Host
 * (plain Node), so it never imports `vscode` itself. Local pre-merge gate only —
 * this repo has no CI (`.github/` has no `workflows/`).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Launch VS Code with a throwaway `--user-data-dir`.
 *
 * It exists for one reason: without it this track's pass/fail is a coin flip. VS
 * Code restores the windows a previous launch left open, and every temp workspace
 * `withTempWorkspace` adds becomes such a window in the shared
 * `.vscode-test/user-data` profile. On the next launch each one is restored as its
 * own window, each window gets its own Extension Host, and **each Extension Host
 * runs `extensionTestsPath` — the whole suite — concurrently.**
 *
 * Measured on 2026-07-28: 10 Extension Hosts alive at once (all exiting inside the
 * same 6 s at shutdown, so genuinely concurrent, not sequential restarts), the
 * suite's first files reporting PASS 9-10 times each, and 2217 log lines of
 * `Ignoring the error while validating workspace folder … ENOENT` for temp
 * directories deleted runs ago. The consequences were worse than the noise: the
 * hosts fought over the active editor, which is why `comment-undo-routes`'s `undo`
 * capability probe came back true in only 1 of 9 tries and skipped its real
 * assertions the other 8; `sidecar-reload`'s `FileSystemWatcher` case was starved
 * past its 10 s bound and flaked; and because only the last host to report sets the
 * exit code, the same tree with the same genuinely failing case exited 1 on one
 * invocation and 0 on the next — a red case swallowed silently.
 *
 * A fresh profile has nothing to restore, so exactly one window and one Extension
 * Host run the suite exactly once. Measured after this change: 1 Extension Host, one
 * PASS/FAIL line per file, 0 ENOENT lines, the log down from 3211 lines to ~90, the
 * undo capability true (so those cases now run for real rather than skipping), and
 * two consecutive invocations reporting an identical verdict.
 *
 * The folder passed as the last launch arg is separately load-bearing, and it is why
 * `withTempWorkspace` no longer touches `updateWorkspaceFolders` at all.
 * `updateWorkspaceFolders` cannot add the FIRST folder to an EMPTY workspace: it
 * returns false, and the harness's bounded wait for the change event then timed out
 * and carried on as if it had worked. A diagnostic probe run on 2026-07-28 printed
 * `vscode.workspace.workspaceFolders` as **empty inside `withTempWorkspace`**, so the
 * whole track had been running with no workspace folder — and a
 * `createFileSystemWatcher` given a plain string glob only ever matches inside a
 * workspace folder, which is why `sidecar-reload`'s AC1/AC2 case could never see its
 * sidecar (an explicit `RelativePattern(root, …)` saw the same writes fine, which is
 * what isolated the cause). Opening the folder here, once, and giving each test a
 * subdirectory of it means the folder list never changes: nothing to refuse, no
 * restart to attempt, and every test file lives inside the workspace.
 *
 * `.vscode/settings.json` is seeded here rather than per test, because a
 * folder-scoped settings file only takes effect at a workspace folder root — and this
 * is now the only one. 22 of the 23 call sites want exactly this base; the one that
 * needs an override (`comment-undo-routes.test.ts`'s AC9 save-participant control)
 * gets it by `withTempWorkspace` merging into this file and restoring it afterwards.
 */
async function main(): Promise<void> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-host-profile-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-host-workspace-'));
  fs.mkdirSync(path.join(workspaceDir, '.vscode'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, '.vscode', 'settings.json'),
    JSON.stringify({ 'orcaEditor.comments.authorName': 'Host Test Author' }, null, 2),
    'utf8'
  );
  try {
    // dist/test/host/runTest.js -> repo root is three levels up.
    const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
    const extensionTestsPath = path.resolve(__dirname, './index');
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-extensions', '--user-data-dir', userDataDir, workspaceDir],
      // How `_harness.ts` finds the one open workspace folder to nest inside.
      extensionTestsEnv: { ORCA_HOST_TEST_WORKSPACE: workspaceDir },
    });
  } catch (err) {
    console.error('[test:host] failed to run host tests', err);
    process.exitCode = 1;
  } finally {
    for (const dir of [workspaceDir, userDataDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.error(`[test:host] failed to remove ${dir}`, err);
      }
    }
  }
}

void main();
