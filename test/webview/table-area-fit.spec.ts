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

/** openTable, then wait until the render and ResizeObserver fit passes agree (GATE A (d)). */
async function openStableTable(page: Page, viewport: number, md: string): Promise<void> {
  await openTable(page, viewport, md);
  let prev = '';
  await expect
    .poll(
      async () => {
        const cur = await page.evaluate(() => {
          const r = (document.querySelector('#content table') as HTMLElement).getBoundingClientRect();
          return `${Math.round(r.width)}|${Math.round(r.height)}`;
        });
        const same = cur === prev;
        prev = cur;
        return same;
      },
      { timeout: 8000, intervals: [150] }
    )
    .toBe(true);
}

interface TableMetrics {
  fit: boolean;
  scrolls: boolean;
  scrollW: number;
  w: number;
  h: number;
  contentW: number;
  widths: number[];
  /** Per row, the column whose content is strictly the tallest; -1 on a tie. */
  topCol: number[];
  ch15: number;
  ch30: number;
  ch36: number;
}

/** Table rect (the visible box, as GATE A (d) measured it), column widths and N·ch in the cell font. */
async function tableMetrics(page: Page): Promise<TableMetrics> {
  return page.evaluate(() => {
    const t = document.querySelector('#content table') as HTMLTableElement;
    const r = t.getBoundingClientRect();
    const cell = t.tBodies[0].rows[0].cells[0];
    const cs = getComputedStyle(cell);
    const ch = (n: number): number => {
      const probe = document.createElement('span');
      probe.style.cssText = `position:absolute;visibility:hidden;display:inline-block;width:${n}ch;padding:0;border:0;`;
      probe.style.fontFamily = cs.fontFamily;
      probe.style.fontSize = cs.fontSize;
      probe.style.fontWeight = cs.fontWeight;
      probe.style.letterSpacing = cs.letterSpacing;
      document.body.appendChild(probe);
      const px = probe.getBoundingClientRect().width;
      probe.remove();
      return px;
    };
    const range = document.createRange();
    const topCol = Array.from(t.rows).map((row) => {
      const hs = Array.from(row.cells).map((c) => {
        range.selectNodeContents(c);
        return range.getBoundingClientRect().height;
      });
      const max = Math.max(...hs);
      const at = hs.filter((h) => h > max - 1);
      return at.length === 1 ? hs.indexOf(max) : -1;
    });
    return {
      fit: t.classList.contains('md-table-fit'),
      scrolls: t.scrollWidth - t.clientWidth > 1,
      scrollW: t.scrollWidth,
      w: r.width,
      h: r.height,
      contentW: (document.getElementById('content') as HTMLElement).clientWidth,
      widths: Array.from(t.tBodies[0].rows[0].cells).map((c) => c.getBoundingClientRect().width),
      topCol,
      ch15: ch(15),
      ch30: ch(30),
      ch36: ch(36),
    };
  });
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

  // GATE A (d) baseline per viewport: the pre-solver fit ladder's table rect
  // W × H (px²) and its scroll width (#content width where it did not scroll).
  const BASELINE: Record<string, [string, Record<number, { area: number; scrollW: number }>]> = {
    '#8b': [TABLE_8B, { 800: { area: 224622, scrollW: 996 }, 1000: { area: 284681, scrollW: 996 }, 1200: { area: 319036, scrollW: 1148 } }],
    '#20': [TABLE_20, { 800: { area: 291615, scrollW: 926 }, 1000: { area: 369587, scrollW: 948 }, 1200: { area: 344741, scrollW: 1148 } }],
  };
  for (const [name, [md, baseline]] of Object.entries(BASELINE)) {
    test(`area vs the GATE A baseline: ${name} is lower and not wider`, async ({ page }) => {
      const rows: string[] = [];
      let lower = 0;
      for (const viewport of [800, 1000, 1200]) {
        await openStableTable(page, viewport, md);
        const m = await tableMetrics(page);
        const area = Math.round(m.w * m.h);
        const base = baseline[viewport];
        rows.push(`${name} @ ${viewport}: ${area} px² (baseline ${base.area}, ${(((area - base.area) / base.area) * 100).toFixed(1)}%) W ${m.w.toFixed(0)} / #content ${m.contentW} scrollW ${m.scrollW} (baseline ${base.scrollW}) widths ${m.widths.map((w) => w.toFixed(0)).join(' ')}`);
        expect.soft(m.w).toBeLessThanOrEqual(m.contentW + 1);
        // US-19.27 (PO 2026-09-30): a scrolling table is judged by scroll width, not visible area.
        if (m.scrolls) {
          expect.soft(m.scrollW).toBeLessThanOrEqual(base.scrollW);
        } else {
          expect.soft(area).toBeLessThanOrEqual(base.area);
          if (area < base.area) lower++;
        }
      }
      console.log(rows.join('\n'));
      expect(lower).toBeGreaterThanOrEqual(2);
    });
  }

  test('#20 Risk column is between 15ch and 30ch at viewport 800 / 1000 / 1200', async ({ page }) => {
    const rows: string[] = [];
    for (const viewport of [800, 1000, 1200]) {
      await openStableTable(page, viewport, TABLE_20);
      const m = await tableMetrics(page);
      rows.push(`#20 @ ${viewport}: Risk ${m.widths[0].toFixed(0)} px (15ch ${m.ch15.toFixed(0)}, 30ch ${m.ch30.toFixed(0)})`);
      expect.soft(m.widths[0]).toBeLessThan(m.ch30);
      expect.soft(m.widths[0]).toBeGreaterThanOrEqual(m.ch15 - 1);
    }
    console.log(rows.join('\n'));
  });

  test('#8b JA and ZH columns: ≥ 36ch where they hold a row\'s tallest cell, ≥ 15ch otherwise', async ({ page }) => {
    // Contract 5 (PO 2026-09-30): a CJK column that sets no row's height may shrink to 15ch.
    const rows: string[] = [];
    for (const viewport of [800, 1000, 1200]) {
      await openStableTable(page, viewport, TABLE_8B);
      const m = await tableMetrics(page);
      for (const [label, col] of [['JA', 2], ['ZH', 3]] as [string, number][]) {
        const tops = m.topCol.flatMap((c, r) => (c === col ? [r] : []));
        rows.push(`#8b @ ${viewport}: ${label} ${m.widths[col].toFixed(0)} px, tallest in rows [${tops.join(',')}] (15ch ${m.ch15.toFixed(0)}, 36ch ${m.ch36.toFixed(0)})`);
        expect.soft(m.widths[col]).toBeGreaterThanOrEqual((tops.length ? m.ch36 : m.ch15) - 1);
      }
    }
    console.log(rows.join('\n'));
  });

  test('knee: a table whose extra width saves < 5% height stops short of #content, at ≥ 85% of it', async ({ page }) => {
    // 30 one-line rows plus one long paragraph: past the knee, each line the
    // paragraph loses is ≈ 3% of the table height.
    const long = Array.from({ length: 40 }, (_, i) => `sentence part ${i + 1} of the long note`).join(', ');
    const md =
      '| Key | Value | Note |\n| --- | --- | --- |\n' +
      `| k0 | v0 | ${long} |\n` +
      Array.from({ length: 30 }, (_, r) => `| k${r + 1} | value ${r + 1} | ok |`).join('\n') +
      '\n';
    await openStableTable(page, 1000, md);
    const m = await tableMetrics(page);
    console.log(`knee @ 1000: W ${m.w.toFixed(0)} / #content ${m.contentW} (${((m.w / m.contentW) * 100).toFixed(1)}%)`);
    expect(m.fit).toBe(true);
    expect(m.w).toBeLessThan(m.contentW - 1);
    expect(m.w).toBeGreaterThanOrEqual(0.85 * m.contentW - 1);
  });

  // Contract 8: add/delete row/column re-fits against the applied widths
  // (AREA_FIT_HYSTERESIS) instead of re-solving from scratch. Each case first
  // widens Mitigation by 12 px into the knee's spare width (H can only drop),
  // so a from-scratch re-solve would visibly undo it.
  async function headerWidths(page: Page): Promise<number[]> {
    return page.evaluate(() =>
      Array.from((document.querySelector('#content table') as HTMLTableElement).rows[0].cells).map((c) => c.getBoundingClientRect().width)
    );
  }
  async function widenMitigation(page: Page): Promise<number[]> {
    await page.evaluate(() => {
      const t = document.querySelector('#content table') as HTMLTableElement;
      t.style.width = `${parseFloat(t.style.width) + 12}px`;
      for (const row of Array.from(t.rows)) {
        const c = row.cells[3];
        const w = `${parseFloat(c.style.width) + 12}px`;
        c.style.width = w;
        c.style.maxWidth = w;
      }
    });
    return headerWidths(page);
  }
  async function tableEdit(page: Page, cell: string, action: string): Promise<void> {
    await page.locator(cell).first().click();
    await page.locator(`#table-toolbar button[title="${action}"]`).click();
    await page.waitForTimeout(300);
  }
  function expectKept(after: number[], before: number[], what: string): void {
    before.forEach((w, i) => expect(Math.abs(after[i] - w), `column ${i} after ${what}`).toBeLessThanOrEqual(1));
  }

  test('#20 at viewport 1000: adding a row keeps every column width', async ({ page }) => {
    await openStableTable(page, 1000, TABLE_20);
    const before = await widenMitigation(page);
    await tableEdit(page, '#content td:text-is("Binh")', 'Insert row below');
    expect(await page.evaluate(() => (document.querySelector('#content table') as HTMLTableElement).rows.length)).toBe(6);
    expectKept(await headerWidths(page), before, 'add row');
  });

  // T1.7.p2: a row delete that narrows a column's content is handled like deleting
  // text — no re-fit at once; the idle settle (FIT_IDLE_SETTLE_MS) narrows it later.
  test('deleting the row that held a column\'s widest cell keeps every width until the table settles', async ({ page }) => {
    const long = 'reads well only when this column gets a generous share of the panel width '.repeat(4);
    const md = `| Key | Notes | Details |\n| --- | --- | --- |\n| a | ${long} | ${long} |\n| Supercalifragilistic expialidocious wording | x | y |\n| b | ${long} | ${long} |\n`;
    await openStableTable(page, 1000, md);
    const before = await headerWidths(page);
    await tableEdit(page, '#content td:text-is("Supercalifragilistic expialidocious wording")', 'Delete current row');
    expect(await page.evaluate(() => (document.querySelector('#content table') as HTMLTableElement).rows.length)).toBe(3);
    expectKept(await headerWidths(page), before, 'delete row');
    await page.waitForTimeout(700);
    expectKept(await headerWidths(page), before, 'delete row, 1 s later');
    await expect.poll(async () => (await headerWidths(page))[0], { timeout: 3000 }).toBeLessThan(before[0] - 20);
  });

  // At viewport 1000 the knee leaves 76 px, less than the new column's 105 px:
  // keeping every width is infeasible there, so the column case runs at 1200.
  test('#20 at viewport 1200: inserting then deleting a column keeps the existing column widths', async ({ page }) => {
    await openStableTable(page, 1200, TABLE_20);
    const before = await widenMitigation(page);
    await tableEdit(page, '#content td:text-is("Binh")', 'Insert column right');
    const inserted = await headerWidths(page);
    expect(inserted.length).toBe(7);
    expect(inserted.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual((await tableInfo(page)).contentWidth);
    expectKept(inserted, before, 'insert column');
    await tableEdit(page, '#content th:text-is("New Column")', 'Delete current column');
    const deleted = await headerWidths(page);
    expect(deleted.length).toBe(6);
    expectKept(deleted, before, 'delete column');
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
