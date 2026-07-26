/**
 * Req 23 US-23.4: keeping every comment attached to the right spot after the
 * Author edits, moves or deletes the surrounding text.
 *
 * Four tiers, in order, per thread:
 *   1. the structural id still resolves in the live DOM  -> exact, stop here
 *   2. the recorded text snapshot fuzzy-matches a node    -> exact, id re-stamped
 *   3. nearest still-present block at/above the last line -> approximate
 *   4. nothing matched                                    -> floating
 *
 * The structural id is SESSION-scoped (block-map.ts mints fresh ids on every
 * parse and none of them is persisted), so a file close→reopen necessarily
 * starts at tier 2 — which is why the recorded text, last known line and nearest
 * heading are captured at creation time.
 *
 * Nothing here writes to the `.md`: a tier only moves a session-only DOM
 * attribute and tells the host where the native thread's Range should sit, so
 * re-resolution can never enter the document's undo stack (US-23.6). Sidecar
 * persistence is US-23.5, so this registry lives for the session only; its field
 * names match the frozen `.orca-comments.jsonl` anchor schema so that story can
 * persist it verbatim.
 */
import { pickAnchorCandidate } from './comment-anchor';
import {
  anchorCandidates,
  commentAnchorLine,
  COMMENT_ANCHOR_ATTR,
  dedupeCommentAnchors,
  findCommentAnchor,
  nearestHeadingBefore,
  type AnchorCandidateNode,
} from './block-map';
import { ANCHOR_REEVAL_DEBOUNCE_MS, COMMENT_ANCHOR_STATE_ATTR } from './constants';
import type { VsCodeApi } from './vscode-api';

/**
 * Where a thread currently sits. Runtime-derived and orthogonal to the
 * Open/Resolved/Closed status axis (US-23.3) — the two must never be conflated.
 */
export type AnchorState = 'exact' | 'approximate' | 'floating';

/** Everything one thread recorded about its anchor, plus where it resolved last. */
export interface ThreadAnchor {
  threadId: string;
  anchorId: string;
  offsetStart: number;
  offsetEnd: number;
  /** Full text of the anchored node at creation time — tier 2 matches against this. */
  recordedText: string;
  /** 1-based line the anchor was last seen on; updated as tiers relocate it. */
  lastKnownLine: number;
  nearestHeading: string;
  /** The comment's own text — what a card in the "Unresolved location" panel shows (US-23.4 AC4). */
  body: string;
  /** Author actually recorded on the thread, echoed by the host at create time. */
  author: string;
  /** ISO-8601 creation timestamp from the host; the panel orders newest-first by it. */
  createdAt: string;
  state: AnchorState;
  /**
   * The node this thread resolved to last pass. Session-only and never
   * persisted — it is what tells a pasted COPY from its original when the copy
   * lands above it in document order (dedup would otherwise hand the id to
   * whichever came first).
   */
  carrier?: HTMLElement;
}

/** The anchor facts a thread is registered with (state and carrier are derived, never supplied). */
export type ThreadAnchorSeed = Omit<ThreadAnchor, 'state' | 'carrier'>;

export interface CommentResolveController {
  /** Record a freshly created thread so later renders can re-resolve it (US-23.1 hands this over). */
  register(seed: ThreadAnchorSeed): void;
  /** Re-run the tiers for every thread once the document has settled. */
  refresh(): void;
  /**
   * Called after every pass whose outcome differs from the last one, so the
   * panel and its toolbar badge re-render without polling.
   */
  onChange(listener: () => void): void;
  /**
   * Threads no tier could place. Uncapped and never pruned — US-23.4 AC4 forbids
   * a cap and a silent drop, even when one large edit floats many at once. The
   * "Unresolved location" panel that renders these is its own story.
   */
  floatingThreads(): ThreadAnchor[];
  /** Manual re-attachment of a floating thread onto `el` (the panel's drag/picker entry point). */
  reattach(threadId: string, el: HTMLElement): boolean;
  /** Current resolution of a thread — the read model for tests and later UI stories. */
  anchorOf(threadId: string): ThreadAnchor | undefined;
  /** Seed from `InitConfig.docUri` — echoed on every update so the host can verify the document. */
  setDocUri(uri: string): void;
}

export function initCommentResolve(content: HTMLElement, vscode: VsCodeApi): CommentResolveController {
  let docUri = '';
  const threads = new Map<string, ThreadAnchor>();
  const listeners: Array<() => void> = [];
  let timer: number | undefined;

  /**
   * Mark the node so US-23.2's pin/highlight — and AC3's "visibly marked as
   * approximate" — can tell an exact anchor from a relocated one.
   */
  function stampState(el: HTMLElement, state: AnchorState): void {
    el.setAttribute(COMMENT_ANCHOR_STATE_ATTR, state);
  }

  /**
   * Every element that can carry an anchor attribute, `#content` included —
   * querySelectorAll only walks descendants, and `#content` itself is a valid
   * anchor (US-23.1: a selection spanning several blocks resolves to it), so
   * leaving it out silently exempts whole-document anchors from every sweep.
   */
  function carriersOf(attr: string, value?: string): HTMLElement[] {
    const selector = value === undefined ? `[${attr}]` : `[${attr}="${CSS.escape(value)}"]`;
    const found = Array.from(content.querySelectorAll<HTMLElement>(selector));
    return content.matches(selector) ? [content, ...found] : found;
  }

  /** Cleared before each pass so a node that stops carrying a thread stops being marked. */
  function clearStates(): void {
    for (const el of carriersOf(COMMENT_ANCHOR_STATE_ATTR)) {
      el.removeAttribute(COMMENT_ANCHOR_STATE_ATTR);
    }
  }

  /** Is `id` the anchor of some OTHER live thread? */
  function idUsedByAnother(id: string, self: ThreadAnchor): boolean {
    for (const other of threads.values()) {
      if (other !== self && other.anchorId === id) {
        return true;
      }
    }
    return false;
  }

  /**
   * Move a thread onto `el`, keeping its within-node offsets (US-23.1 AC3).
   *
   * Two nodes cannot both carry one id, and one node cannot carry two: the id
   * is lifted off whatever held it before (leaving it behind would make tier 1
   * snap the thread back to the stale node next pass), and if `el` already
   * belongs to another thread this thread ADOPTS that id instead of overwriting
   * it — the same "two comments on the same node share one anchor" rule
   * `ensureCommentAnchorId` applies at creation. Overwriting would make the two
   * threads take the attribute from each other on alternating passes forever.
   */
  function place(anchor: ThreadAnchor, el: HTMLElement, state: AnchorState): void {
    const occupant = el.getAttribute(COMMENT_ANCHOR_ATTR);
    if (occupant && occupant !== anchor.anchorId && idUsedByAnother(occupant, anchor)) {
      anchor.anchorId = occupant;
    } else {
      for (const previous of carriersOf(COMMENT_ANCHOR_ATTR, anchor.anchorId)) {
        if (previous !== el) {
          previous.removeAttribute(COMMENT_ANCHOR_ATTR);
        }
      }
      el.setAttribute(COMMENT_ANCHOR_ATTR, anchor.anchorId);
    }
    anchor.lastKnownLine = commentAnchorLine(content, el) || anchor.lastKnownLine;
    anchor.nearestHeading = nearestHeadingBefore(content, el);
    // The offsets were measured inside a different node — clamping keeps them a
    // valid range in the new one instead of pointing past its end (AC2: the
    // offsets are what place the comment precisely WITHIN the node found).
    const length = (el.textContent ?? '').length;
    anchor.offsetStart = Math.min(anchor.offsetStart, length);
    anchor.offsetEnd = Math.min(Math.max(anchor.offsetEnd, anchor.offsetStart), length);
    anchor.state = state;
    anchor.carrier = el;
    stampState(el, state);
  }

  /**
   * Tier 3: the block that still SPANS the anchor's last known line — the
   * surviving equivalent of AC3's "walk up the ancestor chain from the last
   * known location", since the anchored node itself is gone and its real
   * ancestors with it. Whatever occupies that location now is the right
   * neighbourhood, and it is marked approximate so it never reads as exact.
   *
   * Requiring actual coverage (rather than "nearest block above") is what makes
   * tier 4 reachable: once the document no longer reaches that line at all — the
   * text and everything after it was deleted — the location is genuinely gone
   * and the thread must float rather than be parked on an unrelated block.
   */
  function blockCovering(line: number, candidates: readonly AnchorCandidateNode[]): HTMLElement | null {
    let best: AnchorCandidateNode | null = null;
    for (const candidate of candidates) {
      if (candidate.line > line || line > candidate.lineEnd) {
        continue;
      }
      // Narrowest wins: the latest-starting span, and on a tie (a blockquote and
      // its only paragraph report the same line) the deeper — i.e. more
      // specific — node, not whichever came first in document order.
      if (
        !best ||
        candidate.line > best.line ||
        (candidate.line === best.line && candidate.depth > best.depth)
      ) {
        best = candidate;
      }
    }
    return best?.el ?? null;
  }

  function resolveOne(anchor: ThreadAnchor, candidates: readonly AnchorCandidateNode[]): void {
    // Only a thread that is currently EXACT may use tier 1. Tier 3 stamps the id
    // onto the block it parked on, so an approximate (or a floating thread whose
    // id is still on some stale node) would otherwise be "found" by tier 1 and
    // silently promoted from a guess to an exact match. Re-running tier 2
    // instead is also what lets text coming back (an undo) restore a real anchor.
    const exact = anchor.state === 'exact' ? findCommentAnchor(content, anchor.anchorId) : null;
    if (exact) {
      anchor.lastKnownLine = commentAnchorLine(content, exact) || anchor.lastKnownLine;
      anchor.carrier = exact;
      anchor.state = 'exact';
      stampState(exact, 'exact');
      return;
    }

    const match = pickAnchorCandidate(anchor.recordedText, candidates, {
      lastKnownLine: anchor.lastKnownLine,
      nearestHeading: anchor.nearestHeading,
    });
    if (match) {
      place(anchor, candidates[match.index].el, 'exact');
      return;
    }

    const covering = blockCovering(anchor.lastKnownLine, candidates);
    if (covering) {
      place(anchor, covering, 'approximate');
      return;
    }

    // Tier 4: nothing left to hold it. The thread keeps its recorded text, line
    // and heading so a later edit (or an undo) can promote it back out.
    anchor.carrier = undefined;
    anchor.state = 'floating';
  }

  function postUpdate(anchor: ThreadAnchor): void {
    vscode.postMessage({
      type: 'commentAnchorUpdate',
      docUri,
      threadId: anchor.threadId,
      anchorId: anchor.anchorId,
      line: anchor.lastKnownLine,
      state: anchor.state,
    });
  }

  /**
   * One pass over every thread, run once the document has settled.
   *
   * The clone dedup (AC6) runs FIRST and from here rather than from each edit
   * site: an edit that duplicates a node (splitting a paragraph with Enter, a
   * paste that carries markup) does not necessarily re-render, and tier 1 must
   * never resolve a thread onto a copy. Doing it here also keeps the scan off
   * the per-keystroke path — this whole function only runs behind the debounce.
   */
  function notifyChanged(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function resolveAll(): void {
    if (threads.size === 0) {
      return;
    }
    let changed = false;
    const keep = new Set<HTMLElement>();
    for (const anchor of threads.values()) {
      if (anchor.carrier?.isConnected) {
        keep.add(anchor.carrier);
      }
    }
    dedupeCommentAnchors(content, keep);
    clearStates();
    const candidates = anchorCandidates(content);
    for (const anchor of threads.values()) {
      const previousLine = anchor.lastKnownLine;
      const previousState = anchor.state;
      const previousAnchorId = anchor.anchorId;
      resolveOne(anchor, candidates);
      if (
        anchor.lastKnownLine !== previousLine ||
        anchor.state !== previousState ||
        anchor.anchorId !== previousAnchorId
      ) {
        postUpdate(anchor);
        changed = true;
      }
    }
    if (changed) {
      notifyChanged();
    }
  }

  function cancelPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  return {
    register(seed): void {
      threads.set(seed.threadId, { ...seed, state: 'exact' });
      // Resolve now so the new thread is stamped immediately, and drop any
      // pending pass — it would re-resolve the same DOM generation a second time
      // and post duplicate updates for every other thread.
      cancelPending();
      resolveAll();
      // A brand-new thread never changes state on its first pass, so resolveAll
      // posts nothing — but the panel's count still has to account for it.
      notifyChanged();
    },
    refresh(): void {
      cancelPending();
      timer = window.setTimeout(() => {
        timer = undefined;
        resolveAll();
      }, ANCHOR_REEVAL_DEBOUNCE_MS);
    },
    floatingThreads(): ThreadAnchor[] {
      // Newest created first (design handoff): the author is looking for a
      // comment they remember writing, not for whichever anchor broke last.
      return Array.from(threads.values())
        .filter((anchor) => anchor.state === 'floating')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    reattach(threadId, el): boolean {
      const anchor = threads.get(threadId);
      if (!anchor || !content.contains(el)) {
        return false;
      }
      // A manual re-attachment is the user's own answer to "where does this
      // belong", so it counts as exact — and the node now carries the id, which
      // makes tier 1 keep it there on every later pass.
      place(anchor, el, 'exact');
      postUpdate(anchor);
      notifyChanged();
      return true;
    },
    anchorOf(threadId): ThreadAnchor | undefined {
      return threads.get(threadId);
    },
    onChange(listener): void {
      listeners.push(listener);
    },
    setDocUri(uri): void {
      docUri = uri;
    },
  };
}
