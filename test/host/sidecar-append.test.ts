/**
 * US-23.17 AC8/AC9: the sidecar append success and failure paths, exercised
 * against a real filesystem inside a real Extension Host — today verified by
 * reading the code only (`deferred-work.md`, US-23.6 review item 5).
 *
 * Scope boundary (deliberate, per review 2026-07-28): AC9 names the chain
 * "`sidecar-store.append` error → `CreateThreadOutcome.error` → `createCommentResult`
 * → the surfaced message." This test asserts the first two links directly
 * against the real `CommentSupport.createThread`. The third link —
 * `provider.ts`'s `case 'createComment':` turning that outcome into a
 * `createCommentResult` message posted to an actual webview panel — is not
 * exercised here: the public `vscode` API gives a host test no way to open the
 * custom editor's real webview and observe `postMessage` calls without either
 * a new production-only test hook in `provider.ts` (a bigger surface than this
 * story's own "harness plus tests for exactly the surfaces that have already
 * caused real data loss" scope asks for) or fragile prototype-patching. That
 * third link is a 3-line ternary in `provider.ts` with no branching logic of
 * its own to protect — the risk AC9 exists to cover lives entirely in the
 * first two links, which this test does assert end to end.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import { createSidecarStore } from '../../src/comments/sidecar-store';
import { createCommentSupport } from '../../src/comments/commentController';
import { buildCommentLine, serializeSidecarLine } from '../../src/comments/sidecar-format';
import type { CreateCommentMessage } from '../../src/comments/comment-utils';
import { allowAllGuard, noopLog, openTempMdFile, withTempWorkspace, HostTestRunner } from './_harness';

function createMessage(docUri: string, threadId: string): CreateCommentMessage {
  return {
    type: 'createComment',
    requestId: 1,
    docUri,
    threadId,
    anchorId: 'anchor-1',
    offsetStart: 0,
    offsetEnd: 4,
    line: 1,
    body: 'a host-test comment',
    recordedText: 'doc',
    nearestHeading: '',
  };
}

export async function run(): Promise<void> {
  const runner = new HostTestRunner();

  await runner.case('AC8: a successful append writes the exact serialized line and leaves the .md untouched', async () => {
    await withTempWorkspace(async (root) => {
      const document = await openTempMdFile(root, 'append-success.md', '# doc\n');
      const mdBefore = fs.readFileSync(document.uri.fsPath);
      const store = createSidecarStore(allowAllGuard, noopLog, false);
      const line = buildCommentLine({
        id: 'comment-1',
        author: 'Host Test Author',
        timestamp: '2026-01-01T00:00:00.000Z',
        body: 'hello',
        anchor: { offset_start: 0, offset_end: 4, recorded_text: 'doc', last_known_line: 1, nearest_heading: '' },
      });

      const err = await store.append(document, line);
      assert.strictEqual(err, null);

      const sidecarPath = store.uriFor(document).fsPath;
      const onDisk = fs.readFileSync(sidecarPath, 'utf8');
      assert.strictEqual(onDisk, '\n' + serializeSidecarLine(line));
      assert.ok(fs.readFileSync(document.uri.fsPath).equals(mdBefore), '.md must be byte-identical after a sidecar append');
    });
  });

  await runner.case('AC9: an append failure surfaces the reason, creates no thread, and alters no earlier line', async () => {
    await withTempWorkspace(async (root) => {
      const document = await openTempMdFile(root, 'append-failure.md', '# doc\n');
      // Seed one real line directly (bypassing the store, whose fsOps below always fails).
      const seedStore = createSidecarStore(allowAllGuard, noopLog, false);
      const seedLine = buildCommentLine({
        id: 'seed-comment',
        author: 'Host Test Author',
        timestamp: '2026-01-01T00:00:00.000Z',
        body: 'already there',
        anchor: { offset_start: 0, offset_end: 4, recorded_text: 'doc', last_known_line: 1, nearest_heading: '' },
      });
      assert.strictEqual(await seedStore.append(document, seedLine), null);
      const sidecarPath = seedStore.uriFor(document).fsPath;
      const beforeAttempt = fs.readFileSync(sidecarPath, 'utf8');

      const failingStore = createSidecarStore(allowAllGuard, noopLog, false, {
        fsOps: {
          appendFile: async () => {
            const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          },
          rename: fs.promises.rename,
          writeFile: fs.promises.writeFile,
          unlink: fs.promises.unlink,
          readFile: fs.promises.readFile,
        },
      });
      const comments = createCommentSupport(failingStore, noopLog, false);
      try {
        const outcome = await comments.createThread(createMessage(document.uri.toString(), 'thread-1'), document);
        assert.deepStrictEqual(outcome, { ok: false, error: 'Failed to save the comment.' });
        assert.deepStrictEqual(comments.listThreads(document), []);
        assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), beforeAttempt, 'no earlier sidecar line may be altered by a failed append');
      } finally {
        comments.dispose();
      }
    });
  });

  runner.finish();
}
