/**
 * Req 24 `_bmad-output/quick-dev/inprogress-comment-delete-sidecar-rewrite.md`
 * — delete now physically rewrites (or removes) `.orca-comments.jsonl`
 * instead of appending a `delete` tombstone.
 *
 * This needs the extension-host track, not the Playwright one: the assertions
 * are about the actual bytes `store.removeComment` leaves on disk, which needs
 * a real `TextDocument` and a real sidecar file — same reasoning
 * `comment-undo-routes.test.ts`'s header gives for its own track choice.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { createSidecarStore } from '../../src/comments/sidecar-store';
import { createCommentSupport } from '../../src/comments/commentController';
import { buildCommentLine } from '../../src/comments/sidecar-format';
import type { CreateCommentMessage } from '../../src/comments/comment-utils';
import { allowAllGuard, noopLog, openTempMdFile, withTempWorkspace, HostTestRunner } from './_harness';

const DOC_TEXT = '# doc\n\nAlpha paragraph.\n\nBeta paragraph.\n';

function createMessage(docUri: string, threadId: string, body: string): CreateCommentMessage {
  return {
    type: 'createComment',
    requestId: 1,
    docUri,
    threadId,
    anchorId: `anchor-${threadId}`,
    offsetStart: 0,
    offsetEnd: 5,
    line: 3,
    body,
    recordedText: 'Alpha paragraph.',
    nearestHeading: 'doc',
  };
}

/** Sidecar bytes for `document`, or null when no sidecar exists on disk. */
function sidecarBytes(store: ReturnType<typeof createSidecarStore>, document: vscode.TextDocument): string | null {
  const p = store.uriFor(document).fsPath;
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/**
 * The one physical JSONL line containing `marker`, out of raw sidecar `text`
 * — every line is one compact `JSON.stringify` object (`serializeSidecarLine`),
 * so a substring match on a field like `"id":"…"` or `"body":"…"` finds a
 * line exactly, immune to the blank-line padding `append` leaves between
 * entries (which the delete rewrite's tighter join does not reproduce — a
 * non-goal, not a regression).
 */
function lineContaining(text: string, marker: string): string | undefined {
  return text.split('\n').find((line) => line.includes(marker));
}

export async function run(): Promise<void> {
  const runner = new HostTestRunner();

  // One shared workspace for every case below — same reasoning
  // `comment-undo-routes.test.ts` gives: each `withTempWorkspace` restarts the
  // Extension Host, so sharing one keeps this file to a single restart.
  await withTempWorkspace(async (root) => {
    await runner.case('deleting the only thread removes the .orca-comments.jsonl file entirely', async () => {
      const document = await openTempMdFile(root, 'delete-last-thread.md', DOC_TEXT);
      const store = createSidecarStore(allowAllGuard, noopLog, false);
      const comments = createCommentSupport(store, noopLog, false);
      try {
        const created = await comments.createThread(createMessage(document.uri.toString(), 'thread-1', 'only thread'), document);
        assert.strictEqual(created.ok, true, 'precondition: the thread must exist before it is deleted');
        assert.ok(sidecarBytes(store, document) !== null, 'precondition: the sidecar must exist on disk');

        const outcome = await comments.deleteComment(
          { type: 'deleteComment', requestId: 1, docUri: document.uri.toString(), threadId: 'thread-1' },
          document
        );

        assert.strictEqual(outcome.ok, true, 'deleting the only thread must succeed');
        assert.strictEqual(
          sidecarBytes(store, document),
          null,
          'the .orca-comments.jsonl file must be removed from disk, not left as an empty file'
        );
      } finally {
        comments.dispose();
      }
    });

    await runner.case("deleting one of several threads leaves the other thread's bytes untouched", async () => {
      const document = await openTempMdFile(root, 'delete-one-of-several.md', DOC_TEXT);
      const store = createSidecarStore(allowAllGuard, noopLog, false);
      const comments = createCommentSupport(store, noopLog, false);
      try {
        const bodyA = "A's thread";
        const bodyB = "B's thread";
        const createdA = await comments.createThread(createMessage(document.uri.toString(), 'thread-a', bodyA), document);
        const createdB = await comments.createThread(createMessage(document.uri.toString(), 'thread-b', bodyB), document);
        assert.strictEqual(createdA.ok, true, 'precondition: thread A must exist');
        assert.strictEqual(createdB.ok, true, 'precondition: thread B must exist');

        // Matched by its own body text, not the durable sidecar id: neither
        // `createThread`'s outcome nor `listThreads` exposes the host-minted
        // comment id for a thread created this session — only `threadId`, the
        // webview-minted key, which never appears in the sidecar line itself.
        const bMarker = `"body":${JSON.stringify(bodyB)}`;
        const beforeDelete = sidecarBytes(store, document);
        assert.ok(beforeDelete !== null, 'precondition: the sidecar must exist before the delete');
        const bLineBefore = lineContaining(beforeDelete, bMarker);
        assert.ok(bLineBefore !== undefined, "precondition: thread B's own line must be found in the sidecar");

        const outcome = await comments.deleteComment(
          { type: 'deleteComment', requestId: 1, docUri: document.uri.toString(), threadId: 'thread-a' },
          document
        );

        assert.strictEqual(outcome.ok, true, 'deleting thread A must succeed');
        const afterDelete = sidecarBytes(store, document);
        assert.ok(afterDelete !== null, 'the sidecar must still exist — thread B is still live');
        assert.strictEqual(
          lineContaining(afterDelete, bMarker),
          bLineBefore,
          "thread B's own line must survive byte-identical"
        );
        assert.strictEqual(
          afterDelete.includes(`"body":${JSON.stringify(bodyA)}`),
          false,
          "thread A's own line must be gone after its delete"
        );
      } finally {
        comments.dispose();
      }
    });

    await runner.case('deleting one reply out of three leaves the rest of the thread intact', async () => {
      const document = await openTempMdFile(root, 'delete-one-reply.md', DOC_TEXT);
      const store = createSidecarStore(allowAllGuard, noopLog, false);
      const comments = createCommentSupport(store, noopLog, false);
      try {
        const created = await comments.createThread(createMessage(document.uri.toString(), 'thread-1', 'the comment'), document);
        assert.strictEqual(created.ok, true, 'precondition: the thread must exist');
        const reply1 = await comments.reply({ type: 'replyToComment', requestId: 1, docUri: document.uri.toString(), threadId: 'thread-1', body: 'reply one' }, document);
        const reply2 = await comments.reply({ type: 'replyToComment', requestId: 2, docUri: document.uri.toString(), threadId: 'thread-1', body: 'reply two' }, document);
        const reply3 = await comments.reply({ type: 'replyToComment', requestId: 3, docUri: document.uri.toString(), threadId: 'thread-1', body: 'reply three' }, document);
        assert.strictEqual(reply1.ok, true, 'precondition: reply one must exist');
        assert.strictEqual(reply2.ok, true, 'precondition: reply two must exist');
        assert.strictEqual(reply3.ok, true, 'precondition: reply three must exist');
        const reply1Id = (reply1 as { replyId: string }).replyId;
        const reply2Id = (reply2 as { replyId: string }).replyId;
        const reply3Id = (reply3 as { replyId: string }).replyId;

        const beforeDelete = sidecarBytes(store, document);
        assert.ok(beforeDelete !== null, 'precondition: the sidecar must exist before the delete');
        const reply1LineBefore = lineContaining(beforeDelete, `"id":"${reply1Id}"`);
        const reply3LineBefore = lineContaining(beforeDelete, `"id":"${reply3Id}"`);
        assert.ok(reply1LineBefore !== undefined && reply3LineBefore !== undefined, 'precondition: replies one and three must be found in the sidecar');

        const outcome = await comments.deleteComment(
          { type: 'deleteComment', requestId: 1, docUri: document.uri.toString(), threadId: 'thread-1', targetReplyId: reply2Id },
          document
        );

        assert.strictEqual(outcome.ok, true, 'deleting reply two must succeed');
        const afterDelete = sidecarBytes(store, document);
        assert.ok(afterDelete !== null, 'the sidecar must still exist — the thread and two replies are still live');
        assert.strictEqual(lineContaining(afterDelete, `"id":"${reply1Id}"`), reply1LineBefore, "reply one's own line must survive byte-identical");
        assert.strictEqual(lineContaining(afterDelete, `"id":"${reply3Id}"`), reply3LineBefore, "reply three's own line must survive byte-identical");
        assert.strictEqual(lineContaining(afterDelete, `"id":"${reply2Id}"`), undefined, "reply two's own line must be gone");
        const threadAfter = comments.listThreads(document).find((t) => t.threadId === 'thread-1');
        assert.strictEqual(threadAfter?.replies.length, 2, 'the thread must keep exactly its two surviving replies');
      } finally {
        comments.dispose();
      }
    });

    // Patch 3(a): the I/O Matrix's "concurrent write lands between read and
    // write" row, exercised directly against `store.removeComment` (no need
    // for the full `deleteComment`/webview flow) — a fake `readFile` seam
    // makes the SECOND internal read (the "re-read immediately before the
    // write" check) see one more line than the first, without a real timing
    // race.
    await runner.case(
      'store.removeComment: a concurrent write landing between the two reads fails with a retryable error, not a silent clobber',
      async () => {
        const document = await openTempMdFile(root, 'delete-concurrent-write.md', DOC_TEXT);
        const seedStore = createSidecarStore(allowAllGuard, noopLog, false);
        const seedLine = buildCommentLine({
          id: 'race-comment',
          author: 'Host Test Author',
          timestamp: '2026-01-01T00:00:00.000Z',
          body: 'about to race',
          anchor: { offset_start: 0, offset_end: 4, recorded_text: 'doc', last_known_line: 1, nearest_heading: '' },
        });
        assert.strictEqual(await seedStore.append(document, seedLine), null, 'precondition: the seed comment must be written');
        const sidecarPath = seedStore.uriFor(document).fsPath;
        const onDiskBefore = fs.readFileSync(sidecarPath, 'utf8');

        let readCount = 0;
        const racingStore = createSidecarStore(allowAllGuard, noopLog, false, {
          fsOps: {
            appendFile: fs.promises.appendFile,
            rename: fs.promises.rename,
            writeFile: fs.promises.writeFile,
            unlink: fs.promises.unlink,
            readFile: (async (...args: Parameters<typeof fs.promises.readFile>) => {
              readCount += 1;
              const real = await fs.promises.readFile(...args);
              // First call is removeComment's "read fresh, immediately before
              // computing what to keep". Every call after that stands in for
              // its "re-read immediately before the write" — reporting one
              // extra line the delete never saw, as if another session's
              // append landed in the window between the two reads.
              return readCount === 1 ? real : `${real}\n{"schema_version":1,"type":"comment","id":"concurrent-comment"}`;
            }) as typeof fs.promises.readFile,
          },
        });

        const result = await racingStore.removeComment(document, 'race-comment');
        assert.notStrictEqual(result, null, 'a concurrent write landing mid-delete must fail, not silently clobber it');
        assert.strictEqual(
          fs.readFileSync(sidecarPath, 'utf8'),
          onDiskBefore,
          'the sidecar on disk must be untouched when the delete is refused'
        );
      }
    );

    // Patch 3(b): the I/O Matrix's "sidecar already gone" row — a document
    // that was never commented on (or whose sidecar another session already
    // deleted) has nothing to remove, so the delete is a no-op success, not a
    // reported failure.
    await runner.case('store.removeComment: no sidecar file on disk is a no-op success, not a failure', async () => {
      const document = await openTempMdFile(root, 'delete-no-sidecar.md', DOC_TEXT);
      const store = createSidecarStore(allowAllGuard, noopLog, false);
      assert.strictEqual(sidecarBytes(store, document), null, 'precondition: no sidecar must exist yet');

      const result = await store.removeComment(document, 'no-such-id');

      assert.strictEqual(result, null, 'removeComment on an absent sidecar must be a no-op success');
    });
  });

  runner.finish();
}
