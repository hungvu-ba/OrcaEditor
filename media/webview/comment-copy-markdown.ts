/**
 * Req 24 US-23.12: pure Markdown-export builder — no DOM access. `comment-panel.ts`
 * assembles an `ExportSnapshot` from its own live registry/sort/"Hide closed"
 * state and hands it to `renderCommentsMarkdown`; nothing in this file reaches
 * into `comment-resolve.ts`, the document, or the sidecar (AC7).
 */
import { truncateDisplay } from './trigger-popup';
import type { CommentStatus } from '../../src/shared/messages';

/** AC6: the anchor snippet's own bound, independent of US-23.9 AC7's row bound. */
export const EXPORT_SNIPPET_MAX_CHARS = 300;

export type ExportGroupKey = 'open' | 'floating' | 'resolved' | 'closed';

/** AC3: fixed export order, Orphaned excluded entirely (this story's own scope carve-out). */
export const EXPORT_GROUP_ORDER: ExportGroupKey[] = ['open', 'floating', 'resolved', 'closed'];

export const EXPORT_GROUP_LABEL: Record<ExportGroupKey, string> = {
  open: 'Open',
  floating: 'Unresolved location',
  resolved: 'Resolved',
  closed: 'Closed',
};

export type ExportLocation =
  | { kind: 'floating' }
  | { kind: 'wholeDocument'; approximate: boolean }
  | { kind: 'line'; line: number; approximate: boolean }
  | { kind: 'range'; start: number; end: number; approximate: boolean };

export interface ExportComment {
  author: string;
  timestamp: string;
  body: string;
}

export interface ExportThread {
  group: ExportGroupKey;
  status: CommentStatus;
  location: ExportLocation;
  lastTransitionAuthor: string;
  lastTransitionTimestamp: string;
  /** Raw recorded anchor text; '' means textless (caret/image/diagram) — never rendered as an empty blockquote. */
  anchorText: string;
  /** `[0]` is the opening comment, the rest are replies, in append order. */
  comments: ExportComment[];
}

export interface ExportSnapshot {
  docRelativePath: string;
  exportedAtIso: string;
  foreignSidecar: boolean;
  /**
   * Already filtered (tombstones/Orphaned/"Hide closed" applied) and sorted by
   * the caller's current comparator — this module only buckets by group,
   * preserving relative order within each bucket.
   */
  threads: ExportThread[];
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * AC5: `YYYY-MM-DD HH:mm ±HH:mm`, hardcoded — never locale-derived — with
 * minute precision and the host's own UTC offset. `offsetMinutesOverride`
 * exists only so a test can pin a deterministic offset instead of depending on
 * the running machine's timezone; production call sites omit it.
 */
export function formatExportTimestamp(iso: string, offsetMinutesOverride?: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const offsetMinutes = offsetMinutesOverride ?? -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(absMinutes / 60))}:${pad2(absMinutes % 60)}`;
  // Shift the instant by the target offset, then read UTC getters on the
  // shifted instant — the wall-clock fields for a specific offset, with no
  // dependence on the running machine's own timezone (needed both to honor
  // `offsetMinutesOverride` and to keep this in-process-timezone-independent).
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const mo = pad2(shifted.getUTCMonth() + 1);
  const d = pad2(shifted.getUTCDate());
  const h = pad2(shifted.getUTCHours());
  const mi = pad2(shifted.getUTCMinutes());
  return `${y}-${mo}-${d} ${h}:${mi} ${offset}`;
}

const INLINE_MARKDOWN_CHARS = /[\\`*_[\]<>|~#]/g;

/**
 * AC6: backslash-escape the CommonMark punctuation set for a single-line body
 * or an author name. A leading list/ordered-list marker is escaped too — the
 * field is always inlined mid-line (after "— " or inside `**…**`), never at
 * line start, but this is a defensive second guard.
 */
export function escapeMarkdownInline(text: string): string {
  let escaped = text.replace(INLINE_MARKDOWN_CHARS, '\\$&');
  escaped = escaped.replace(/^([-+*])(?=\s)/, '\\$1');
  escaped = escaped.replace(/^(\d+)([.)])(?=\s)/, '$1\\$2');
  return escaped;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * AC6: the blockquoted snippet line, or `undefined` for a textless anchor —
 * never emitted empty. Content is literal (no escaping): blockquote context
 * makes a leading `#`/`>` inert.
 */
export function buildSnippetLine(anchorText: string): string | undefined {
  const collapsed = collapseWhitespace(anchorText);
  if (collapsed === '') {
    return undefined;
  }
  return `> ${truncateDisplay(collapsed, EXPORT_SNIPPET_MAX_CHARS)}`;
}

function longestBacktickRun(text: string): number {
  const matches = text.match(/`+/g);
  return matches === null ? 0 : Math.max(...matches.map((m) => m.length));
}

/** `indent`: column the body's own text starts at — 2 for a top-level comment, 4 for a nested reply. */
function renderBody(body: string, indent: number): string {
  if (!body.includes('\n')) {
    return escapeMarkdownInline(body);
  }
  // AC6: fenced block for a multi-line/blank-line-separated body, fence length
  // long enough that no run of backticks already inside the body can close it early.
  const fenceLen = Math.max(3, longestBacktickRun(body) + 1);
  const fence = '`'.repeat(fenceLen);
  const gutter = ' '.repeat(indent);
  const lines = body.split('\n').map((line) => `${gutter}${line}`);
  return `\n${gutter}${fence}\n${lines.join('\n')}\n${gutter}${fence}`;
}

/** AC4: an absent/blank author renders the literal `Unknown author`, never escaped. */
function renderAuthor(author: string): string {
  const trimmed = author.trim();
  return trimmed === '' ? 'Unknown author' : escapeMarkdownInline(trimmed);
}

function renderCommentLine(comment: ExportComment, indent: number): string {
  const marker = `${' '.repeat(indent - 2)}- `;
  const author = renderAuthor(comment.author);
  const timestamp = formatExportTimestamp(comment.timestamp);
  const body = renderBody(comment.body, indent);
  return `${marker}**${author}** · ${timestamp} — ${body}`;
}

/**
 * AC4: a non-floating textless anchor (caret, image, diagram) carries US-23.9
 * AC7's fallback label — the same "No anchored text" wording that surface
 * already uses (`comment-panel.ts`'s `anchorSnippet`) — on the heading itself,
 * since its blockquote line is omitted entirely (review finding, 2026-07-28).
 */
function renderLocation(location: ExportLocation, textless: boolean): string {
  const suffix = textless ? ' (no anchored text)' : '';
  switch (location.kind) {
    case 'floating':
      return 'No anchor — Unresolved location';
    case 'wholeDocument':
      return `Whole document${location.approximate ? ' (approximate)' : ''}${suffix}`;
    case 'line':
      return `Ln ${location.line}${location.approximate ? ' (approximate)' : ''}${suffix}`;
    case 'range':
      return `Ln ${location.start}–${location.end}${location.approximate ? ' (approximate)' : ''}${suffix}`;
  }
}

function renderThread(thread: ExportThread): string {
  const author = renderAuthor(thread.lastTransitionAuthor);
  const timestamp = formatExportTimestamp(thread.lastTransitionTimestamp);
  const textless = thread.location.kind !== 'floating' && collapseWhitespace(thread.anchorText) === '';
  const lines: string[] = [
    `#### ${thread.status} · ${renderLocation(thread.location, textless)} · ${author} · ${timestamp}`,
  ];
  // AC4: omitted for a floating thread (no anchor to quote) and for a textless
  // anchor (caret, image, diagram) — never emitted empty; the latter carries
  // its fallback label on the heading above instead (`textless`, above).
  if (thread.location.kind !== 'floating') {
    const snippetLine = buildSnippetLine(thread.anchorText);
    if (snippetLine !== undefined) {
      lines.push(snippetLine);
    }
  }
  const [opening, ...replies] = thread.comments;
  if (opening !== undefined) {
    lines.push(renderCommentLine(opening, 2));
  }
  for (const reply of replies) {
    lines.push(renderCommentLine(reply, 4));
  }
  return lines.join('\n');
}

/** AC4's last bullet — same cause line the Comment tab's own banner (US-23.9 AC13) shows. */
export const FOREIGN_SIDECAR_BANNER =
  'None of the text these comments were written against is still in this file — the sidecar may describe a different document.';

/** AC3/AC4: the full exported Markdown, LF line endings throughout. */
export function renderCommentsMarkdown(snapshot: ExportSnapshot): string {
  const grouped = new Map<ExportGroupKey, ExportThread[]>();
  for (const thread of snapshot.threads) {
    const bucket = grouped.get(thread.group);
    if (bucket === undefined) {
      grouped.set(thread.group, [thread]);
    } else {
      bucket.push(thread);
    }
  }
  const count = snapshot.threads.length;
  const segments: string[] = [
    `## Review — ${snapshot.docRelativePath} · ${count} thread${count === 1 ? '' : 's'} · ${formatExportTimestamp(snapshot.exportedAtIso)}`,
  ];
  if (snapshot.foreignSidecar) {
    segments.push(FOREIGN_SIDECAR_BANNER);
  }
  for (const key of EXPORT_GROUP_ORDER) {
    const bucket = grouped.get(key);
    if (bucket === undefined || bucket.length === 0) {
      continue;
    }
    segments.push(`### ${EXPORT_GROUP_LABEL[key]} (${bucket.length})`);
    for (const thread of bucket) {
      segments.push(renderThread(thread));
    }
  }
  return `${segments.join('\n\n')}\n`;
}

/** AC8: the six disabled-reason causes, in priority order. `undefined` means enabled. */
export interface CopyDisabledInput {
  sidecarProblem: string | undefined;
  loading: boolean;
  sidecarForeign: boolean;
  /** `resolve.allThreads().length` — unfiltered by "Hide closed". */
  totalThreadCount: number;
  /** Threads that would actually be exported, after the "Hide closed" filter. */
  exportableThreadCount: number;
  hideClosed: boolean;
}

export function copyDisabledReason(input: CopyDisabledInput): string | undefined {
  if (input.sidecarProblem !== undefined) {
    return input.sidecarProblem;
  }
  if (input.loading) {
    return 'Comments are still loading.';
  }
  if (input.sidecarForeign && input.totalThreadCount === 0) {
    return FOREIGN_SIDECAR_BANNER;
  }
  if (input.exportableThreadCount > 0) {
    return undefined;
  }
  if (input.hideClosed && input.totalThreadCount > 0) {
    return 'Every thread in this file is Closed. Turn off "Hide closed" to include them.';
  }
  return 'No comments in this file to copy.';
}
