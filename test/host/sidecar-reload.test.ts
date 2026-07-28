/**
 * Req 24 US-23.15 on the US-23.17 host track: the sidecar changing UNDERNEATH an
 * open document. Every case here needs a real filesystem plus a real
 * `vscode.comments` controller — `test/unit.ts` cannot reach `commentController.ts`
 * at all (it imports `vscode`), which is exactly why AC1/AC2's removal and refresh
 * rules could not be tested before this track existed.
 *
 * Scope boundary, stated precisely (the first version of this header understated
 * it — review finding): `register()` runs at activation, so a host test cannot
 * re-register the provider's own watcher or reach its private
 * `documentForSidecar`. Covered here instead: the two halves that carry the real
 * risk — that the production GLOB actually matches a sidecar's change and delete
 * events, and that `mdNameForSidecar` maps such an event back to its `.md` — plus
 * everything the wiring invokes (`reloadThreads`, `forgetDocument`,
 * `sidecarPathFor`). Still uncovered: the 300 ms debounce coalescing, the
 * `panels.size > 0` live-panel gate, and the `documentStateKey` fold over
 * `panelsByUri`. Recorded in `deferred-work.md` rather than implied to be tested.
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { createSidecarStore } from '../../src/comments/sidecar-store';
import { createCommentSupport, type CommentSupport } from '../../src/comments/commentController';
import { sidecarShareState, type GitRunner } from '../../src/comments/sidecar-git';
import {
  buildCommentLine,
  buildReplyLine,
  mdNameForSidecar,
  serializeSidecarLine,
  SIDECAR_WATCH_GLOB,
  type SidecarLine,
} from '../../src/comments/sidecar-format';
import { allowAllGuard, noopLog, openTempMdFile, withTempWorkspace, HostTestRunner } from './_harness';

const DOC_TEXT = '# doc\n\nfirst paragraph\n\nsecond paragraph\n';

/** A `comment` line with a deliberately SHORT recorded text, so `sidecarBelongsToDocument` returns `unknown` and no belonging banner/notification fires during a case counting notifications. */
function commentLine(id: string, body: string): SidecarLine {
  return buildCommentLine({
    id,
    author: 'Host Test Author',
    timestamp: `2026-01-0${id.length}T00:00:00.000Z`,
    body,
    anchor: { offset_start: 0, offset_end: 5, recorded_text: 'first', last_known_line: 3, nearest_heading: 'doc' },
  });
}

/** Writes the sidecar's WHOLE content — how a `git pull`, a branch switch or a hand edit replaces it, unlike the append-only path the editor itself uses. */
function writeSidecar(path: string, lines: string[]): void {
  fs.writeFileSync(path, lines.join(''), 'utf8');
}

interface Fixture {
  document: vscode.TextDocument;
  support: CommentSupport;
  sidecarPath: string;
}

async function withFixture(root: vscode.Uri, name: string, fn: (f: Fixture) => Promise<void>): Promise<void> {
  const document = await openTempMdFile(root, name, DOC_TEXT);
  const store = createSidecarStore(allowAllGuard, noopLog, false);
  const support = createCommentSupport(store, noopLog, false);
  try {
    await fn({ document, support, sidecarPath: store.uriFor(document).fsPath });
  } finally {
    // Disposing the support disposes every native thread it created, so one
    // case's threads can never be visible to the next.
    support.dispose();
  }
}

export async function run(): Promise<void> {
  const runner = new HostTestRunner();

  await runner.case("AC1: a teammate's reply written by another window appears on reload", async () => {
    await withTempWorkspace(async (root) => {
      await withFixture(root, 'reload-reply.md', async ({ document, support, sidecarPath }) => {
        writeSidecar(sidecarPath, [serializeSidecarLine(commentLine('c1', 'the original comment'))]);
        await support.loadThreads(document);
        assert.strictEqual(support.listThreads(document).length, 1);
        assert.strictEqual(support.listThreads(document)[0].replies.length, 0);

        // The second window's append — same file, a line this session never wrote.
        fs.appendFileSync(
          sidecarPath,
          serializeSidecarLine(
            buildReplyLine({
              id: 'r1',
              parentCommentId: 'c1',
              author: 'Teammate',
              timestamp: '2026-01-02T00:00:00.000Z',
              body: 'a reply from the other window',
            })
          ),
          'utf8'
        );

        await support.reloadThreads(document);
        const threads = support.listThreads(document);
        assert.strictEqual(threads.length, 1, 'the reload must not duplicate the thread');
        assert.strictEqual(threads[0].replies.length, 1, "a known thread must pick up a teammate's reply");
        assert.strictEqual(threads[0].replies[0].body, 'a reply from the other window');
      });
    });
  });

  await runner.case('AC1: a thread whose line is no longer on disk is removed from every surface', async () => {
    await withTempWorkspace(async (root) => {
      await withFixture(root, 'reload-removal.md', async ({ document, support, sidecarPath }) => {
        writeSidecar(sidecarPath, [
          serializeSidecarLine(commentLine('c1', 'kept')),
          serializeSidecarLine(commentLine('c22', 'dropped by the pull')),
        ]);
        await support.loadThreads(document);
        assert.strictEqual(support.listThreads(document).length, 2);

        // A `git pull` landing a branch where the second comment was never made.
        writeSidecar(sidecarPath, [serializeSidecarLine(commentLine('c1', 'kept'))]);
        await support.reloadThreads(document);

        const threads = support.listThreads(document);
        assert.strictEqual(threads.length, 1, 'the vanished thread must be removed, not left stale');
        assert.strictEqual(threads[0].body, 'kept');
      });
    });
  });

  await runner.case('AC1: reloading an unchanged sidecar twice changes nothing', async () => {
    await withTempWorkspace(async (root) => {
      await withFixture(root, 'reload-idempotent.md', async ({ document, support, sidecarPath }) => {
        writeSidecar(sidecarPath, [serializeSidecarLine(commentLine('c1', 'stable'))]);
        await support.loadThreads(document);
        await support.reloadThreads(document);
        await support.reloadThreads(document);
        assert.strictEqual(support.listThreads(document).length, 1, 'a reload burst must not multiply threads');
      });
    });
  });

  await runner.case('AC2: the sidecar being deleted drops its threads, and a restored one comes back', async () => {
    await withTempWorkspace(async (root) => {
      await withFixture(root, 'reload-delete.md', async ({ document, support, sidecarPath }) => {
        const seeded = [serializeSidecarLine(commentLine('c1', 'on the branch'))];
        writeSidecar(sidecarPath, seeded);
        await support.loadThreads(document);
        assert.strictEqual(support.listThreads(document).length, 1);

        // What a branch switch (or `git rm`) does. The delete event's handler in
        // `provider.ts` calls exactly this.
        fs.rmSync(sidecarPath);
        support.forgetDocument(document.uri);
        assert.strictEqual(support.listThreads(document).length, 0, 'a deleted sidecar must not leave stale threads');

        // Switching back: the create event reloads from disk.
        writeSidecar(sidecarPath, seeded);
        await support.loadThreads(document);
        assert.strictEqual(support.listThreads(document).length, 1, 'a restored sidecar must rebuild its threads');
      });
    });
  });

  await runner.case('AC3/AC4: load losses are surfaced once per newly-discovered problem', async () => {
    await withTempWorkspace(async (root) => {
      await withFixture(root, 'reload-losses.md', async ({ document, support, sidecarPath }) => {
        writeSidecar(sidecarPath, [
          serializeSidecarLine(commentLine('c1', 'good')),
          '<<<<<<< HEAD\n',
          '{"schema_version":1,"type":"comm\n',
          serializeSidecarLine(
            buildReplyLine({
              id: 'r-orphan',
              parentCommentId: 'no-such-comment',
              author: 'Teammate',
              timestamp: '2026-01-02T00:00:00.000Z',
              body: 'orphaned by a merge',
            })
          ),
        ]);

        // The only way to assert "told the user, and told them ONCE" — there is no
        // public API that reports what notifications were shown.
        const seen: string[] = [];
        const windowRef = vscode.window as unknown as { showWarningMessage: unknown };
        const original = windowRef.showWarningMessage;
        windowRef.showWarningMessage = (message: string): Thenable<undefined> => {
          seen.push(message);
          return Promise.resolve(undefined);
        };
        try {
          await support.loadThreads(document);
          const state = support.sidecarStateFor(document);
          assert.strictEqual(state?.conflicted, true, 'a conflict marker must mark the sidecar conflicted (AC4)');
          // ONE loss, not two: the truncated line is lost data, the conflict
          // marker is not (it carries no record), and `conflicted` reports that
          // half on its own — counting it would claim data loss that never
          // happened (review finding, 2026-07-28).
          assert.strictEqual(state?.skipped, 1, 'only the truncated line is a lost record (AC3)');
          assert.strictEqual(state?.orphans?.length, 1, 'the parentless reply is reported as an orphan');
          assert.strictEqual(seen.length, 1, 'the user is told, not only the log');
          assert.ok(seen[0].includes('reload-losses.md.orca-comments.jsonl'), 'the notification names the file');
          assert.ok(seen[0].includes('conflicted'), 'a conflicted merge is named as one');

          // Same damage, second look: nothing new to report.
          await support.reloadThreads(document);
          assert.strictEqual(seen.length, 1, 'an unchanged reload must not repeat the notification');

          // New damage: reported again.
          fs.appendFileSync(sidecarPath, '{"schema_version":1,"type":"trunc\n', 'utf8');
          await support.reloadThreads(document);
          assert.strictEqual(seen.length, 2, 'a newly-discovered loss must be reported');
        } finally {
          windowRef.showWarningMessage = original;
        }
      });
    });
  });

  await runner.case('AC5: git decides whether a sidecar can reach the team', async () => {
    await withTempWorkspace(async (root) => {
      const document = await openTempMdFile(root, 'share.md', DOC_TEXT);
      const store = createSidecarStore(allowAllGuard, noopLog, false);
      const sidecarPath = store.uriFor(document).fsPath;
      writeSidecar(sidecarPath, [serializeSidecarLine(commentLine('c1', 'shared?'))]);

      // Outside a repository first — AC5 is explicitly a no-op there, and the temp
      // workspace is not inside one until `git init` runs below.
      assert.strictEqual(await sidecarShareState(sidecarPath), 'no-repo');

      try {
        execFileSync('git', ['init', '-q'], { cwd: root.fsPath });
      } catch {
        runner.skip('AC5: git decides whether a sidecar can reach the team', 'git is not available on PATH');
        return;
      }
      assert.strictEqual(await sidecarShareState(sidecarPath), 'untracked', 'a never-added sidecar cannot be shared');

      fs.writeFileSync(vscode.Uri.joinPath(root, '.gitignore').fsPath, '*.orca-comments.jsonl\n', 'utf8');
      assert.strictEqual(
        await sidecarShareState(sidecarPath),
        'ignored',
        'an ignore rule must win over "not added yet" — it is the reason git add would fail'
      );

      fs.rmSync(vscode.Uri.joinPath(root, '.gitignore').fsPath);
      execFileSync('git', ['add', '--', sidecarPath], { cwd: root.fsPath });
      assert.strictEqual(await sidecarShareState(sidecarPath), 'shared', 'a tracked sidecar reaches the team');
    });
  });

  await runner.case('AC1/AC2: the production glob sees a sidecar change and delete, and maps back to its .md', async () => {
    await withTempWorkspace(async (root) => {
      const document = await openTempMdFile(root, 'watched.md', DOC_TEXT);
      const store = createSidecarStore(allowAllGuard, noopLog, false);
      const sidecarPath = store.uriFor(document).fsPath;
      // The SAME glob constant `provider.ts` registers — a typo there would make
      // AC1/AC2 silently inoperative with every other case still green.
      const watcher = vscode.workspace.createFileSystemWatcher(SIDECAR_WATCH_GLOB);
      const seen: Array<{ kind: 'change' | 'create' | 'delete'; uri: vscode.Uri }> = [];
      const subs = [
        watcher.onDidChange((uri) => seen.push({ kind: 'change', uri })),
        watcher.onDidCreate((uri) => seen.push({ kind: 'create', uri })),
        watcher.onDidDelete((uri) => seen.push({ kind: 'delete', uri })),
      ];
      const waitFor = async (kind: 'change' | 'create' | 'delete'): Promise<vscode.Uri> => {
        for (let i = 0; i < 100; i++) {
          const hit = seen.find((e) => e.kind === kind);
          if (hit !== undefined) {
            return hit.uri;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`no ${kind} event for the sidecar within 10s — the glob does not match it`);
      };
      try {
        writeSidecar(sidecarPath, [serializeSidecarLine(commentLine('c1', 'watch me'))]);
        const created = await waitFor('create');
        // The provider's sidecar→`.md` hop, on a real event uri.
        const mdName = mdNameForSidecar(created.path.split('/').pop() ?? '');
        assert.strictEqual(mdName, 'watched.md', 'a real event uri must map back to its own .md');
        assert.strictEqual(
          vscode.Uri.joinPath(created, '..', mdName ?? '').fsPath,
          document.uri.fsPath,
          'the derived .md uri must be the open document'
        );

        fs.rmSync(sidecarPath);
        await waitFor('delete');
      } finally {
        for (const sub of subs) {
          sub.dispose();
        }
        watcher.dispose();
      }
    });
  });

  await runner.case('AC1: a native field left open survives a reload instead of losing its text', async () => {
    await withTempWorkspace(async (root) => {
      await withFixture(root, 'reload-editing.md', async ({ document, support, sidecarPath }) => {
        writeSidecar(sidecarPath, [serializeSidecarLine(commentLine('c1', 'before'))]);
        await support.loadThreads(document);
        // Open the native edit field on the thread's own comment, exactly as the
        // `orcaEditor.editComment` command does (US-23.14 AC1).
        assert.strictEqual(support.setEditingMode('c1', undefined, true), true);

        // A teammate's edit lands while the field is open.
        fs.appendFileSync(
          sidecarPath,
          serializeSidecarLine(
            buildReplyLine({
              id: 'r1',
              parentCommentId: 'c1',
              author: 'Teammate',
              timestamp: '2026-01-02T00:00:00.000Z',
              body: 'landed mid-edit',
            })
          ),
          'utf8'
        );
        await support.reloadThreads(document);

        // The reply is folded into the registry (the Comment tab and the webview
        // see it), but the open field is untouched — VS Code holds the user's
        // in-progress text in that very Comment object.
        assert.strictEqual(support.listThreads(document)[0].replies.length, 1);
        assert.strictEqual(support.listThreads(document).length, 1, 'the thread must not be dropped mid-edit');
      });
    });
  });

  await runner.case('AC1: a damaged sidecar never removes a live thread', async () => {
    await withTempWorkspace(async (root) => {
      await withFixture(root, 'reload-damaged.md', async ({ document, support, sidecarPath }) => {
        writeSidecar(sidecarPath, [
          serializeSidecarLine(commentLine('c1', 'first')),
          serializeSidecarLine(commentLine('c22', 'second')),
        ]);
        await support.loadThreads(document);
        assert.strictEqual(support.listThreads(document).length, 2);

        // A crashed append / half-written pull leaves c22's line truncated. Its
        // data is still on disk, just unreadable this pass — removing the thread
        // would present a recoverable state as a deletion.
        writeSidecar(sidecarPath, [
          serializeSidecarLine(commentLine('c1', 'first')),
          '{"schema_version":1,"type":"comm\n',
        ]);
        await support.reloadThreads(document);
        assert.strictEqual(
          support.listThreads(document).length,
          2,
          'a fold with unreadable lines is not authoritative about what is gone'
        );

        // Once the file parses cleanly again, the removal does happen.
        writeSidecar(sidecarPath, [serializeSidecarLine(commentLine('c1', 'first'))]);
        await support.reloadThreads(document);
        assert.strictEqual(support.listThreads(document).length, 1, 'a clean fold prunes as AC1 requires');
      });
    });
  });

  await runner.case('AC5: a document with no sidecar is never told to run git add', async () => {
    await withTempWorkspace(async (root) => {
      const document = await openTempMdFile(root, 'no-comments.md', DOC_TEXT);
      const store = createSidecarStore(allowAllGuard, noopLog, false);
      const sidecarPath = store.uriFor(document).fsPath;
      assert.ok(!fs.existsSync(sidecarPath), 'the fixture must have no sidecar');
      try {
        execFileSync('git', ['init', '-q'], { cwd: root.fsPath });
      } catch {
        runner.skip('AC5: a document with no sidecar is never told to run git add', 'git is not available on PATH');
        return;
      }
      // Without the `no-sidecar` state this returns 'untracked' — a "run git add"
      // warning on every never-commented file the user opens in a repo.
      assert.strictEqual(await sidecarShareState(sidecarPath), 'no-sidecar');
    });
  });

  await runner.case('AC5: a git that cannot answer is never turned into a warning', async () => {
    // The two failure modes that must NOT read as "your comments are stranded":
    // no `git` binary at all, and a directory that is not a repository.
    const stub = (answers: Record<string, { code: number; stdout: string }>): GitRunner =>
      async (args) => answers[args[0]] ?? { code: 1, stdout: '' };
    // The path is never touched, so its existence is stubbed too — these cases are
    // about git's answers, not about the file.
    const present = async (): Promise<boolean> => true;
    const PATH = '/tmp/x.md.orca-comments.jsonl';
    assert.strictEqual(
      await sidecarShareState(PATH, stub({ 'rev-parse': { code: -1, stdout: '' } }), present),
      'unknown'
    );
    assert.strictEqual(
      await sidecarShareState(PATH, stub({ 'rev-parse': { code: 128, stdout: '' } }), present),
      'no-repo'
    );
    // A bare repository has no worktree, so nothing there can be tracked.
    assert.strictEqual(
      await sidecarShareState(PATH, stub({ 'rev-parse': { code: 0, stdout: 'false\n' } }), present),
      'no-repo'
    );
    // And the guard itself: a missing sidecar short-circuits before git is asked.
    let asked = false;
    assert.strictEqual(
      await sidecarShareState(
        PATH,
        async () => {
          asked = true;
          return { code: 0, stdout: 'true\n' };
        },
        async () => false
      ),
      'no-sidecar'
    );
    assert.strictEqual(asked, false, 'git must not be spawned for a sidecar that does not exist');
  });

  runner.finish();
}
