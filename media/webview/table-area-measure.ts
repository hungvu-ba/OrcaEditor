/**
 * US-19.27 area fit: DOM adapter turning a rendered table cell into the pure
 * solver's `CellLines` (Code Plan contracts 3, 9, 11). Read-only — call it with
 * the table under the nowrap measure class (`md-table-col-fit-measuring`), so
 * every hard line lays out on one line and each Range width is a one-line width.
 */
import type { BreakUnit, CellLines } from './table-area-fit';
import { isCjkBreakUnit } from './reading-stats';

/**
 * Fixed-height content: each match is one atomic unit (its own text, e.g. KaTeX's
 * hidden MathML, is not walked) and its height feeds `fixedH`.
 */
const FIXED_BOX_SELECTOR = 'img,svg,video,.katex';

/**
 * Break units of `cell`, one segment per hard line (`<br>`). A `\S+` word is one
 * unit whose gap is the Range width of the whitespace before it; inside a word,
 * each CJK glyph is its own unit with gap 0 (the glyph run measured once, split
 * evenly) and every non-CJK run between glyphs stays atomic — the split
 * table.ts's `widestWordWidth` uses. A word split across inline elements with
 * no whitespace between (`<b>foo</b>bar`) stays one unit.
 */
export function measureCellLines(cell: HTMLTableCellElement, range: Range): CellLines {
  const segments: BreakUnit[][] = [];
  let seg: BreakUnit[] = [];
  let units = 0;
  let cjkUnits = 0;
  let fixedH: number | undefined;
  // Whitespace width since the last unit; whether the last unit is a non-CJK
  // word with no whitespace after it yet (the next word run joins it).
  let gap = 0;
  let joinPrev = false;

  const width = (node: Node, start: number, end: number): number => {
    range.setStart(node, start);
    range.setEnd(node, end);
    return range.getBoundingClientRect().width;
  };
  const push = (w: number, word: boolean, cjk = false): void => {
    if (word && joinPrev) {
      seg[seg.length - 1].w += w;
    } else {
      seg.push({ w, gap: seg.length ? gap : 0 });
      units++;
      if (cjk) {
        cjkUnits++;
      }
    }
    gap = 0;
    joinPrev = word;
  };
  /** `cjkGlyphs` > 0 → [start, end) is a run of that many CJK glyphs. */
  const addRun = (node: Node, start: number, end: number, cjkGlyphs: number): void => {
    if (end <= start) {
      return;
    }
    const w = width(node, start, end);
    if (cjkGlyphs === 0) {
      push(w, true);
      return;
    }
    for (let i = 0; i < cjkGlyphs; i++) {
      push(w / cjkGlyphs, false, true);
    }
  };
  const addText = (node: Node): void => {
    const text = node.nodeValue ?? '';
    const re = /(\s+)|\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) {
        gap += width(node, m.index, m.index + m[0].length);
        joinPrev = false;
        continue;
      }
      let runStart = m.index;
      let offset = m.index;
      let cjkGlyphs = 0;
      for (const ch of m[0]) {
        const cjk = isCjkBreakUnit(ch);
        if (cjk !== (cjkGlyphs > 0) && offset > runStart) {
          addRun(node, runStart, offset, cjkGlyphs);
          runStart = offset;
          cjkGlyphs = 0;
        }
        if (cjk) {
          cjkGlyphs++;
        }
        offset += ch.length;
      }
      addRun(node, runStart, offset, cjkGlyphs);
    }
  };
  const walk = (parent: Node): void => {
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === Node.TEXT_NODE) {
        addText(node);
      } else if (node instanceof Element) {
        if (node.tagName === 'BR') {
          segments.push(seg);
          seg = [];
          gap = 0;
          joinPrev = false;
        } else if (node.matches(FIXED_BOX_SELECTOR)) {
          const rect = node.getBoundingClientRect();
          fixedH = Math.max(fixedH ?? 0, rect.height);
          push(rect.width, false);
        } else {
          walk(node);
        }
      }
    }
  };

  walk(cell);
  if (units === 0) {
    return { segments: [], cjkUnits: 0, units: 0 };
  }
  segments.push(seg);
  // A trailing <br> ends the last line without opening a new one.
  if (seg.length === 0) {
    segments.pop();
  }
  const lines: CellLines = { segments, cjkUnits, units };
  if (fixedH !== undefined) {
    lines.fixedH = fixedH;
  }
  return lines;
}
