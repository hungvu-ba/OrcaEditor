/**
 * Req 23 US-23.1: pure helpers behind the comment CommentController — no
 * `vscode` import, so test/unit.ts can exercise them directly (commentController.ts
 * itself needs the VS Code runtime and cannot be imported there).
 */
import type { WebviewToHost } from '../shared/messages';

/** A `createComment` message, narrowed out of the WebviewToHost union. */
export type CreateCommentMessage = Extract<WebviewToHost, { type: 'createComment' }>;

/** A `commentAnchorUpdate` message (US-23.4), narrowed out of the WebviewToHost union. */
export type AnchorUpdateMessage = Extract<WebviewToHost, { type: 'commentAnchorUpdate' }>;

/** The anchor-resolution states US-23.4's tiers can produce. */
const ANCHOR_STATES: readonly AnchorUpdateMessage['state'][] = ['exact', 'approximate', 'floating'];

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
  if (msg.threadId === '') {
    // US-23.4: the handle every later anchor update names. A thread stored under
    // an empty key could never be addressed again.
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
 * Why a `commentAnchorUpdate` is refused, or null when it is valid (US-23.4).
 * Same untrusted-input rule as `createCommentRejection`: a webview message is
 * validated where the host consumes it, never assumed safe because a sibling
 * path validated something similar.
 *
 * A refused update leaves the thread exactly where it was — the webview keeps
 * its own resolution either way, so dropping a malformed update can only cost a
 * stale native Range, never a corrupted one.
 */
export function anchorUpdateRejection(msg: AnchorUpdateMessage, docUri: string): string | null {
  if (msg.docUri !== docUri) {
    return 'This anchor update was written for a different document.';
  }
  if (msg.threadId === '' || msg.anchorId === '') {
    return 'This anchor update names no thread.';
  }
  // 0 is legal, not a missing value: `commentAnchorLine` returns it for a node
  // that maps to no source line (a whole-document anchor), `createComment`
  // accepts it, and `commentThreadLine` already translates it. Refusing it here
  // would leave exactly those threads unable to ever report a relocation.
  if (!Number.isInteger(msg.line) || msg.line < 0) {
    return 'This anchor update carries no usable line.';
  }
  if (!ANCHOR_STATES.includes(msg.state)) {
    return 'This anchor update carries an unknown resolution state.';
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
