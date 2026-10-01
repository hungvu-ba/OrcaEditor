/**
 * US-19.27 area fit (T1.9, T1.3 review): `measureTableLines`
 * (media/webview/table-area-measure.ts) turns every cell of a real rendered table
 * into the solver's CellLines, with Chromium's own break opportunities. Driven via
 * window.TableAreaFitDebug (esbuild.js's tableAreaFitDebugConfig + _harness.ts).
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';
import { TABLE_20 } from './table-area-fixtures';

interface BreakUnit {
  w: number;
  gap: number;
}
interface CellLines {
  segments: BreakUnit[][];
  cjkUnits: number;
  units: number;
  fixedH?: number[];
}
interface Measured {
  lines: CellLines;
  /** One-line width of the cell's content (its Range bounding box). */
  lineW: number;
  /** The call left the table's HTML (classes and inline styles included) untouched. */
  readOnly: boolean;
}

/** 1×1 transparent GIF; the CSS size sets the box. */
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Renders a one-cell table, sets the body cell's HTML to each entry in turn and measures the table. */
async function measureCells(page: Page, cellHtmls: string[]): Promise<Measured[]> {
  await openEditor(page, '| Case |\n| --- |\n| x |\n');
  await page.locator('#content table').waitFor();
  return page.evaluate((htmls) => {
    const table = document.querySelector('#content table') as HTMLTableElement;
    const cell = table.tBodies[0].rows[0].cells[0];
    const debug = (window as unknown as {
      TableAreaFitDebug: { measureTableLines(table: HTMLTableElement): CellLines[][] };
    }).TableAreaFitDebug;
    const range = document.createRange();
    return htmls.map((html) => {
      cell.innerHTML = html;
      const tableBefore = table.outerHTML;
      const lines = debug.measureTableLines(table)[1][0];
      const readOnly = table.outerHTML === tableBefore;
      table.classList.add('md-table-col-fit-measuring');
      range.selectNodeContents(cell);
      const lineW = range.getBoundingClientRect().width;
      table.classList.remove('md-table-col-fit-measuring');
      return { lines, lineW, readOnly };
    });
  }, cellHtmls);
}

async function measureCell(page: Page, cellHtml: string): Promise<Measured> {
  return (await measureCells(page, [cellHtml]))[0];
}

/** Σ (w + gap) of a one-segment cell — its simulated one-line width. */
function oneLineWidth(lines: CellLines): number {
  return lines.segments[0].reduce((acc, u) => acc + u.w + u.gap, 0);
}

test.describe('Table area fit — measureTableLines', () => {
  test('words: Chromium breaks after a hyphen, even inside a date; gaps are the whitespace widths', async ({ page }) => {
    const { lines, lineW, readOnly } = await measureCell(page, 'alpha beta-gamma 2026-09-24');
    expect(readOnly).toBe(true);
    expect(lines.segments).toHaveLength(1);
    const seg = lines.segments[0];
    // alpha | beta- | gamma | 2026- | 09- | 24; no whitespace → gap 0 up to the 1/64 px layout rounding.
    expect(lines.units).toBe(6);
    expect(lines.cjkUnits).toBe(0);
    expect(lines.fixedH).toBeUndefined();
    expect(seg).toHaveLength(6);
    expect(seg.map((u) => (Math.abs(u.gap) < 0.1 ? 0 : Math.sign(u.gap)))).toEqual([0, 1, 0, 1, 0, 0]);
    expect(Math.abs(oneLineWidth(lines) - lineW)).toBeLessThanOrEqual(2);
  });

  test('a CJK run is one unit per glyph with gap 0', async ({ page }) => {
    const { lines } = await measureCell(page, '用户在预订博物馆门票');
    expect(lines.units).toBe(10);
    expect(lines.cjkUnits).toBe(10);
    expect(lines.segments).toHaveLength(1);
    expect(lines.segments[0]).toHaveLength(10);
    for (const u of lines.segments[0]) {
      expect(Math.abs(u.gap)).toBeLessThan(0.1);
      expect(u.w).toBeGreaterThan(0);
    }
  });

  test('kinsoku: a glyph Chromium never starts a line with joins the unit before it', async ({ page }) => {
    // Chromium's own kinsoku: 、 。 々 〜 cannot start a line; ー and small kana can.
    const [closing, allowed, leading, marks] = await measureCells(page, ['必要で、承認。', 'コーディネーター', '、あ', '人々〜']);
    expect(closing.lines.units).toBe(5);
    expect(closing.lines.cjkUnits).toBe(5);
    const seg = closing.lines.segments[0];
    expect(seg[2].w).toBeGreaterThan(1.5 * seg[0].w);
    expect(Math.abs(oneLineWidth(closing.lines) - closing.lineW)).toBeLessThanOrEqual(2);
    expect(allowed.lines.units).toBe(8);
    expect(leading.lines.units).toBe(2);
    expect(marks.lines.units).toBe(1);
  });

  test('a mixed word keeps its Latin run atomic and splits its CJK glyphs', async ({ page }) => {
    const { lines, lineW } = await measureCell(page, '48時間前');
    expect(lines.units).toBe(4);
    expect(lines.cjkUnits).toBe(3);
    expect(lines.segments[0].map((u) => Math.abs(u.gap) < 0.1)).toEqual([true, true, true, true]);
    expect(Math.abs(oneLineWidth(lines) - lineW)).toBeLessThanOrEqual(2);
  });

  test('a word split across inline elements stays one unit', async ({ page }) => {
    const { lines, lineW } = await measureCell(page, '<b>foo</b>bar baz');
    expect(lines.units).toBe(2);
    expect(Math.abs(oneLineWidth(lines) - lineW)).toBeLessThanOrEqual(2);
  });

  test('non-breaking spaces stay inside the word', async ({ page }) => {
    const { lines } = await measureCell(page, '10&nbsp;km 20 km');
    expect(lines.units).toBe(2);
  });

  test('<wbr> is a break opportunity inside a word', async ({ page }) => {
    const { lines } = await measureCell(page, 'foo<wbr>bar baz');
    expect(lines.units).toBe(3);
  });

  test('a line-height below the glyph box still gives one unit per word', async ({ page }) => {
    // At 1px each word is its own line; the lines' glyph boxes overlap (as with a
    // tall CJK fallback font under a small markdown.preview.lineHeight).
    const { lines } = await measureCell(page, '<div style="line-height: 0.6">alpha beta gamma delta</div>');
    expect(lines.segments).toHaveLength(1);
    expect(lines.units).toBe(4);
  });

  test('an RTL run: gaps are the whitespace widths, never negative', async ({ page }) => {
    const { lines, lineW } = await measureCell(page, 'שלום עולם גדול מאוד');
    expect(lines.units).toBe(4);
    expect(lines.segments[0].every((u) => u.gap > -0.1)).toBe(true);
    expect(Math.abs(oneLineWidth(lines) - lineW)).toBeLessThanOrEqual(2);
  });

  test('inline box padding counts in the unit width; an inline-block is one unit', async ({ page }) => {
    const { lines, lineW } = await measureCell(
      page,
      'a <code>b</code> <span style="display: inline-block; padding: 0 10px">c d</span>'
    );
    expect(lines.units).toBe(3);
    expect(Math.abs(oneLineWidth(lines) - lineW)).toBeLessThanOrEqual(2);
  });

  test('a hidden element adds no unit', async ({ page }) => {
    const { lines } = await measureCell(page, 'a <span style="display: none">hidden words</span> b');
    expect(lines.units).toBe(2);
    expect(lines.segments[0][1].gap).toBeGreaterThan(0);
  });

  test('<br> starts a new segment', async ({ page }) => {
    const { lines } = await measureCell(page, 'a<br>b');
    expect(lines.segments).toHaveLength(2);
    expect(lines.segments[0]).toHaveLength(1);
    expect(lines.segments[1]).toHaveLength(1);
    expect(lines.units).toBe(2);
  });

  test('a trailing <br> opens no line; consecutive and <br>-only lines count', async ({ page }) => {
    const [trailing, double, onlyBreaks, onlyBreak] = await measureCells(page, [
      'a<br>',
      'a<br><br>',
      '<br><br>',
      '<br>',
    ]);
    expect(trailing.lines.segments).toHaveLength(1);
    expect(double.lines.segments).toHaveLength(2);
    expect(onlyBreaks.lines.segments).toHaveLength(2);
    expect(onlyBreak.lines).toEqual({ segments: [], cjkUnits: 0, units: 0 });
  });

  test('block children are hard lines; a list item carries its indent', async ({ page }) => {
    const [paragraphs, list] = await measureCells(page, [
      '<p>alpha</p><p>beta</p>',
      '<ul><li>alpha</li><li>beta</li></ul>',
    ]);
    expect(paragraphs.lines.segments.map((s) => s.length)).toEqual([1, 1]);
    expect(list.lines.segments.map((s) => s.length)).toEqual([1, 1]);
    expect(list.lines.segments[0][0].w).toBeGreaterThan(paragraphs.lines.segments[0][0].w + 10);
  });

  test('fixedH is the height of the cell image', async ({ page }) => {
    const { lines } = await measureCell(page, `<img src="${PIXEL}" style="width: 40px; height: 120px">`);
    expect(lines.fixedH).toHaveLength(1);
    expect(Math.abs(lines.fixedH![0] - 120)).toBeLessThanOrEqual(1);
  });

  test('fixedH holds the tallest box of each hard line', async ({ page }) => {
    const img = (h: number): string => `<img src="${PIXEL}" style="width: 40px; height: ${h}px">`;
    const [stacked, sameLine] = await measureCells(page, [
      `${img(120)}<br>${img(80)}<br>text`,
      `${img(120)} ${img(80)}`,
    ]);
    expect(stacked.lines.fixedH!.map(Math.round)).toEqual([120, 80, 0]);
    expect(sameLine.lines.fixedH!.map(Math.round)).toEqual([120]);
  });

  test('fixedH of inline math is the formula height, not its line box', async ({ page }) => {
    await openEditor(page, '| Case |\n| --- |\n| $\\dfrac{\\dfrac{a}{b}}{\\dfrac{c}{d}}$ |\n');
    await page.locator('#content td .katex').waitFor();
    const { fixedH, lineBoxH, contentH } = await page.evaluate(() => {
      const table = document.querySelector('#content table') as HTMLTableElement;
      const cell = table.tBodies[0].rows[0].cells[0];
      const debug = (window as unknown as {
        TableAreaFitDebug: { measureTableLines(table: HTMLTableElement): CellLines[][] };
      }).TableAreaFitDebug;
      const measured = debug.measureTableLines(table)[1][0];
      table.classList.add('md-table-col-fit-measuring');
      const range = document.createRange();
      range.selectNodeContents(cell);
      const result = {
        fixedH: measured.fixedH?.[0],
        lineBoxH: cell.querySelector('.katex')!.getBoundingClientRect().height,
        contentH: range.getBoundingClientRect().height,
      };
      table.classList.remove('md-table-col-fit-measuring');
      return result;
    });
    expect(fixedH).toBeDefined();
    expect(fixedH!).toBeGreaterThan(lineBoxH * 1.8);
    expect(fixedH!).toBeLessThanOrEqual(contentH + 1);
  });

  test('a fitted table (fit class, inline widths) is left exactly as found', async ({ page }) => {
    await openEditor(page, TABLE_20);
    await page.locator('#content table').waitFor();
    const { same, units } = await page.evaluate(() => {
      const table = document.querySelector('#content table') as HTMLTableElement;
      const debug = (window as unknown as {
        TableAreaFitDebug: { measureTableLines(table: HTMLTableElement): CellLines[][] };
      }).TableAreaFitDebug;
      table.classList.add('md-table-fit');
      table.style.width = '900px';
      for (const row of Array.from(table.rows)) {
        for (const cell of Array.from(row.cells)) {
          cell.style.width = '150px';
          cell.style.maxWidth = '150px';
        }
      }
      const before = table.outerHTML;
      const measured = debug.measureTableLines(table);
      return { same: table.outerHTML === before, units: measured.flat().reduce((n, c) => n + c.units, 0) };
    });
    expect(same).toBe(true);
    expect(units).toBeGreaterThan(30);
  });

  test('an empty cell has no segments', async ({ page }) => {
    const { lines } = await measureCell(page, '');
    expect(lines).toEqual({ segments: [], cjkUnits: 0, units: 0 });
  });

  test('every cell of table #20 sums to its one-line width', async ({ page }) => {
    await openEditor(page, TABLE_20);
    await page.locator('#content table').waitFor();
    const result = await page.evaluate(() => {
      const table = document.querySelector('#content table') as HTMLTableElement;
      const debug = (window as unknown as {
        TableAreaFitDebug: { measureTableLines(table: HTMLTableElement): CellLines[][] };
      }).TableAreaFitDebug;
      const measured = debug.measureTableLines(table);
      table.classList.add('md-table-col-fit-measuring');
      const range = document.createRange();
      const all: { lines: CellLines; lineW: number }[] = [];
      Array.from(table.rows).forEach((row, r) =>
        Array.from(row.cells).forEach((cell, c) => {
          range.selectNodeContents(cell);
          all.push({ lines: measured[r][c], lineW: range.getBoundingClientRect().width });
        })
      );
      table.classList.remove('md-table-col-fit-measuring');
      return all;
    });
    expect(result).toHaveLength(5 * 6);
    for (const { lines, lineW } of result) {
      expect(lines.units).toBeGreaterThan(0);
      expect(lines.segments).toHaveLength(1);
      expect(Math.abs(oneLineWidth(lines) - lineW)).toBeLessThanOrEqual(2);
    }
  });
});
