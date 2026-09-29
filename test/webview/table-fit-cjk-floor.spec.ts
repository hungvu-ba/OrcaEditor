/**
 * US-19.25 bug fix: the fit-mode word floor treats each CJK glyph as its own word.
 *
 * A long unbroken Japanese run has no whitespace, but the browser may break
 * between almost any two CJK glyphs — so it must not raise its column floor to
 * the run's full one-line width (~650px). Non-CJK runs between glyphs stay atomic.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

const CJK_RUN = '総合メニューから＠を入力すると以下画面が出る(裏画面)ソウゴウニュウリョクイカガメンデウラガメン';
/** A long atomic Latin token wedged between CJK glyphs — must not be split. */
const TOKEN = 'IMPACT_MAP_D63110A1_IMPACT_MAP_D63110A1';
const CJK_COL = 1;
const TOKEN_COL = 3;
const LATIN_COL = 0;

/** A markdown table; `cell(r,c)` gives each body cell's text. */
function makeTable(cols: number, rows: number, cell: (r: number, c: number) => string): string {
  const header = '| ' + Array.from({ length: cols }, (_, c) => `Col ${c + 1}`).join(' | ') + ' |';
  const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
  const body = Array.from({ length: rows }, (_, r) =>
    '| ' + Array.from({ length: cols }, (_, c) => cell(r, c)).join(' | ') + ' |'
  ).join('\n');
  return `${header}\n${sep}\n${body}\n`;
}

const CELL = (r: number, c: number): string => {
  if (c === CJK_COL) {
    return CJK_RUN;
  }
  if (c === TOKEN_COL) {
    return `ユーザ${TOKEN}設定`;
  }
  return `long cell content value for row ${r + 1} column ${c + 1}`;
};

test.describe('Table fit mode — CJK word floor', () => {
  test('ON: a long CJK run sits at the 30ch floor and wraps; a Latin token between glyphs stays whole', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    // 6 wide columns → branch ③ (scroll, each column held at its floor).
    await openEditor(page, makeTable(6, 4, CELL), { tableFitMode: true });
    await page.locator('#content table').waitFor();
    await page.waitForTimeout(300);

    const r = await page.evaluate(({ cjkCol, tokenCol, latinCol, token }) => {
      const t = document.querySelector('#content table') as HTMLTableElement;
      const cells = t.tBodies[0].rows[0].cells;
      const width = (i: number): number => cells[i].getBoundingClientRect().width;
      // Line count of the CJK cell's text: distinct line-box tops.
      const range = document.createRange();
      range.selectNodeContents(cells[cjkCol]);
      const tops = new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top)));
      // One-line width of the token in the cell's own font.
      const probe = document.createElement('span');
      probe.style.whiteSpace = 'nowrap';
      probe.textContent = token;
      cells[tokenCol].appendChild(probe);
      const tokenW = probe.getBoundingClientRect().width;
      probe.remove();
      return {
        scrolls: t.scrollWidth - t.clientWidth > 1,
        cjkW: width(cjkCol),
        latinW: width(latinCol),
        tokenColW: width(tokenCol),
        tokenW,
        cjkLines: tops.size,
      };
    }, { cjkCol: CJK_COL, tokenCol: TOKEN_COL, latinCol: LATIN_COL, token: TOKEN });

    expect(r.scrolls).toBe(true); // branch ③
    // (a) CJK column held at the same ③ floor as a wide Latin column — not ~650px.
    expect(Math.abs(r.cjkW - r.latinW)).toBeLessThanOrEqual(2);
    expect(r.cjkLines).toBeGreaterThanOrEqual(2);
    // (b) the Latin run between CJK glyphs is not broken mid-word.
    expect(r.tokenColW).toBeGreaterThanOrEqual(r.tokenW);
  });
});
