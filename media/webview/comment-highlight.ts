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
 * The toggle only gates the PASSIVE set (every non-Closed thread); the
 * currently open popover's thread is always included regardless of the
 * toggle, since "clicking a gutter pin opens the popover with the anchored
 * range highlighted" (US-23.2 AC) must hold even with "Show Comments" off.
 *
 * Nothing here writes to `#content` — Ranges are pure text-position handles,
 * so there is no DOM class/attribute for turndown.ts to strip.
 */
import { rangeWithinOffsets } from './dom-utils';
import type { CommentResolveController, ThreadAnchor } from './comment-resolve';
import { COMMENT_HIGHLIGHT_NAME, COMMENT_HIGHLIGHT_NONEXACT_NAME } from './constants';

export interface CommentHighlightController {
  /** "Show Comments" toolbar toggle changed. */
  setToggle(on: boolean): void;
  isOn(): boolean;
  /** The thread whose popover is currently open (or none) — always highlighted regardless of the toggle. */
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
      // A Closed thread keeps no pin and no highlight (design handoff) — only
      // the not-yet-built Comment tab (US-23.7) can still reach it.
      if (anchor.status === 'Closed') {
        continue;
      }
      const isActive = anchor.threadId === activeThreadId;
      if (!on && !isActive) {
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
