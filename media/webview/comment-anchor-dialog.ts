/**
 * Req 23 US-23.3 AC3: the anchor-lost confirmation.
 *
 * When all four of US-23.4's tiers fail to relocate a thread, the text it was
 * written against is gone, and there are two very different reasons for that —
 * the Author fixed the thing the comment asked about, or the comment simply lost
 * its place. The system must not guess between them, so the Author is asked
 * once per floating episode:
 *
 *   "This was resolved"      -> Resolved (the Reviewer's Close is still required)
 *   "This comment lost its anchor" -> stays in the Unresolved-location list,
 *                                     resolve status untouched
 *
 * Three equivalent ways out without deciding (x, "Decide later", Escape/scrim) —
 * not deciding is a real answer. Nothing about the answer is persisted: the frozen
 * sidecar schema has a line type for a real status change and none for "I was
 * asked and deferred", so a deferral lasts this session and the question is
 * re-offered on the next open. Never auto-decides, never times out, and never
 * offers "apply to all" (design handoff).
 *
 * Only the thread's own Author is asked. A Reviewer is not blocked by a modal for
 * a decision that is not theirs — the floating thread is still visible to them in
 * the Unresolved-location panel (US-23.4 AC4), which is where a Reviewer acts.
 *
 * Mounted on `document.body` with its own scrim, like every other dialog here:
 * nothing this module creates may land inside `#content`, where turndown.ts's
 * raw-HTML path could carry a session-only class into the `.md` (US-23.6).
 */
import type { CommentPopoverController } from './comment-popover';
import type { CommentResolveController, ThreadAnchor } from './comment-resolve';
import { COMMENT_ANCHOR_LOST_CLASS, COMMENT_PANEL_SNIPPET_CHARS } from './constants';
import { el, showToast } from './dom-utils';
import { ESCAPE_PRIORITY, registerEscapeHandler, type Disposable } from './escape-stack';
import { truncateDisplay } from './trigger-popup';
import { sameAuthor } from '../../src/comments/sidecar-format';

export interface CommentAnchorDialogController {
  setAuthorName(name: string): void;
}

/**
 * One line of the recorded text, so the Author can tell WHICH comment is being
 * asked about. Truncated through the shared `truncateDisplay`, which cuts by code
 * point — slicing by UTF-16 index splits a surrogate pair landing on the boundary
 * into a lone-surrogate replacement glyph.
 */
function snippet(text: string): string {
  return truncateDisplay(text.replace(/\s+/g, ' ').trim(), COMMENT_PANEL_SNIPPET_CHARS);
}

export function initCommentAnchorDialog(
  resolve: CommentResolveController,
  popover: CommentPopoverController
): CommentAnchorDialogController {
  let authorName = '';
  /** The thread the open dialog is asking about — undefined while it is hidden. */
  let askingAbout: string | undefined;
  /** The thread whose "This was resolved" answer is still with the host. */
  let resolving: string | undefined;
  let escDisposable: Disposable | undefined;

  const scrim = el('div', `${COMMENT_ANCHOR_LOST_CLASS}-scrim`);
  scrim.hidden = true;
  const card = el('div', COMMENT_ANCHOR_LOST_CLASS);
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', 'This comment lost its anchor');
  // Focusable so `open()` can move focus off `#content`. The scrim only blocks the
  // MOUSE: this dialog is raised by a debounced re-resolution, not by a click, so
  // it can appear while the Author is mid-keystroke — and focus left behind in the
  // editor would keep typing into the document underneath the scrim.
  card.tabIndex = -1;
  scrim.appendChild(card);
  document.body.appendChild(scrim);

  /** Tear the dialog down without touching the thread's pending flag. */
  function hide(): string | undefined {
    const threadId = askingAbout;
    askingAbout = undefined;
    scrim.hidden = true;
    escDisposable?.dispose();
    escDisposable = undefined;
    card.textContent = '';
    return threadId;
  }

  /**
   * Leave without answering. Clears the thread's pending flag so the dialog does
   * not immediately re-raise itself from the change this very close notifies —
   * a later floating transition arms it again.
   */
  function dismiss(): void {
    const threadId = hide();
    if (threadId !== undefined) {
      resolve.clearAnchorDecision(threadId);
    }
  }

  /** "This was resolved": Resolved now, the Reviewer's Close still required (AC1). */
  function answerResolved(threadId: string): void {
    // `hide()`, NOT `dismiss()`: the pending flag stays armed until the host says
    // the line is durable. Clearing it here — before the answer — silently loses
    // the decision whenever the append is refused (read-only sidecar, disk full,
    // the thread already resolved from another surface), because the flag is the
    // only thing that would ever raise the question again.
    hide();
    resolving = threadId;
    const sent = popover.requestStatusChange(threadId, 'resolve', (ok, error) => {
      resolving = undefined;
      if (!ok) {
        showToast(error ?? 'That comment could not be marked resolved.');
      }
      // On success the host's snapshot carries a non-Open status, and THAT is what
      // clears the flag (`refreshFromSeed`). On failure it is still armed, so the
      // question is re-raised rather than quietly dropped.
      checkPending();
    });
    if (!sent) {
      // Another comment action holds the single in-flight slot, so nothing was
      // posted and no outcome will ever arrive for this click.
      resolving = undefined;
      showToast('Another comment action is still saving — try again in a moment.');
      checkPending();
    }
  }

  /**
   * "This comment lost its anchor": AC3 is explicit that this moves it to the
   * Unresolved-location list "instead of changing its resolve state" — and it is
   * already there, since being floating is what raised this dialog. So the answer
   * writes nothing; it only records that the Author has seen it.
   */
  function answerLost(): void {
    dismiss();
  }

  function choice(label: string, consequence: string, onPick: () => void): HTMLElement {
    const wrap = el('div', 'comment-anchor-lost-choice');
    // Both answers at identical weight, with no autofocus and no Enter default:
    // the whole point is that the system must not lean either way (design handoff).
    const button = el('button', 'comment-anchor-lost-answer', label);
    button.type = 'button';
    button.addEventListener('click', onPick);
    wrap.appendChild(button);
    wrap.appendChild(el('div', 'comment-anchor-lost-consequence', consequence));
    return wrap;
  }

  function open(anchor: ThreadAnchor): void {
    askingAbout = anchor.threadId;
    card.textContent = '';

    const head = el('div', 'comment-anchor-lost-head');
    head.appendChild(el('span', 'comment-anchor-lost-title', 'This comment lost its anchor'));
    const closeBtn = el('button', 'comment-anchor-lost-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Decide later');
    closeBtn.addEventListener('click', dismiss);
    head.appendChild(closeBtn);
    card.appendChild(head);

    card.appendChild(
      el(
        'div',
        'comment-anchor-lost-lede',
        'The text this comment was written against is no longer in the document.'
      )
    );
    const quote = snippet(anchor.recordedText);
    if (quote !== '') {
      card.appendChild(el('div', 'comment-anchor-lost-quote', `“${quote}”`));
    }
    card.appendChild(el('div', 'comment-anchor-lost-body', anchor.body));

    const answers = el('div', 'comment-anchor-lost-answers');
    answers.appendChild(
      choice('This was resolved', 'Marks the thread Resolved. The reviewer still has to close it.', () =>
        answerResolved(anchor.threadId)
      )
    );
    answers.appendChild(
      choice(
        'This comment lost its anchor',
        'Keeps it in the Unresolved location list, with its status unchanged.',
        answerLost
      )
    );
    card.appendChild(answers);

    const later = el('button', 'comment-anchor-lost-later', 'Decide later');
    later.type = 'button';
    later.addEventListener('click', dismiss);
    card.appendChild(later);

    scrim.hidden = false;
    // The CARD, never an answer button: the two answers must stay at identical
    // weight, so autofocusing either would nudge the decision (design handoff).
    card.focus();
    escDisposable?.dispose();
    escDisposable = registerEscapeHandler(ESCAPE_PRIORITY.MODAL, () => {
      if (scrim.hidden) {
        return false;
      }
      dismiss();
      return true;
    });
  }

  /**
   * Raise the dialog for the next thread that owes an answer, one at a time
   * (design handoff: no "apply to all", so a mass delete that floats several
   * threads asks about each in turn rather than deciding for the rest).
   */
  function checkPending(): void {
    // `resolving` keeps the dialog down while an answer is with the host: the flag
    // is deliberately still armed then, so without this the very next change
    // notification would re-raise the same question mid-round-trip.
    if (askingAbout !== undefined || resolving !== undefined || authorName === '') {
      return;
    }
    const next = resolve
      .floatingThreads()
      .find((anchor) => anchor.awaitingAnchorDecision && sameAuthor(authorName, anchor.author));
    if (next) {
      open(next);
    }
  }

  scrim.addEventListener('mousedown', (e) => {
    // Scrim only — a mousedown inside the card must not dismiss it.
    if (e.target === scrim) {
      dismiss();
    }
  });

  resolve.onChange(() => {
    if (askingAbout !== undefined && resolve.anchorOf(askingAbout)?.awaitingAnchorDecision !== true) {
      // The thread was answered elsewhere, promoted back out by an undo, or
      // deleted — the question no longer stands, so take the dialog down without
      // clearing a flag that is already gone.
      hide();
    }
    checkPending();
  });

  return {
    setAuthorName(name): void {
      authorName = name;
      // The name arrives with `init`, potentially after a reload already floated a
      // thread — re-check rather than waiting for the next settled change.
      checkPending();
    },
  };
}
