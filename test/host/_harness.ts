/**
 * US-23.17 AC2: shared infra for the `test/host/*.test.ts` track — not itself a
 * test file (leading underscore, excluded from `esbuild.js`'s host-test entry
 * points, same convention as `test/webview/_harness.ts`).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SidecarWriteGuard } from '../../src/comments/sidecar-store';
import { normalizeAssetName } from '../../src/text-utils';

/** Every host test allows any write target — none of these tests exercise the outside-allowed-roots refusal, already covered by `test/unit.ts`'s `modelRefusalFor`. */
export const allowAllGuard: SidecarWriteGuard = async () => true;

export const noopLog = (_message: string, _err?: unknown): void => {};

const WORKSPACE_FOLDER_CHANGE_TIMEOUT_MS = 5000;

/**
 * Resolves once `vscode.workspace.onDidChangeWorkspaceFolders` fires, or after
 * `timeoutMs` — the API's own doc comment forbids a second `updateWorkspaceFolders`
 * call before the previous one's change event has fired, so a blind `setTimeout(0)`
 * (the pre-review version of this harness) races that contract instead of
 * honouring it. Bounded rather than awaited forever: a lost event must surface as
 * a slow/failed test, never a silently hung one.
 */
function waitForWorkspaceFoldersChange(timeoutMs = WORKSPACE_FOLDER_CHANGE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve();
    }, timeoutMs);
    const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearTimeout(timer);
      sub.dispose();
      resolve();
    });
  });
}

/**
 * AC2: a fresh temp workspace directory outside the repo tree, added as a real
 * VS Code workspace folder for the duration of `fn`, with `orcaEditor.*`
 * settings seeded up front (never the developer's own `settings.json`), and
 * removed + deleted unconditionally afterwards — pass, fail, or throw.
 */
export async function withTempWorkspace<T>(
  fn: (root: vscode.Uri) => Promise<T>,
  settings: Record<string, unknown> = {}
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-host-test-'));
  fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.vscode', 'settings.json'),
    JSON.stringify({ 'orcaEditor.comments.authorName': 'Host Test Author', ...settings }, null, 2),
    'utf8'
  );
  const root = vscode.Uri.file(dir);
  const insertAt = vscode.workspace.workspaceFolders?.length ?? 0;
  const changed = waitForWorkspaceFoldersChange();
  vscode.workspace.updateWorkspaceFolders(insertAt, 0, { uri: root });
  await changed;
  try {
    return await fn(root);
  } finally {
    // Neither cleanup step may replace/mask whatever `fn` itself threw — each
    // gets its own try/catch so a workspace-folder-index mismatch (e.g. a
    // still-running case from an earlier timeout mutating the folder list
    // concurrently) can't stop the other step or override the real failure.
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const index = folders.findIndex(
        (f) => normalizeAssetName(f.uri.fsPath, true) === normalizeAssetName(root.fsPath, true)
      );
      if (index !== -1) {
        const removed = waitForWorkspaceFoldersChange();
        vscode.workspace.updateWorkspaceFolders(index, 1);
        await removed;
      }
    } catch (err) {
      console.error(`[test:host] failed to remove workspace folder for ${dir}`, err);
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
