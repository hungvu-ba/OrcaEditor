/**
 * Per-block original-style detection (HLR item 18, US-18.4a heading axis +
 * US-18.4b remaining axes).
 *
 * turndown applies one fixed global style to the whole DOM tree on every
 * serialize, so the FIRST edit anywhere in a file silently rewrites every block
 * of that type to Orca's canonical style — destroying the exact `.md` syntax the
 * user originally wrote (a data-integrity problem, not a cosmetic one). This
 * module detects the ORIGINAL syntax variant of each block from its `mdSlice`
 * (the block's own source-markdown slice, kept by the Block Map) so serialize can
 * reproduce that variant.
 *
 * Pure functions, no live state — runnable both in the webview and in Node tests.
 * Axes covered: heading (ATX/Setext, US-18.4a), bullet marker, code block style,
 * em/strong delimiter, HR variant (US-18.4b). Link style is deferred to its own
 * spec (needs document-level reference-definition capture).
 */

/** Transient attributes (stamped on the serialize-time CLONE only, never in `.md`). */
export const HEADING_STYLE_ATTR = 'data-md-heading-style';
export const BULLET_STYLE_ATTR = 'data-md-bullet-style';
export const CODE_STYLE_ATTR = 'data-md-code-style';
/**
 * US-4.28: marks a code block whose language the user changed in place. An
 * INDENTED block can't carry a language token, so `applyBlockStyleOverrides`
 * must NOT re-force its original indented style (which would drop the picked
 * language on serialize) — it drops the code axis for a marked block instead.
 */
export const LANG_SWITCHED_ATTR = 'data-md-lang-switched';
export const EM_STYLE_ATTR = 'data-md-em-style';
export const STRONG_STYLE_ATTR = 'data-md-strong-style';
export const HR_STYLE_ATTR = 'data-md-hr-style';
export const TABLE_SEP_STYLE_ATTR = 'data-md-table-sep-style';

/**
 * A block's style override, one field per axis; `null` = axis not applicable to
 * this block type (or variant not detected) → fall through to turndown's global
 * default.
 */
export interface StyleOverride {
  /** ATX (`# x`) vs Setext (`x\n===`). Applies to H1/H2 only; H3+ is always ATX. */
  heading: 'atx' | 'setext' | null;
  /**
   * Original Setext underline length, to reproduce it faithfully instead of
   * normalizing it. Non-null only when `heading === 'setext'`.
   */
  headingUnderlineLength: number | null;
  /** First bullet marker found in the list block; nested items inherit it. */
  bullet: '-' | '+' | '*' | null;
  /** Non-default code block styles; backtick fence is the default (null). */
  code: 'indented' | 'indented-tab' | 'fence-tilde' | null;
  /** `_em_` instead of the default `*em*`. First-encountered delimiter wins. */
  em: '_' | null;
  /** `__strong__` instead of the default `**strong**`. First-encountered wins. */
  strong: '__' | null;
  /** Raw trimmed HR line (`***`, `___`, `- - -`...) when it differs from `---`. */
  hr: string | null;
  /** `compact` (`|---|---|`, no inner spaces) when it differs from the padded default. */
  tableSeparator: 'compact' | null;
}

/** Block types whose mdSlice can contain markdown emphasis (not literal text). */
const EMPHASIS_CAPABLE_TYPES = new Set(['paragraph', 'heading', 'list', 'blockquote', 'table']);

/**
 * Detect a block's original style from its `mdSlice` + block type (from the Block
 * Map). Pure. Returns `null` per axis that doesn't apply so the caller knows to
 * fall back to the default.
 */
export function detectBlockStyle(mdSlice: string, blockType: string): StyleOverride {
  const underline = blockType === 'heading' ? detectSetextUnderlineLength(mdSlice) : null;
  const emphasisSource = EMPHASIS_CAPABLE_TYPES.has(blockType) ? stripNonContent(mdSlice) : null;
  // Lists inside a blockquote live in a 'blockquote'-typed block; strip the `>`
  // prefixes so their markers are detected too (otherwise the global-default flip
  // to '*' would silently rewrite `> - item` on every save).
  const bulletSource =
    blockType === 'list'
      ? stripFencedLines(mdSlice)
      : blockType === 'blockquote'
        ? stripFencedLines(mdSlice.replace(/^[ \t>]+/gm, ''))
        : null;
  return {
    heading: blockType === 'heading' ? (underline != null ? 'setext' : 'atx') : null,
    headingUnderlineLength: underline,
    bullet: bulletSource != null ? detectBulletMarker(bulletSource) : null,
    code: blockType === 'code' ? detectCodeStyle(mdSlice) : null,
    em: emphasisSource != null ? detectEmDelimiter(emphasisSource) : null,
    strong: emphasisSource != null ? detectStrongDelimiter(emphasisSource) : null,
    hr: blockType === 'hr' ? detectHrVariant(mdSlice) : null,
    tableSeparator: blockType === 'table' ? detectTableSeparatorStyle(mdSlice) : null,
  };
}

/**
 * Setext when a line other than the first consists solely of `=` or `-` (the
 * Setext underline) — returns that underline's length. ATX starts with `#` and
 * has no such line → returns `null`. A heading's `mdSlice` spans only its own
 * source lines (markdown-it's exact token map), so a `---` belonging to a
 * sibling block is never included here.
 */
function detectSetextUnderlineLength(mdSlice: string): number | null {
  const lines = mdSlice.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const m = /^\s*(=+|-+)\s*$/.exec(lines[i]);
    if (m) {
      return m[1].length;
    }
  }
  return null;
}

/**
 * First bullet-marker line wins for the whole block (a block = one top-level
 * list, nested levels included) — a nested level with a different marker is
 * collapsed to the first one, per the spec's "first-encountered wins" rule.
 * Purely ordered lists have no marker line → `null` (bullet axis inapplicable).
 * Caller pre-strips fenced code so a `diff` snippet's `- removed` lines never
 * count as markers.
 */
function detectBulletMarker(source: string): '-' | '+' | '*' | null {
  const m = /^\s*([-+*])[ \t]/m.exec(source);
  return m ? (m[1] as '-' | '+' | '*') : null;
}

/**
 * Code block style is single-value: one check on the first non-blank line.
 * 4-space indent → 'indented'; tab indent → 'indented-tab' (re-emitted with
 * tabs, not silently converted to spaces); `~~~` fence (up to 3 leading
 * spaces) → 'fence-tilde'; backtick fence is the default → `null` (never
 * stamped).
 */
function detectCodeStyle(mdSlice: string): 'indented' | 'indented-tab' | 'fence-tilde' | null {
  const first = mdSlice.split('\n').find((l) => l.trim() !== '');
  if (first == null) {
    return null;
  }
  if (/^ {4}/.test(first)) {
    return 'indented';
  }
  if (/^\t/.test(first)) {
    return 'indented-tab';
  }
  if (/^ {0,3}~~~/.test(first)) {
    return 'fence-tilde';
  }
  return null;
}

/**
 * Drop every line inside a fenced code region (``` or ~~~, closing fence of the
 * same char). Heuristic line scanner, not a parser: an unclosed fence swallows
 * the rest of the slice, which is the safe direction (fewer false delimiter
 * detections, never more).
 */
function stripFencedLines(text: string): string {
  const out: string[] = [];
  let fenceChar: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceChar == null && m) {
      fenceChar = m[1][0];
      continue;
    }
    if (fenceChar != null) {
      if (m && m[1][0] === fenceChar) {
        fenceChar = null;
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Remove text that can contain literal `_`/`*` without them being emphasis
 * delimiters, so the detectors below only see real content: fenced regions,
 * backtick code spans (equal-length runs, so `` `_x` `` inside a longer span
 * strips fully), link/image destinations `](...)`, autolinks/inline HTML
 * `<...>`, and escaped-backslash pairs `\\` (so the `\`-escape lookbehind
 * keeps the right parity). Deliberately simple heuristics, not a parser.
 */
function stripNonContent(mdSlice: string): string {
  return stripFencedLines(mdSlice)
    .replace(/\\\\/g, '')
    .replace(/(`+)(?!`)[\s\S]*?\1(?!`)/g, '')
    .replace(/\]\([^)\s]*/g, '](')
    .replace(/<[^>\n]*>/g, '');
}

/** Earliest match position among the given regexes, or -1 when none match. */
function firstIndex(source: string, regexes: RegExp[]): number {
  let min = -1;
  for (const re of regexes) {
    const i = source.search(re);
    if (i >= 0 && (min < 0 || i < min)) {
      min = i;
    }
  }
  return min;
}

/**
 * `_` wins the em axis only when an `_` opener appears before any `*` opener.
 * Openers must not be escaped, intraword (Unicode letters/digits count, so
 * `chữ_ký` never opens), or mid-run; a `___x___` run opens em+strong together,
 * so it counts for both this detector and the strong one. Literal intraword
 * stars (`2*4`) are excluded symmetrically. First-encountered heuristic on the
 * content-stripped slice.
 */
function detectEmDelimiter(source: string): '_' | null {
  const underscore = firstIndex(source, [
    /(?<![\p{L}\p{N}_\\])_(?![_\s])/u,
    /(?<![\p{L}\p{N}_\\])___(?![_\s])/u,
  ]);
  const star = firstIndex(source, [
    /(?<![\p{L}\p{N}_*\\])\*(?![*\s])/u,
    /(?<![\p{L}\p{N}_*\\])\*\*\*(?![*\s])/u,
  ]);
  return underscore >= 0 && (star < 0 || underscore < star) ? '_' : null;
}

/**
 * `__` wins the strong axis only when a `__` opener (incl. the `___x___` form)
 * appears before any `**` opener. Same guards as the em detector.
 */
function detectStrongDelimiter(source: string): '__' | null {
  const underscore = source.search(/(?<![\p{L}\p{N}_\\])__(?!\s)/u);
  const star = source.search(/(?<![\p{L}\p{N}_*\\])\*\*(?!\s)/u);
  return underscore >= 0 && (star < 0 || underscore < star) ? '__' : null;
}

/**
 * Raw HR line kept verbatim (leading indent included — up to 3 spaces is
 * legal and must round-trip) — `null` when it's already canonical `---`.
 */
function detectHrVariant(mdSlice: string): string | null {
  const line = mdSlice.replace(/\s+$/, '');
  return line && line !== '---' ? line : null;
}

/**
 * `compact` when the header-separator row (the table block's 2nd line, e.g.
 * `|---|---|` or `|:--|--:|`) has no whitespace between any pipe/dash/colon —
 * `null` (fall through to the padded `| --- |` default) otherwise, including
 * when the row is missing or malformed.
 */
function detectTableSeparatorStyle(mdSlice: string): 'compact' | null {
  const sepLine = mdSlice.split('\n')[1]?.trim();
  return sepLine && !/\s/.test(sepLine) ? 'compact' : null;
}

/**
 * Stamp the override onto the block element (the CLONE) as transient attributes
 * for the turndown rules to read back. Each axis is stamped ONLY when it differs
 * from the global default — a canonical block gets no attribute, so it serializes
 * byte-identical to today (Golden Rule).
 */
export function stampStyleOverride(el: Element, style: StyleOverride): void {
  if (style.heading === 'setext' && style.headingUnderlineLength != null) {
    el.setAttribute(HEADING_STYLE_ATTR, String(style.headingUnderlineLength));
  }
  if (style.bullet != null && style.bullet !== '*') {
    el.setAttribute(BULLET_STYLE_ATTR, style.bullet);
  }
  if (style.code != null) {
    el.setAttribute(CODE_STYLE_ATTR, style.code);
  }
  if (style.em != null) {
    el.setAttribute(EM_STYLE_ATTR, style.em);
  }
  if (style.strong != null) {
    el.setAttribute(STRONG_STYLE_ATTR, style.strong);
  }
  if (style.hr != null) {
    el.setAttribute(HR_STYLE_ATTR, style.hr);
  }
  if (style.tableSeparator != null) {
    el.setAttribute(TABLE_SEP_STYLE_ATTR, style.tableSeparator);
  }
}
