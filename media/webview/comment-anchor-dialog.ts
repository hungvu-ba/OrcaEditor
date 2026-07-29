/**
 * Req 23 US-23.3 AC3, revised by US-23.11 AC4: the anchor-lost notice.
 *
 * When all four of US-23.4's tiers fail to relocate a thread, the text it was
 * written against is gone. Whoever is at the keyboard is told once per floating
 * episode, so a comment does not silently drop out of the document:
 *
 *   "This comment lost its anchor" -> stays in the Unresolved-location list,
 *                                     resolve status untouched
 *
 * **No status action is offered (PO decision, 2026-07-27).** US-23.3 AC5 paired
 * the notice with a "This was resolved" answer, on the theory that a vanished
 * anchor usually means the Author fixed the thing. It is removed at every status:
 * from a Resolved thread the transition it posted is illegal (US-23.11 AC5's
 * matrix allows `resolve` only from Open), so the answer looped — refused by the
 * host, re-raised by the still-armed flag. The user re-attaches the thread from
 * the Comment tab or drops the anchor, whichever they meant; the dialog does not
 * guess for them.
 *
 * Three equivalent ways out without deciding (x, "Decide later", Escape/scrim) —
 * not deciding is a real answer. Nothing about the answer is persisted: the frozen
 * sidecar schema has a line type for a real status change and none for "I was
 * asked and deferred", so a deferral lasts this session and the question is
 * re-offered on the next open. Never auto-decides, never times out, and never
 * offers "apply to all" (design handoff).
 *
 * US-23.11 AC1: no identity filter. Whoever is at the keyboard is told, whatever
 * name the thread was filed under — the free-text author setting was never a
 * reason to hide a broken anchor from the one person looking at it.
 *
 * Mounted on `document.body` with its own scrim, like every other dialog here:
 * nothing this module creates may land inside `#content`, where turndown.ts's
 * raw-HTML path could carry a session-only class into the `.md` (US-23.6).
 */
import type { CommentResolveController, ThreadAnchor } from './comment-resolve';
import { COMMENT_ANCHOR_LOST_CLASS, COMMENT_PANEL_SNIPPET_CHARS } from './constants';
import { el } from './dom-utils';
import { ESCAPE_PRIORITY, registerEscapeHandler, type Disposable } from './escape-stack';
import { truncateDisplay } from './trigger-popup';

/**
 * One line of the recorded text, so the Author can tell WHICH comment is being
 * asked about. Truncated through the shared `truncateDisplay`, which cuts by code
 * point — slicing by UTF-16 index splits a surrogate pair landing on the boundary
 * into a lone-surrogate replacement glyph.
 */
function snippet(text: string): string {
  return truncateDisplay(text.replace(/\s+/g, ' ').trim(), COMMENT_PANEL_SNIPPET_CHARS);
}

export function initCommentAnchorDialog(resolve: CommentResolveController): void {
  /** The thread the open dialog is telling the user about — undefined while hidden. */
  let askingAbout: string | undefined;
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

  /**
   * "This comment lost its anchor": AC3 is explicit that this moves it to the
   * Unresolved-location list "instead of changing its resolve state" — and it is
   * already there, since being floating is what raised this dialog. So the answer
   * writes nothing; it only records that the user has seen it.
   */
  function answerLost(): void {
    dismiss();
  }

  function choice(label: string, consequence: string, onPick: () => void): HTMLElement {
    const wrap = el('div', 'comment-anchor-lost-choice');
    // No autofocus and no Enter default: the notice must not push the user toward
    // acknowledging it rather than going and re-attaching the thread.
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
    // The CARD, never the answer button — see `choice`.
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
   * Raise the dialog for the next thread that owes an acknowledgement, one at a
   * time (design handoff: no "apply to all", so a mass delete that floats several
   * threads reports each in turn rather than collapsing them into one notice).
   */
  function checkPending(): void {
    if (askingAbout !== undefined) {
      return;
    }
    // US-23.11 AC1 (PO decision, planning 2026-07-27): no identity filter. The
    // question is asked of whoever is at the keyboard — filtering it by a
    // free-text author name meant the one person looking at the broken anchor
    // was often the one person never asked about it.
    const next = resolve.floatingThreads().find((anchor) => anchor.awaitingAnchorDecision);
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

}
