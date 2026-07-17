/**
 * Per-block original-style detection (HLR item 18, US-18.4a — hotfix).
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
 * This hotfix does the HEADING axis only (ATX vs Setext); the remaining axes
 * (emphasis/strong, horizontal rule — US-18.4b/deferred) add branches here.
 */

/** Transient attribute (stamped on the serialize-time CLONE only, never in `.md`). */
export const HEADING_STYLE_ATTR = 'data-md-heading-style';

/**
 * A block's style override, one field per axis; `null` = axis not applicable to
 * this block type (or variant not detected) → fall through to turndown's global
 * default. Extension point for US-18.4b: add `emphasis`/`strong`/`hr` here.
 */
export interface StyleOverride {
  /** ATX (`# x`) vs Setext (`x\n===`). Applies to H1/H2 only; H3+ is always ATX. */
  heading: 'atx' | 'setext' | null;
  /**
   * Original Setext underline length, to reproduce it faithfully instead of
   * normalizing it. Non-null only when `heading === 'setext'`.
   */
  headingUnderlineLength: number | null;
}

/**
 * Detect a block's original style from its `mdSlice` + block type (from the Block
 * Map). Pure. Returns `null` per axis that doesn't apply so the caller knows to
 * fall back to the default.
 */
export function detectBlockStyle(mdSlice: string, blockType: string): StyleOverride {
  const underline = blockType === 'heading' ? detectSetextUnderlineLength(mdSlice) : null;
  return {
    heading: blockType === 'heading' ? (underline != null ? 'setext' : 'atx') : null,
    headingUnderlineLength: underline,
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
 * Stamp the override onto the block element (the CLONE) as transient attributes
 * for the turndown rules to read back. Only stamped when it differs from the
 * default (Setext) — a canonical block gets no attribute, so it serializes
 * byte-identical to today (Golden Rule). US-18.4b extension point: stamp
 * additional attributes for emphasis/strong/hr.
 */
export function stampStyleOverride(el: Element, style: StyleOverride): void {
  if (style.heading === 'setext' && style.headingUnderlineLength != null) {
    el.setAttribute(HEADING_STYLE_ATTR, String(style.headingUnderlineLength));
  }
}
