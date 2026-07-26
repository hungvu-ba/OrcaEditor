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
 * Out of scope (US-23.3, unbuilt): Resolve/Close/Reopen controls. Status is
 * shown (Open/Resolved/Closed) since `foldSidecarRecords` can in principle
 * report any of the three, but nothing in this story ever transitions one.
 */
import type { CommentHighlightController } from './comment-highlight';
import type { CommentResolveController, ThreadAnchor } from './comment-resolve';
import { COMMENT_DELETE_CONFIRM_CLASS, COMMENT_POPOVER_CLASS, COMMENT_REPLY_INPUT_CLASS } from './constants';
import { el, positionNear, showToast } from './dom-utils';
import { ESCAPE_PRIORITY, initPopoverDismiss } from './escape-stack';
import type { VsCodeApi } from './vscode-api';
import { sameAuthor } from '../../src/comments/sidecar-format';

export interface CommentPopoverController {
  /** Open (or re-focus) the popover for `threadId`, anchored beside `anchorRect`. */
  open(threadId: string, anchorRect: DOMRect): void;
  /** Close the popover if it is showing one of these now-deleted threads. */
  forgetThreads(threadIds: string[]): void;
  setDocUri(uri: string): void;
  setAuthorName(name: string): void;
  notifyReplyResult(requestId: number, ok: boolean, error?: string): void;
  notifyDeleteResult(requestId: number, ok: boolean, error?: string): void;
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
  const replyActions = el('div', 'comment-popover-reply-actions');
  const replyCancel = el('button', 'comment-popover-reply-cancel', 'Cancel');
  replyCancel.type = 'button';
  const replySubmit = el('button', 'comment-popover-reply-submit', 'Submit');
  replySubmit.type = 'button';
  replyActions.append(replyCancel, replySubmit);
  replyBox.append(replyInput, replyActions);

  // Re-opens the reply box after Cancel collapsed it (AC6: Cancel "discards the
  // draft and closes the input") — without this the user would have to close and
  // re-open the whole popover to reply.
  const replyOpen = el('button', 'comment-popover-reply-open', 'Reply');
  replyOpen.type = 'button';

  const closedNotice = el('div', 'comment-popover-closed-notice', 'This thread is closed');

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

  card.append(header, quoteRow, list, replyBox, replyOpen, closedNotice, confirmDialog);
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

  const cardDismiss = initPopoverDismiss(card, () => {
    currentThreadId = undefined;
    highlight.setActiveThread(undefined);
    confirmDismiss.close();
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
  }

  /**
   * The reply affordance is a three-way state: the notice (thread Closed), the
   * open composer, or the collapsed "Reply" button once Cancel discarded a draft.
   */
  function applyReplyVisibility(closed: boolean): void {
    replyBox.hidden = closed || replyCollapsed;
    replyOpen.hidden = closed || !replyCollapsed;
  }

  /** Cancel: discard the draft AND close the input (AC6), appending no sidecar line. */
  function closeReplyDraft(): void {
    replyInput.value = '';
    replyCollapsed = true;
    syncSubmitState();
    const anchor = currentThreadId ? resolve.anchorOf(currentThreadId) : undefined;
    applyReplyVisibility(anchor?.status === 'Closed');
  }

  function syncSubmitState(): void {
    const ready = replyInput.value.trim() !== '';
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
    const requestId = ++requestSeq;
    inFlightReplyRequest = requestId;
    inFlightReplyThread = threadId;
    vscode.postMessage({ type: 'replyToComment', requestId, docUri, threadId, body });
  }

  replyInput.addEventListener('input', syncSubmitState);
  replyCancel.addEventListener('click', () => {
    // Cancel discards the draft without appending any sidecar line — distinct
    // from submitting empty text, since it also discards a non-empty draft.
    closeReplyDraft();
  });
  replyOpen.addEventListener('click', () => {
    replyCollapsed = false;
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
    open(threadId, anchorRect): void {
      const anchor = resolve.anchorOf(threadId);
      if (!anchor) {
        showToast('That comment no longer exists.');
        return;
      }
      const isNewThread = currentThreadId !== threadId;
      currentThreadId = threadId;
      if (isNewThread) {
        replyInput.value = '';
        replyCollapsed = false;
      }
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
      if (!ok) {
        showToast(error ?? 'The reply could not be saved.');
        return;
      }
      if (forThread !== currentThreadId) {
        // Resolved, but the user has moved to another thread — clearing the
        // shared input now would destroy that thread's unsent draft.
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
  };
}
