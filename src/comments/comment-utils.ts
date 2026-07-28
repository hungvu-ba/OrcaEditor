/**
 * Req 23 US-23.1: pure helpers behind the comment CommentController — no
 * `vscode` import, so test/unit.ts can exercise them directly (commentController.ts
 * itself needs the VS Code runtime and cannot be imported there).
 */
import * as os from 'os';
import type { CommentStatus, CommentStatusAction, WebviewToHost } from '../shared/messages';
import { sameAuthor } from './sidecar-format';
import { COMMENT_BODY_MAX_CODEPOINTS, commentBodyCodePointLength } from './comment-body-limit';

/**
 * US-23.10 AC4: `os.userInfo()` throws on some containerized/CI environments
 * with no passwd entry for the running uid — the ONE place that guard is
 * applied, so `commentController.ts`'s `authorFor` and `provider.ts`'s two
 * display-only author-name hints all fall back to `''` instead of one of them
 * crashing its caller (the requirement's own Source line names all three call
 * sites as needing this coverage).
 */
export function safeOsUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

/** A `createComment` message, narrowed out of the WebviewToHost union. */
export type CreateCommentMessage = Extract<WebviewToHost, { type: 'createComment' }>;

/** A `commentAnchorUpdate` message (US-23.4), narrowed out of the WebviewToHost union. */
export type AnchorUpdateMessage = Extract<WebviewToHost, { type: 'commentAnchorUpdate' }>;

/** A `replyToComment` message (US-23.2), narrowed out of the WebviewToHost union. */
export type ReplyMessage = Extract<WebviewToHost, { type: 'replyToComment' }>;

/** A `deleteComment` message (US-23.2), narrowed out of the WebviewToHost union. */
export type DeleteCommentMessage = Extract<WebviewToHost, { type: 'deleteComment' }>;

/** An `editComment` message (US-23.14), narrowed out of the WebviewToHost union. */
export type EditCommentMessage = Extract<WebviewToHost, { type: 'editComment' }>;

/** A `changeCommentStatus` message (US-23.3), narrowed out of the WebviewToHost union. */
export type StatusChangeMessage = Extract<WebviewToHost, { type: 'changeCommentStatus' }>;

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
 * US-23.10 AC4: why the AC4 author-prompt's raw answer is rejected, or null
 * when it is valid — meant for `showInputBox`'s `validateInput`, run against
 * the SAME trim+NFC form the answer is persisted in, so a name that passes
 * validation here is exactly what gets saved (no second, disagreeing check at
 * confirm time). Distinct from `resolveCommentAuthor` above, which resolves a
 * DISPLAY name from already-trusted config/OS values — this validates
 * untrusted free-text typed into a prompt.
 */
export function authorNamePromptRejection(raw: string): string | null {
  const normalized = raw.trim().normalize('NFC');
  if (normalized === '') {
    return 'Enter a name.';
  }
  // Newline/control characters would corrupt the sidecar's one-line-per-record
  // shape or spoof the author column when rendered -- rejected here rather than
  // silently stripped, so the user sees why and can retype. Compared by code
  // point rather than a regex literal, so no raw control byte sits in this
  // source file itself.
  if (containsControlChar(normalized)) {
    return 'The name cannot contain a newline or control character.';
  }
  if (normalized.length > 100) {
    return 'The name must be 100 characters or fewer.';
  }
  return null;
}

/** C0 control characters (below code point 32) or DEL (code point 127) -- see `authorNamePromptRejection`. */
function containsControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
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
  // US-23.5: these three are written straight into the sidecar's `anchor` block,
  // and its loader rejects the whole line if any is off-shape — so an unvalidated
  // value here would report success and then vanish on the next reopen. `line` is
  // 0-or-positive by the same rule `commentThreadLine`/`anchorUpdateRejection`
  // use (0 = "maps to no source line"); the two texts may be empty (an empty
  // node, or a node under no heading) but must be strings, not absent.
  if (!Number.isInteger(msg.line) || msg.line < 0) {
    return 'This comment lost its anchor before it could be created.';
  }
  if (typeof msg.recordedText !== 'string' || typeof msg.nearestHeading !== 'string') {
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
  // US-23.13 AC1/AC2: `origin` marks a transition the host must also persist —
  // validated only when present, since most `commentAnchorUpdate`s stay
  // in-memory-only and never carry one.
  if (msg.origin !== undefined) {
    if (msg.origin !== 'manual' && msg.origin !== 'resolved') {
      return 'This anchor update carries an unknown origin.';
    }
    if (
      !Number.isInteger(msg.offsetStart) ||
      !Number.isInteger(msg.offsetEnd) ||
      msg.offsetStart < 0 ||
      msg.offsetEnd < msg.offsetStart
    ) {
      return 'This anchor update carries no usable anchor text range.';
    }
    if (typeof msg.recordedText !== 'string' || typeof msg.nearestHeading !== 'string') {
      return 'This anchor update carries no usable anchor text.';
    }
  }
  return null;
}

/**
 * Why a `replyToComment` request is refused, or null when valid (US-23.2). The
 * thread's live status is passed in rather than read here — only
 * `commentController.ts` has the live registry, so this stays the same
 * pure-validator/thin-controller split `createCommentRejection` already
 * establishes. `undefined` status means the named thread does not exist.
 */
export function replyRejection(msg: ReplyMessage, docUri: string, threadStatus: CommentStatus | undefined): string | null {
  if (msg.docUri !== docUri) {
    return 'This reply was written for a different document.';
  }
  if (msg.threadId === '') {
    return 'This reply names no thread.';
  }
  if (msg.body.trim() === '') {
    return 'A reply needs some text.';
  }
  if (threadStatus === undefined) {
    return 'This comment thread no longer exists.';
  }
  // US-23.2 AC: replying is blocked while the thread is Closed (US-23.3) — the
  // popover shows "this thread is closed" instead of a reply box. Reachable
  // since US-23.3 shipped `statusChangeRejection`/`changeStatus` below; only the
  // Reviewer's Reopen lifts it.
  if (threadStatus === 'Closed') {
    return 'This thread is closed — reopen it before replying.';
  }
  return null;
}

/**
 * Why a `deleteComment` request is refused, or null when valid (US-23.2 PO
 * decision). `target` is the author string recorded on whatever this delete
 * would remove (the thread's own comment, or one specific reply) — `undefined`
 * means the named target no longer exists (already deleted, or never existed).
 * The author-match check is a soft, non-authenticated UX nudge (same
 * convention as US-23.3 AC6's Close-gating), never a security boundary.
 */
export function deleteRejection(
  msg: DeleteCommentMessage,
  docUri: string,
  target: { author: string } | undefined,
  currentAuthor: string
): string | null {
  if (msg.docUri !== docUri) {
    return 'This delete was written for a different document.';
  }
  if (msg.threadId === '') {
    return 'This delete names no thread.';
  }
  if (!target) {
    return 'That comment or reply no longer exists.';
  }
  if (!sameAuthor(target.author, currentAuthor)) {
    return 'Only the original author can delete this.';
  }
  return null;
}

/**
 * Why an `editComment` request is refused, or null when valid (US-23.14).
 * `threadStatus` `undefined` means the named thread does not exist. **No
 * authority check** (AC8, PO decision) — unlike `deleteRejection`, any user
 * with the file open may edit any comment or reply regardless of whose name
 * is on it. The "unchanged text is treated as Cancel" rule (AC2's sub-
 * criterion) is NOT a rejection — it is a silent no-op the caller checks
 * after this passes, so it is handled in `commentController.ts`, not here.
 */
export function editRejection(
  msg: EditCommentMessage,
  docUri: string,
  threadStatus: CommentStatus | undefined,
  /**
   * The body this edit would replace, when the caller has resolved the target.
   * Used only to avoid punishing an edit for length it did not introduce — see
   * the cap check below.
   */
  originalBody?: string
): string | null {
  if (msg.docUri !== docUri) {
    return 'This edit was written for a different document.';
  }
  if (msg.threadId === '') {
    return 'This edit names no thread.';
  }
  // Untrusted input: every field arrives off the wire, so a non-string body is
  // refused rather than reaching `.trim()` and throwing inside the host's
  // message handler — a throw there posts no result at all and leaves the
  // webview's guard waiting out its full timeout.
  if (typeof msg.body !== 'string') {
    return 'This edit carries no usable text.';
  }
  if (msg.body.trim() === '') {
    return 'Removing all the text is what Delete is for — a comment cannot be saved empty.';
  }
  // AC7 bounds an edit at the same cap creation enforces — but US-23.10 AC10 has
  // NOT shipped, so bodies longer than the cap already exist in the wild. Capping
  // such a body at 4000 would make an editor silently destroy content they did
  // not write (AC8 lets anyone edit anyone's comment), and refusing outright
  // would make it permanently uneditable. So the ceiling is the cap OR the
  // length already there, whichever is larger: an edit can never GROW an
  // over-long body, and a normal body still cannot exceed the cap.
  const ceiling = Math.max(
    COMMENT_BODY_MAX_CODEPOINTS,
    originalBody === undefined ? 0 : commentBodyCodePointLength(originalBody)
  );
  if (commentBodyCodePointLength(msg.body) > ceiling) {
    return `A comment can be at most ${COMMENT_BODY_MAX_CODEPOINTS} characters.`;
  }
  if (threadStatus === undefined) {
    return 'This comment thread no longer exists.';
  }
  if (threadStatus === 'Closed') {
    return 'This thread is closed — reopen it before editing.';
  }
  return null;
}

/** The status each action moves a thread to (US-23.3 AC1/AC5). */
export const STATUS_CHANGE_TARGET: Record<CommentStatusAction, CommentStatus> = {
  resolve: 'Resolved',
  close: 'Closed',
  reopen: 'Open',
};

/**
 * The statuses each action may be invoked FROM (US-23.3 AC1/AC5). Reopen accepts
 * both Resolved and Closed because the PO decision made it one action covering
 * "the Reviewer disagrees this is fixed" and "that Close was a mistake" alike.
 */
const STATUS_CHANGE_SOURCE: Record<CommentStatusAction, readonly CommentStatus[]> = {
  resolve: ['Open'],
  close: ['Resolved'],
  reopen: ['Resolved', 'Closed'],
};

/**
 * The native `CommentThread.contextValue` for a thread, carrying BOTH axes
 * (US-23.4's anchor resolution and US-23.3's status).
 *
 * Pure and here rather than inline in `commentController.ts` so `test/unit.ts` can
 * assert it against the `when` clauses in `package.json` — a typo on either side
 * silently removes all three native Resolve/Close/Reopen actions, with nothing
 * failing anywhere. Both halves must always be present: a thread carrying only
 * `anchor-…` matches no `status-…` clause and offers none of the three.
 */
export function commentThreadContextValue(
  anchorState: AnchorUpdateMessage['state'],
  status: CommentStatus
): string {
  return `anchor-${anchorState} status-${status.toLowerCase()}`;
}

/**
 * Why a `changeCommentStatus` request is refused, or null when valid
 * (US-23.3, revised by US-23.11 AC1/AC5).
 *
 * The thread's live status is passed in for the same reason `replyRejection`
 * takes it: only `commentController.ts` holds the live registry, so this stays a
 * pure validator. `threadStatus` `undefined` means the named thread does not
 * exist.
 *
 * **No identity check.** US-23.11 AC1 (PO decision, supersedes US-23.3 AC6):
 * `orcaEditor.comments.authorName` is free text on a local single-machine
 * extension, so gating an action on it bought nothing and — because the recorded
 * author is the Reviewer who filed the thread — the gate was inverted, locking a
 * Reviewer out of their own Closed thread. Availability is a function of the
 * thread's current status alone; accountability comes from the transition trail.
 */
export function statusChangeRejection(
  msg: StatusChangeMessage,
  docUri: string,
  threadStatus: CommentStatus | undefined
): string | null {
  if (msg.docUri !== docUri) {
    return 'This status change was written for a different document.';
  }
  if (msg.threadId === '') {
    return 'This status change names no thread.';
  }
  // Untrusted input: an unknown action must be refused, never fall through to a
  // lookup that would yield `undefined` and append a malformed sidecar line.
  if (!Object.prototype.hasOwnProperty.call(STATUS_CHANGE_TARGET, msg.action)) {
    return 'This status change carries an unknown action.';
  }
  if (threadStatus === undefined) {
    return 'This comment thread no longer exists.';
  }
  // Also covers US-23.11 AC7's "already at that status" case: no action is legal
  // from the status it produces, so a request that would be a no-op is refused
  // here before any line is appended.
  if (!STATUS_CHANGE_SOURCE[msg.action].includes(threadStatus)) {
    return msg.action === 'close'
      ? 'Resolve the thread before closing it.'
      : `A ${threadStatus} thread cannot be ${msg.action === 'resolve' ? 'resolved' : 'reopened'}.`;
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

/**
 * Req 24 US-23.12 AC1: `Copied {n} thread(s) as Markdown`, naming the "Hide
 * closed" exclusion when it applies. Host-side (not `media/webview/`) because
 * the confirmation itself is a `vscode.window.setStatusBarMessage` call.
 */
export function copyConfirmationMessage(threadCount: number, hiddenClosedCount: number | undefined): string {
  const base = `Copied ${threadCount} thread${threadCount === 1 ? '' : 's'} as Markdown`;
  return hiddenClosedCount === undefined || hiddenClosedCount === 0
    ? base
    : `${base} (${hiddenClosedCount} Closed hidden)`;
}

/**
 * Req 24 US-23.13 AC6: which panel becomes authoritative for a document when
 * the current holder is gone — the first one still registered, in iteration
 * (insertion) order. Generic and VS Code-API-free so it can be unit-tested
 * against plain values; `provider.ts` calls it with its `Set<vscode.WebviewPanel>`.
 * `undefined` when none remain (the document has no open panel left).
 */
export function nextAuthoritativePanel<T>(remaining: Iterable<T>): T | undefined {
  for (const panel of remaining) {
    return panel;
  }
  return undefined;
}
