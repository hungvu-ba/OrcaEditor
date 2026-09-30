/**
 * US-19.27 area fit: DOM adapter turning a rendered table's cells into the pure
 * solver's `CellLines` (Code Plan contracts 3, 9, 11). Chromium decides the
 * break units: with every column at 1px content width it takes every break
 * opportunity, so the items sharing a line form one unbreakable unit; unit
 * widths and gaps then come from the nowrap measure layout. Two layout states
 * in one tick, and the table is left exactly as it was found.
 */
import type { BreakUnit, CellLines } from './table-area-fit';
import { isCjkBreakUnit } from './reading-stats';
import { MD_TABLE_FIT_CLASS, TABLE_FIT_MEASURING_CLASS, TABLE_MIN_MEASURING_CLASS } from './constants';

/**
 * Fixed-height content: `fixedH[s]` is the tallest such box on hard line s.
 * img/svg/video are one atomic item; a `.katex` is walked, since
 * Chromium breaks between its `.base` inline-blocks.
 */
const FIXED_BOX_SELECTOR = 'img,svg,video,.katex';

/** Letters, digits and marks of scripts Chromium never breaks inside (no auto hyphenation, `word-break: normal`). */
const WORD_RE = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}]\p{M}*$/u;
/** Collapsible whitespace: a break opportunity, never an item. */
const SPACE_RE = /^[ \t\n\r\f]+$/;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const px = (value: string): number => parseFloat(value) || 0;

/**
 * Height of a fixed box. An inline `.katex` rect is only its font's line box;
 * the formula's extent is the union of its `.base` inline-blocks.
 */
function fixedBoxHeight(el: Element, rect: DOMRect): number {
  if (!el.classList.contains('katex')) {
    return rect.height;
  }
  let top = rect.top;
  let bottom = rect.bottom;
  for (const base of Array.from(el.querySelectorAll('.base'))) {
    const r = base.getBoundingClientRect();
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }
  return bottom - top;
}

/** A grapheme of a text node ([start, end)), or an atomic box (`node` is the element). */
interface Item {
  node: Node;
  start: number;
  end: number;
  cjk: boolean;
  /** Continues a letter/digit run with no whitespace: no break opportunity before it. */
  glued: boolean;
  /** Inline-box margin + border + padding opening before it / closing after it (px). */
  lead: number;
  trail: number;
}

interface HardLine {
  items: Item[];
  /** Left inset of the open block ancestors, added to the line's first unit. */
  indent: number;
  fixed: Element[];
}

/**
 * The cell's hard lines (`<br>`, or a block-level child's boundary) of items.
 * An inline element's horizontal margin + border + padding goes to its first
 * and last item; an atomic inline box (`inline-block`, …, e.g. a button) is one
 * item with its margins; `display: none` and out-of-flow content is skipped.
 * Style reads only.
 */
function collectLines(cell: HTMLTableCellElement): HardLine[] {
  const lines: HardLine[] = [];
  let line: HardLine = { items: [], indent: 0, fixed: [] };
  let indent = 0;
  let lead = 0;
  let space = true;
  let prevWord = false;

  const add = (item: Item): void => {
    if (!line.items.length) {
      line.indent = indent;
    }
    item.lead += lead;
    lead = 0;
    line.items.push(item);
    space = false;
  };
  const atom = (el: Element, marginL: number, marginR: number): void => {
    add({ node: el, start: 0, end: 0, cjk: false, glued: false, lead: marginL, trail: marginR });
    prevWord = false;
  };
  const newLine = (): void => {
    line = { items: [], indent, fixed: [] };
    space = true;
  };
  /** A block boundary ends the current line, if any, without opening an empty one. */
  const endLine = (): void => {
    if (line.items.length) {
      lines.push(line);
      newLine();
    }
    space = true;
  };
  const addText = (node: Text): void => {
    for (const { segment, index } of graphemes.segment(node.data)) {
      if (SPACE_RE.test(segment)) {
        space = true;
        continue;
      }
      const cjk = isCjkBreakUnit(String.fromCodePoint(segment.codePointAt(0) ?? 0));
      const word = !cjk && WORD_RE.test(segment);
      const glued = !space && prevWord && word && line.items.length > 0;
      add({ node, start: index, end: index + segment.length, cjk, glued, lead: 0, trail: 0 });
      prevWord = word;
    }
  };
  const walk = (parent: Node): void => {
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === Node.TEXT_NODE) {
        addText(node as Text);
        continue;
      }
      if (!(node instanceof Element)) {
        continue;
      }
      if (node.tagName === 'BR') {
        lines.push(line);
        newLine();
        continue;
      }
      // A break opportunity: the next item is not glued, its rect decides.
      if (node.tagName === 'WBR') {
        space = true;
        continue;
      }
      if (node.matches(FIXED_BOX_SELECTOR)) {
        line.fixed.push(node);
        if (node.classList.contains('katex')) {
          walk(node);
        } else {
          atom(node, 0, 0);
        }
        continue;
      }
      const style = getComputedStyle(node);
      const display = style.display;
      if (display === 'none' || style.position === 'absolute' || style.position === 'fixed') {
        continue;
      }
      const marginL = px(style.marginLeft);
      const marginR = px(style.marginRight);
      if (display.startsWith('inline-')) {
        atom(node, marginL, marginR);
        continue;
      }
      const insetL = marginL + px(style.borderLeftWidth) + px(style.paddingLeft);
      if (display === 'inline' || display === 'contents') {
        lead += insetL;
        walk(node);
        const insetR = marginR + px(style.borderRightWidth) + px(style.paddingRight);
        if (lead === 0 && line.items.length) {
          line.items[line.items.length - 1].trail += insetR;
        } else {
          lead += insetR;
        }
      } else {
        endLine();
        indent += insetL;
        walk(node);
        indent -= insetL;
        endLine();
      }
    }
  };

  walk(cell);
  lines.push(line);
  // A trailing <br> ends the last line without opening a new one.
  if (!line.items.length) {
    lines.pop();
  }
  return lines;
}

function itemRect(item: Item, range: Range): DOMRect {
  if (item.node instanceof Element) {
    return item.node.getBoundingClientRect();
  }
  range.setStart(item.node, item.start);
  range.setEnd(item.node, item.end);
  return range.getBoundingClientRect();
}

/** [first, last] item index of each unit: a new unit where Chromium broke the 1px layout. Layout reads only. */
function unitSpans(line: HardLine, range: Range): [number, number][] {
  const spans: [number, number][] = [];
  let bottom = -Infinity;
  line.items.forEach((item, k) => {
    if (k > 0 && item.glued) {
      spans[spans.length - 1][1] = k;
      return;
    }
    const r = itemRect(item, range);
    // Midpoint, not top: a glyph box taller than the line-height overlaps the next line.
    if (k > 0 && (r.top + r.bottom) / 2 < bottom) {
      spans[spans.length - 1][1] = k;
      bottom = Math.max(bottom, r.bottom);
      return;
    }
    spans.push([k, k]);
    bottom = r.bottom;
  });
  return spans;
}

/** The cell's `CellLines` from its units' nowrap extents. Layout reads only. */
function toCellLines(lines: HardLine[], spans: [number, number][][], range: Range): CellLines {
  const segments: BreakUnit[][] = [];
  let units = 0;
  let cjkUnits = 0;
  let fixedH: number[] | undefined;
  lines.forEach((line, i) => {
    let prevLeft = 0;
    let prevRight = 0;
    segments.push(
      spans[i].map(([a, b], k) => {
        const first = line.items[a];
        const last = line.items[b];
        if (first.node instanceof Element) {
          range.setStartBefore(first.node);
        } else {
          range.setStart(first.node, first.start);
        }
        if (last.node instanceof Element) {
          range.setEndAfter(last.node);
        } else {
          range.setEnd(last.node, last.end);
        }
        const r = range.getBoundingClientRect();
        const left = r.left - first.lead;
        const right = r.right + last.trail;
        // An RTL run lays units out right to left: the gap is then on the unit's right.
        const gap = left >= prevLeft ? left - prevRight : prevLeft - right;
        const unit = k ? { w: right - left, gap } : { w: right - left + line.indent, gap: 0 };
        prevLeft = left;
        prevRight = right;
        units++;
        if (first.cjk) {
          cjkUnits++;
        }
        return unit;
      })
    );
    if (line.fixed.length) {
      fixedH ??= new Array<number>(lines.length).fill(0);
      fixedH[i] = Math.max(...line.fixed.map((el) => fixedBoxHeight(el, el.getBoundingClientRect())));
    }
  });
  // No unit and at most one (empty) hard line: an empty cell. `<br><br>` still
  // renders two lines.
  if (units === 0 && segments.length <= 1) {
    return { segments: [], cjkUnits: 0, units: 0 };
  }
  const cellLines: CellLines = { segments, cjkUnits, units };
  if (fixedH !== undefined) {
    cellLines.fixedH = fixedH;
  }
  return cellLines;
}

/** Restores an attribute exactly, including its absence. */
function restoreAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    el.removeAttribute(name);
  } else {
    el.setAttribute(name, value);
  }
}

/**
 * Break units of every cell of `table` (`[row][cell]`, `table.rows` order), one
 * segment per hard line. Pass 1: every column pinned to 1px content width in
 * fixed layout — each line holds one unbreakable unit (a word, a CJK glyph with
 * the kinsoku marks Chromium keeps with it, a KaTeX `.base` box, …). Pass 2:
 * under the nowrap measure class, one Range per unit gives its width; its gap is
 * the distance from the previous unit's right edge. A block child's left inset
 * goes to the first unit of each of its lines.
 */
export function measureTableLines(table: HTMLTableElement): CellLines[][] {
  const cells = Array.from(table.rows).map((row) => Array.from(row.cells));
  const collected = cells.map((row) => row.map(collectLines));
  const range = document.createRange();
  const tableStyle = table.getAttribute('style');
  const tableClass = table.getAttribute('class');
  const cellStyles = cells.map((row) => row.map((cell) => cell.getAttribute('style')));

  table.classList.add(MD_TABLE_FIT_CLASS, TABLE_MIN_MEASURING_CLASS);
  table.style.width = `${Math.max(0, ...cells.map((row) => row.length))}px`;
  table.style.maxWidth = 'none';
  for (const row of cells) {
    for (const cell of row) {
      cell.style.boxSizing = 'content-box';
      cell.style.width = '1px';
      cell.style.minWidth = '0';
      cell.style.maxWidth = '1px';
    }
  }
  const spans = collected.map((row) => row.map((lines) => lines.map((line) => unitSpans(line, range))));
  restoreAttr(table, 'style', tableStyle);
  restoreAttr(table, 'class', tableClass);
  cells.forEach((row, i) => row.forEach((cell, j) => restoreAttr(cell, 'style', cellStyles[i][j])));

  table.classList.add(TABLE_FIT_MEASURING_CLASS);
  const out = collected.map((row, i) => row.map((lines, j) => toCellLines(lines, spans[i][j], range)));
  restoreAttr(table, 'class', tableClass);
  return out;
}
