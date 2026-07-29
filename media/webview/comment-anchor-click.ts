/**
 * Req 24 US-23.23: open a comment thread by clicking the highlighted text it is
 * anchored to — a second mouse route into the popover US-23.2 already reaches
 * from a gutter pin. The pin binds to a whole source LINE, so on a line carrying
 * several threads it cannot express "this phrase"; the wash can.
 *
 * This module owns ONLY the "was that a click, and is it ours to act on"
 * decision. WHICH thread sits under the pointer — and the "Show Comments" gate
 * (AC2) — belongs to `comment-highlight.ts`, because that module paints the wash
 * and therefore defines the target. Asking it rather than re-deriving the answer
 * is what keeps the clickable region identical to the visible one.
 *
 * Kept out of `main.ts` as its own module for the same reason
 * `comment-undo-guard.ts` is: one comment concern per file, with `main.ts` only
 * wiring it.
 */
import type { CommentHighlightController } from './comment-highlight';
import { COMMENT_ANCHOR_OPEN_DELAY_MS, COMMENT_PANEL_DRAG_THRESHOLD_PX } from './constants';
import { CAPTION_CLASS } from './render';

/**
 * AC4: click targets inside `#content` whose own handler already owns a plain
 * click. Those listeners are registered on `#content` too and none uses
 * `stopImmediatePropagation`, so without this list one gesture fires two features
 * and two anchored cards appear at once.
 *
 * `button` rather than an enumeration of class names: every injected control in
 * `#content` is a `<button>` (`dom-postprocess.ts` builds the code-header copy /
 * wrap / language buttons and the math toggle; `front-matter.ts` the collapse, RAW
 * and Copy buttons), and each renders its own label, so its glyphs sit inside
 * `textRectsOf`'s rects and really would resolve to a washed thread. Two review
 * passes each found a class the enumeration had missed; the element type cannot go
 * stale the same way. `.md-caption` is named separately because it is a `<span>`.
 *
 * `img` and `input[type="checkbox"]` are deliberately ABSENT even though AC4 names
 * them: `threadAtPoint` hit-tests text-node rects only, so no non-text box is ever
 * a hit and their own handlers already keep the gesture. Listing them would be dead
 * code (verified by mutation) that also implies images are otherwise clickable.
 *
 * A bare `<a>` is deliberately NOT here — a plain link click is not navigation in
 * this editor, so the AC opens the thread instead. That premise does NOT hold for a
 * `## References` entry (US-20.5 navigates on an unmodified click); recorded as
 * US-23.23's Open Question #1 and split to Requirement 20, because excluding it
 * would change what AC4 promises.
 */
const CLICK_OWNED_ELSEWHERE = `button, .${CAPTION_CLASS}`;

export function initCommentAnchorClick(
  content: HTMLElement,
  highlight: CommentHighlightController,
  /** Same shape `comment-gutter.ts` is wired with, so both routes reach the popover identically. */
  openThread: (threadId: string, anchorRect: DOMRect) => void
): void {
  /** Where the primary button went down, so `click` can tell a click from a drag (AC3). */
  let pressedAt: { x: number; y: number } | undefined;
  /** The armed open from the last qualifying click — cancelled if the gesture turns out to be a double-click. */
  let pendingOpen: number | undefined;

  function cancelPendingOpen(): void {
    if (pendingOpen !== undefined) {
      window.clearTimeout(pendingOpen);
      pendingOpen = undefined;
    }
  }

  // Cancellation is on `document`, not `content`: the gutter pin layer, its cluster
  // list and the Comment tab are all mounted on `document.body`, so a press there
  // never reaches `#content`. Without this, clicking washed text and then a pin
  // within 250ms let the stale timer replace the thread the pin had just opened —
  // the reader's LATER, more specific action losing to the earlier one.
  document.addEventListener('mousedown', cancelPendingOpen, true);

  content.addEventListener('mousedown', (e) => {
    // AC3: a second press means the gesture was not a single click after all —
    // this is what turns a double- or triple-click into "no popover opens" rather
    // than a visible flash. The leading click cannot be told apart from a plain
    // one at the time it fires, so the only evidence is the press that follows.
    cancelPendingOpen();
    // Only the primary button goes on to produce a `click`; recording any other
    // would leave a stale origin for the next real click to measure against.
    pressedAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : undefined;
  });

  // Scrolling moves the document under the armed coordinates, so the thread that
  // was clicked is no longer the thread there. Cancel rather than re-resolve: the
  // reader has moved on. Cancelling a timer forces no layout, so this is safe in a
  // scroll handler (CLAUDE.md's throttling trap does not apply).
  window.addEventListener('scroll', cancelPendingOpen, { capture: true, passive: true });

  content.addEventListener('click', (e) => {
    const press = pressedAt;
    // Consumed on every path, including the bails: a `click` with no mousedown of
    // its own (a synthetic dispatch, or one whose mousedown was swallowed) must
    // not be able to measure itself against an older gesture's origin.
    pressedAt = undefined;
    if (press === undefined) {
      return;
    }
    // AC4: Cmd/Ctrl+Click belongs to the link / autolinked-relative-path handler.
    // Both modifiers tested per CLAUDE.md's cross-platform trap — a `metaKey`-only
    // test would hijack the Windows/Linux chord.
    if (e.metaKey || e.ctrlKey) {
      return;
    }
    if ((e.target as Element | null)?.closest?.(CLICK_OWNED_ELSEWHERE)) {
      return;
    }
    // AC3, gate 1 of 2 — pointer travel. Catches a drag that ends with NO
    // selection to inspect: released over a non-selectable node, or cleared by
    // the browser. Gate 2 is blind to those.
    //
    // Radius, not per-axis, so this predicate is identical to the one
    // `comment-panel.ts` applies to the same constant — sharing the number while
    // testing each axis separately made a dx=dy=3 gesture a drag for the card and
    // a click here, which is the drift the constant's doc claims cannot happen.
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) >= COMMENT_PANEL_DRAG_THRESHOLD_PX) {
      return;
    }
    // AC3, gate 2 of 2 — what the gesture left selected. Catches a drag-select
    // too short to break the travel slop (a single character can be 8px wide, but
    // the pointer need not have moved that far). Neither gate subsumes the other,
    // so neither may be dropped.
    //
    // This is also what turns a double- or triple-click away, which is why there
    // is deliberately NO `e.detail === 1` test here: Chromium selects the word on
    // the SECOND mousedown, so by the time that click arrives the selection is
    // already a range and this gate refuses it. An `e.detail` test would be
    // redundant with that and would additionally kill a legitimate re-click —
    // Chromium keeps incrementing `detail` for any click landing near the previous
    // one within the double-click interval, so reopening a thread just after
    // closing it would silently stop working.
    const sel = window.getSelection();
    if (sel !== null && !sel.isCollapsed) {
      return;
    }
    if (highlight.threadAtPoint(e.clientX, e.clientY) === undefined) {
      // Nothing under the pointer — do not arm a timer for every click in the
      // document just to find that out 250ms later.
      return;
    }
    const { clientX, clientY } = e;
    cancelPendingOpen();
    pendingOpen = window.setTimeout(() => {
      pendingOpen = undefined;
      // Re-resolved rather than captured: a host update can splice the clicked
      // block during the wait, which would leave the earlier hit pointing at a
      // detached carrier or at a thread that has since moved.
      const hit = highlight.threadAtPoint(clientX, clientY);
      if (hit === undefined) {
        return;
      }
      // No `preventDefault` anywhere on this path (AC6): the browser's own caret
      // placement stands, so the reader keeps the caret where they clicked, and
      // focus behaviour is whatever the popover does from a gutter pin — which is
      // to leave focus in `#content`, since `open()` focuses the card on neither
      // route. AC6 asks for parity with the pin, and this is that parity; it does
      // not ask this route to focus the card, so do not "restore" a focus move
      // that never existed.
      openThread(hit.threadId, hit.rect);
    }, COMMENT_ANCHOR_OPEN_DELAY_MS);
  });
}
