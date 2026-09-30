/**
 * Reading-stats helpers for the TOC panel header (US-10.7): readable-prose
 * extraction, word count, estimated read time, and thousands-separator
 * formatting. Pure logic, no DOM mutation of the live document.
 */

import { MATH_BLOCK_CLASS, MATH_INLINE_CLASS, MERMAID_CLASS } from './render';

const EXCLUDED_SELECTOR = `pre, code, .${MATH_BLOCK_CLASS}, .${MATH_INLINE_CLASS}, .${MERMAID_CLASS}`;

/** Words per minute used to derive estimated read time (US-10.7, fixed constant). */
const WORDS_PER_MINUTE = 200;

/**
 * Han, Hiragana, and Katakana — each counted as one word (no word-space
 * segmentation). Unicode script property escapes (the `u` flag) so this
 * also matches Han characters outside the Basic Multilingual Plane (e.g.
 * CJK Extension B+, encoded as surrogate pairs) — a plain BMP-only
 * character-range regex would silently miss those.
 */
const CJK_CHAR_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/gu;

/** Non-global (no lastIndex state): CJK scripts + CJK punctuation, prolonged sound mark, full-width forms. */
const CJK_BREAK_UNIT_RE = new RegExp(`^(?:${CJK_CHAR_RE.source}|[\\u3000-\\u303F\\u30FC\\uFF00-\\uFFEF])$`, 'u');

/**
 * True when `ch` (one code point) is a glyph the browser may break a line on
 * either side of — i.e. it is its own "word" for layout purposes.
 */
export function isCjkBreakUnit(ch: string): boolean {
  return CJK_BREAK_UNIT_RE.test(ch);
}

/**
 * Rendered prose text of `content`: headings, blockquotes, table cells, and
 * link text are included by default (textContent); code (fenced + inline),
 * math, and Mermaid blocks are excluded. Image alt text is never part of
 * textContent, so it is excluded without special-casing. Walks the live tree
 * read-only (no clone) — the excluded subtrees are rejected, not removed.
 */
export function extractReadableText(content: HTMLElement): string {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(EXCLUDED_SELECTOR)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node as Text).data;
    }
  }
  return text;
}

/** Non-CJK runs (split on whitespace) plus one word per CJK character. */
export function countWords(text: string): number {
  const cjkMatches = text.match(CJK_CHAR_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkWords = text.replace(CJK_CHAR_RE, ' ').trim().split(/\s+/).filter(Boolean).length;
  return nonCjkWords + cjkCount;
}

/** 0 words → 0 minutes (empty state hides the line entirely); otherwise at least 1 minute. */
export function estimateReadMinutes(words: number): number {
  return words === 0 ? 0 : Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/** Hardcoded comma thousands separator — deterministic regardless of host locale (no toLocaleString). */
export function formatCount(n: number): string {
  const rounded = Math.trunc(n);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded).toString();
  let grouped = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) {
      grouped += ',';
    }
    grouped += digits[i];
  }
  return sign + grouped;
}
