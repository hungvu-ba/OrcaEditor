/**
 * Req 23 US-23.5: the `.orca-comments.jsonl` sidecar's on-disk format — pure
 * functions only (no `vscode`, no `fs` import), so test/unit.ts can exercise
 * every rule directly the way it does `comment-utils.ts`.
 *
 * The file is append-only: one JSON object per line, LF-terminated, and no line
 * is ever rewritten (US-23.6). That is what lets two reviewers acting on the
 * same thread each add their own line with no shared line to conflict over
 * (AC2/AC3) — a delete is a `delete` tombstone, and a status change is a
 * `status-change` line, never an edit of the original `comment` line.
 *
 * LF is used regardless of the paired `.md`'s `document.eol`: this is a machine
 * sidecar, not prose reconciled to the document's line ending.
 */
import { normalizeAssetName } from '../text-utils';

/** Bumped only when a line's shape changes incompatibly. */
const SIDECAR_SCHEMA_VERSION = 1;

/** Appended to the `.md`'s own file name — the sidecar is its 1:1 sibling (AC1). */
const SIDECAR_SUFFIX = '.orca-comments.jsonl';

/** The Open → Resolved → Closed axis (US-23.3). Orthogonal to anchor state (US-23.4). */
export type CommentStatus = 'Open' | 'Resolved' | 'Closed';

/** Fields every line carries. */
interface SidecarEnvelope {
  schema_version: number;
  /** This line's own identity — a host-minted uuid, never the webview's session-scoped threadId. */
  id: string;
  author: string;
  /** ISO-8601 UTC. */
  timestamp: string;
}

/**
 * What tiers 2–3 (US-23.4) need to find the anchored node again after a reopen.
 * The session-scoped structural id is deliberately absent — US-23.4 AC1 states it
 * is never a durable key, so only what survives a fresh parse is written here.
 */
export interface SidecarAnchor {
  offset_start: number;
  offset_end: number;
  recorded_text: string;
  last_known_line: number;
  nearest_heading: string;
}

/** The thread-creating line (US-23.1). */
export interface CommentLine extends SidecarEnvelope {
  type: 'comment';
  body: string;
  anchor: SidecarAnchor;
  /** Set only on a FOLDED (in-memory) copy when an `edit` line named this comment — never present on a raw parsed line (US-23.14 AC4). The winning edit's timestamp. */
  editedAt?: string;
}

/** A reply under a thread (US-23.2). */
export interface ReplyLine extends SidecarEnvelope {
  type: 'reply';
  parent_comment_id: string;
  body: string;
  /** Set only on a FOLDED (in-memory) copy when an `edit` line named this reply — never present on a raw parsed line (US-23.14 AC4). The winning edit's timestamp. */
  editedAt?: string;
}

/** An Open/Resolved/Closed transition (US-23.3). */
export interface StatusChangeLine extends SidecarEnvelope {
  type: 'status-change';
  parent_comment_id: string;
  from_status: CommentStatus;
  to_status: CommentStatus;
}

/** A tombstone excluding an earlier `comment` or `reply` line (US-23.2 PO decision). */
export interface DeleteLine extends SidecarEnvelope {
  type: 'delete';
  target_id: string;
}

/**
 * A persisted re-attachment or automatic resolution of a thread's anchor
 * (US-23.13 AC1/AC2) — appended, never a rewrite of the original `comment`
 * line's own `anchor`. `origin` records how the transition happened: a
 * deliberate re-attach (drag, `⋯` picker, keyboard walk) is `'manual'`; a tier
 * promoting a floating thread back onto the document on its own is
 * `'resolved'`. Only one of the two is ever written for a given transition —
 * whichever fires first, the other never writes a second, redundant line for
 * it.
 */
export interface AnchorUpdateLine extends SidecarEnvelope {
  type: 'anchor-update';
  parent_comment_id: string;
  origin: 'manual' | 'resolved';
  anchor: SidecarAnchor;
}

/**
 * An append-only correction of an earlier `comment` or `reply` line's `body`
 * (US-23.14 PO decision) — mirrors `DeleteLine`'s tombstone pattern rather than
 * rewriting the target line (US-23.5 AC2, US-23.6 AC1/AC5). `target_id` names
 * either a `comment` or a `reply` line; the target's own `author`/`timestamp`
 * are never overwritten, so original attribution survives every edit.
 */
export interface EditLine extends SidecarEnvelope {
  type: 'edit';
  target_id: string;
  body: string;
}

export type SidecarLine = CommentLine | ReplyLine | StatusChangeLine | DeleteLine | AnchorUpdateLine | EditLine;

/** One reassembled thread, ready to become a `vscode.CommentThread`. */
export interface SidecarThread {
  /** The creating `comment` line's id — the durable handle for this thread. */
  id: string;
  comment: CommentLine;
  /** Timestamp-ordered, tombstoned replies removed. */
  replies: ReplyLine[];
  /** Timestamp-ordered. */
  statusChanges: StatusChangeLine[];
  /** Derived by folding `statusChanges`; never read off the comment line. */
  status: CommentStatus;
  /**
   * Where the thread currently believes it is anchored (US-23.13 AC1/AC2).
   * Starts as `comment.anchor` and is replaced by the latest folded
   * `anchor-update` line, resolved by FILE/APPEND order — never by comparing
   * `timestamp` (a fast retry or a clock with coarse resolution must never
   * decide the winner).
   */
  anchor: SidecarAnchor;
}

export interface FoldedSidecar {
  /** Ordered by their comment's timestamp — oldest thread first. */
  threads: SidecarThread[];
  /**
   * A line whose `parent_comment_id`/`target_id` names no known `comment`
   * (or, for `delete`/`edit`, no known `comment` or `reply` either) — the
   * chain is exactly one level deep for every line type alike (US-23.16 AC7).
   * Never a `comment` line itself — a comment is always the root, never
   * something that points elsewhere.
   */
  orphans: (ReplyLine | StatusChangeLine | AnchorUpdateLine | DeleteLine | EditLine)[];
  warnings: string[];
  /**
   * A sidecar exists but could not be read (permissions, a directory in its
   * place, a transient I/O error). Distinct from an empty result: "no comments"
   * and "could not tell" must never look the same to the caller, or a read
   * failure silently presents the file as uncommented.
   */
  unreadable?: boolean;
}

export interface ParsedSidecar {
  lines: SidecarLine[];
  warnings: string[];
}

/** The sidecar file name for a `.md` file name — `foo.md` → `foo.md.orca-comments.jsonl`. */
export function sidecarNameFor(mdFileName: string): string {
  return `${mdFileName}${SIDECAR_SUFFIX}`;
}

/**
 * The timestamped-backup sibling name for a sidecar a rename would otherwise
 * overwrite (US-23.20 AC8) — displaces rather than deletes it. `stamp` must
 * already be filesystem-safe (no `:`); the caller derives it.
 */
export function sidecarBackupNameFor(sidecarFileName: string, stamp: string): string {
  return `${sidecarFileName}.${stamp}.bak`;
}

/**
 * Whether two sidecar file names denote the same file. Never compare a sidecar
 * name with a raw `===`.
 *
 * Delegates to `normalizeAssetName` — the codebase's existing RAW on-disk
 * basename normalizer (X-1) — rather than a second, divergent one. That is
 * load-bearing, not just deduplication: its doc comment records why an on-disk
 * name must NOT be percent-decoded (a literal `%20` in a filename is real, so
 * decoding conflates `a%20b.md` with `a b.md`). Since this comparison authorises
 * a rename, a match it invents destroys real data.
 *
 * What it does apply is the step that matters here: NFC, because a Vietnamese
 * requirement file named on macOS is often stored decomposed while the same name
 * typed on Windows is composed, and on a byte-exact filesystem those are two
 * different directory entries for what the user sees as one name.
 */
export function sidecarNameMatches(candidate: string, expected: string, caseInsensitive: boolean): boolean {
  return normalizeAssetName(candidate, caseInsensitive) === normalizeAssetName(expected, caseInsensitive);
}

/** Whether a directory entry is a comment sidecar at all. */
export function isSidecarName(name: string): boolean {
  return normalizeAssetName(name, true).endsWith(SIDECAR_SUFFIX.toLowerCase());
}

/**
 * The `.md` file name a sidecar belongs to, or null when the name is not a
 * sidecar. Lets a caller check whether a candidate sidecar is genuinely orphaned
 * before treating it as drift.
 */
export function mdNameForSidecar(sidecarName: string): string | null {
  return isSidecarName(sidecarName) ? sidecarName.slice(0, -SIDECAR_SUFFIX.length) : null;
}

/**
 * Whether a loaded sidecar belongs to the document it was found next to (AC7
 * clause 2): a `.md` deleted and later recreated at the same path must NOT
 * silently inherit the old file's threads.
 *
 * - `belongs` — at least one recorded text is still present, so this is the file
 *   that was commented on. Per-thread accuracy is US-23.4's job, not this one's.
 * - `foreign` — positive evidence: no recorded text is present at all.
 * - `unknown` — nothing discriminating to test, so no claim is made.
 */
export type SidecarBelonging = 'belongs' | 'foreign' | 'unknown';

/**
 * The discriminating floor for the MULTI-thread case (AC5): a single
 * boilerplate-length hit (this repo's own template headings, "Acceptance
 * Criteria", "Given / When / Then") is not accepted as proof on its own, so
 * more than one thread must clear this floor AND match. Untuned default,
 * clears typical boilerplate phrases.
 */
const BELONGING_MIN_DISCRIMINATING_CHARS = 40;

/**
 * The floor for the SINGLE-thread case (AC5): a document with exactly one
 * comment thread has no second thread to corroborate a match, so that lone
 * thread's match is accepted alone once it clears this stricter floor — high
 * enough that a lone match is still strong proof, not a lowered bar in
 * disguise.
 */
const BELONGING_SINGLE_THREAD_MIN_CHARS = 80;

/**
 * A comparison form that survives the domain gap between the two sides: a
 * `recorded_text` is the anchored DOM node's TEXT, while the document here is RAW
 * markdown. Comparing them directly fails on ordinary content — measured, for a
 * heading `## Title` vs its recorded `Title`, normalized similarity is 0.625, and
 * for `See [the spec](a.md)` it is 0.600, both under US-23.4's 0.8 tier-2
 * threshold. Dropping every non-letter/digit closes that gap: `## Title` and
 * `Title` both reduce to `title`.
 *
 * Case is folded too. This is a "is it the same document at all" test, not the
 * anchor-precision test US-23.4 performs on real DOM text.
 */
function toBelongingText(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deliberately NOT decided by the `.md`'s creation date (evaluated and rejected
 * 2026-07-26): `git clone` and `git checkout` both recreate the file, so its
 * birth time becomes "now" while its comments stay older — the heuristic would
 * discard every comment on every file after any fresh clone, which is exactly the
 * git-shared workflow AC1 designs for. It is also unavailable on some Linux
 * filesystems, and NTFS file-system tunneling preserves the old creation time when
 * a file is recreated under the same name within 15 s — failing in the very case
 * this function exists to catch. Content is the reliable signal; a timestamp is not.
 */
export function sidecarBelongsToDocument(
  threads: readonly SidecarThread[],
  documentText: string
): SidecarBelonging {
  const haystack = toBelongingText(documentText);
  // US-23.13 AC1/AC2: `thread.anchor` is the folded CURRENT position (a
  // persisted re-attach/auto-resolve if one exists), not the immutable
  // `thread.comment.anchor` creation-time snapshot — a thread deliberately
  // re-attached away from since-deleted text must be tested against where it
  // now points, not where it used to.
  const needles = threads.map((thread) => toBelongingText(thread.anchor.recorded_text));

  // AC5: a document with exactly one thread has no second thread to
  // corroborate a match, so it gets its own, stricter floor.
  if (needles.length === 1) {
    const needle = needles[0];
    if (needle.length < BELONGING_SINGLE_THREAD_MIN_CHARS) {
      return 'unknown';
    }
    return haystack.includes(needle) ? 'belongs' : 'foreign';
  }

  // AC5/AC6: only texts long enough to actually discriminate are counted —
  // this same rule, unchanged, is what makes a partial-rewrite (AC6) safe:
  // whichever threads still match exactly keep counting normally, no separate
  // signal needed.
  const discriminating = needles.filter((needle) => needle.length >= BELONGING_MIN_DISCRIMINATING_CHARS);
  if (discriminating.length === 0) {
    // Nothing usable either way — never claim `foreign` on a guess, since that
    // would hide real comments.
    return 'unknown';
  }
  // Counted as DISTINCT matched texts, not matched threads: two threads that
  // recorded the identical boilerplate phrase (this repo's own template text,
  // repeated verbatim across sections) must not count as two corroborating
  // pieces of evidence — that is exactly the single-boilerplate-hit false
  // positive AC5 exists to prevent (review finding, 2026-07-28).
  const matches = new Set(discriminating.filter((needle) => haystack.includes(needle))).size;
  if (matches > 1) {
    return 'belongs';
  }
  if (matches === 1) {
    // Real evidence, but a single hit is exactly the boilerplate-recreated-file
    // case AC5 guards against — not enough to prove belonging, but not
    // evidence AGAINST it either, so this is `unknown`, not `foreign`.
    return 'unknown';
  }
  return 'foreign';
}

/**
 * One record as the single line to append. `JSON.stringify` escapes any newline
 * inside a body/author as `\n`, so the result is always exactly one physical
 * line — that is what keeps this a line-oriented format even for multi-line
 * comment text. The trailing newline is part of the write (AC3): every append
 * lands after a completed line, so two concurrent appends are non-overlapping
 * diff hunks rather than a collision on one line region.
 */
export function serializeSidecarLine(line: SidecarLine): string {
  return `${JSON.stringify(line)}\n`;
}

/** Assemble the thread-creating line for a new comment. Caller supplies id/timestamp so this stays pure. */
export function buildCommentLine(input: {
  id: string;
  author: string;
  timestamp: string;
  body: string;
  anchor: SidecarAnchor;
}): CommentLine {
  return {
    schema_version: SIDECAR_SCHEMA_VERSION,
    type: 'comment',
    id: input.id,
    author: input.author,
    timestamp: input.timestamp,
    body: input.body,
    anchor: input.anchor,
  };
}

/** Assemble a reply line (US-23.2). Caller supplies id/timestamp so this stays pure. */
export function buildReplyLine(input: {
  id: string;
  parentCommentId: string;
  author: string;
  timestamp: string;
  body: string;
}): ReplyLine {
  return {
    schema_version: SIDECAR_SCHEMA_VERSION,
    type: 'reply',
    id: input.id,
    parent_comment_id: input.parentCommentId,
    author: input.author,
    timestamp: input.timestamp,
    body: input.body,
  };
}

/**
 * Assemble an Open/Resolved/Closed transition line (US-23.3). Caller supplies
 * id/timestamp so this stays pure.
 *
 * `from_status` is recorded as well as `to_status` even though the fold only
 * reads the latter: a Reopen has to say which of Resolved/Closed it undid
 * (US-23.3 AC5), and the pair is what makes a merged sidecar's history
 * readable after two authors' lines interleave.
 */
export function buildStatusChangeLine(input: {
  id: string;
  parentCommentId: string;
  author: string;
  timestamp: string;
  fromStatus: CommentStatus;
  toStatus: CommentStatus;
}): StatusChangeLine {
  return {
    schema_version: SIDECAR_SCHEMA_VERSION,
    type: 'status-change',
    id: input.id,
    parent_comment_id: input.parentCommentId,
    author: input.author,
    timestamp: input.timestamp,
    from_status: input.fromStatus,
    to_status: input.toStatus,
  };
}

/** Assemble a delete tombstone (US-23.2 PO decision). Caller supplies id/timestamp so this stays pure. */
export function buildDeleteLine(input: {
  id: string;
  targetId: string;
  author: string;
  timestamp: string;
}): DeleteLine {
  return {
    schema_version: SIDECAR_SCHEMA_VERSION,
    type: 'delete',
    id: input.id,
    target_id: input.targetId,
    author: input.author,
    timestamp: input.timestamp,
  };
}

/** Assemble an anchor-update line (US-23.13 AC1/AC2). Caller supplies id/timestamp so this stays pure. */
export function buildAnchorUpdateLine(input: {
  id: string;
  parentCommentId: string;
  author: string;
  timestamp: string;
  origin: 'manual' | 'resolved';
  anchor: SidecarAnchor;
}): AnchorUpdateLine {
  return {
    schema_version: SIDECAR_SCHEMA_VERSION,
    type: 'anchor-update',
    id: input.id,
    parent_comment_id: input.parentCommentId,
    author: input.author,
    timestamp: input.timestamp,
    origin: input.origin,
    anchor: input.anchor,
  };
}

/** Assemble an edit line (US-23.14). Caller supplies id/timestamp so this stays pure. */
export function buildEditLine(input: {
  id: string;
  targetId: string;
  author: string;
  timestamp: string;
  body: string;
}): EditLine {
  return {
    schema_version: SIDECAR_SCHEMA_VERSION,
    type: 'edit',
    id: input.id,
    target_id: input.targetId,
    author: input.author,
    timestamp: input.timestamp,
    body: input.body,
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isStatus(value: unknown): value is CommentStatus {
  return value === 'Open' || value === 'Resolved' || value === 'Closed';
}

function isAnchorOrigin(value: unknown): value is AnchorUpdateLine['origin'] {
  return value === 'manual' || value === 'resolved';
}

function isAnchor(value: unknown): value is SidecarAnchor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const a = value as Record<string, unknown>;
  return (
    isInt(a.offset_start) &&
    isInt(a.offset_end) &&
    isString(a.recorded_text) &&
    isInt(a.last_known_line) &&
    isString(a.nearest_heading)
  );
}

/**
 * Narrow one parsed JSON value to a known line, or null when it is not one.
 * The sidecar is committed to git and can arrive hand-edited or merged, so a
 * line is validated structurally rather than trusted for having parsed as JSON.
 *
 * An unfamiliar `schema_version` is not rejected on the number alone: a future
 * line whose shape still satisfies these checks loads fine, and one whose shape
 * differs is skipped by the same checks — silently dropping every line from a
 * newer writer would lose more than it protects.
 */
function asSidecarLine(value: unknown): SidecarLine | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const line = value as Record<string, unknown>;
  if (!isInt(line.schema_version) || line.schema_version < 1) {
    return null;
  }
  // An empty id could never be addressed again by a reply or a tombstone.
  if (!isString(line.id) || line.id === '' || !isString(line.author) || !isString(line.timestamp)) {
    return null;
  }
  switch (line.type) {
    case 'comment':
      return isString(line.body) && isAnchor(line.anchor) ? (line as unknown as CommentLine) : null;
    case 'reply':
      return isString(line.parent_comment_id) && line.parent_comment_id !== '' && isString(line.body)
        ? (line as unknown as ReplyLine)
        : null;
    case 'status-change':
      return isString(line.parent_comment_id) &&
        line.parent_comment_id !== '' &&
        isStatus(line.from_status) &&
        isStatus(line.to_status)
        ? (line as unknown as StatusChangeLine)
        : null;
    case 'delete':
      return isString(line.target_id) && line.target_id !== '' ? (line as unknown as DeleteLine) : null;
    case 'edit':
      return isString(line.target_id) && line.target_id !== '' && isString(line.body)
        ? (line as unknown as EditLine)
        : null;
    case 'anchor-update':
      return isString(line.parent_comment_id) &&
        line.parent_comment_id !== '' &&
        isAnchorOrigin(line.origin) &&
        isAnchor(line.anchor)
        ? (line as unknown as AnchorUpdateLine)
        : null;
    default:
      return null;
  }
}

/**
 * Every readable line of a sidecar's text, in on-disk order. A line that fails
 * to parse (or is not a recognised record) is skipped with a warning instead of
 * aborting the whole file's load (AC4) — one truncated final line from a crashed
 * append, or one conflict marker left by a bad merge, must not cost every other
 * comment in the file.
 */
export function parseSidecarText(text: string): ParsedSidecar {
  const lines: SidecarLine[] = [];
  const warnings: string[] = [];
  // Split on LF only — the writer never emits CRLF. `trim()` below absorbs a
  // stray CR that a Windows editor or a git merge may have left behind.
  text.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      // The trailing newline every append writes, or a blank line from a merge.
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      warnings.push(`line ${index + 1}: not valid JSON, skipped`);
      return;
    }
    const line = asSidecarLine(parsed);
    if (line === null) {
      warnings.push(`line ${index + 1}: not a recognised sidecar record, skipped`);
      return;
    }
    lines.push(line);
  });
  return { lines, warnings };
}

/**
 * Author comparison for the delete-ownership check (US-23.11 AC9).
 *
 * Normalizes decode → trim → NFC → case-fold on both sides, per this repo's
 * cross-platform rule: the same name typed on macOS (often NFD) and on Windows
 * (NFC) must count as one person, and neither a trailing space left in the
 * setting nor a capitalized first letter may split one person into two. Not a
 * security boundary — `orcaEditor.comments.authorName` is free text, so this is
 * a soft nudge only; US-23.11 AC1 removed the status-action gate that used to
 * lean on it.
 *
 * AC9's other half — "an empty or whitespace-only `orcaEditor.comments.authorName`
 * never matches any stored author" — is scoped to the CURRENT USER's name, so it
 * lives at the callers that have one (`deleteRejection`, the popover), not here.
 * Two blank names still compare equal in this function on purpose: the loader's
 * tombstone check compares two STORED authors, and refusing a blank-vs-blank
 * match there would silently stop a `delete` line from deleting its target,
 * resurrecting a comment the user had removed.
 *
 * Exported (not local to this fold) so US-23.2's own delete-gating in
 * `comment-utils.ts`/`commentController.ts` uses this exact comparison rather
 * than a second, potentially-diverging copy.
 */
export function sameAuthor(a: string, b: string): boolean {
  return normalizeAuthorName(a) === normalizeAuthorName(b);
}

/**
 * The one normalizer every author-name comparison goes through.
 *
 * `decodeURIComponent` is attempted first because a name can reach here from a
 * `vscode.Uri`-derived string; a malformed escape sequence throws, in which case
 * the raw text is the best available answer.
 */
function normalizeAuthorName(name: string): string {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // Not percent-encoded (or malformed) — compare the literal text.
  }
  // NFC last as well as first: case-folding can itself denormalize (İ U+0130
  // lowercases to `i` + a combining dot), so normalizing only before it would
  // leave two spellings of one name comparing unequal.
  return decoded.trim().normalize('NFC').toLowerCase().normalize('NFC');
}

/**
 * Chronological order. `Array.prototype.sort` is stable, so equal timestamps keep
 * their disk order.
 *
 * An unparseable timestamp sorts FIRST, not last. Sorting it last would let one
 * malformed field outrank every valid one: the status fold takes the last
 * transition, so a garbage timestamp on a `status-change` would decide a thread's
 * status forever and a real, later Reopen could never win. Treating undated data
 * as oldest keeps it from overriding data that is actually dated.
 */
function byTimestamp(a: { timestamp: string }, b: { timestamp: string }): number {
  const parsedA = Date.parse(a.timestamp);
  const parsedB = Date.parse(b.timestamp);
  const keyA = Number.isNaN(parsedA) ? Number.NEGATIVE_INFINITY : parsedA;
  const keyB = Number.isNaN(parsedB) ? Number.NEGATIVE_INFINITY : parsedB;
  // Both unparseable: equal, so the stable sort keeps disk order (`a - b` would
  // be NaN here, which the spec coerces to +0 — spelled out rather than relied on).
  if (keyA === keyB) {
    return 0;
  }
  return keyA - keyB;
}

/**
 * The winning `edit` line for one target (US-23.14 AC3): the latest `timestamp`
 * wins; an exact tie resolves by file/append order (`byTimestamp`'s stable sort
 * keeps disk order among equal keys, so the last entry after sorting is the
 * latest-appended one among the tied maxima) — never by re-comparing equal
 * timestamps.
 */
function resolveEdit(edits: EditLine[] | undefined): EditLine | null {
  if (!edits || edits.length === 0) {
    return null;
  }
  const sorted = edits.slice().sort(byTimestamp);
  return sorted[sorted.length - 1];
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * Cross-type duplicate-`id` resolution (AC1/AC2): a double merge or a
 * cherry-pick can produce duplicate lines of ANY type sharing one `id`, not
 * just within one type. First-seen wins, defined as the lowest `timestamp`
 * (`byTimestamp` already sorts unparseable as oldest and ties as on-disk
 * order — exactly this definition), the rest are flagged as not applied.
 * Discarded duplicates are dropped in memory only; the sidecar file itself is
 * never rewritten (US-23.6's append-only rule stays intact).
 *
 * `deduped` is built with a SECOND pass over `lines`, keeping a line only when
 * it IS (by reference) the winner computed for its id — never by pushing
 * winners in the order their id was first grouped. A winning duplicate can be
 * the LAST-occurring copy of its id (an earlier timestamp appended later), and
 * grouping order would then place it ahead of an unrelated, different-id line
 * that truly sits between the two duplicates on disk — corrupting the
 * relative on-disk order `anchor-update`'s last-one-wins fold and `edit`'s
 * timestamp-tie file-order tie-break both depend on (review finding, 2026-07-28).
 */
function dedupeById(lines: readonly SidecarLine[]): { deduped: SidecarLine[]; warnings: string[] } {
  const byId = new Map<string, SidecarLine[]>();
  for (const line of lines) {
    pushInto(byId, line.id, line);
  }
  const winners = new Map<string, SidecarLine>();
  const warnings: string[] = [];
  for (const group of byId.values()) {
    const [winner, ...rest] = group.slice().sort(byTimestamp);
    winners.set(winner.id, winner);
    for (const discarded of rest) {
      warnings.push(
        `duplicate id ${discarded.id} (${discarded.type}): kept the first-seen ${winner.type} line, this one not applied`
      );
    }
  }
  const deduped = lines.filter((line) => winners.get(line.id) === line);
  return { deduped, warnings };
}

/**
 * Reassemble lines into threads (AC4). Ordering comes from `timestamp`, never
 * from on-disk order, so a git merge that interleaves two authors' lines still
 * displays one coherent conversation.
 *
 * Tombstones are applied last, after grouping and dedup, per the requirement's
 * loader semantics: a `delete` naming a comment cascades to its replies and
 * status changes; one naming a reply removes only that reply; one naming an
 * unknown or already-deleted id is a no-op, so a stray delete from a race
 * between two sessions cannot error the load.
 */
export function foldSidecarRecords(lines: readonly SidecarLine[]): FoldedSidecar {
  // AC1/AC2: resolved up front, across every line type at once, so none of the
  // per-type buckets below ever see a colliding id.
  const { deduped, warnings } = dedupeById(lines);
  const comments = new Map<string, CommentLine>();
  const replyById = new Map<string, ReplyLine>();
  const repliesByParent = new Map<string, ReplyLine[]>();
  const statusByParent = new Map<string, StatusChangeLine[]>();
  const anchorUpdatesByParent = new Map<string, AnchorUpdateLine[]>();
  const editsByTarget = new Map<string, EditLine[]>();
  const tombstones: DeleteLine[] = [];

  for (const line of deduped) {
    switch (line.type) {
      case 'comment':
        comments.set(line.id, line);
        break;
      case 'reply':
        replyById.set(line.id, line);
        pushInto(repliesByParent, line.parent_comment_id, line);
        break;
      case 'status-change':
        pushInto(statusByParent, line.parent_comment_id, line);
        break;
      case 'delete':
        tombstones.push(line);
        break;
      case 'edit':
        // Pushed in on-disk order; resolveEdit() below sorts by timestamp and
        // relies on this order only to break an exact-timestamp tie (AC3).
        pushInto(editsByTarget, line.target_id, line);
        break;
      case 'anchor-update':
        // Pushed in on-disk order (the loop above walks `deduped` in file
        // order) — last-one-wins below reads the array's LAST entry, never
        // sorts it by `timestamp` (US-23.13 AC1's own rule: a fast retry or a
        // coarse-resolution clock must never decide the winner).
        pushInto(anchorUpdatesByParent, line.parent_comment_id, line);
        break;
    }
  }

  // AC7: a reply whose OWN parent doesn't resolve to a comment is itself an
  // orphan (the reply-to-reply case AC7 guards against). A delete/edit naming
  // such a reply as its target must not be treated as "resolved" either — else
  // it is silently applied-and-hidden (the reply drops out of `orphans` via
  // `deletedReplies`, and the delete/edit itself never reaches `orphans`
  // either, so BOTH lines vanish with no trace) instead of routing to orphans
  // (review finding, 2026-07-28).
  const orphanedReplyIds = new Set<string>();
  for (const [parentId, group] of repliesByParent) {
    if (!comments.has(parentId)) {
      for (const orphanedReply of group) {
        orphanedReplyIds.add(orphanedReply.id);
      }
    }
  }
  const resolvesToRealLine = (id: string): boolean =>
    comments.has(id) || (replyById.has(id) && !orphanedReplyIds.has(id));

  // AC8: no authority check — a `delete` is applied regardless of whose name
  // is on it, per Requirement 23's "no line type carries an authority check"
  // rule (the same call US-23.11 already made for `status-change`).
  const deletedComments = new Set<string>();
  const deletedReplies = new Set<string>();
  for (const tombstone of tombstones) {
    if (comments.has(tombstone.target_id)) {
      deletedComments.add(tombstone.target_id);
      continue;
    }
    if (replyById.has(tombstone.target_id) && !orphanedReplyIds.has(tombstone.target_id)) {
      deletedReplies.add(tombstone.target_id);
      continue;
    }
    // Unknown target, or a target that is itself an orphaned reply: idempotent
    // no-op here, not a warning — two sessions racing on the same delete is
    // legitimate. Routed to `orphans` below (AC7) instead of vanishing silently.
  }

  const threads: SidecarThread[] = [];
  for (const [id, comment] of comments) {
    if (deletedComments.has(id)) {
      // Deleting a thread deletes its replies and status changes with it.
      continue;
    }
    const replies = (repliesByParent.get(id) ?? [])
      .filter((reply) => !deletedReplies.has(reply.id))
      .sort(byTimestamp)
      .map((reply) => {
        // Unknown/tombstoned targets never reach here (id was filtered above),
        // so a stray edit for one is a silent no-op — same tolerance `delete`
        // already has (AC5).
        const winningEdit = resolveEdit(editsByTarget.get(reply.id));
        return winningEdit ? { ...reply, body: winningEdit.body, editedAt: winningEdit.timestamp } : reply;
      });
    const recordedChanges = (statusByParent.get(id) ?? []).slice().sort(byTimestamp);
    // Last-write-wins on `to_status`, defaulting to Open when nothing has been
    // recorded: the current status is always this fold, never a stored field on
    // the comment line. US-23.11 AC6: `from_status` is a guard, not a note — a
    // line whose recorded origin disagrees with what the strictly-earlier lines
    // folded to is SKIPPED and the prior status retained, so a hand-edited file
    // or a git merge interleaving two branches cannot land an illegal jump
    // (Open → Closed) that no control would ever have offered. The disagreement
    // is still surfaced as a warning; the skipped line is also dropped from the
    // thread's transition list, since it never took effect.
    const statusChanges: StatusChangeLine[] = [];
    let status: CommentStatus = 'Open';
    for (const change of recordedChanges) {
      if (change.from_status !== status) {
        warnings.push(
          `status-change ${change.id}: recorded a move from ${change.from_status}, but the thread was ${status} — the transition was skipped`
        );
        continue;
      }
      statusChanges.push(change);
      status = change.to_status;
    }
    // Last-one-wins by file/append order (the array is already in that order —
    // see the push above), never by `timestamp`.
    const anchorUpdates = anchorUpdatesByParent.get(id);
    const anchor = anchorUpdates && anchorUpdates.length > 0 ? anchorUpdates[anchorUpdates.length - 1].anchor : comment.anchor;
    const winningCommentEdit = resolveEdit(editsByTarget.get(id));
    const foldedComment = winningCommentEdit
      ? { ...comment, body: winningCommentEdit.body, editedAt: winningCommentEdit.timestamp }
      : comment;
    threads.push({
      id,
      comment: foldedComment,
      replies,
      statusChanges,
      status,
      anchor,
    });
  }
  threads.sort((a, b) => byTimestamp(a.comment, b.comment));

  // AC7: every line type whose reference resolves nowhere routes here — a
  // uniform rule instead of `reply`/`status-change` alone. `delete`/`edit`
  // may legitimately target either a `comment` or a `reply` (both maps are
  // checked, via `resolvesToRealLine` above); an already-tombstoned target
  // still resolves (`comments`/`replyById` are never pruned by deletion), so
  // that ordinary race is untouched — only a target/parent that never named a
  // real `comment` (or, for `delete`/`edit`, a non-orphaned `reply` either)
  // lands here.
  const orphans: (ReplyLine | StatusChangeLine | AnchorUpdateLine | DeleteLine | EditLine)[] = [];
  for (const [parentId, group] of repliesByParent) {
    if (!comments.has(parentId)) {
      orphans.push(...group.filter((reply) => !deletedReplies.has(reply.id)));
    }
  }
  for (const [parentId, group] of statusByParent) {
    if (!comments.has(parentId)) {
      orphans.push(...group);
    }
  }
  for (const [parentId, group] of anchorUpdatesByParent) {
    if (!comments.has(parentId)) {
      orphans.push(...group);
    }
  }
  for (const tombstone of tombstones) {
    if (!resolvesToRealLine(tombstone.target_id)) {
      orphans.push(tombstone);
    }
  }
  for (const [targetId, group] of editsByTarget) {
    if (!resolvesToRealLine(targetId)) {
      orphans.push(...group);
    }
  }
  orphans.sort(byTimestamp);

  return { threads, orphans, warnings };
}
