/**
 * Req 23 US-23.1: the extension's single `vscode.comments` CommentController —
 * the thread/reply/author/timestamp data model for review comments (the same
 * model the GitHub Pull Requests extension uses).
 *
 * Scope of this story: threads are created and held IN MEMORY only. Durable
 * persistence to the per-file `.orca-comments.jsonl` sidecar is US-23.5, and
 * nothing here ever touches the `.md` — a comment must never occupy a slot in
 * the document's undo stack (US-23.6).
 *
 * The structural anchor recorded on each thread ({anchorId, offsetStart,
 * offsetEnd}) is authoritative; the `vscode.Range` the native API requires is a
 * best-effort translation of the anchored node's source line, kept only so the
 * thread is a valid CommentThread. Re-resolving that anchor across edits is
 * US-23.4.
 */
import * as os from 'os';
import * as vscode from 'vscode';
import {
  commentThreadLine,
  createCommentRejection,
  resolveCommentAuthor,
  type CreateCommentMessage,
} from './comment-utils';

/** The structural anchor a thread was created against (US-23.1; re-resolved by US-23.4). */
export interface CommentAnchor {
  anchorId: string;
  offsetStart: number;
  offsetEnd: number;
}

export interface CommentSupport extends vscode.Disposable {
  /**
   * Create one thread for a validated `createComment` request. Returns the
   * rejection reason (to be surfaced to the Reviewer) or null on success —
   * a refused request must never leave a thread against a stale/empty anchor.
   */
  createThread(msg: CreateCommentMessage, document: vscode.TextDocument): string | null;
  /** The structural anchor a thread was created against — US-23.4 re-resolves from here. */
  anchorOf(thread: vscode.CommentThread): CommentAnchor | undefined;
}

export function createCommentSupport(): CommentSupport {
  const controller = vscode.comments.createCommentController(
    'orcaEditor.comments',
    'Orca Editor Comments'
  );
  // Threads are placed from the webview's structural anchor, never by dragging a
  // range in the text editor's gutter — so no commentingRangeProvider.
  const anchors = new WeakMap<vscode.CommentThread, CommentAnchor>();

  return {
    createThread(msg, document): string | null {
      const rejection = createCommentRejection(msg, document.uri.toString());
      if (rejection !== null) {
        return rejection;
      }
      const line = commentThreadLine(msg.line);
      const range = new vscode.Range(line, 0, line, 0);
      const author = resolveCommentAuthor(
        vscode.workspace
          .getConfiguration('orcaEditor.comments', document.uri)
          .get<string>('authorName'),
        os.userInfo().username
      );
      const comment: vscode.Comment = {
        body: new vscode.MarkdownString(msg.body),
        mode: vscode.CommentMode.Preview,
        author: { name: author },
        timestamp: new Date(),
      };
      const thread = controller.createCommentThread(document.uri, range, [comment]);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      anchors.set(thread, {
        anchorId: msg.anchorId,
        offsetStart: msg.offsetStart,
        offsetEnd: msg.offsetEnd,
      });
      return null;
    },
    anchorOf(thread): CommentAnchor | undefined {
      return anchors.get(thread);
    },
    dispose(): void {
      controller.dispose();
    },
  };
}
