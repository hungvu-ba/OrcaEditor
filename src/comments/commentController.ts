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
  anchorUpdateRejection,
  commentThreadLine,
  createCommentRejection,
  resolveCommentAuthor,
  type AnchorUpdateMessage,
  type CreateCommentMessage,
} from './comment-utils';

/** The structural anchor a thread was created against (US-23.1; re-resolved by US-23.4). */
export interface CommentAnchor {
  anchorId: string;
  offsetStart: number;
  offsetEnd: number;
  /** US-23.4 tier 2: the anchored node's text at creation time. */
  recordedText: string;
  /** US-23.4: 1-based line the anchor was last resolved to. */
  lastKnownLine: number;
  /** US-23.4 tier 2 tie-breaker: heading the anchored node sat under. */
  nearestHeading: string;
  /** US-23.4: which tier placed it — orthogonal to the Open/Resolved/Closed axis (US-23.3). */
  state: AnchorUpdateMessage['state'];
}

export interface CommentSupport extends vscode.Disposable {
  /**
   * Create one thread for a validated `createComment` request. Returns the
   * rejection reason (to be surfaced to the Reviewer) or null on success —
   * a refused request must never leave a thread against a stale/empty anchor.
   */
  createThread(msg: CreateCommentMessage, document: vscode.TextDocument): string | null;
  /**
   * US-23.4: a tier moved (or gave up on) a thread's anchor — follow it with the
   * native Range and record the new state. Returns the rejection reason or null.
   * Never edits the document (US-23.6).
   */
  updateAnchor(msg: AnchorUpdateMessage, document: vscode.TextDocument): string | null;
  /** The structural anchor a thread was created against — US-23.4 re-resolves from here. */
  anchorOf(threadId: string): CommentAnchor | undefined;
}

/** What a non-exact anchor reads as on the native thread (US-23.4 AC3/AC4). */
const ANCHOR_STATE_LABEL: Record<Exclude<AnchorUpdateMessage['state'], 'exact'>, string> = {
  approximate: 'Approximate location',
  floating: 'Unresolved location',
};

export function createCommentSupport(): CommentSupport {
  const controller = vscode.comments.createCommentController(
    'orcaEditor.comments',
    'Orca Editor Comments'
  );
  // Threads are placed from the webview's structural anchor, never by dragging a
  // range in the text editor's gutter — so no commentingRangeProvider.
  //
  // Keyed by the webview's threadId (US-23.4): the webview owns re-resolution and
  // addresses threads by that id, and a Map (unlike the previous WeakMap on the
  // thread object) is what lets an update find the thread from the id alone.
  const threads = new Map<string, { thread: vscode.CommentThread; anchor: CommentAnchor }>();

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
      if (threads.has(msg.threadId)) {
        // One controller serves every document, so a colliding handle would
        // silently replace another thread's entry and misdirect its updates.
        return 'A comment thread with this id already exists.';
      }
      const thread = controller.createCommentThread(document.uri, range, [comment]);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      threads.set(msg.threadId, {
        thread,
        anchor: {
          anchorId: msg.anchorId,
          offsetStart: msg.offsetStart,
          offsetEnd: msg.offsetEnd,
          recordedText: msg.recordedText,
          lastKnownLine: msg.line,
          nearestHeading: msg.nearestHeading,
          state: 'exact',
        },
      });
      return null;
    },
    updateAnchor(msg, document): string | null {
      const rejection = anchorUpdateRejection(msg, document.uri.toString());
      if (rejection !== null) {
        return rejection;
      }
      const entry = threads.get(msg.threadId);
      if (!entry) {
        return 'This anchor update names a thread that no longer exists.';
      }
      if (entry.thread.uri.toString() !== msg.docUri) {
        // Belt and braces behind the unique handle: never let one document's
        // resolution move a thread that lives in another file.
        return 'This anchor update names a thread in another document.';
      }
      // A floating thread keeps its last known line, which can sit past the end
      // of a document that has since been cut down.
      const line = Math.min(commentThreadLine(msg.line), Math.max(0, document.lineCount - 1));
      try {
        entry.thread.range = new vscode.Range(line, 0, line, 0);
        // The native surface has no notion of anchor drift, so the state is
        // carried as a contextValue (available to menu `when` clauses) plus a
        // label — AC3's "never silently indistinguishable from an exact anchor"
        // has to hold here too, not only in the webview.
        entry.thread.contextValue = `anchor-${msg.state}`;
        entry.thread.label = msg.state === 'exact' ? undefined : ANCHOR_STATE_LABEL[msg.state];
      } catch {
        // The thread was disposed (the user deleted it in the Comments panel, or
        // the controller tore it down). Forget it rather than throwing out of the
        // message handler on every later pass.
        threads.delete(msg.threadId);
        return 'This anchor update names a thread that no longer exists.';
      }
      entry.anchor.anchorId = msg.anchorId;
      entry.anchor.lastKnownLine = msg.line;
      entry.anchor.state = msg.state;
      return null;
    },
    anchorOf(threadId): CommentAnchor | undefined {
      return threads.get(threadId)?.anchor;
    },
    dispose(): void {
      threads.clear();
      controller.dispose();
    },
  };
}
