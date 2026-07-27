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
  COMMENT_POPOVER_CLASS,
  COMMENT_REPLY_INPUT_CLASS,
} from './constants';
import { el, neutralizeBodyText, normalizeBodyEol, positionNear, showToast } from './dom-utils';
import { ESCAPE_PRIORITY, initPopoverDismiss } from './escape-stack';
import type { VsCodeApi } from './vscode-api';
import { sameAuthor } from '../../src/comments/sidecar-format';
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

  const card = el('div', COMMENT_POPOVER_CLASS);
  card.hidden = true;
  card.setAttribute('role', 'dialog');

  const header = el('div', 'comment-popover-header');
  const headerTitle = el('span', 'comment-popover-title', 'Comment thread');
  const headerLine = el('span', 'comment-popover-line');
  const statusPill = el('span', 'comment-popover-status');
  header.append(headerTitle, headerLine, statusPill);

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

  /** Bring the anchored range into view first if it is off-screen (AC: "unfolding/scrolling ... into view"). */
  function revealIfNeeded(target: HTMLElement): void {
    const rect = target.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      target.scrollIntoView({ block: 'center' });
    }
  }

  // --- Rendering ---------------------------------------------------------------

  function personRow(className: string, author: string, timestamp: string, body: string, onDelete: (() => void) | undefined): HTMLElement {
    const row = el('div', className);
    const meta = el('div', 'comment-popover-person-meta');
    // First CODE POINT, not `author[0]`: an emoji-first name would otherwise be
    // split mid-surrogate-pair and render as a replacement char.
    const initial = Array.from(author)[0] ?? '?';
    const avatar = el('span', 'comment-popover-avatar', initial.toUpperCase());
    meta.append(avatar, el('span', 'comment-popover-author', author), el('span', 'comment-popover-time', formatTimestamp(timestamp)));
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

  function requestDeleteThread(anchor: ThreadAnchor, anchorRect: DOMRect): void {
    if (inFlightDeleteRequest !== undefined) {
      return;
    }
    openConfirm('Delete this comment thread and all its replies?', anchorRect, () => {
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

    const quote = anchorQuote(anchor);
    quoteRow.hidden = quote === '';
    quoteText.textContent = quote ? `“${quote}”` : '';

    list.textContent = '';
    const ownsComment = authorName !== '' && sameAuthor(authorName, anchor.author);
    list.appendChild(
      personRow(
        'comment-popover-original',
        anchor.author,
        anchor.createdAt,
        anchor.body,
        ownsComment ? () => requestDeleteThread(anchor, list.getBoundingClientRect()) : undefined
      )
    );
    for (const reply of anchor.replies) {
      const ownsReply = authorName !== '' && sameAuthor(authorName, reply.author);
      const row = personRow(
        'comment-popover-reply',
        reply.author,
        reply.timestamp,
        reply.body,
        ownsReply ? () => requestDeleteReply(anchor, reply.id, list.getBoundingClientRect()) : undefined
      );
      // Distinguishes replies whose rendered text happens to be a substring of
      // one another — not something a display-only class/text query can do.
      row.dataset.replyId = reply.id;
      list.appendChild(row);
    }

    // Replying is blocked while the thread is Closed (US-23.3) — the popover
    // shows a notice instead of the reply box, per the AC.
    const closed = anchor.status === 'Closed';
    closedNotice.hidden = !closed;
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

  /**
   * The reply affordance is a three-way state: the notice (thread Closed), the
   * open composer, or the collapsed "Reply" button once Cancel discarded a draft.
   */
  function applyReplyVisibility(closed: boolean): void {
    replyBox.hidden = closed || replyCollapsed;
    replyOpen.hidden = closed || !replyCollapsed;
  }

  /** US-23.10 AC5: while a reply is in flight, the input is read-only and Submit inert — never after a refusal, which re-arms both. */
  let replyBusy = false;

  function showReplyError(message: string): void {
    replyError.textContent = message;
    replyError.hidden = false;
  }

  function clearReplyError(): void {
    replyError.hidden = true;
    replyError.textContent = '';
  }

  /** Cancel: discard the draft AND close the input (AC6), appending no sidecar line. */
  function closeReplyDraft(): void {
    replyInput.value = '';
    replyCollapsed = true;
    clearReplyError();
    syncSubmitState();
    const anchor = currentThreadId ? resolve.anchorOf(currentThreadId) : undefined;
    applyReplyVisibility(anchor?.status === 'Closed');
  }

  function syncSubmitState(): void {
    const ready = !replyBusy && replyInput.value.trim() !== '';
    replySubmit.setAttribute('aria-disabled', String(!ready));
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
      cardDismiss.close();
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
        cardDismiss.close();
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
      inFlightReplyRequest = undefined;
      const forThread = inFlightReplyThread;
      inFlightReplyThread = undefined;
      replyBusy = false;
      replyInput.readOnly = false;
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
        // reason shown inline — never a toast.
        showReplyError(error ?? 'The reply could not be saved.');
        syncSubmitState();
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
  };
}
