/**
 * US-19.27 area fit (T1.4): fit mode's squeeze branches are driven by the
 * height-first solver (`solveAreaFit`) fed by `measureTableLines`. Checks the
 * integration in a real layout: CJK read floor, fixed-height content, fit⇄scroll
 * continuity and word-atomic wrap on the shared scenario fixtures.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';
import { TABLE_1, TABLE_4, TABLE_8A, TABLE_8B, TABLE_20 } from './table-area-fixtures';

/** A markdown table; `cell(r,c)` gives each body cell's text. */
function makeTable(cols: number, rows: number, cell: (r: number, c: number) => string): string {
  const header = '| ' + Array.from({ length: cols }, (_, c) => `Col ${c + 1}`).join(' | ') + ' |';
  const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
  const body = Array.from({ length: rows }, (_, r) =>
    '| ' + Array.from({ length: cols }, (_, c) => cell(r, c)).join(' | ') + ' |'
  ).join('\n');
  return `${header}\n${sep}\n${body}\n`;
}

/** 50-glyph unbroken CJK run (from table-fit-cjk-floor.spec.ts). */
const CJK_RUN = '総合メニューから＠を入力すると以下画面が出る(裏画面)ソウゴウニュウリョクイカガメンデウラガメン';
const CJK_COL = 1;
const WIDE = (r: number, c: number): string => `long cell content value for row ${r + 1} column ${c + 1}`;

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

interface TableInfo {
  fit: boolean;
  scrolls: boolean;
  scrollWidth: number;
  contentWidth: number;
  /** Border-box width of every column, from the first body row. */
  widths: number[];
}

async function tableInfo(page: Page): Promise<TableInfo> {
  return page.evaluate(() => {
    const t = document.querySelector('#content table') as HTMLTableElement;
    return {
      fit: t.classList.contains('md-table-fit'),
      scrolls: t.scrollWidth - t.clientWidth > 1,
      scrollWidth: t.scrollWidth,
      contentWidth: (document.getElementById('content') as HTMLElement).clientWidth,
      widths: Array.from(t.tBodies[0].rows[0].cells).map((c) => c.getBoundingClientRect().width),
    };
  });
}

async function openTable(page: Page, viewport: number, md: string): Promise<void> {
  await page.setViewportSize({ width: viewport, height: 700 });
  await openEditor(page, md, { tableFitMode: true });
  await page.locator('#content table').waitFor();
  await page.waitForTimeout(300);
}

test.describe('US-19.27 table area fit', () => {
  test('a squeezed column holding a long CJK run ends at or below its 36ch read floor', async ({ page }) => {
    await openTable(page, 900, makeTable(5, 4, (r, c) => (c === CJK_COL ? CJK_RUN : WIDE(r, c))));
    const r = await page.evaluate((col) => {
      const cell = (document.querySelector('#content table') as HTMLTableElement).tBodies[0].rows[0].cells[col];
      // 36ch in the cell's font, measured like table.ts measureChWidth.
      const cs = getComputedStyle(cell);
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;display:inline-block;width:36ch;padding:0;border:0;';
      probe.style.fontFamily = cs.fontFamily;
      probe.style.fontSize = cs.fontSize;
      probe.style.fontWeight = cs.fontWeight;
      probe.style.letterSpacing = cs.letterSpacing;
      document.body.appendChild(probe);
      const floor36 = probe.getBoundingClientRect().width;
      probe.remove();
      const range = document.createRange();
      range.selectNodeContents(cell);
      const lines = new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size;
      return { w: cell.getBoundingClientRect().width, floor36, lines };
    }, CJK_COL);
    expect(r.lines).toBeGreaterThanOrEqual(2); // squeezed, not at its one-line width
    expect(r.w).toBeLessThanOrEqual(r.floor36 + 2);
  });

  test('a row with a tall image does not widen that row\'s text columns', async ({ page }) => {
    // Row 1 holds the table's longest text; with a 200px image beside it, that
    // row's height is set by the image, so its text needs no extra width.
    const long = 'the longest text of the whole table which would set the height of its row if nothing else in the row were taller than it is';
    const table = (lead: string): string =>
      '| Pic | Notes | Details |\n| --- | --- | --- |\n' +
      `| ${lead} | ${long} | ${long} |\n` +
      '| x | a medium sentence of text for the notes column here | another medium sentence for the details column |\n' +
      '| x | short | short |\n';
    const img = `<img src="${PIXEL}" style="width: 12px; height: 200px">`;

    await openTable(page, 700, table('x'));
    const without = await tableInfo(page);
    await openTable(page, 700, table(img));
    const withImage = await tableInfo(page);
    const imgH = await page.evaluate(() => (document.querySelector('#content table img') as HTMLImageElement).getBoundingClientRect().height);

    expect(imgH).toBeGreaterThan(190); // the image rendered at its set height
    expect(withImage.fit).toBe(true);
    for (const col of [1, 2]) {
      expect(withImage.widths[col]).toBeLessThanOrEqual(without.widths[col] + 2);
    }
  });

  test('fit⇄scroll: no width change crossing the floor total', async ({ page }) => {
    await openTable(page, 700, makeTable(6, 4, WIDE));
    const atScroll = await tableInfo(page);
    expect(atScroll.scrolls).toBe(true);
    expect(atScroll.fit).toBe(false);

    // Budget just above the floor total → the solver fits at the same widths.
    const chrome = 700 - atScroll.contentWidth;
    await page.setViewportSize({ width: Math.ceil(atScroll.scrollWidth + chrome) + 4, height: 700 });
    await page.waitForTimeout(300);
    const atFit = await tableInfo(page);
    expect(atFit.scrolls).toBe(false);
    expect(atFit.fit).toBe(true);
    atFit.widths.forEach((w, i) => expect(Math.abs(w - atScroll.widths[i])).toBeLessThanOrEqual(1));
  });

  const fixtures: Record<string, string> = { '#1': TABLE_1, '#4': TABLE_4, '#8a': TABLE_8A, '#8b': TABLE_8B, '#20': TABLE_20 };
  for (const [name, md] of Object.entries(fixtures)) {
    for (const viewport of [700, 1000]) {
      test(`no mid-word break: ${name} at viewport ${viewport}`, async ({ page }) => {
        await openTable(page, viewport, md);
        const broken = await page.evaluate(() => {
          const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿ー＀-￯]/u;
          const out: string[] = [];
          const range = document.createRange();
          const table = document.querySelector('#content table') as HTMLTableElement;
          const walker = document.createTreeWalker(table, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            // KaTeX breaks between its own boxes; the math toggle is chrome.
            if (node.parentElement?.closest('.katex, button')) {
              continue;
            }
            const text = node.nodeValue ?? '';
            const re = /\S+/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
              // Non-CJK runs are atomic words; each CJK glyph may break on either side.
              let offset = m.index;
              let runStart = m.index;
              const check = (end: number): void => {
                if (end > runStart) {
                  range.setStart(node!, runStart);
                  range.setEnd(node!, end);
                  const tops = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top)));
                  if (tops.size > 1) {
                    out.push(text.slice(runStart, end));
                  }
                }
              };
              for (const ch of m[0]) {
                if (cjk.test(ch)) {
                  check(offset);
                  runStart = offset + ch.length;
                }
                offset += ch.length;
              }
              check(offset);
            }
          }
          return out;
        });
        expect(broken).toEqual([]);
      });
    }
  }
});
