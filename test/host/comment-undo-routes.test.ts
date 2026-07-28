/**
 * Req 24 US-23.18 AC4/AC5/AC9/AC10 — undo/redo arriving by a route that is not a
 * webview keystroke.
 *
 * These cases need the extension-host track and cannot be written on the
 * Playwright one: that harness stubs `acquireVsCodeApi`, so it can observe which
 * messages the webview *tried* to post but has no `TextDocument`, no
 * `document.version`, no real command dispatch, and no sidecar on disk. AC1's
 * document-level assertions have the same requirement — US-23.18 names US-23.17
 * (this track) as the dependency for exactly that reason.
 *
 * AC10 asks for one named case per route so that removing the guard for one
 * cannot be masked by another's test. The Command Palette, the Edit menu and a
 * rebound keybinding all converge on `executeCommand('undo')`, which AC10
 * explicitly allows to be covered by a single case at that entry point — that is
 * `undoCommand` below, not three near-copies of it.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { createSidecarStore } from '../../src/comments/sidecar-store';
import { createCommentSupport } from '../../src/comments/commentController';
import type { CreateCommentMessage } from '../../src/comments/comment-utils';
import { allowAllGuard, noopLog, openTempMdFile, withTempWorkspace, HostTestRunner } from './_harness';

const DOC_TEXT = '# doc\n\nAlpha paragraph.\n';

function createMessage(docUri: string, threadId: string): CreateCommentMessage {
  return {
    type: 'createComment',
    requestId: 1,
    docUri,
    threadId,
    anchorId: 'anchor-1',
    offsetStart: 0,
    offsetEnd: 5,
    line: 3,
    body: 'a host-test comment',
    recordedText: 'Alpha paragraph.',
    nearestHeading: 'doc',
  };
}

/**
 * The one host entry point every non-keystroke route lands on. `showTextDocument`
 * first: `undo` is a global command acting on the ACTIVE editor, so without this
 * the case would be asserting against whichever editor an earlier case happened
 * to leave focused — the very confusion AC5 is about.
 */
async function undoCommand(document: vscode.TextDocument, type: 'undo' | 'redo' = 'undo'): Promise<void> {
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand(type);
  // The command can resolve before its edit is applied — same settle the
  // provider's own undo handler performs.
  await new Promise<void>((r) => setTimeout(r, 50));
}

/** Sidecar bytes for `document`, or null when no sidecar exists yet. */
function sidecarBytes(store: ReturnType<typeof createSidecarStore>, document: vscode.TextDocument): string | null {
  const p = store.uriFor(document).fsPath;
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

export async function run(): Promise<void> {
  const runner = new HostTestRunner();

  await runner.case(
    'AC4: undo via executeCommand (Command Palette / Edit menu / rebound key) appends no sidecar line and changes no status',
    async () => {
      await withTempWorkspace(async (root) => {
        const document = await openTempMdFile(root, 'undo-no-write.md', DOC_TEXT);
        const store = createSidecarStore(allowAllGuard, noopLog, false);
        const comments = createCommentSupport(store, noopLog, false);
        try {
          const created = await comments.createThread(createMessage(document.uri.toString(), 'thread-1'), document);
          assert.strictEqual(created.ok, true, 'precondition: the thread must exist before undo runs');
          const sidecarBefore = sidecarBytes(store, document);
          assert.ok(sidecarBefore !== null, 'precondition: a sidecar must exist to prove it is left alone');
          const statusBefore = comments.listThreads(document).map((t) => t.status);

          await undoCommand(document);

          assert.strictEqual(
            sidecarBytes(store, document),
            sidecarBefore,
            'an undo must neither append nor remove a sidecar line'
          );
          assert.deepStrictEqual(
            comments.listThreads(document).map((t) => t.status),
            statusBefore,
            'an undo must not change any thread status'
          );
        } finally {
          comments.dispose();
        }
      });
    }
  );

  await runner.case('AC4: undo reverts the .md text edit itself and nothing else', async () => {
    await withTempWorkspace(async (root) => {
      const document = await openTempMdFile(root, 'undo-text-only.md', DOC_TEXT);
      const store = createSidecarStore(allowAllGuard, noopLog, false);
      const comments = createCommentSupport(store, noopLog, false);
      try {
        assert.strictEqual(
          (await comments.createThread(createMessage(document.uri.toString(), 'thread-1'), document)).ok,
          true
        );
        const sidecarBefore = sidecarBytes(store, document);

        // A real text edit for undo to have something of its own to revert —
        // without one, a passing assertion below would prove only that undo did
        // nothing at all (AC3's positive-control concern, at the host level).
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        await editor.edit((b) => b.insert(new vscode.Position(2, 0), 'INSERTED '));
        assert.ok(document.getText().includes('INSERTED '), 'precondition: the edit must have applied');

        await undoCommand(document);

        assert.ok(!document.getText().includes('INSERTED '), 'undo must revert the document text edit');
        assert.strictEqual(sidecarBytes(store, document), sidecarBefore, 'and must leave the sidecar untouched');
      } finally {
        comments.dispose();
      }
    });
  });

  // Scope boundary, stated rather than implied (same shape as
  // `sidecar-append.test.ts`'s own header): this case exercises the PREMISE
  // `provider.ts`'s `case 'undo':` now relies on — that a global `undo` acting
  // on another editor leaves this document's `version` flat — not the handler
  // itself. Driving that handler needs a real webview posting a message to it,
  // and the public API offers no way to open the custom editor's webview and
  // intercept its `postMessage`. The handler's own logic past this premise is a
  // single `if (document.version === versionBefore) break;`.
  await runner.case('AC5: a global undo acting on another editor leaves this document\'s version flat', async () => {
    await withTempWorkspace(async (root) => {
      const target = await openTempMdFile(root, 'undo-target.md', DOC_TEXT);
      const other = await openTempMdFile(root, 'undo-other.md', DOC_TEXT);

      // Put a real undoable edit on `other` only, then make `other` the active
      // editor. This is AC5's scenario: the webview panel for `target` is what
      // the user pressed undo in, but the global command will act on `other`.
      const otherEditor = await vscode.window.showTextDocument(other, { preview: false });
      await otherEditor.edit((b) => b.insert(new vscode.Position(2, 0), 'OTHER '));
      assert.ok(other.getText().includes('OTHER '), 'precondition: the other document must have an undoable edit');

      const targetVersionBefore = target.version;
      await vscode.commands.executeCommand('undo');
      await new Promise<void>((r) => setTimeout(r, 50));

      // The provider reports success off THIS document's version. `target` was
      // never touched, so that signal must stay flat even though an undo really
      // did happen — in the other editor.
      assert.strictEqual(
        target.version,
        targetVersionBefore,
        "the target document's version must not move when the undo landed elsewhere"
      );
    });
  });

  await runner.case('AC9: a document change inside the write\'s in-flight window refuses the write', async () => {
    await withTempWorkspace(async (root) => {
      const document = await openTempMdFile(root, 'undo-in-flight.md', DOC_TEXT);
      const editor = await vscode.window.showTextDocument(document, { preview: false });

      // Deterministic, not a race. `saveBeforeAppend` awaits `store.refusalFor`,
      // which awaits the write guard — an injected seam that sits INSIDE the
      // in-flight window, after the caller captured `versionAtEntry` and before
      // the version is re-checked. Editing from inside the guard reproduces
      // "an undo landed mid-write" exactly, every run, on any machine. A bare
      // un-awaited `editor.edit()` fired alongside the call would only sometimes
      // interleave, and would pass or fail on timing rather than on behaviour.
      let editedDuringWindow = false;
      const editingGuard = async (): Promise<boolean> => {
        if (!editedDuringWindow) {
          editedDuringWindow = true;
          await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'UNDONE\n'));
        }
        return true;
      };
      const store = createSidecarStore(editingGuard, noopLog, false);
      const comments = createCommentSupport(store, noopLog, false);
      try {
        const outcome = await comments.createThread(createMessage(document.uri.toString(), 'thread-1'), document);

        assert.ok(editedDuringWindow, 'precondition: the injected edit must actually have run');
        assert.strictEqual(outcome.ok, false, 'a write whose document changed mid-flight must be refused, not appended');
        assert.match(
          String((outcome as { error?: string }).error ?? ''),
          /document changed while your comment was being saved/,
          'the refusal must state its reason'
        );
        assert.deepStrictEqual(comments.listThreads(document), [], 'a refused create must register no thread');
        assert.strictEqual(sidecarBytes(store, document), null, 'and must write no sidecar line');
      } finally {
        comments.dispose();
      }
    });
  });

  await runner.case('AC9: a save participant editing during the save does NOT refuse the write', async () => {
    await withTempWorkspace(
      async (root) => {
        const document = await openTempMdFile(root, 'undo-save-participant.md', '# doc\n\nAlpha paragraph.   \n');
        const store = createSidecarStore(allowAllGuard, noopLog, false);
        const comments = createCommentSupport(store, noopLog, false);
        try {
          // Dirty the buffer with trailing whitespace so the configured
          // `files.trimTrailingWhitespace` participant edits during the save and
          // bumps `document.version` legitimately.
          const editor = await vscode.window.showTextDocument(document, { preview: false });
          await editor.edit((b) => b.insert(new vscode.Position(2, 16), '   '));
          assert.ok(document.isDirty, 'precondition: the buffer must be dirty for the save to run');

          const outcome = await comments.createThread(createMessage(document.uri.toString(), 'thread-1'), document);

          // The negative control for the case above. Counting the save's own
          // participant edit as a conflict would refuse the FIRST comment action
          // on any dirty buffer in a workspace configured this way — the common
          // case, not an adversarial one.
          assert.strictEqual(outcome.ok, true, 'a save participant must not be mistaken for a concurrent undo');
          assert.ok(sidecarBytes(store, document) !== null, 'the comment must have been written');
        } finally {
          comments.dispose();
        }
      },
      { 'files.trimTrailingWhitespace': true }
    );
  });

  runner.finish();
}
