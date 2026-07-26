/**
 * Req 23 US-23.1: pure helpers behind the comment CommentController — no
 * `vscode` import, so test/unit.ts can exercise them directly (commentController.ts
 * itself needs the VS Code runtime and cannot be imported there).
 */
import type { WebviewToHost } from '../shared/messages';

/** A `createComment` message, narrowed out of the WebviewToHost union. */
export type CreateCommentMessage = Extract<WebviewToHost, { type: 'createComment' }>;

/**
 * Author recorded on a new comment: the `orcaEditor.comments.authorName`
 * setting when the user has set one, else the OS username. The setting is
 * free-text with no authentication behind it (US-23.3's PO decision) — this
 * resolves a display name, it is not an identity check. Whitespace-only is
 * treated as unset so a stray space doesn't produce a blank author.
 */
export function resolveCommentAuthor(configured: string | undefined, osUsername: string): string {
  const trimmed = (configured ?? '').trim();
  return trimmed !== '' ? trimmed : osUsername;
}

/**
 * Why a `createComment` request is refused, or null when it is valid. Every
 * webview message is untrusted input, so the payload is validated at the point
 * the host consumes it:
 *
 * - a different `docUri` means the message arrived after a tab switch — creating
 *   the thread would attach it to the wrong document (same guard as
 *   `executeCommand`/`addReference`);
 * - an empty/whitespace-only body must never create a thread (US-23.1: confirming
 *   with an empty body is a no-op, the "refuse rather than store malformed data"
 *   convention);
 * - a missing anchor id or a negative/reversed offset pair is a malformed anchor,
 *   not something to best-effort around.
 */
export function createCommentRejection(msg: CreateCommentMessage, docUri: string): string | null {
  if (msg.docUri !== docUri) {
    return 'This comment was written for a different document.';
  }
  if (msg.body.trim() === '') {
    return 'A comment needs some text.';
  }
  if (msg.anchorId === '') {
    return 'This comment lost its anchor before it could be created.';
  }
  if (
    !Number.isInteger(msg.offsetStart) ||
    !Number.isInteger(msg.offsetEnd) ||
    msg.offsetStart < 0 ||
    msg.offsetEnd < msg.offsetStart
  ) {
    return 'This comment lost its anchor before it could be created.';
  }
  return null;
}

/**
 * 0-based line for the native `CommentThread`'s required `vscode.Range`,
 * translated from the webview's 1-based source line (0 = "maps to no source
 * line", e.g. a selection spanning several blocks). Best-effort API compliance
 * only — the structural anchor, not this line, is what US-23.4 re-resolves.
 */
export function commentThreadLine(line: number): number {
  return line > 0 ? line - 1 : 0;
}
