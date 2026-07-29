/**
 * US-23.17 AC2: shared infra for the `test/host/*.test.ts` track — not itself a
 * test file (leading underscore, excluded from `esbuild.js`'s host-test entry
 * points, same convention as `test/webview/_harness.ts`).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SidecarWriteGuard } from '../../src/comments/sidecar-store';

/** Every host test allows any write target — none of these tests exercise the outside-allowed-roots refusal, already covered by `test/unit.ts`'s `modelRefusalFor`. */
export const allowAllGuard: SidecarWriteGuard = async () => true;

export const noopLog = (_message: string, _err?: unknown): void => {};

/**
 * The one workspace folder VS Code was launched on, provided by `runTest.ts` via
 * `extensionTestsEnv`. Read at call time rather than module scope so a missing value
 * names the fix instead of producing a confusing `undefined` path.
 */
function hostTestWorkspaceRoot(): string {
  const dir = process.env.ORCA_HOST_TEST_WORKSPACE;
  if (dir === undefined || dir === '') {
    throw new Error(
      'ORCA_HOST_TEST_WORKSPACE is not set — runTest.ts must create the workspace folder, pass it as ' +
        'the last launch arg, and forward it through extensionTestsEnv'
    );
  }
  return dir;
}

/**
 * AC2: a fresh directory outside the repo tree for the duration of `fn`, deleted
 * unconditionally afterwards — pass, fail, or throw.
 *
 * It is a **subdirectory of the single workspace folder VS Code was launched on**,
 * and deliberately does not call `updateWorkspaceFolders`. The earlier version added
 * each temp directory as its own workspace folder, which does not work here and
 * failed silently: `updateWorkspaceFolders` will not add the first folder to an empty
 * workspace (it returns false, which was not checked), and the bounded wait for the
 * change event then timed out and returned as though it had. A 2026-07-28 diagnostic
 * probe printed `vscode.workspace.workspaceFolders` as EMPTY inside this function —
 * so every case on this track had been running against a workspace containing none
 * of its own files. Most did not notice, but `sidecar-reload`'s AC1/AC2 case did: a
 * plain string glob given to `createFileSystemWatcher` matches only inside a
 * workspace folder, so its sidecar's create event never arrived. Nesting inside the
 * launched folder fixes that, and because the folder list now never changes there is
 * also nothing left to trigger the Extension Host restart the old version fought.
 *
 * `settings` overrides go to the workspace root's own `.vscode/settings.json` — the
 * only place a folder-scoped settings file now takes effect — merged over the base
 * `runTest.ts` seeded and restored afterwards. The per-directory copy the old version
 * wrote never applied at all, because those directories were never workspace folder
 * roots. One case relies on this (`comment-undo-routes.test.ts`'s AC9 save-participant
 * control, which needs `files.trimTrailingWhitespace`), so it is restored rather than
 * dropped; cases run sequentially, so mutating the shared file around one is safe.
 */
export async function withTempWorkspace<T>(
  fn: (root: vscode.Uri) => Promise<T>,
  settings: Record<string, unknown> = {}
): Promise<T> {
  const workspaceRoot = hostTestWorkspaceRoot();
  const dir = fs.mkdtempSync(path.join(workspaceRoot, 'case-'));
  const settingsPath = path.join(workspaceRoot, '.vscode', 'settings.json');
  const baseSettings = fs.readFileSync(settingsPath, 'utf8');
  const overriding = Object.keys(settings).length > 0;
  if (overriding) {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ ...(JSON.parse(baseSettings) as Record<string, unknown>), ...settings }, null, 2),
      'utf8'
    );
    // VS Code picks the change up asynchronously; without this the case can read the
    // configuration before the override has landed.
    await new Promise<void>((r) => setTimeout(r, 300));
  }
  try {
    return await fn(vscode.Uri.file(dir));
  } finally {
    // Each cleanup step gets its own try/catch so neither can mask whatever `fn`
    // itself threw, nor stop the other from running.
    if (overriding) {
      try {
        fs.writeFileSync(settingsPath, baseSettings, 'utf8');
      } catch (err) {
        console.error(`[test:host] failed to restore ${settingsPath}`, err);
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[test:host] failed to remove temp workspace ${dir}`, err);
    }
  }
}

/** Writes `content` to `root/relativeName` and opens it as a real `vscode.TextDocument`. */
export async function openTempMdFile(
  root: vscode.Uri,
  relativeName: string,
  content = '# doc\n'
): Promise<vscode.TextDocument> {
  const uri = vscode.Uri.joinPath(root, relativeName);
  fs.writeFileSync(uri.fsPath, content, 'utf8');
  return vscode.workspace.openTextDocument(uri);
}

const CASE_TIMEOUT_MS = 30_000;

function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms — a hung await (e.g. an unanswered showInputBox) never releases without this bound`));
    }, timeoutMs);
    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Collects named async cases, isolating one failure from the rest, and throws
 * one aggregate error at the end — the async analogue of `test/roundtrip/_lib.ts`'s
 * `Runner`, sized for this track (no diffing, no golden files).
 *
 * `skip` is a distinct outcome from `case` (a platform genuinely can't construct
 * the scenario — see `sidecar-adopt.test.ts`), reported separately in `finish()`'s
 * summary so a skipped regression test can never blend into the pass count and
 * read as "ran and passed" when it never ran at all.
 */
export class HostTestRunner {
  private readonly failures: string[] = [];
  private readonly skipped: string[] = [];
  private ran = 0;

  async case(name: string, fn: () => Promise<void>): Promise<void> {
    this.ran++;
    try {
      await withTimeout(fn, CASE_TIMEOUT_MS);
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      this.failures.push(`${name}:\n${detail}`);
    }
  }

  /** Records a case that could not run on this platform/filesystem — logged and counted, never silently indistinguishable from a pass. */
  skip(name: string, reason: string): void {
    this.skipped.push(name);
    console.log(`[test:host] SKIPPED ${name} — ${reason}`);
  }

  finish(): void {
    if (this.skipped.length > 0) {
      console.log(`[test:host] ${this.skipped.length} case(s) skipped: ${this.skipped.join('; ')}`);
    }
    if (this.failures.length > 0) {
      throw new Error(`${this.failures.length}/${this.ran} case(s) failed:\n\n${this.failures.join('\n\n')}`);
    }
  }
}
