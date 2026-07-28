/**
 * Req 23 US-23.2: the thread popover — opened from a gutter pin, showing the
 * read-only original comment, its replies, a reply box (or a "closed" notice),
 * and delete controls gated to the content's own author.
 *
 * Mounted on `document.body` (comment-panel.ts's convention) so no session-
 * only class ever risks reaching turndown.ts's raw-HTML serialize path — this
 * module writes nothing into `#content`. Single instance, single-open-at-a-
 * time: `open()` always reuses the same card, so opening a second thread
 * closes whatever was open first for free.
 *
 * Reply/delete write ONLY through `replyToComment`/`deleteComment` messages —
 * the host validates and appends the sidecar line (US-23.6: never a
 * `TextDocument` edit). The reply `<textarea>` gets its own native field undo
 * (main.ts's `ownsNativeUndo` already covers any `<textarea>` by type, and
 * since this card lives outside `#content`, the editor's own undo/redo keydown
 * handler — bound to `#content` — never even sees a keystroke typed here).
 *
 * US-23.3 added the action bar (Mark as Resolved / Close / Reopen) and the
 * passive drift strip; US-23.11 added the transition trail. All three are
 * rendered from the live thread only — the action bar offers exactly the
 * transitions the thread's STATUS allows (never a disabled control, and never a
 * function of who is asking), and the strip is derived from
 * `anchor.contentDrifted` on every render, never a stored flag.
 */
import type { CommentHighlightController } from './comment-highlight';
import type { CommentResolveController, ThreadAnchor } from './comment-resolve';
import {
  COMMENT_ACTION_BAR_CLASS,
  COMMENT_DELETE_CONFIRM_CLASS,
  COMMENT_DRIFT_STRIP_CLASS,
  COMMENT_EDIT_INPUT_CLASS,
  COMMENT_POPOVER_CLASS,
  COMMENT_REPLY_INPUT_CLASS,
  COMMENT_REPLY_RESULT_TIMEOUT_MS,
} from './constants';
import { el, neutralizeBodyText, normalizeBodyEol, positionNear, showToast } from './dom-utils';
import { ESCAPE_PRIORITY, initPopoverDismiss } from './escape-stack';
import type { VsCodeApi } from './vscode-api';
import { sameAuthor } from '../../src/comments/sidecar-format';
import {
  clipCommentBodyToLimit,
  commentBodyCodePointLength,
  COMMENT_BODY_COUNTER_THRESHOLD,
  COMMENT_BODY_MAX_CODEPOINTS,
} from '../../src/comments/comment-body-limit';
import type { CommentStatusAction } from '../../src/shared/messages';

export interface CommentPopoverController {
  /**
   * Open (or re-focus) the popover for `threadId`, anchored beside `anchorRect`.
   * `returnFocusTo` is focused when the popover closes — US-23.9's list rows,
   * which would otherwise orphan focus on a row that is about to be re-rendered.
   */
  open(threadId: string, anchorRect: DOMRect, returnFocusTo?: HTMLElement): void;
  /** Close the popover if it is showing one of these now-deleted threads. */
  forgetThreads(threadIds: string[]): void;
  setDocUri(uri: string): void;
  setAuthorName(name: string): void;
  notifyReplyResult(requestId: number, ok: boolean, error?: string): void;
  notifyDeleteResult(requestId: number, ok: boolean, error?: string): void;
  /** US-23.3: outcome of a Resolve/Close/Reopen request this popover sent. */
  notifyStatusResult(requestId: number, ok: boolean, error?: string): void;
  /** US-23.14: outcome of an `editComment` request this popover sent. */
  notifyEditResult(requestId: number, ok: boolean, error?: string): void;
}

/** One button in the popover's action bar, already decided for the thread being rendered. */
interface StatusAction {
  action: CommentStatusAction;
  label: string;
  /** The action the design leads with for this status. */
  primary: boolean;
}

/**
 * US-23.3 AC1/AC5, revised by US-23.11 AC1/AC5: which transitions may be invoked
 * on this thread. A function of the thread's STATUS ALONE — never of who is
 * asking.
 *
 * Deliberately mirrors `statusChangeRejection` host-side rather than replacing
 * it — the host is the authority (every webview message is untrusted input) and
 * re-validates against the freshly-folded status. This half exists so the same
 * matrix is what the user sees: Open → Resolve; Resolved → Close and Reopen;
 * Closed → Reopen. An action that is not legal from the current status is not
 * rendered at all, so there is no disabled control left to explain.
 *
 * US-23.11 AC1 (PO decision) removed the identity gate that used to sit here.
 * It bought nothing on a local extension whose author name is free text, and it
 * was inverted: because the recorded author is the Reviewer who filed the
 * thread, a Reviewer whose thread the Author had Closed was left with no reply
 * box, no Reopen, and only "delete the whole thread" as an exit.
 */
function statusActionsFor(status: ThreadAnchor['status']): StatusAction[] {
  if (status === 'Open') {
    return [{ action: 'resolve', label: 'Mark as Resolved', primary: true }];
  }
  const reopen: StatusAction = { action: 'reopen', label: 'Reopen', primary: status === 'Closed' };
  if (status === 'Closed') {
    return [reopen];
  }
  return [{ action: 'close', label: 'Close', primary: true }, reopen];
}

function formatTimestamp(iso: string): string {
  if (iso === '') {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The exact anchored substring a comment refers to — '' for a bare-caret anchor (no quote to show). */
function anchorQuote(anchor: ThreadAnchor): string {
  return anchor.recordedText.slice(anchor.offsetStart, anchor.offsetEnd).trim();
}

export function initCommentPopover(
  vscode: VsCodeApi,
  resolve: CommentResolveController,
  highlight: CommentHighlightController
): CommentPopoverController {
  let docUri = '';
  let authorName = '';
  let currentThreadId: string | undefined;
  let requestSeq = 0;
  let inFlightReplyRequest: number | undefined;
  /** AC3(i): released if `replyResult` never arrives — a host-busy/disposed-panel/dropped-message never leaves this dead for the session. */
  let replyTimeoutHandle: number | undefined;
  let inFlightDeleteRequest: number | undefined;
  /** Which reply (its durable id), or 'thread' for the thread itself, the in-flight delete targets — released on either outcome. */
  let inFlightDeleteTarget: string | 'thread' | undefined;
  // The thread each in-flight request was made FOR. `requestId` alone is not
  // enough: the card is a single reused instance, so a result that lands after
  // the user opened a different thread would clear THAT thread's draft or close
  // its popover. Recorded here and re-checked before any UI mutation.
  let inFlightReplyThread: string | undefined;
  let inFlightDeleteThread: string | undefined;
  /** US-23.3: the one in-flight Resolve/Close/Reopen, so a double-click can't append two lines. */
  let inFlightStatusRequest: number | undefined;
  /** Whether Cancel has collapsed the reply composer for the open thread. */
  let replyCollapsed = false;

  // US-23.14: only one edit FIELD is open at a time in this single-instance
  // popover, but saves are tracked PER TARGET (`inFlightEdits` below) — AC6
  // requires that an in-flight edit on one comment never block a different
  // comment's edit, and a field can be closed (or its thread switched away
  // from) while its own save is still with the host.
  let editingOpen = false;
  /** `undefined` = editing the thread's own opening comment; else that reply's durable id. */
  let editingReplyId: string | undefined;
  let editingThreadId: string | undefined;
  let editingDraftText = '';
  /**
   * The field's caret/selection, carried across a `render()` rebuild. Unlike the
   * reply box — a persistent element `render` never touches — the edit field
   * lives INSIDE `list`, which every render clears and rebuilds. Without this
   * the caret would jump to the end of the text on every settled re-resolution
   * pass (`resolve.onChange`) while the user is mid-sentence.
   */
  let editingCaretStart = 0;
  let editingCaretEnd = 0;
  /** Whether the rebuilt field should reclaim focus — true on open, and whenever it held focus before the rebuild. */
  let editFocusPending = false;
  /**
   * The length ceiling for the field currently open: the shared cap, or the
   * body's own already-over-cap length when it has one. Set per `startEdit`.
   */
  let editingCapCeiling = COMMENT_BODY_MAX_CODEPOINTS;
  let editError = '';
  /**
   * One in-flight save per TARGET, keyed by `editTargetKey`. AC6: the guard is
   * "keyed per target being edited" — an in-flight edit on one comment can
   * never block or release a different comment's edit (nor a reply, which has
   * its own separate guard). A single scalar could not express that: the user
   * can save on thread A, switch to B, and legitimately save B before A's
   * result lands.
   *
   * Each entry also remembers WHICH target it is for, so a result can be
   * matched back to it by `requestId` alone and surfaced only if that exact
   * target's field is still the one on screen.
   */
  const inFlightEdits = new Map<string, { requestId: number; timeout: number; thread: string; replyId: string | undefined }>();

  const card = el('div', COMMENT_POPOVER_CLASS);
  card.hidden = true;
  card.setAttribute('role', 'dialog');

  const header = el('div', 'comment-popover-header');
  const headerTitle = el('span', 'comment-popover-title', 'Comment thread');
  const headerLine = el('span', 'comment-popover-line');
  const statusPill = el('span', 'comment-popover-status');
  // AC2: tier 3/4 anchors are never silently indistinguishable from an exact
  // one on this surface — the requirement's own wording, matching the native
  // `vscode.comments` surface (US-23.4 AC3) and the Comment tab's anchor pill
  // (US-23.9 AC6).
  const anchorStateNote = el('span', 'comment-popover-anchor-state');
  anchorStateNote.hidden = true;
  header.append(headerTitle, headerLine, statusPill, anchorStateNote);

  const quoteRow = el('div', 'comment-popover-quote');
  const quoteText = el('div', 'comment-popover-quote-text');
  quoteRow.appendChild(quoteText);

  const list = el('div', 'comment-popover-list');

  const replyInput = document.createElement('textarea');
  replyInput.className = COMMENT_REPLY_INPUT_CLASS;
  replyInput.rows = 3;
  replyInput.placeholder = 'Reply — required';
  replyInput.setAttribute('aria-label', 'Reply text');

  const replyBox = el('div', 'comment-popover-reply-box');
  // US-23.10 AC5: a refusal is shown INLINE here (never a toast), and keeps
  // the typed draft — mirrors the composer's own `comment-composer-error`.
  const replyError = el('div', 'comment-popover-reply-error');
  replyError.hidden = true;
  replyError.setAttribute('role', 'alert');
  const replyActions = el('div', 'comment-popover-reply-actions');
  const replyCancel = el('button', 'comment-popover-reply-cancel', 'Cancel');
  replyCancel.type = 'button';
  const replySubmit = el('button', 'comment-popover-reply-submit', 'Submit');
  replySubmit.type = 'button';
  replyActions.append(replyCancel, replySubmit);
  replyBox.append(replyInput, replyError, replyActions);

  // Re-opens the reply box after Cancel collapsed it (AC6: Cancel "discards the
  // draft and closes the input") — without this the user would have to close and
  // re-open the whole popover to reply.
  const replyOpen = el('button', 'comment-popover-reply-open', 'Reply');
  replyOpen.type = 'button';

  const closedNotice = el('div', 'comment-popover-closed-notice', 'This thread is closed');

  // Req 24 US-23.8 AC4: a Close landing while a draft is open must never drop
  // it — this transient notice sits ABOVE the still-visible, still-editable
  // replyBox instead of the permanent `closedNotice` replacing it outright.
  // Cleared the moment the thread leaves Closed (Reopen) or the draft itself
  // is cleared (Cancel, or a successful submit).
  const closedWhileDraftNotice = el('div', 'comment-popover-closed-while-draft', 'This thread was just closed — your reply has not been sent.');
  closedWhileDraftNotice.hidden = true;
  closedWhileDraftNotice.setAttribute('role', 'status');

  // AC2: a passive strip, directly under the header as in the design. No button
  // and no dismiss — it is recomputed from the anchor on every render, so it
  // leaves on its own once the text matches again and returns if it drifts later.
  const driftStrip = el('div', COMMENT_DRIFT_STRIP_CLASS);
  driftStrip.hidden = true;
  driftStrip.setAttribute('role', 'status');

  // US-23.11 AC2: the thread's full transition trail, one row per applied
  // `status-change`, above the action bar. A list rather than the single
  // right-aligned note the design shows, because a reader has to be able to tell
  // a Resolve and a Close made by two different people from one person doing
  // both. Hidden until the thread has actually left Open.
  const transitionList = el('ul', 'comment-popover-transitions');
  transitionList.hidden = true;

  // AC1/AC5: Mark as Resolved / Close / Reopen, plus the hint shown while the
  // thread has no transitions to list yet.
  const actionBar = el('div', COMMENT_ACTION_BAR_CLASS);
  const actionNote = el('span', 'comment-popover-action-note');

  // --- Delete confirmation (its own small popover, nested lifecycle) ---------
  //
  // Appended as a CHILD of `card`, not a body-level sibling: `initPopoverDismiss`'s
  // outside-mousedown check tests `card.contains(target)`, so a sibling dialog's
  // own buttons would read as "outside the card" and close the whole popover out
  // from under a click before its own handler ever ran. Nesting it keeps that
  // check true while `position: fixed` (set by `positionNear`) still positions it
  // independently of the card's own box.
  const confirmDialog = el('div', COMMENT_DELETE_CONFIRM_CLASS);
  confirmDialog.hidden = true;
  confirmDialog.setAttribute('role', 'alertdialog');
  // NESTED_POPUP so Escape cancels this inner dialog, not the card hosting it.
  const confirmDismiss = initPopoverDismiss(
    confirmDialog,
    () => {
      confirmDialog.textContent = '';
    },
    ESCAPE_PRIORITY.NESTED_POPUP
  );

  card.append(
    header,
    driftStrip,
    quoteRow,
    list,
    closedWhileDraftNotice,
    replyBox,
    replyOpen,
    closedNotice,
    transitionList,
    actionBar,
    confirmDialog
  );
  document.body.appendChild(card);

  function openConfirm(message: string, anchorRect: DOMRect, onConfirm: () => void): void {
    confirmDialog.textContent = '';
    confirmDialog.appendChild(el('div', 'comment-delete-confirm-message', message));
    const actions = el('div', 'comment-delete-confirm-actions');
    const cancelBtn = el('button', 'comment-delete-confirm-cancel', 'Cancel');
    cancelBtn.type = 'button';
    const deleteBtn = el('button', 'comment-delete-confirm-delete', 'Delete');
    deleteBtn.type = 'button';
    cancelBtn.addEventListener('click', () => confirmDismiss.close());
    deleteBtn.addEventListener('click', () => {
      confirmDismiss.close();
      onConfirm();
    });
    actions.append(cancelBtn, deleteBtn);
    confirmDialog.appendChild(actions);
    confirmDialog.hidden = false;
    positionNear(confirmDialog, anchorRect);
    confirmDismiss.arm();
  }

  // --- Dismiss lifecycle -------------------------------------------------------

  /** Where focus goes when this popover closes — set per open (US-23.9 rows). */
  let focusOnClose: HTMLElement | undefined;

  const cardDismiss = initPopoverDismiss(card, () => {
    currentThreadId = undefined;
    highlight.setActiveThread(undefined);
    confirmDismiss.close();
    const returnTo = focusOnClose;
    focusOnClose = undefined;
    // Only reclaim focus the popover actually held: closing from a click
    // elsewhere would otherwise steal it from whatever the user just clicked.
    if (returnTo?.isConnected === true && card.contains(document.activeElement)) {
      returnTo.focus();
    }
  });

  /**
   * Req 24 US-23.8 AC4: a thread (or its parent comment) deleted while this
   * popover is open must never close silently — state it in a toast. Guarded
   * on `card.hidden` since both `resolve.onChange`'s `!anchor` branch and
   * `forgetThreads` can observe the SAME deletion off the same sync and would
   * otherwise toast twice; `cardDismiss.close()` itself is a no-op once the
   * card is already hidden, so only the first caller ever gets here.
   */
  function closeForDeletion(): void {
    if (card.hidden) {
      return;
    }
    cardDismiss.close();
    showToast('This thread was deleted.');
  }

  /** Bring the anchored range into view first if it is off-screen (AC: "unfolding/scrolling ... into view"). */
  function revealIfNeeded(target: HTMLElement): void {
    const rect = target.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      target.scrollIntoView({ block: 'center' });
    }
  }

  // --- Rendering ---------------------------------------------------------------

  /**
   * The avatar/author/time header every row starts with — shared by the static
   * row and US-23.14's edit row so the two cannot drift (and so the identical
   * block is not duplicated, which `check:duplication` would flag).
   */
  function personMeta(author: string, timestamp: string): HTMLElement {
    const meta = el('div', 'comment-popover-person-meta');
    // First CODE POINT, not `author[0]`: an emoji-first name would otherwise be
    // split mid-surrogate-pair and render as a replacement char.
    const initial = Array.from(author)[0] ?? '?';
    const avatar = el('span', 'comment-popover-avatar', initial.toUpperCase());
    meta.append(
      avatar,
      el('span', 'comment-popover-author', author),
      el('span', 'comment-popover-time', formatTimestamp(timestamp))
    );
    return meta;
  }

  function rememberEditCaret(input: HTMLTextAreaElement): void {
    editingCaretStart = input.selectionStart ?? input.value.length;
    editingCaretEnd = input.selectionEnd ?? editingCaretStart;
  }

  /** US-23.14 AC4: "edited ⟨timestamp⟩" marker text, or '' when never edited. */
  function editedMarker(editedAt: string | undefined): string {
    if (editedAt === undefined) {
      return '';
    }
    const t = formatTimestamp(editedAt);
    // AC4: "an edit is never silently indistinguishable from the original text".
    // A hand-edited or merge-mangled sidecar can carry an empty/unparseable
    // stamp, and `formatTimestamp` returns '' for those — dropping the marker
    // entirely would hide the edit, so mark it without a time instead.
    return t ? `edited ${t}` : 'edited';
  }

  function personRow(
    className: string,
    author: string,
    timestamp: string,
    body: string,
    editedAt: string | undefined,
    onDelete: (() => void) | undefined,
    onEdit: (() => void) | undefined
  ): HTMLElement {
    const row = el('div', className);
    const meta = personMeta(author, timestamp);
    const marker = editedMarker(editedAt);
    if (marker !== '') {
      meta.appendChild(el('span', 'comment-popover-edited', marker));
    }
    // AC8: Edit carries no authority check — offered to whoever is at the
    // keyboard, unlike Delete below. `onEdit` is undefined only when the
    // thread is Closed (mirrors `replyBox.hidden = closed`'s gating), never by
    // authorship.
    if (onEdit) {
      const editBtn = el('button', 'comment-popover-edit', '');
      editBtn.type = 'button';
      editBtn.setAttribute('aria-label', 'Edit');
      editBtn.title = 'Edit';
      editBtn.textContent = '✎';
      editBtn.addEventListener('click', onEdit);
      meta.appendChild(editBtn);
    }
    // AC5: the Delete control is DISABLED (a visible soft nudge showing the
    // content isn't yours), not removed — the real enforcement is the host's
    // author check in `deleteRejection`, not this button's state.
    const deleteBtn = el('button', 'comment-popover-delete', '');
    deleteBtn.type = 'button';
    deleteBtn.setAttribute('aria-label', 'Delete');
    deleteBtn.textContent = '🗑';
    if (onDelete) {
      deleteBtn.title = 'Delete';
      deleteBtn.addEventListener('click', onDelete);
    } else {
      deleteBtn.disabled = true;
      deleteBtn.setAttribute('aria-disabled', 'true');
      deleteBtn.title = 'Only the author of this content can delete it';
    }
    meta.appendChild(deleteBtn);
    row.appendChild(meta);
    row.appendChild(el('div', 'comment-popover-body-text', body));
    return row;
  }

  /**
   * US-23.14 AC1: the editable field replacing a row's body — reuses the reply
   * `<textarea>` pattern (its own native undo history) pre-filled with the
   * post-fold displayed text via the closure-held `editingDraftText`, which
   * survives a `render()` re-run triggered by anything else changing
   * (AC1's "not force-refreshed" sub-criterion) since it is read back in here
   * rather than reset.
   */
  function personEditRow(
    className: string,
    author: string,
    timestamp: string,
    threadId: string,
    replyId: string | undefined
  ): HTMLElement {
    const row = el('div', className);
    row.appendChild(personMeta(author, timestamp));

    const input = document.createElement('textarea');
    input.className = COMMENT_EDIT_INPUT_CLASS;
    input.rows = 3;
    input.setAttribute('aria-label', 'Edit comment text');
    input.value = editingDraftText;
    input.readOnly = isEditBusy();

    const errorEl = el('div', 'comment-popover-edit-error');
    errorEl.setAttribute('role', 'alert');
    errorEl.hidden = editError === '';
    if (editError !== '') {
      errorEl.textContent = editError;
    }

    const counter = el('span', 'comment-popover-edit-counter');
    const actions = el('div', 'comment-popover-edit-actions');
    const cancelBtn = el('button', 'comment-popover-edit-cancel', 'Cancel');
    cancelBtn.type = 'button';
    const saveBtn = el('button', 'comment-popover-edit-save', 'Save');
    saveBtn.type = 'button';
    actions.append(counter, cancelBtn, saveBtn);

    function refreshCounter(): void {
      const len = commentBodyCodePointLength(input.value);
      counter.hidden = len < COMMENT_BODY_COUNTER_THRESHOLD;
      counter.textContent = `${len}/${COMMENT_BODY_MAX_CODEPOINTS}`;
    }
    function refreshSaveState(): void {
      saveBtn.setAttribute('aria-disabled', String(isEditBusy() || input.value.trim() === ''));
    }

    input.addEventListener('input', () => {
      // AC7 sub-criterion: paste-clipping, code-point-safe — bounded by
      // `editingCapCeiling`, never below the length the body ALREADY had.
      // US-23.10 AC10 has not shipped, so an over-cap comment can exist;
      // clipping it to 4000 on the first keystroke would silently destroy
      // content this editor did not write (AC8 lets anyone edit anyone's).
      // Mirrors `editRejection`'s identical ceiling host-side.
      const clipped = clipCommentBodyToLimit(input.value, editingCapCeiling);
      if (clipped !== input.value) {
        const pos = Math.min(input.selectionStart ?? clipped.length, clipped.length);
        input.value = clipped;
        input.setSelectionRange(pos, pos);
      }
      editingDraftText = input.value;
      rememberEditCaret(input);
      refreshCounter();
      refreshSaveState();
    });
    // A click/arrow-key move is not an `input` event, so the caret is recorded
    // on selection changes too — otherwise a render mid-navigation would snap it
    // back to wherever the last keystroke left it.
    input.addEventListener('keyup', () => rememberEditCaret(input));
    input.addEventListener('mouseup', () => rememberEditCaret(input));
    cancelBtn.addEventListener('click', () => cancelEdit());
    saveBtn.addEventListener('mousedown', (e) => e.preventDefault());
    saveBtn.addEventListener('click', () => submitEdit(threadId, replyId, input.value));

    row.appendChild(input);
    row.appendChild(errorEl);
    refreshCounter();
    refreshSaveState();
    row.appendChild(actions);
    return row;
  }

  function requestDeleteThread(anchor: ThreadAnchor, anchorRect: DOMRect): void {
    if (inFlightDeleteRequest !== undefined) {
      return;
    }
    // Req 24 US-23.13 AC3: only a delete opened against a FLOATING thread needs
    // re-validation — an ordinary attached-thread delete is unaffected and must
    // keep working exactly as before.
    const wasFloating = anchor.state === 'floating';
    openConfirm('Delete this comment thread and all its replies?', anchorRect, () => {
      // The confirm dialog can sit open across an async state push (AC2's
      // floating→resolved auto-promotion, or a manual re-attach elsewhere) that
      // `resolve.onChange` already re-renders the popover for — but not this
      // dialog, whose `onConfirm` closure still holds the anchor as it was when
      // the dialog opened. Re-read the LIVE anchor here rather than trusting it:
      // if the thread left floating in that window, the confirmation is stale —
      // drop it instead of deleting a thread that just found its place. The
      // popover underneath already reflects the new state (the same onChange
      // pass that moved it also re-rendered `render(anchor)`), so nothing further
      // is needed to "refresh the surface".
      if (wasFloating && resolve.anchorOf(anchor.threadId)?.state !== 'floating') {
        return;
      }
      const requestId = ++requestSeq;
      inFlightDeleteRequest = requestId;
      inFlightDeleteTarget = 'thread';
      inFlightDeleteThread = anchor.threadId;
      vscode.postMessage({ type: 'deleteComment', requestId, docUri, threadId: anchor.threadId });
    });
  }

  function requestDeleteReply(anchor: ThreadAnchor, replyId: string, anchorRect: DOMRect): void {
    if (inFlightDeleteRequest !== undefined) {
      return;
    }
    openConfirm('Delete this reply?', anchorRect, () => {
      const requestId = ++requestSeq;
      inFlightDeleteRequest = requestId;
      inFlightDeleteTarget = replyId;
      inFlightDeleteThread = anchor.threadId;
      vscode.postMessage({ type: 'deleteComment', requestId, docUri, threadId: anchor.threadId, targetReplyId: replyId });
    });
  }

  /**
   * US-23.3: ask the host for a transition. The status the popover shows is never
   * changed here — it comes back through `commentThreadsSync` once the sidecar
   * line is durable, so a refused or failed transition can never leave the UI
   * claiming a state the file does not hold.
   */
  function requestChangeStatus(threadId: string, action: CommentStatusAction): boolean {
    if (inFlightStatusRequest !== undefined) {
      // US-23.11 AC7: a second click while the first transition is still with the
      // host is a no-op, not a second `status-change` line. The host carries the
      // same guard for the cross-surface race the popover cannot see.
      return false;
    }
    const requestId = ++requestSeq;
    inFlightStatusRequest = requestId;
    vscode.postMessage({ type: 'changeCommentStatus', requestId, docUri, threadId, action });
    return true;
  }

  /** AC1/AC5: the action bar for the thread being rendered. */
  function renderActionBar(anchor: ThreadAnchor): void {
    actionBar.textContent = '';
    for (const item of statusActionsFor(anchor.status)) {
      const button = el(
        'button',
        `comment-popover-action comment-popover-action-${item.action}${item.primary ? ' is-primary' : ''}`,
        item.label
      );
      button.type = 'button';
      button.addEventListener('click', () => requestChangeStatus(anchor.threadId, item.action));
      actionBar.appendChild(button);
    }
    // The trail below carries every transition, so the note is only the design's
    // hint for a thread that has none yet.
    actionNote.textContent = anchor.statusChanges.length === 0 ? 'Moves the thread to Resolved' : '';
    actionBar.appendChild(actionNote);
  }

  /**
   * US-23.11 AC2: one row per applied transition, in fold order —
   * `<to_status> · <author> · <timestamp>`.
   *
   * `toStatus` is rendered as the ACTION that produced it, not as the bare
   * status: "Open by X" reads as authorship rather than as a reopen. A blank
   * author (a transition taken before the name setting was filled in) reads as
   * `Unknown` rather than leaving a dangling separator.
   */
  function renderTransitions(anchor: ThreadAnchor): void {
    transitionList.textContent = '';
    transitionList.hidden = anchor.statusChanges.length === 0;
    for (const transition of anchor.statusChanges) {
      const what = transition.toStatus === 'Open' ? 'Reopened' : transition.toStatus;
      const when = formatTimestamp(transition.timestamp);
      const who = transition.author.trim() === '' ? 'Unknown' : transition.author;
      transitionList.appendChild(
        el('li', 'comment-popover-transition', `${what} · ${who}${when ? ` · ${when}` : ''}`)
      );
    }
  }

  function render(anchor: ThreadAnchor): void {
    headerLine.textContent = anchor.lastKnownLine > 0 ? `Ln ${anchor.lastKnownLine}` : '';
    statusPill.textContent = anchor.status;
    statusPill.className = `comment-popover-status status-${anchor.status.toLowerCase()}`;
    anchorStateNote.hidden = anchor.state === 'exact';
    anchorStateNote.textContent =
      anchor.state === 'floating' ? 'Unresolved location' : 'Approximate location';

    const quote = anchorQuote(anchor);
    quoteRow.hidden = quote === '';
    quoteText.textContent = quote ? `“${quote}”` : '';

    // Captured BEFORE the rebuild below destroys the node: if the edit field
    // held focus, the rebuilt one must reclaim it (and its caret), otherwise a
    // settled re-resolution pass would drop the user out of the field mid-word.
    const editFieldHadFocus =
      document.activeElement instanceof HTMLTextAreaElement &&
      document.activeElement.classList.contains(COMMENT_EDIT_INPUT_CLASS);
    if (editFieldHadFocus) {
      editFocusPending = true;
    }

    list.textContent = '';
    const ownsComment = authorName !== '' && sameAuthor(authorName, anchor.author);
    // AC1 sub-criterion: Edit is gated on thread status exactly like Reply —
    // not offered at all on a Closed thread.
    const editGated = anchor.status === 'Closed';
    let editingThisThread = editingOpen && editingThreadId === anchor.threadId;
    if (editingThisThread && editGated) {
      // The lockout applies to a field that is ALREADY open, not just to the
      // button: a Close landing from another panel or the native UI would
      // otherwise leave a live, Save-armed field the host is bound to refuse.
      // The in-flight guard is deliberately NOT released — if a save for this
      // target is still with the host, its result must still find a home (a
      // toast, via `editFieldStillOn`) rather than be dropped silently.
      resetEditState();
      editingThisThread = false;
      showToast('This thread was closed — editing is no longer available.');
    }
    if (editingThisThread && editingReplyId === undefined) {
      list.appendChild(personEditRow('comment-popover-original', anchor.author, anchor.createdAt, anchor.threadId, undefined));
    } else {
      list.appendChild(
        personRow(
          'comment-popover-original',
          anchor.author,
          anchor.createdAt,
          anchor.body,
          anchor.editedAt,
          ownsComment ? () => requestDeleteThread(anchor, list.getBoundingClientRect()) : undefined,
          editGated ? undefined : () => startEdit(anchor.threadId, undefined, anchor.body)
        )
      );
    }
    for (const reply of anchor.replies) {
      if (editingThisThread && editingReplyId === reply.id) {
        const row = personEditRow('comment-popover-reply', reply.author, reply.timestamp, anchor.threadId, reply.id);
        row.dataset.replyId = reply.id;
        list.appendChild(row);
        continue;
      }
      const ownsReply = authorName !== '' && sameAuthor(authorName, reply.author);
      const row = personRow(
        'comment-popover-reply',
        reply.author,
        reply.timestamp,
        reply.body,
        reply.editedAt,
        ownsReply ? () => requestDeleteReply(anchor, reply.id, list.getBoundingClientRect()) : undefined,
        editGated ? undefined : () => startEdit(anchor.threadId, reply.id, reply.body)
      );
      // Distinguishes replies whose rendered text happens to be a substring of
      // one another — not something a display-only class/text query can do.
      row.dataset.replyId = reply.id;
      list.appendChild(row);
    }
    if (editingThisThread) {
      const stillExists = editingReplyId === undefined || anchor.replies.some((r) => r.id === editingReplyId);
      if (!stillExists) {
        // AC1 sub-criterion: the target vanished (deleted directly, or via a
        // cascading thread delete) while the field was open — close it with a
        // stated notice instead of leaving stale state around.
        resetEditState();
        showToast('This comment was deleted.');
      } else if (editFocusPending) {
        editFocusPending = false;
        const input = list.querySelector<HTMLTextAreaElement>(`.${COMMENT_EDIT_INPUT_CLASS}`);
        if (input) {
          input.focus();
          const max = input.value.length;
          input.setSelectionRange(Math.min(editingCaretStart, max), Math.min(editingCaretEnd, max));
        }
      }
    }

    // Replying is blocked while the thread is Closed (US-23.3) — the popover
    // shows a notice instead of the reply box, unless AC4's protected-draft
    // case applies (an open draft or an in-flight submit survives the Close).
    const closed = anchor.status === 'Closed';
    applyReplyVisibility(closed);

    // AC2: live and derived. Suppressed once the thread reaches Resolved/Closed —
    // the suggestion has either been acted on or the thread is a record now.
    const suggestResolve = anchor.contentDrifted && anchor.status === 'Open';
    driftStrip.hidden = !suggestResolve;
    // US-23.11 AC1: Resolve is offered to whoever is at the keyboard, so the
    // invitation is no longer conditioned on owning the comment.
    const driftText = suggestResolve ? 'The commented text may have changed — mark as resolved?' : '';
    if (driftStrip.textContent !== driftText) {
      // Assigned only on a real change: `render` runs on every settled pass, and
      // this is an `aria-live` region — reassigning the same string re-announces
      // it to a screen reader on every keystroke burst.
      driftStrip.textContent = driftText;
    }
    renderTransitions(anchor);
    renderActionBar(anchor);
  }

  /** US-23.10 AC5: while a reply is in flight, the input is read-only and Submit inert — never after a refusal, which re-arms both. */
  let replyBusy = false;

  /** Req 24 US-23.8 AC4: unsubmitted text sitting in an open composer. */
  function hasProtectedDraft(): boolean {
    return !replyCollapsed && replyInput.value.trim() !== '';
  }

  /**
   * The reply affordance is a four-way state: the permanent notice (thread
   * Closed, nothing to protect), the AC4 protected-draft state (thread Closed
   * but the box stays visible+editable with Submit disabled and a transient
   * notice above it), the open composer, or the collapsed "Reply" button once
   * Cancel discarded a draft.
   */
  function applyReplyVisibility(closed: boolean): void {
    if (replyBusy) {
      // Req 24 US-23.8 AC4: a submit already in flight is never interrupted by
      // a concurrent Close — it stays a normal in-flight composer, and no
      // closed-related notice appears until its OWN result (notifyReplyResult)
      // decides the outcome and re-runs this function.
      replyBox.hidden = replyCollapsed;
      replyOpen.hidden = !replyCollapsed;
      closedNotice.hidden = true;
      closedWhileDraftNotice.hidden = true;
      syncSubmitState();
      return;
    }
    const protectedDraft = closed && hasProtectedDraft();
    replyBox.hidden = (closed && !protectedDraft) || replyCollapsed;
    replyOpen.hidden = closed || !replyCollapsed;
    closedNotice.hidden = !closed || protectedDraft;
    closedWhileDraftNotice.hidden = !protectedDraft;
    syncSubmitState();
  }

  function showReplyError(message: string): void {
    replyError.textContent = message;
    replyError.hidden = false;
  }

  function clearReplyError(): void {
    replyError.hidden = true;
    replyError.textContent = '';
  }

  /**
   * Cancel: discard the draft AND close the input (AC6), appending no sidecar
   * line. Req 24 US-23.8 AC3(i): if THIS thread's reply is still in flight,
   * abandon it here too — otherwise Cancel leaves `inFlightReplyRequest` set
   * with no visible box to show a late result in (a failure would land
   * silently inside the now-hidden `replyBox`), and blocks a fresh Submit for
   * up to the timeout's full duration. A late `notifyReplyResult`/timeout for
   * the abandoned request is a safe no-op once released (its `requestId` no
   * longer matches anything in flight) — the write, if it succeeds host-side,
   * still reaches this thread through the next `commentThreadsSync`.
   */
  function closeReplyDraft(): void {
    if (inFlightReplyRequest !== undefined && inFlightReplyThread === currentThreadId) {
      releaseReplyGuard();
    }
    replyInput.value = '';
    replyCollapsed = true;
    clearReplyError();
    const anchor = currentThreadId ? resolve.anchorOf(currentThreadId) : undefined;
    applyReplyVisibility(anchor?.status === 'Closed');
  }

  function syncSubmitState(): void {
    // Req 24 US-23.8 AC4: Submit stays disabled while the thread is Closed,
    // even in the protected-draft case — reopening is what re-enables it.
    const anchor = currentThreadId ? resolve.anchorOf(currentThreadId) : undefined;
    const closed = anchor?.status === 'Closed';
    const ready = !replyBusy && !closed && replyInput.value.trim() !== '';
    replySubmit.setAttribute('aria-disabled', String(!ready));
  }

  /** AC3(i): clears the in-flight state and its timeout, whatever released it (a result or a timeout). */
  function releaseReplyGuard(): void {
    if (replyTimeoutHandle !== undefined) {
      window.clearTimeout(replyTimeoutHandle);
      replyTimeoutHandle = undefined;
    }
    inFlightReplyRequest = undefined;
    inFlightReplyThread = undefined;
    replyBusy = false;
    replyInput.readOnly = false;
  }

  /**
   * AC3(i): `replyResult` never arrived. Same surfacing rule `notifyReplyResult`
   * uses below — inline on the thread whose box is still showing, a toast if the
   * user has since moved to another thread. A `replyResult` that does arrive
   * after this fires is for a request id that no longer matches anything
   * in-flight, so `notifyReplyResult`'s own guard drops it as a harmless no-op —
   * the reply itself is not lost, since a successful host-side append still
   * reaches this thread through the next `commentThreadsSync` push regardless.
   */
  function handleReplyTimeout(requestId: number, forThread: string): void {
    if (requestId !== inFlightReplyRequest) {
      return;
    }
    releaseReplyGuard();
    const message = 'No response from the host — the reply may not have been saved. Try again.';
    if (forThread !== currentThreadId) {
      showToast(message);
      return;
    }
    showReplyError(message);
    // Req 24 US-23.8 AC4: same reasoning as `notifyReplyResult`'s failure
    // branch — `replyBusy` just cleared, so this reveals a "just closed"
    // notice if a concurrent Close landed while the request was stuck.
    const anchor = resolve.anchorOf(forThread);
    applyReplyVisibility(anchor?.status === 'Closed');
  }

  function submitReply(): void {
    const threadId = currentThreadId;
    const anchor = threadId ? resolve.anchorOf(threadId) : undefined;
    const body = replyInput.value.trim();
    if (!threadId || !anchor || body === '' || inFlightReplyRequest !== undefined) {
      return;
    }
    if (anchor.status === 'Closed') {
      showToast('This thread is closed — reopen it before replying.');
      return;
    }
    clearReplyError();
    const requestId = ++requestSeq;
    inFlightReplyRequest = requestId;
    inFlightReplyThread = threadId;
    replyBusy = true;
    replyInput.readOnly = true;
    replyTimeoutHandle = window.setTimeout(
      () => handleReplyTimeout(requestId, threadId),
      COMMENT_REPLY_RESULT_TIMEOUT_MS
    );
    syncSubmitState();
    // US-23.10 AC9: same neutralize + CRLF->LF treatment as a new comment's
    // body, applied here since a reply is authored the same way. EOL first —
    // see the matching comment in comment-menu.ts's `submit`.
    vscode.postMessage({
      type: 'replyToComment',
      requestId,
      docUri,
      threadId,
      body: neutralizeBodyText(normalizeBodyEol(body)),
    });
  }

  // --- US-23.14: edit an already-posted comment or reply ----------------------

  /** The `inFlightEdits` key for one target. `\0` cannot occur in a durable id, so the two halves can never run together ambiguously. */
  function editTargetKey(thread: string | undefined, replyId: string | undefined): string {
    return `${thread ?? ''}\0${replyId ?? ''}`;
  }

  function inFlightEditByRequest(requestId: number): { requestId: number; thread: string; replyId: string | undefined } | undefined {
    for (const entry of inFlightEdits.values()) {
      if (entry.requestId === requestId) {
        return entry;
      }
    }
    return undefined;
  }

  /** Whether the OPEN field's own save is in flight — what makes it read-only and its Save inert. */
  function isEditBusy(): boolean {
    return inFlightEdits.has(editTargetKey(editingThreadId, editingReplyId));
  }

  /** Closes the FIELD only — never touches `inFlightEdits`, so a save already sent still resolves and surfaces. */
  function resetEditState(): void {
    editingOpen = false;
    editingReplyId = undefined;
    editingThreadId = undefined;
    editingDraftText = '';
    editingCaretStart = 0;
    editingCaretEnd = 0;
    editFocusPending = false;
    editError = '';
  }

  /** AC6 sub: clears ONE target's in-flight entry and its timeout, whatever released it. */
  function releaseEditGuard(key: string): void {
    const entry = inFlightEdits.get(key);
    if (!entry) {
      return;
    }
    window.clearTimeout(entry.timeout);
    inFlightEdits.delete(key);
  }

  /**
   * Whether the field currently on screen is open on the exact target a
   * just-resolved request was for — the only case an inline surface belongs to
   * it. Anything else (the user switched threads, switched targets, or closed
   * the field) falls back to a toast, mirroring `notifyReplyResult`.
   */
  function editFieldStillOn(thread: string | undefined, replyId: string | undefined): boolean {
    return editingOpen && editingThreadId === thread && editingReplyId === replyId && thread === currentThreadId;
  }

  /** Re-render whichever thread is open, when there is one. */
  function rerenderOpenThread(): void {
    const anchor = currentThreadId ? resolve.anchorOf(currentThreadId) : undefined;
    if (anchor) {
      render(anchor);
    }
  }

  /**
   * Open (or retarget) the edit field for one comment/reply. `replyId`
   * undefined targets the thread's own opening comment. Only one field is open
   * at a time; re-opening the field for a target whose OWN save is still in
   * flight is ignored (there is nothing to type into it yet), while a different
   * target's in-flight save never blocks this one (AC6).
   */
  function startEdit(threadId: string, replyId: string | undefined, currentBody: string): void {
    if (inFlightEdits.has(editTargetKey(threadId, replyId))) {
      return;
    }
    editingOpen = true;
    editingReplyId = replyId;
    editingThreadId = threadId;
    editingDraftText = currentBody;
    // Caret at the end of the pre-filled text — the field opens ready to type.
    editingCaretStart = currentBody.length;
    editingCaretEnd = currentBody.length;
    editFocusPending = true;
    editingCapCeiling = Math.max(COMMENT_BODY_MAX_CODEPOINTS, commentBodyCodePointLength(currentBody));
    editError = '';
    const anchor = resolve.anchorOf(threadId);
    if (anchor) {
      render(anchor);
    }
  }

  /** Cancel: discard the draft and close the field, appending no sidecar line. */
  function cancelEdit(): void {
    // Scoped to THIS target's own request: releasing a DIFFERENT target's guard
    // would drop its `requestId`, and its later `editCommentResult` would match
    // nothing and be discarded silently — the user would be told nothing about
    // a refusal that really happened.
    releaseEditGuard(editTargetKey(editingThreadId, editingReplyId));
    const threadId = editingThreadId;
    resetEditState();
    const anchor = threadId ? resolve.anchorOf(threadId) : undefined;
    if (anchor) {
      render(anchor);
    }
  }

  /** AC6 sub: `editCommentResult` never arrived — same surfacing rule `handleReplyTimeout` uses. */
  function handleEditTimeout(requestId: number): void {
    const entry = inFlightEditByRequest(requestId);
    if (!entry) {
      return;
    }
    releaseEditGuard(editTargetKey(entry.thread, entry.replyId));
    const message = 'No response from the host — the edit may not have been saved. Try again.';
    if (!editFieldStillOn(entry.thread, entry.replyId)) {
      showToast(message);
      return;
    }
    editError = message;
    rerenderOpenThread();
  }

  function submitEdit(threadId: string, replyId: string | undefined, rawValue: string): void {
    // AC6: a second Save for the SAME target while its first is in flight is a
    // no-op (this is the double-click/double-Enter case). A save in flight for
    // any OTHER target is irrelevant here and must not block this one.
    if (inFlightEdits.has(editTargetKey(threadId, replyId))) {
      return;
    }
    const trimmed = rawValue.trim();
    const anchor = resolve.anchorOf(threadId);
    if (anchor?.status === 'Closed') {
      // Mirrors `submitReply`'s own Closed guard: refuse locally rather than
      // spend a round trip on a request the host is bound to refuse. Covers the
      // click that races a Close arriving between two renders.
      showToast('This thread is closed — reopen it before editing.');
      return;
    }
    if (trimmed === '') {
      editError = 'Removing all the text is what Delete is for — a comment cannot be saved empty.';
      if (anchor) {
        render(anchor);
      }
      return;
    }
    const currentBody = replyId === undefined ? anchor?.body : anchor?.replies.find((r) => r.id === replyId)?.body;
    // AC2 sub-criterion: unchanged (trimmed) text is Cancel — no message sent,
    // no line appended, no "edited" marker newly set.
    if (currentBody !== undefined && trimmed === currentBody.trim()) {
      cancelEdit();
      return;
    }
    editError = '';
    const requestId = ++requestSeq;
    inFlightEdits.set(editTargetKey(threadId, replyId), {
      requestId,
      thread: threadId,
      replyId,
      timeout: window.setTimeout(() => handleEditTimeout(requestId), COMMENT_REPLY_RESULT_TIMEOUT_MS),
    });
    if (anchor) {
      render(anchor);
    }
    // US-23.10 AC9: same neutralize + CRLF->LF treatment as a new comment's body.
    vscode.postMessage({
      type: 'editComment',
      requestId,
      docUri,
      threadId,
      targetReplyId: replyId,
      body: neutralizeBodyText(normalizeBodyEol(trimmed)),
    });
  }

  replyInput.addEventListener('input', syncSubmitState);
  replyCancel.addEventListener('click', () => {
    // Cancel discards the draft without appending any sidecar line — distinct
    // from submitting empty text, since it also discards a non-empty draft.
    closeReplyDraft();
  });
  replyOpen.addEventListener('click', () => {
    replyCollapsed = false;
    clearReplyError();
    const anchor = currentThreadId ? resolve.anchorOf(currentThreadId) : undefined;
    applyReplyVisibility(anchor?.status === 'Closed');
    replyInput.focus();
  });
  replySubmit.addEventListener('mousedown', (e) => e.preventDefault());
  replySubmit.addEventListener('click', submitReply);

  resolve.onChange(() => {
    if (!currentThreadId || card.hidden) {
      return;
    }
    const anchor = resolve.anchorOf(currentThreadId);
    if (!anchor) {
      closeForDeletion();
      return;
    }
    render(anchor);
  });

  return {
    open(threadId, anchorRect, returnFocusTo): void {
      const anchor = resolve.anchorOf(threadId);
      if (!anchor) {
        showToast('That comment no longer exists.');
        return;
      }
      focusOnClose = returnFocusTo;
      const isNewThread = currentThreadId !== threadId;
      currentThreadId = threadId;
      if (isNewThread) {
        replyInput.value = '';
        replyCollapsed = false;
        clearReplyError();
        // US-23.14: an edit field belongs to the thread it was opened
        // against — switching threads closes its LOCAL UI; an in-flight save,
        // if any, still resolves in the background and surfaces via a toast
        // (`notifyEditResult`'s `forThread !== currentThreadId` branch), same
        // as an in-flight reply. `editingThreadId` is deliberately NOT cleared:
        // it is what that branch reads to know which thread the late result
        // belonged to.
        editingOpen = false;
        editingReplyId = undefined;
        editingDraftText = '';
        editingCaretStart = 0;
        editingCaretEnd = 0;
        editFocusPending = false;
        editError = '';
      }
      // US-23.10 AC5: the shared reply box is busy/read-only only for the
      // thread whose OWN reply is actually in flight — opening a DIFFERENT
      // thread while thread A's reply is still with the host must not lock
      // thread B's draft too (the `inFlightReplyRequest` guard already blocks
      // an actual double-submit regardless of this attribute).
      replyBusy = inFlightReplyRequest !== undefined && inFlightReplyThread === threadId;
      replyInput.readOnly = replyBusy;
      syncSubmitState();
      render(anchor);
      card.hidden = false;
      // Reveal BEFORE measuring: `scrollIntoView` moves the document, and the
      // card is `position: fixed`, so positioning against the pre-scroll rect
      // left it detached from (or covering) its own anchor.
      let rect = anchorRect;
      if (anchor.carrier?.isConnected) {
        revealIfNeeded(anchor.carrier);
        rect = anchor.carrier.getBoundingClientRect();
      }
      positionNear(card, rect);
      cardDismiss.arm();
      highlight.setActiveThread(threadId);
    },
    forgetThreads(threadIds): void {
      // A thread pruned by a host snapshot (deleted here, in a second panel, or
      // from the native Comments UI) must not keep an open popover alive.
      if (currentThreadId !== undefined && threadIds.includes(currentThreadId)) {
        closeForDeletion();
      }
    },
    setDocUri(uri): void {
      docUri = uri;
    },
    setAuthorName(name): void {
      authorName = name;
    },
    notifyReplyResult(requestId, ok, error): void {
      if (requestId !== inFlightReplyRequest) {
        return;
      }
      const forThread = inFlightReplyThread;
      releaseReplyGuard();
      if (forThread !== currentThreadId) {
        // Resolved, but the user has moved to another thread — the inline
        // error surface belongs to the thread whose box is showing now, not
        // the one this result is for, so a refusal here still needs SOME
        // visible surface (US-23.10 AC5: never silent) — fall back to a toast
        // rather than dropping it, but never touch the current thread's box.
        if (!ok) {
          showToast(error ?? 'The reply could not be saved.');
        }
        return;
      }
      if (!ok) {
        // US-23.10 AC5: the reply box stays open with its text intact and the
        // reason shown inline — never a toast. Req 24 US-23.8 AC4: `replyBusy`
        // is already cleared by `releaseReplyGuard` above, so re-running
        // `applyReplyVisibility` here is what surfaces the "just closed" notice
        // if a concurrent Close landed while this request was in flight —
        // exactly the "notice appears only afterwards" case.
        showReplyError(error ?? 'The reply could not be saved.');
        const anchor = currentThreadId ? resolve.anchorOf(currentThreadId) : undefined;
        applyReplyVisibility(anchor?.status === 'Closed');
        return;
      }
      closeReplyDraft();
      // The corresponding `commentThreadsSync` push re-renders the list with
      // the new reply — no manual DOM patch needed here.
    },
    notifyDeleteResult(requestId, ok, error): void {
      if (requestId !== inFlightDeleteRequest) {
        return;
      }
      inFlightDeleteRequest = undefined;
      const target = inFlightDeleteTarget;
      inFlightDeleteTarget = undefined;
      const forThread = inFlightDeleteThread;
      inFlightDeleteThread = undefined;
      if (!ok) {
        showToast(error ?? 'That could not be deleted.');
        return;
      }
      if (target === 'thread' && forThread === currentThreadId) {
        // The whole thread is gone — nothing left to show. Guarded on the thread
        // it was deleted FOR, so a late result cannot close a different thread's
        // popover and imply that one was deleted.
        cardDismiss.close();
      }
      // A single reply delete is picked up by the next `commentThreadsSync` re-render.
    },
    notifyStatusResult(requestId, ok, error): void {
      if (requestId !== inFlightStatusRequest) {
        return;
      }
      // Released before anything else (US-23.11 AC8): the control has to be live
      // again for a retry the moment the refusal is on screen.
      inFlightStatusRequest = undefined;
      if (!ok) {
        showToast(error ?? 'That comment could not be updated.');
      }
      // On success there is nothing to patch: the host's `commentThreadsSync`
      // push carries the new status/actor/timestamp, and `resolve.onChange`
      // re-renders whichever thread is open — including the case where the user
      // moved to a different thread while this was in flight.
    },
    notifyEditResult(requestId, ok, error): void {
      // Matched back to its own target by `requestId` — several saves can be in
      // flight at once (AC6 keys them per target), so this is never "the" one.
      const entry = inFlightEditByRequest(requestId);
      if (!entry) {
        return;
      }
      const forThread = entry.thread;
      const forReplyId = entry.replyId;
      releaseEditGuard(editTargetKey(forThread, forReplyId));
      if (!editFieldStillOn(forThread, forReplyId)) {
        // Resolved, but the field this result belongs to is no longer the one on
        // screen (the user switched thread or target, or closed it) — same
        // fallback `notifyReplyResult` uses: a refusal still needs SOME visible
        // surface, but never a field that is showing a different target.
        if (!ok) {
          showToast(error ?? 'The edit could not be saved.');
        }
        return;
      }
      if (!ok) {
        // The field stays open with its typed text intact and the reason shown
        // inline — never a toast (mirrors `notifyReplyResult`'s failure branch).
        editError = error ?? 'The edit could not be saved.';
        rerenderOpenThread();
        return;
      }
      // Closed here rather than left to the follow-up `commentThreadsSync`: a
      // dropped or delayed sync would otherwise leave the field sitting open
      // over a comment that has already been saved. The sync that does arrive
      // is what swaps in the new body and its "edited" marker.
      resetEditState();
      rerenderOpenThread();
    },
  };
}
