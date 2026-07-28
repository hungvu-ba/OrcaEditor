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
import { anchorTextRetention, driftBandFor, pickAnchorCandidate } from './comment-anchor';
import {
  anchorCandidates,
  commentAnchorLine,
  COMMENT_ANCHOR_ATTR,
  dedupeCommentAnchors,
  ensureCommentAnchorId,
  findCommentAnchor,
  nearestHeadingBefore,
  type AnchorCandidateNode,
} from './block-map';
import {
  ANCHOR_LOAD_BATCH_THRESHOLD,
  ANCHOR_REEVAL_DEBOUNCE_MS,
  ANCHOR_RESOLVE_CHUNK_SIZE,
  COMMENT_ANCHOR_STATE_ATTR,
} from './constants';
import { showToast } from './dom-utils';
import type { VsCodeApi } from './vscode-api';
import type { CommentStatus, CommentSyncReply, CommentTransition } from '../../src/shared/messages';

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
  /** US-23.14 AC4: the winning `edit` line's own timestamp, once this comment has been edited at least once. */
  editedAt?: string;
  /**
   * US-23.3's Open/Resolved/Closed axis, kept up to date by `syncThread` —
   * orthogonal to `state` (anchor resolution) below. The two must never be
   * conflated: a thread can be floating AND Resolved, or exact AND Closed.
   */
  status: CommentStatus;
  /**
   * US-23.11 AC2: every applied Resolved/Closed/Reopen transition, oldest first —
   * the trail the popover lists so a reader can tell whether Resolve and Close
   * came from two different people. Empty while the thread has never left Open.
   */
  statusChanges: CommentTransition[];
  /** US-23.2: replies under this thread, in append order — what the popover renders. */
  replies: CommentSyncReply[];
  state: AnchorState;
  /**
   * US-23.3 AC2, revised by US-23.11 AC3: whether enough of `recordedText` has
   * been removed or rewritten for the "text may have changed" strip. Recomputed
   * every settled pass — a live derived indicator, never a stored/dismissible
   * flag, so it disappears on its own once the text is restored (e.g. an undo)
   * and comes back if it drifts later.
   *
   * Latched through a hysteresis band rather than a single threshold, which is
   * why it is read as well as written by `applyStatusIndicators`.
   */
  contentDrifted: boolean;
  /**
   * US-23.3 AC3, widened by US-23.11 AC4: this thread just lost its anchor
   * entirely (all four tiers failed) while still Open or Resolved, so whoever is
   * at the keyboard has not yet been told. Set on the transition INTO floating,
   * not on every pass, so the notice is raised once per episode rather than
   * re-raised on every keystroke that settles.
   */
  awaitingAnchorDecision: boolean;
  /**
   * The node this thread resolved to last pass. Session-only and never
   * persisted — it is what tells a pasted COPY from its original when the copy
   * lands above it in document order (dedup would otherwise hand the id to
   * whichever came first).
   */
  carrier?: HTMLElement;
}

/** The anchor facts a thread is registered with (everything else is derived, never supplied). */
export type ThreadAnchorSeed = Omit<
  ThreadAnchor,
  'state' | 'carrier' | 'contentDrifted' | 'awaitingAnchorDecision'
>;

export interface CommentResolveController {
  /** Record a freshly created thread so later renders can re-resolve it (US-23.1 hands this over). */
  register(seed: ThreadAnchorSeed): void;
  /**
   * US-23.2: seed or refresh a thread from a `commentThreadsSync` push. A
   * threadId not yet known is registered fresh (this session never created or
   * saw it — e.g. persisted from a previous session, or reached from the
   * native `vscode.comments` UI); an already-known thread only has its
   * status/replies refreshed — anchor resolution (position/state/carrier) is
   * this session's own business and is never overwritten by a sync.
   */
  syncThread(seed: ThreadAnchorSeed): void;
  /**
   * US-23.2: reconcile the whole registry to one host snapshot — apply every
   * seed AND drop every thread absent from it, so a thread deleted host-side
   * (from this popover, from a second panel, or from the native
   * `vscode.comments` UI) stops keeping its gutter pin, its highlight and a
   * re-openable popover for the rest of the session.
   *
   * Batched deliberately: one resolve + one change notification for the whole
   * snapshot. Calling `syncThread` per thread re-resolves and fans out once PER
   * THREAD, and the host pushes a fresh snapshot per anchor update — which made
   * a single edit that moved M threads cost M×N pin/highlight rebuilds.
   *
   * Returns the pruned threadIds so the caller can drop dependent UI.
   */
  syncAll(seeds: ThreadAnchorSeed[]): string[];
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
  /**
   * US-23.2: every currently-registered thread (any anchor state) — the read
   * model the gutter pins and the highlight overlay build from. Not sorted or
   * filtered; callers pick what they need (e.g. excluding a Closed status).
   */
  allThreads(): ThreadAnchor[];
  /** Manual re-attachment of a floating thread onto `el` (the panel's drag/picker entry point). */
  reattach(threadId: string, el: HTMLElement): boolean;
  /**
   * US-23.3 AC3: the Author has answered the anchor-lost dialog for this thread,
   * or left without deciding. Either way it stops being asked for THIS episode;
   * a later floating transition arms it again (nothing about the answer is
   * persisted — the frozen sidecar schema has no line type for an anchor
   * decision, only for a real status change).
   */
  clearAnchorDecision(threadId: string): void;
  /** Current resolution of a thread — the read model for tests and later UI stories. */
  anchorOf(threadId: string): ThreadAnchor | undefined;
  /** Seed from `InitConfig.docUri` — echoed on every update so the host can verify the document. */
  setDocUri(uri: string): void;
  /**
   * Req 24 US-23.8 AC6/AC7: `main.ts` calls this once per `renderDocument`,
   * right after `content.innerHTML` is assigned. Two jobs share the one call:
   * it is the readiness gate a resolution pass requested before first paint
   * was waiting on (a `commentThreadsSync` racing `renderDocument` — see
   * `syncCommentThreads`'s "best-effort immediate sync" in `provider.ts` — must
   * never read an empty `#content`, which would float every thread), and it
   * bumps the generation stamp a still-running chunked load pass checks so a
   * fresher pass always wins over a stale one (AC7).
   */
  notifyContentRendered(): void;
  /**
   * US-23.13 AC1/AC2: the host failed to persist a `'manual'`/`'resolved'`
   * anchor-update it was asked to. The live re-attachment/resolution stays
   * applied either way (it already happened in-memory) — this only surfaces
   * the reason so the Reviewer knows a retry is needed.
   */
  notifyAnchorUpdateResult(threadId: string, ok: boolean, error?: string): void;
}

export function initCommentResolve(content: HTMLElement, vscode: VsCodeApi): CommentResolveController {
  let docUri = '';
  const threads = new Map<string, ThreadAnchor>();
  const listeners: Array<() => void> = [];
  let timer: number | undefined;
  /**
   * AC6: false until `notifyContentRendered()`'s first call. A resolution
   * pass requested before then is deferred rather than run against whatever
   * `#content` happens to hold (empty, or a previous document) — resolving
   * early would fail every tier and float every thread for no real reason.
   */
  let contentReady = false;
  /** Which deferred pass to run once `contentReady` flips true; last request wins. */
  let deferredResolve: (() => void) | undefined;
  /**
   * AC7: bumped at the start of every full pass (`resolveAll` or a chunked
   * pass's setup). A chunked pass captures the value at its own start and
   * checks it before applying each chunk — a mismatch means some later pass
   * (the debounced `refresh`, a fresh sync, another load) has already
   * superseded it, so its remaining chunks are abandoned rather than
   * overwriting fresher results.
   */
  let resolveGeneration = 0;

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
    } else if (anchor.anchorId === '') {
      // A thread seeded from a host snapshot has no live id — `syncAll` seeds ''
      // deliberately, so the very next pass starts at tier 2. Stamping that empty
      // string onto the node would leave `[data-comment-anchor-id=""]` on it, and
      // every later thread's tier-1 lookup would then "find" this node: one
      // reload would collapse the whole file's threads onto whichever resolved
      // first. Mint a real id instead (block-map.ts also refuses to match '').
      anchor.anchorId = ensureCommentAnchorId(content, el);
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

  /**
   * US-23.3 AC2/AC3: the two derived status indicators, recomputed from the
   * resolution that just ran. They live here rather than in the popover so every
   * surface reads one answer, and so the dialog is armed by the TRANSITION into
   * floating — a plain "is it floating?" check would re-raise it on every settled
   * change for the rest of the session.
   *
   * Neither is posted to the host: both are webview-derived (only the DOM can
   * answer them) and neither moves the native thread's Range.
   */
  function applyStatusIndicators(anchor: ThreadAnchor, previousState: AnchorState): void {
    if (anchor.carrier === undefined) {
      // US-23.11 AC3: a floating thread's drift suggestion is SUPPRESSED, not
      // forced true. The anchor-lost confirmation below owns that question, and
      // asking it twice in two surfaces with two different answer sets is the
      // duplication AC3 removes.
      anchor.contentDrifted = false;
    } else {
      // Hysteresis (AC3): enter drift below the band's floor, leave it only at or
      // above the ceiling, so a retention hovering at the boundary cannot flicker
      // the strip across single keystrokes. The edge in play is passed down so the
      // retention pass can bail out cheaply when the answer is already decided.
      const band = driftBandFor(anchor.recordedText);
      const threshold = anchor.contentDrifted ? band.exit : band.enter;
      const retention = anchorTextRetention(
        anchor.recordedText,
        anchor.carrier.textContent ?? '',
        threshold
      );
      anchor.contentDrifted = retention < threshold;
    }
    if (anchor.state !== 'floating' || anchor.status === 'Closed') {
      // Promoted back out (an undo restored the text), or Closed — nothing left
      // to decide. Clearing here is also what re-arms the dialog for a genuine
      // later episode. US-23.11 AC4: the arming state is Open OR Resolved, so a
      // thread that floats after being resolved is still asked about; only a
      // Closed thread is never asked again.
      anchor.awaitingAnchorDecision = false;
    } else if (previousState !== 'floating') {
      anchor.awaitingAnchorDecision = true;
    }
  }

  /**
   * `origin` is set only for a transition this pass should also PERSIST
   * (US-23.13 AC1/AC2): a deliberate re-attach (`'manual'`, from `reattach`) or
   * an automatic promotion out of floating (`'resolved'`, from
   * `resolveAnchor`). Omitted for every other relocation, which stays
   * in-memory only, unchanged from before this AC.
   */
  function postUpdate(anchor: ThreadAnchor, origin?: 'manual' | 'resolved'): void {
    vscode.postMessage({
      type: 'commentAnchorUpdate',
      docUri,
      threadId: anchor.threadId,
      anchorId: anchor.anchorId,
      line: anchor.lastKnownLine,
      state: anchor.state,
      origin,
      offsetStart: anchor.offsetStart,
      offsetEnd: anchor.offsetEnd,
      recordedText: anchor.recordedText,
      nearestHeading: anchor.nearestHeading,
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

  /**
   * One thread's resolution, isolated: a throw from `resolveOne` (an
   * unexpected DOM shape, a corrupt candidate) floats just this thread and
   * never aborts the pass for every other one (AC6). Returns whether the
   * thread's observable state changed, so the caller can batch `postUpdate`/
   * `notifyChanged` decisions.
   */
  function resolveAnchor(anchor: ThreadAnchor, candidates: readonly AnchorCandidateNode[]): boolean {
    const previousLine = anchor.lastKnownLine;
    const previousState = anchor.state;
    const previousAnchorId = anchor.anchorId;
    const previousDrift = anchor.contentDrifted;
    const previousAwaiting = anchor.awaitingAnchorDecision;
    const previousCarrier = anchor.carrier;
    try {
      resolveOne(anchor, candidates);
      applyStatusIndicators(anchor, previousState);
    } catch (err) {
      console.warn(`[comment-resolve] resolveOne threw for thread ${anchor.threadId}; floating it.`, err);
      anchor.carrier = undefined;
      anchor.state = 'floating';
      applyStatusIndicators(anchor, previousState);
    }
    let changed = false;
    if (
      anchor.lastKnownLine !== previousLine ||
      anchor.state !== previousState ||
      anchor.anchorId !== previousAnchorId
    ) {
      // AC2: persist only a genuine transition OUT of floating — not every
      // relocation, and never a thread that merely stays exact/approximate —
      // so a long editing session doesn't inflate the sidecar with one line
      // per keystroke batch. `reattach` (AC1) covers the manual case; this is
      // the automatic one, and the two never both fire for the same
      // transition (this only runs when the PREVIOUS state was floating).
      const origin = previousState === 'floating' && anchor.state !== 'floating' ? 'resolved' : undefined;
      postUpdate(anchor, origin);
      changed = true;
    }
    if (
      anchor.contentDrifted !== previousDrift ||
      anchor.awaitingAnchorDecision !== previousAwaiting ||
      anchor.carrier !== previousCarrier
    ) {
      // Webview-only concerns: they must re-render the gutter pin/highlight/
      // popover, but there is nothing for the host to follow, so no postUpdate.
      // The carrier check matters even when line/state/id land back on the same
      // values as before a full re-render (US-23.13 AC4: a merge can resolve a
      // thread onto a brand-new element while reporting an unchanged state/line)
      // — every consumer reading `anchor.carrier` (gutter, highlight, popover)
      // would otherwise keep pointing at the stale, now-disconnected element
      // until some LATER, unrelated change happened to fire a notification.
      changed = true;
    }
    return changed;
  }

  /** Shared setup for a full pass: dedup clones, clear stale marks, gather this pass's candidates. */
  function prepareFullPass(): readonly AnchorCandidateNode[] {
    const keep = new Set<HTMLElement>();
    for (const anchor of threads.values()) {
      if (anchor.carrier?.isConnected) {
        keep.add(anchor.carrier);
      }
    }
    dedupeCommentAnchors(content, keep);
    clearStates();
    return anchorCandidates(content);
  }

  function resolveAll(): void {
    if (threads.size === 0) {
      return;
    }
    if (!contentReady) {
      // AC6: `#content` has not painted its first block yet — queue this pass
      // rather than resolve against an empty DOM.
      deferredResolve = resolveAll;
      return;
    }
    resolveGeneration++;
    const candidates = prepareFullPass();
    let changed = false;
    for (const anchor of threads.values()) {
      if (resolveAnchor(anchor, candidates)) {
        changed = true;
      }
    }
    if (changed) {
      notifyChanged();
    }
  }

  /**
   * AC7: the load-time twin of `resolveAll`, used when a `syncAll` reload
   * seeds more than `ANCHOR_LOAD_BATCH_THRESHOLD` new threads at once. Same
   * per-thread work, spread across `setTimeout(0)` ticks so a heavily-
   * commented file's first paint is never blocked, notifying (and so drawing
   * pins) after each completed chunk rather than only at the very end.
   */
  function resolveAllChunked(): void {
    if (threads.size === 0) {
      return;
    }
    if (!contentReady) {
      deferredResolve = resolveAllChunked;
      return;
    }
    const generation = ++resolveGeneration;
    const candidates = prepareFullPass();
    const pending = Array.from(threads.values());
    let index = 0;
    const step = (): void => {
      if (generation !== resolveGeneration) {
        // Superseded by a newer pass (a debounced `refresh`, another load, a
        // fresh `registerSeed`) — its results are already fresher than
        // anything this stale chunk could still apply. Stop, don't overwrite.
        return;
      }
      const end = Math.min(index + ANCHOR_RESOLVE_CHUNK_SIZE, pending.length);
      let changed = false;
      for (; index < end; index++) {
        if (resolveAnchor(pending[index], candidates)) {
          changed = true;
        }
      }
      if (changed) {
        notifyChanged();
      }
      if (index < pending.length) {
        window.setTimeout(step, 0);
      }
    };
    step();
  }

  function cancelPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  /**
   * Anchor resolution (position/state/carrier) stays this session's own — a sync
   * only ever refreshes the mutable, host-owned metadata.
   */
  function refreshFromSeed(existing: ThreadAnchor, seed: ThreadAnchorSeed): void {
    const statusChanged = existing.status !== seed.status;
    existing.status = seed.status;
    existing.replies = seed.replies;
    existing.body = seed.body;
    existing.author = seed.author;
    existing.createdAt = seed.createdAt;
    // US-23.14 AC4: refreshed alongside `body`, since the two always move
    // together — an `edit` line changes the displayed body AND stamps the
    // marker. Omitting it here left a freshly-edited comment showing its new
    // text with no "edited" marker until the next reload. (A reply's own
    // `editedAt` rides along inside `seed.replies` above.)
    existing.editedAt = seed.editedAt;
    existing.statusChanges = seed.statusChanges;
    if (seed.status === 'Closed') {
      // US-23.3 AC3, widened by US-23.11 AC4: only a Closed thread (from this
      // popover, from a second panel, or from the native UI) has nothing left to
      // decide about its lost anchor — an Open or Resolved one is still asked.
      // Cleared on the sync rather than waiting for the next resolution pass,
      // which a metadata-only sync does not run.
      existing.awaitingAnchorDecision = false;
    } else if (statusChanged && seed.status === 'Open' && existing.state === 'floating') {
      // ...and a REOPEN can put a thread back into Open while it is ALREADY
      // anchorless, which is exactly AC3's condition. `applyStatusIndicators`
      // arms only on the transition INTO floating, and this thread is past that,
      // so without arming here the question would never be asked again for the
      // rest of the session.
      //
      // A Reopen and nothing else. US-23.11 AC4 arms on crossing into floating
      // and re-arms on Reopen; it never asks for a re-arm on Resolve. Arming on
      // any status change re-armed the flag on the very snapshot that carries
      // the dialog's own "This was resolved" answer — the answer left the flag
      // deliberately armed for the host to clear, so the thread the user had
      // just answered was asked about again, and the second answer is refused
      // ("A Resolved thread cannot be resolved"). Arming on every SYNC, rather
      // than on a change, was worse still: the host re-pushes the whole snapshot
      // after each anchor update and reply, so "Decide later" came back seconds
      // later.
      existing.awaitingAnchorDecision = true;
    } else if (statusChanged) {
      // Any other transition out of Open answers the question by itself — this
      // is the self-heal `answerResolved` relies on, and what takes the dialog
      // down through the `onChange` guard once the host confirms.
      existing.awaitingAnchorDecision = false;
    }
  }

  /** A thread's initial derived state, before the first resolution pass reads the DOM. */
  function seedToAnchor(seed: ThreadAnchorSeed): ThreadAnchor {
    return { ...seed, state: 'exact', contentDrifted: false, awaitingAnchorDecision: false };
  }

  /** Shared by `register` and `syncThread`'s "not seen before" branch. */
  function registerSeed(seed: ThreadAnchorSeed): void {
    threads.set(seed.threadId, seedToAnchor(seed));
    // Resolve now so the new thread is stamped immediately, and drop any
    // pending pass — it would re-resolve the same DOM generation a second time
    // and post duplicate updates for every other thread.
    cancelPending();
    resolveAll();
    // A brand-new thread never changes state on its first pass, so resolveAll
    // posts nothing — but the panel's count still has to account for it.
    notifyChanged();
  }

  return {
    register(seed): void {
      registerSeed(seed);
    },
    syncThread(seed): void {
      const existing = threads.get(seed.threadId);
      if (!existing) {
        registerSeed(seed);
        return;
      }
      refreshFromSeed(existing, seed);
      notifyChanged();
    },
    syncAll(seeds): string[] {
      const keep = new Set(seeds.map((s) => s.threadId));
      const pruned: string[] = [];
      for (const threadId of Array.from(threads.keys())) {
        if (!keep.has(threadId)) {
          threads.delete(threadId);
          pruned.push(threadId);
        }
      }
      let newlySeeded = 0;
      for (const seed of seeds) {
        const existing = threads.get(seed.threadId);
        if (existing) {
          refreshFromSeed(existing, seed);
        } else {
          threads.set(seed.threadId, seedToAnchor(seed));
          newlySeeded++;
        }
      }
      if (newlySeeded > 0) {
        // Only a newly seeded thread needs the tiers run; a metadata-only
        // refresh leaves every anchor exactly where the last pass put it.
        cancelPending();
        // AC7: a reload seeding hundreds of threads at once runs the chunked
        // pass instead of blocking first paint with one synchronous sweep.
        if (newlySeeded > ANCHOR_LOAD_BATCH_THRESHOLD) {
          resolveAllChunked();
        } else {
          resolveAll();
        }
      }
      notifyChanged();
      return pruned;
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
    allThreads(): ThreadAnchor[] {
      return Array.from(threads.values());
    },
    reattach(threadId, el): boolean {
      const anchor = threads.get(threadId);
      if (!anchor || !content.contains(el)) {
        return false;
      }
      // US-23.11 AC3: the snapshot follows the anchor. A thread the user
      // deliberately re-anchored would otherwise read as permanently drifted
      // against the text of a paragraph that no longer exists. Rewritten BEFORE
      // `place`, so the offsets are clamped against the same node's length the
      // snapshot was just taken from. Persisted below via `postUpdate`'s
      // `'manual'` origin (US-23.13 AC1), so it also survives a reload.
      anchor.recordedText = el.textContent ?? '';
      // The offsets described a range inside the OLD node, so they name nothing in
      // the new one — left as they were, the popover's quote row would show an
      // arbitrary mid-word fragment of the newly chosen paragraph and present it
      // as "the text this comment refers to". A manual re-attach picks a NODE, not
      // a phrase, so the thread becomes a bare-node anchor (US-23.1 already allows
      // an empty range) and no quote is shown.
      anchor.offsetStart = 0;
      anchor.offsetEnd = 0;
      anchor.contentDrifted = false;
      // A manual re-attachment is the user's own answer to "where does this
      // belong", so it counts as exact — and the node now carries the id, which
      // makes tier 1 keep it there on every later pass.
      place(anchor, el, 'exact');
      // US-23.13 AC1: persist this re-attachment so it survives a reload —
      // this IS the manual write `reattach`'s own comment above used to flag
      // as unbuilt.
      postUpdate(anchor, 'manual');
      notifyChanged();
      return true;
    },
    clearAnchorDecision(threadId): void {
      const anchor = threads.get(threadId);
      if (!anchor || !anchor.awaitingAnchorDecision) {
        return;
      }
      anchor.awaitingAnchorDecision = false;
      notifyChanged();
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
    notifyContentRendered(): void {
      contentReady = true;
      // AC7: bump unconditionally, not only when flushing a deferred resolve —
      // `renderDocument` calling this replaces `content.innerHTML` wholesale,
      // which disconnects every element a still-running chunked pass captured
      // in its `candidates`/`carrier` references. Without bumping here, that
      // stale pass would keep applying results against the old (now-detached)
      // DOM for up to `ANCHOR_REEVAL_DEBOUNCE_MS` — until `refresh()`'s own
      // debounced `resolveAll()` finally ran and bumped it — instead of being
      // caught on its very next tick.
      resolveGeneration++;
      const run = deferredResolve;
      deferredResolve = undefined;
      run?.();
    },
    notifyAnchorUpdateResult(threadId, ok, error): void {
      if (ok || !threads.has(threadId)) {
        return;
      }
      showToast(error ?? 'This comment location could not be saved.');
    },
  };
}
