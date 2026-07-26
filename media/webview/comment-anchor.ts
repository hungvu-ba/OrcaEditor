/**
 * Req 23 US-23.4 tier 2: matching a comment's recorded text snapshot against the
 * text of the current document.
 *
 * Deliberately DOM-free and side-effect-free — the DOM half (walking candidates,
 * re-stamping ids, the other three tiers) lives in comment-resolve.ts, so this
 * scoring core can be exercised directly from test/unit.ts.
 */
import {
  ANCHOR_MAX_COMPARE_CHARS,
  ANCHOR_SHORT_TEXT_LEN,
  ANCHOR_SHORT_TEXT_THRESHOLD,
  ANCHOR_SIMILARITY_THRESHOLD,
} from './constants';

/** One node offered to tier 2, described by everything the match needs to know about it. */
export interface AnchorCandidate {
  /** The node's whole text content, as recorded_text was captured at creation time. */
  text: string;
  /** 1-based source line the node starts on, 0 when it maps to none. */
  line: number;
  /** Text of the nearest heading above the node, '' when there is none. */
  heading: string;
  /** Nesting depth below `#content` — separates a container from a lone child that reads identically. */
  depth: number;
}

/** What the comment recorded at creation time, used to break ties only (never as a match key). */
export interface AnchorHint {
  lastKnownLine: number;
  nearestHeading: string;
}

export interface AnchorMatch {
  index: number;
  score: number;
}

/** Float scores are compared for equality only within this slack. */
const SCORE_EPSILON = 1e-9;

/**
 * The comparable form of a piece of anchored text.
 *
 * NFC first (cross-platform trap in CLAUDE.md): the same prose typed on macOS
 * and on Windows can reach the file in different Unicode normalization forms,
 * and a raw comparison would score two identical-looking strings well below the
 * threshold. Whitespace is then collapsed so re-wrapping a paragraph's line
 * breaks — an edit that changes no words — does not move the score at all.
 */
export function normalizeAnchorText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Levenshtein edit distance over two normalized strings (two-row DP, O(min) memory). */
export function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a === '' || b === '') {
    return a.length + b.length;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/**
 * Similarity of two ALREADY-normalized strings, with the work bounded.
 *
 * Levenshtein is O(n·m) and runs for every candidate of every thread on every
 * settled change, while the recorded text is unbounded (a whole-document anchor
 * records the entire file). Two guards keep it off the "unthrottled whole-
 * document work in a hot path" list (CLAUDE.md): the length gate rejects
 * candidates that cannot reach the threshold no matter how they align (distance
 * is at least the length difference), and comparison is capped at
 * ANCHOR_MAX_COMPARE_CHARS, which is far past the point where prose stops being
 * discriminating.
 */
function scoreNormalized(left: string, right: string, threshold: number): number {
  if (left === right) {
    return 1;
  }
  const longest = Math.max(left.length, right.length);
  if (longest === 0) {
    return 0;
  }
  if (1 - Math.abs(left.length - right.length) / longest < threshold) {
    return 0;
  }
  const a = left.slice(0, ANCHOR_MAX_COMPARE_CHARS);
  const b = right.slice(0, ANCHOR_MAX_COMPARE_CHARS);
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/**
 * Character-level similarity in 0–1 (1 = identical after normalization), the
 * score US-23.4's thresholds are stated against. Both sides are normalized here
 * so callers can pass raw document text.
 */
export function similarity(a: string, b: string): number {
  const left = normalizeAnchorText(a);
  const right = normalizeAnchorText(b);
  if (left === '' && right === '') {
    return 1;
  }
  return scoreNormalized(left, right, 0);
}

/** The threshold `recordedText` has to clear — stricter for short text (US-23.4 PO decision). */
export function anchorThresholdFor(recordedText: string): number {
  return normalizeAnchorText(recordedText).length < ANCHOR_SHORT_TEXT_LEN
    ? ANCHOR_SHORT_TEXT_THRESHOLD
    : ANCHOR_SIMILARITY_THRESHOLD;
}

/**
 * Req 23 US-23.3 AC2: does the text a thread is anchored to RIGHT NOW still
 * match what was recorded when the comment was written?
 *
 * Separate from `pickAnchorCandidate` on purpose. Tier 2 answers "which node is
 * this comment's?", and it only runs when tier 1 has already failed — so an
 * Author editing the anchored paragraph in place keeps the structural id, gets
 * resolved by tier 1, and tier 2 never runs at all. That is the very case AC2
 * exists for ("the anchored text changes substantially after creation"), so the
 * indicator has to ask this question directly against the resolved node instead
 * of reading which tier fired.
 *
 * Uses the same normalization and the same per-length threshold as tier 2, so
 * "no longer matches" means exactly what it means there — and the threshold is
 * passed into the score so a candidate whose length alone rules it out costs no
 * Levenshtein pass (this runs once per thread on every settled change).
 *
 * An empty recorded text has nothing to drift from and always reads as matching.
 */
export function anchorTextMatches(recordedText: string, currentText: string): boolean {
  const recorded = normalizeAnchorText(recordedText);
  if (recorded === '') {
    return true;
  }
  const threshold = anchorThresholdFor(recorded);
  return scoreNormalized(recorded, normalizeAnchorText(currentText), threshold) >= threshold;
}

/** One row of the "Re-attach…" picker: a candidate, its index, and how close it reads. */
export interface ReattachTarget {
  index: number;
  /** Similarity to the recorded text in 0–1 — shown as a percentage, never applied automatically. */
  score: number;
}

export interface ReattachTargets {
  /** Closest matches first, capped — the picker's `Suggested` group. */
  suggested: ReattachTarget[];
  /** Everything that passed the filter, in document order. */
  all: ReattachTarget[];
}

/**
 * Req 23 US-23.4 AC4: what the "Re-attach…" picker lists for a floating thread.
 *
 * Suggestions are RANKED, never chosen — even a 92% match sits behind a click,
 * because the whole reason a thread is floating is that automatic matching
 * already failed. `filter` is matched on the normalized text, so a query typed
 * in a different Unicode form or with different spacing still matches.
 */
export function rankReattachTargets(
  recordedText: string,
  candidates: readonly AnchorCandidate[],
  filter: string,
  suggestedLimit = 3
): ReattachTargets {
  const needle = normalizeAnchorText(filter).toLowerCase();
  const recorded = normalizeAnchorText(recordedText);
  const all: ReattachTarget[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const text = normalizeAnchorText(candidates[index].text);
    if (needle !== '' && !text.toLowerCase().includes(needle)) {
      continue;
    }
    all.push({ index, score: recorded === '' ? 0 : scoreNormalized(recorded, text, 0) });
  }
  const suggested = all
    .filter((target) => target.score > 0)
    .slice()
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, suggestedLimit);
  return { suggested, all };
}

/**
 * Tier 2's answer: which candidate the recorded text belongs to, or null when
 * the tier fails and resolution must fall through to tier 3.
 *
 * The score alone decides which candidates are in the running. `nearestHeading`
 * and `lastKnownLine` are consulted ONLY to separate candidates that scored the
 * same (two structurally identical bullets in different sections) — never as a
 * match key of their own, since either can be stale after an edit. Heading goes
 * first because it survives text being inserted above; the line number is the
 * finer, more fragile discriminator. Still ambiguous after both means the tier
 * genuinely cannot tell, so it declines rather than guessing.
 */
export function pickAnchorCandidate(
  recordedText: string,
  candidates: readonly AnchorCandidate[],
  hint: AnchorHint
): AnchorMatch | null {
  const recorded = normalizeAnchorText(recordedText);
  if (recorded === '' || candidates.length === 0) {
    return null;
  }
  const threshold = anchorThresholdFor(recorded);

  let best = -1;
  const scores = candidates.map((candidate) => {
    const score = scoreNormalized(recorded, normalizeAnchorText(candidate.text), threshold);
    if (score >= threshold && score > best) {
      best = score;
    }
    return score;
  });
  if (best < 0) {
    return null;
  }

  let running = scores
    .map((_, index) => index)
    .filter((index) => Math.abs(scores[index] - best) <= SCORE_EPSILON);
  if (running.length > 1 && hint.nearestHeading !== '') {
    // Normalized, not raw: the recorded heading and the current one can differ
    // by Unicode form or whitespace alone (the cross-platform trap this file's
    // own text comparison exists to neutralize).
    const wanted = normalizeAnchorText(hint.nearestHeading);
    const sameHeading = running.filter((index) => normalizeAnchorText(candidates[index].heading) === wanted);
    if (sameHeading.length > 0) {
      running = sameHeading;
    }
  }
  if (running.length > 1 && hint.lastKnownLine > 0) {
    const distanceOf = (index: number): number => Math.abs(candidates[index].line - hint.lastKnownLine);
    const nearest = Math.min(...running.map(distanceOf));
    running = running.filter((index) => distanceOf(index) === nearest);
  }
  if (running.length > 1) {
    // A blockquote and its only paragraph read identically AND report the same
    // source line — nothing above can separate them, but the innermost node is
    // unambiguously the more specific answer. Two SIBLINGS share a depth, so
    // this never turns a genuine ambiguity into a guess.
    const deepest = Math.max(...running.map((index) => candidates[index].depth));
    running = running.filter((index) => candidates[index].depth === deepest);
  }
  return running.length === 1 ? { index: running[0], score: best } : null;
}
