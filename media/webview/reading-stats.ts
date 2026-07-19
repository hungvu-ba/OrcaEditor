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

/**
 * Rendered prose text of `content`: headings, blockquotes, table cells, and
 * link text are included by default (textContent); code (fenced + inline),
 * math, and Mermaid blocks are excluded. Image alt text is never part of
 * textContent, so it is excluded without special-casing. Operates on a
 * detached clone — never mutates the live document.
 */
export function extractReadableText(content: HTMLElement): string {
  const clone = content.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(EXCLUDED_SELECTOR).forEach((el) => el.remove());
  return clone.textContent ?? '';
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
