/**
 * US-19.27 area fit (T1.9): `measureCellLines` (media/webview/table-area-measure.ts)
 * turns a real rendered cell into the solver's CellLines. Driven via
 * window.TableAreaFitDebug (esbuild.js's tableAreaFitDebugConfig + _harness.ts),
 * with the table under the nowrap measure class the fit pass uses.
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
  fixedH?: number;
}

/** 1×1 transparent GIF; the CSS size sets the box. */
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Renders a one-cell table, sets the body cell's HTML, measures it under the nowrap measure class. */
async function measureCell(page: Page, cellHtml: string): Promise<{ lines: CellLines; lineW: number }> {
  await openEditor(page, '| Case |\n| --- |\n| x |\n');
  await page.locator('#content table').waitFor();
  return page.evaluate((html) => {
    const table = document.querySelector('#content table') as HTMLTableElement;
    const cell = table.tBodies[0].rows[0].cells[0];
    cell.innerHTML = html;
    table.classList.add('md-table-col-fit-measuring');
    const debug = (window as unknown as {
      TableAreaFitDebug: { measureCellLines(cell: HTMLTableCellElement, range: Range): CellLines };
    }).TableAreaFitDebug;
    const range = document.createRange();
    const lines = debug.measureCellLines(cell, range);
    range.selectNodeContents(cell);
    const lineW = range.getBoundingClientRect().width;
    table.classList.remove('md-table-col-fit-measuring');
    return { lines, lineW };
  }, cellHtml);
}

test.describe('Table area fit — measureCellLines', () => {
  test('words: hyphenated tokens stay atomic, gaps are the whitespace widths', async ({ page }) => {
    const { lines, lineW } = await measureCell(page, 'alpha beta-gamma 2026-09-24');
    expect(lines.segments).toHaveLength(1);
    const seg = lines.segments[0];
    expect(lines.units).toBe(3);
    expect(lines.cjkUnits).toBe(0);
    expect(seg).toHaveLength(3);
    expect(seg[1].gap).toBeGreaterThan(0);
    expect(seg[2].gap).toBeGreaterThan(0);
    const sum = seg.reduce((acc, u) => acc + u.w + u.gap, 0);
    expect(Math.abs(sum - lineW)).toBeLessThanOrEqual(2);
  });

  test('a CJK run is one unit per glyph with gap 0', async ({ page }) => {
    const { lines } = await measureCell(page, '用户在预订博物馆门票');
    expect(lines.units).toBe(10);
    expect(lines.cjkUnits).toBe(10);
    expect(lines.segments).toHaveLength(1);
    expect(lines.segments[0]).toHaveLength(10);
    for (const u of lines.segments[0]) {
      expect(u.gap).toBe(0);
      expect(u.w).toBeGreaterThan(0);
    }
  });

  test('<br> starts a new segment', async ({ page }) => {
    const { lines } = await measureCell(page, 'a<br>b');
    expect(lines.segments).toHaveLength(2);
    expect(lines.segments[0]).toHaveLength(1);
    expect(lines.segments[1]).toHaveLength(1);
    expect(lines.units).toBe(2);
  });

  test('fixedH is the height of the cell image', async ({ page }) => {
    const { lines } = await measureCell(page, `<img src="${PIXEL}" style="width: 40px; height: 120px">`);
    expect(lines.fixedH).toBeDefined();
    expect(Math.abs(lines.fixedH! - 120)).toBeLessThanOrEqual(1);
  });

  test('an empty cell has no segments', async ({ page }) => {
    const { lines } = await measureCell(page, '');
    expect(lines).toEqual({ segments: [], cjkUnits: 0, units: 0 });
  });

  test('every cell of table #20 measures without throwing', async ({ page }) => {
    await openEditor(page, TABLE_20);
    await page.locator('#content table').waitFor();
    const result = await page.evaluate(() => {
      const table = document.querySelector('#content table') as HTMLTableElement;
      const debug = (window as unknown as {
        TableAreaFitDebug: { measureCellLines(cell: HTMLTableCellElement, range: Range): CellLines };
      }).TableAreaFitDebug;
      table.classList.add('md-table-col-fit-measuring');
      const range = document.createRange();
      const all: CellLines[] = [];
      for (const row of Array.from(table.rows)) {
        for (const cell of Array.from(row.cells)) {
          all.push(debug.measureCellLines(cell, range));
        }
      }
      table.classList.remove('md-table-col-fit-measuring');
      return all;
    });
    expect(result).toHaveLength(5 * 6);
    for (const lines of result) {
      expect(lines.units).toBeGreaterThan(0);
      expect(lines.segments.flat()).toHaveLength(lines.units);
    }
  });
});
