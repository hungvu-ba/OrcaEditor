/**
 * Req 23 US-23.2: the "Show Comments" inline highlight overlay — a soft violet
 * wash over each Open/Resolved thread's exact anchored range.
 *
 * Reuses the CSS Custom Highlight API pattern already established by
 * search.ts (`'search-match'`/`'search-current'`) and select-highlight.ts
 * (`'select-match'`): `CSS.highlights.set(name, new Highlight(...ranges))`,
 * feature-detected the same way. This is the 4th, independent registration
 * name (`COMMENT_HIGHLIGHT_NAME`, constants.ts) — an active comment highlight
 * and an active search-match highlight render as two distinct, non-overriding
 * layers, never mixed.
 *
 * The toggle only gates the PASSIVE set (every non-Closed thread). Req 24
 * US-23.8 AC5: the currently open popover's thread gets its own THIRD,
 * independent registration (`COMMENT_HIGHLIGHT_ACTIVE_NAME`) instead of being
 * folded into the passive set — it is always drawn regardless of the toggle
 * (since "clicking a gutter pin opens the popover with the anchored range
 * highlighted", US-23.2 AC, must hold even with "Show Comments" off) and even
 * for a Closed thread (the Comment tab, US-23.9, can open one), which the
 * passive set deliberately excludes. Keeping it a separate registration means
 * toggling on/off never adds or removes it, and closing the popover never
 * disturbs whatever the toggle itself already draws for that thread.
 *
 * Nothing here writes to `#content` — Ranges are pure text-position handles,
 * so there is no DOM class/attribute for turndown.ts to strip.
 */
import { rangeWithinOffsets } from './dom-utils';
import type { CommentResolveController, ThreadAnchor } from './comment-resolve';
import {
  COMMENT_HIGHLIGHT_ACTIVE_NAME,
  COMMENT_HIGHLIGHT_ACTIVE_NONEXACT_NAME,
  COMMENT_HIGHLIGHT_NAME,
  COMMENT_HIGHLIGHT_NONEXACT_NAME,
} from './constants';

export interface CommentHighlightController {
  /** "Show Comments" toolbar toggle changed. */
  setToggle(on: boolean): void;
  isOn(): boolean;
  /** The thread whose popover is currently open (or none) — always highlighted (its own registration) regardless of the toggle or Closed status. */
  setActiveThread(threadId: string | undefined): void;
  /** Recompute the highlighted ranges — call after a re-render (anchors may have moved to new nodes). */
  refresh(): void;
}

function rangeForAnchor(anchor: ThreadAnchor): Range | null {
  if (!anchor.carrier || !anchor.carrier.isConnected) {
    return null;
  }
  const start = Math.max(0, anchor.offsetStart);
  const end = Math.max(anchor.offsetEnd, start);
  if (start === end) {
    // A bare-caret anchor has no range to wash — nothing to highlight.
    return null;
  }
  // `rangeWithinOffsets`, NOT collectHaystack/rangeAt: these offsets were
  // captured by `getOffsetWithin` (comment-menu.ts) in Range.toString() space,
  // which inserts no inter-block '\n' and does not skip KaTeX's hidden text.
  // Mixing the two spaces washes the wrong characters — see the helper's doc.
  return rangeWithinOffsets(anchor.carrier, start, end);
}

export function initCommentHighlight(resolve: CommentResolveController): CommentHighlightController {
  const supportsHighlight =
    typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
  let on = false;
  let activeThreadId: string | undefined;

  function recompute(): void {
    if (!supportsHighlight) {
      return;
    }
    const exactRanges: Range[] = [];
    // AC2: tier 3 (approximate) washes render distinct from exact — a separate
    // Highlight registration below, never colour alone (dashed decoration too).
    // Tier 4 (floating) has no carrier and so never reaches either bucket.
    const nonExactRanges: Range[] = [];
    for (const anchor of resolve.allThreads()) {
      // A Closed thread keeps no pin and no highlight in the TOGGLE set
      // (design handoff) — the Comment tab (US-23.9) can still open one, and
      // that case is covered below by the independent active-thread bucket,
      // which has no status gate of its own (Req 24 US-23.8 AC5).
      if (anchor.status === 'Closed' || !on) {
        continue;
      }
      const r = rangeForAnchor(anchor);
      if (!r) {
        continue;
      }
      (anchor.state === 'exact' ? exactRanges : nonExactRanges).push(r);
    }
    if (exactRanges.length === 0) {
      CSS.highlights.delete(COMMENT_HIGHLIGHT_NAME);
    } else {
      CSS.highlights.set(COMMENT_HIGHLIGHT_NAME, new Highlight(...exactRanges));
    }
    if (nonExactRanges.length === 0) {
      CSS.highlights.delete(COMMENT_HIGHLIGHT_NONEXACT_NAME);
    } else {
      CSS.highlights.set(COMMENT_HIGHLIGHT_NONEXACT_NAME, new Highlight(...nonExactRanges));
    }

    // Req 24 US-23.8 AC5: a temporary, thread-scoped wash for whichever thread's
    // popover is open right now — its own independent registrations, so they
    // never share a Highlight object with (and never disturb) the toggle-gated
    // buckets above. Driven solely by `activeThreadId`: unaffected by the
    // toggle in either direction, and reachable even for a Closed thread
    // (opened from the Comment tab), which the toggle buckets deliberately
    // exclude. Split exact/non-exact, same as the toggle buckets, so AC2's
    // distinction still holds here even with the toggle off. Reassigned
    // wholesale on every `setActiveThread` call, so switching threads
    // transfers it instead of accumulating.
    const activeAnchor = activeThreadId === undefined ? undefined : resolve.anchorOf(activeThreadId);
    const activeRange = activeAnchor ? rangeForAnchor(activeAnchor) : null;
    const activeIsExact = activeRange !== null && activeAnchor!.state === 'exact';
    if (activeRange && activeIsExact) {
      // `.priority` pins this ABOVE the toggle buckets regardless of `Map`
      // insertion order — without it, the Custom Highlight API paints
      // whichever registration was `.set()` most recently on top, so opening
      // a popover and only THEN toggling "Show Comments" on would silently
      // invert which wash actually renders.
      const h = new Highlight(activeRange);
      h.priority = 1;
      CSS.highlights.set(COMMENT_HIGHLIGHT_ACTIVE_NAME, h);
    } else {
      CSS.highlights.delete(COMMENT_HIGHLIGHT_ACTIVE_NAME);
    }
    if (activeRange && !activeIsExact) {
      const h = new Highlight(activeRange);
      h.priority = 1;
      CSS.highlights.set(COMMENT_HIGHLIGHT_ACTIVE_NONEXACT_NAME, h);
    } else {
      CSS.highlights.delete(COMMENT_HIGHLIGHT_ACTIVE_NONEXACT_NAME);
    }
  }

  resolve.onChange(recompute);

  return {
    setToggle(next): void {
      on = next;
      recompute();
    },
    isOn(): boolean {
      return on;
    },
    setActiveThread(threadId): void {
      activeThreadId = threadId;
      recompute();
    },
    refresh(): void {
      recompute();
    },
  };
}
