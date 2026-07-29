/**
 * Req 24 US-23.18 AC1/AC2/AC8: undo/redo pressed inside a comment surface must
 * die there.
 *
 * US-23.6 AC2 already routes the keystroke correctly for a field mounted INSIDE
 * `#content` — `main.ts`'s `ownsNativeUndo` sees it and declines to delegate.
 * Every comment field is mounted on `document.body` instead, so that handler is
 * structurally unreachable for them: it is registered on `content`, and an event
 * fired on a body-mounted node never propagates through `#content` at all. The
 * shipped guard therefore proves nothing about the surfaces it was written for
 * (US-23.18 AC1 states exactly this), and nothing stops the chord from reaching
 * VS Code's own keybinding layer, which runs `undo` against the TextDocument —
 * rolling back the Author's last document edit because a Reviewer corrected a
 * typo in a reply.
 *
 * `preventDefault()` is the mechanism, and AC1 names it specifically ("not
 * `stopPropagation()` alone"): a webview forwards only its UNHANDLED keydown
 * events to the extension host for keybinding matching, so marking the event
 * handled is what closes the route. Propagation is deliberately left alone —
 * these fields sit outside `#content`, so there is no editor handler downstream
 * to stop, and cancelling propagation would break the popover/escape-stack
 * listeners that legitimately sit above them.
 *
 * Because `preventDefault()` also cancels the browser's own field-level undo,
 * a real text field gets it reissued explicitly, so the Reviewer keeps the
 * typo-correction the guard exists to protect (AC1's "fall back to its own
 * native textarea/input history").
 *
 * Registered in **capture** phase on `document` so it runs ahead of any
 * field-local handler that might cancel propagation before we see the event —
 * the guard must not be defeatable by a listener added later.
 */
import { COMMENT_FIELD_SELECTORS } from './constants';
import { ownsNativeTextHistory } from './dom-utils';

/**
 * Which undo/redo action this chord means, or `undefined` when it is not one.
 *
 * `metaKey || ctrlKey` per CLAUDE.md's cross-platform trap — a macOS-only
 * `metaKey` test leaves the Windows/Linux chord unguarded, which is the whole
 * failure mode. `!altKey` mirrors the same AltGr protection `main.ts` carries on
 * these three branches: on Windows/Linux AltGr sets `ctrlKey` AND `altKey`, so
 * without it AltGr+Z (a real character on several layouts) would be eaten here.
 *
 * Matched on `e.code` (physical key), not `e.key` (produced character), for the
 * reason `main.ts`'s Alt+Shift+C branch already records: on a Cyrillic, Greek or
 * Hebrew layout Ctrl+Z reports `e.key === 'я'` and an `e.key` test goes blind —
 * while VS Code's own keybinding layer still resolves the physical key and runs
 * `undo` on the document. That combination is the worst case: the guard misses
 * and the document is edited anyway.
 */
function undoRedoAction(e: KeyboardEvent): 'undo' | 'redo' | undefined {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) {
    return undefined;
  }
  if (e.code === 'KeyZ') {
    return e.shiftKey ? 'redo' : 'undo';
  }
  if (e.code === 'KeyY' && !e.shiftKey) {
    return 'redo';
  }
  return undefined;
}

/** The comment surface this event happened in, or `null` when it happened elsewhere. */
function commentSurfaceFor(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest(COMMENT_FIELD_SELECTORS.join(', '));
}

export function initCommentUndoGuard(): void {
  document.addEventListener(
    'keydown',
    (e) => {
      // An IME candidate window is open and owns the keystroke — this repo has
      // been bitten by acting ahead of composition before (the `@`/`/` trigger
      // popups). Nothing to undo at the document level mid-composition anyway,
      // and `preventDefault()` here would interfere with the IME's own handling.
      if (e.isComposing) {
        return;
      }
      const action = undoRedoAction(e);
      if (action === undefined || commentSurfaceFor(e.target) === null) {
        // Not our chord, or not our surface — `#content`'s own handler still owns
        // the delegation to the document's undo stack (AC3: undo must still work).
        return;
      }
      e.preventDefault();
      if (ownsNativeTextHistory(e.target)) {
        // Give the field back the undo `preventDefault()` just cancelled.
        //
        // Gated on the target being a real text entry rather than issued
        // unconditionally: `execCommand` follows the SELECTION, not focus, and the
        // anchor-lost dialog (AC8) is a focusable card with no text field of its
        // own — the selection can still be sitting in `#content` behind the scrim,
        // where an unconditional call would undo the Author's document edit. That
        // is the exact corruption this module exists to prevent, so a surface with
        // nothing of its own to undo simply swallows the chord.
        document.execCommand(action);
      }
    },
    true
  );
}
