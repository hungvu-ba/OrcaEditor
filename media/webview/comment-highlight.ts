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
  /**
   * Req 24 US-23.23 AC1: the washed thread covering viewport point (x, y), plus
   * the client rect the point landed in (what a popover anchors against), or
   * `undefined` when no wash is there. Owned by this module rather than the
   * caller because the wash IS the click target — see the implementation.
   */
  threadAtPoint(x: number, y: number): { threadId: string; rect: DOMRect } | undefined;
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

/**
 * The rects of the characters a range actually PAINTS.
 *
 * `Range.getClientRects()` cannot be used directly for a hit test: per CSSOM-View
 * it returns the border box of every element the range **fully contains**, not
 * just its text runs. A comment spanning more than one block resolves its carrier
 * to the common ancestor (`#content`, a `<ul>`, a `<blockquote>` — `block-map.ts`),
 * so every inner block comes back as a full-content-width box and the empty margin
 * beside a short line reads as "inside the wash" — measured at 1053px past the last
 * glyph on a three-paragraph anchor. Clipping to text nodes keeps the hit area on
 * the glyphs, which is what "the clickable region IS the washed region" requires.
 *
 * A range confined to one text node reports only line-box rects, so per-node
 * sub-ranges give exactly the painted geometry, wrapped lines included.
 */
function textRectsOf(range: Range): DOMRect[] {
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(
    root.nodeType === Node.TEXT_NODE ? (root.parentNode ?? root) : root,
    NodeFilter.SHOW_TEXT
  );
  const rects: DOMRect[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const text = n as Text;
    // `comparePoint` rather than the legacy `intersectsNode`, matching the
    // containment idiom already used in `comment-menu.ts` and `input-rules.ts`.
    // Every node the walker yields shares the range's root, so it cannot throw.
    if (range.comparePoint(text, text.data.length) === -1 || range.comparePoint(text, 0) === 1) {
      continue;
    }
    const start = text === range.startContainer ? range.startOffset : 0;
    const end = text === range.endContainer ? range.endOffset : text.data.length;
    if (start >= end) {
      continue;
    }
    const part = document.createRange();
    part.setStart(text, start);
    part.setEnd(text, end);
    for (const r of part.getClientRects()) {
      rects.push(r);
    }
  }
  return rects;
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

  /**
   * Req 24 US-23.23 AC1/AC2/AC5: which washed thread sits under (x, y).
   *
   * Hit-tests the range's own client rects instead of resolving the point to a
   * caret. `caretRangeFromPoint` (the pattern `comment-menu.ts` uses to anchor a
   * NEW comment) snaps to the NEAREST text position, so a click in the blank
   * space to the right of a line whose text ends inside a wash resolves back into
   * that wash and would open a thread the reader never clicked on. Client rects
   * answer the question actually being asked — did the pointer land on painted
   * characters — and a wrapped or multi-block anchor's several rects come free.
   *
   * The layout reads are bounded to one `click`, not a `mousemove`/`scroll`
   * handler, so CLAUDE.md's rAF-coalescing trap does not apply; caching the rects
   * instead would go stale on every re-render, reflow and scroll.
   */
  function threadAtPoint(x: number, y: number): { threadId: string; rect: DOMRect } | undefined {
    if (!supportsHighlight || !on) {
      // AC2: with "Show Comments" off nothing is painted, and an invisible click
      // target is exactly what the toggle promises not to leave behind. The
      // active-thread registrations below are deliberately NOT consulted either:
      // they exist to mark the thread already open, not to add a second target.
      return undefined;
    }
    let best: { threadId: string; rect: DOMRect; span: number } | undefined;
    for (const anchor of resolve.allThreads()) {
      // The same gate `recompute()` applies to the passive set, read through the
      // same helper below: the clickable region IS the washed region, so a reader
      // can never click text that looks plain.
      if (anchor.status === 'Closed') {
        continue;
      }
      // Also the AC1 gate for a floating thread (no connected carrier) and a
      // bare-caret anchor (`offsetStart === offsetEnd`): both return null here,
      // which is why neither has a click target.
      const range = rangeForAnchor(anchor);
      if (!range) {
        continue;
      }
      // AC5 ranks on the range actually PAINTED, not on `offsetEnd - offsetStart`:
      // `rangeWithinOffsets` clamps both ends to the carrier's live text, and
      // resolution is debounced, so between an edit and the next pass the stored
      // offsets can claim a wider span than anything on screen — which would let a
      // stale-wide thread lose to a genuinely wider one. Measured after
      // `rangeForAnchor` for the same reason: ranking before it would skip the
      // hit-test of a candidate whose stored span only looks wider.
      const span = range.toString().length;
      if (best !== undefined && span >= best.span) {
        continue;
      }
      // Strict `>=` above keeps the FIRST thread found at a given span, which is
      // the registry order the AC's tie-break names.
      const hit = textRectsOf(range).find(
        (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      );
      if (hit !== undefined) {
        best = { threadId: anchor.threadId, rect: hit, span };
      }
    }
    return best === undefined ? undefined : { threadId: best.threadId, rect: best.rect };
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
    threadAtPoint,
  };
}
