/**
 * US-19.25: Fit-mode — smart content-aware table column widths (global toggle).
 *
 * OFF (default) = today's US-19.3 scroll-island (wide table scrolls horizontally).
 * ON = columns shrink/wrap to fit the panel; a column dominated by one outlier
 * cell is capped so the outlier wraps; falls back to horizontal scroll only when
 * even min-content overflows. Needs real layout (Range/getBoundingClientRect,
 * ResizeObserver, table-layout:fixed wrapping), so it lives here, not roundtrip.
 *
 * US-19.26 narrows when the cap fires: only when Σmax-content exceeds the panel
 * (branch ①a keeps max-content while there is room, ①b hands the spare back), and
 * empty cells no longer count towards p75.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

/** A markdown table; `cell(r,c)` gives each body cell's text. */
function makeTable(cols: number, rows: number, cell: (r: number, c: number) => string): string {
  const header = '| ' + Array.from({ length: cols }, (_, c) => `Col ${c + 1}`).join(' | ') + ' |';
  const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
  const body = Array.from({ length: rows }, (_, r) =>
    '| ' + Array.from({ length: cols }, (_, c) => cell(r, c)).join(' | ') + ' |'
  ).join('\n');
  return `${header}\n${sep}\n${body}\n`;
}

const SHORT = (r: number, c: number): string => `r${r + 1}c${c + 1}`;
const WIDE = (r: number, c: number): string => `long cell content value for row ${r + 1} column ${c + 1}`;
/** Column 1 (index 1) holds one very long cell among short ones → outlier column. */
const OUTLIER = (r: number, c: number): string =>
  c === 1 ? (r === 1 ? 'this is a very very very long outlier value that dominates the column width' : 'ok') : SHORT(r, c);

/** Rendered width of cell `col` in the first body row. */
async function bodyCellWidth(page: Page, col: number): Promise<number> {
  return page.evaluate((i) => {
    const t = document.querySelector('#content table') as HTMLTableElement;
    return Math.round(t.tBodies[0].rows[0].cells[i].getBoundingClientRect().width);
  }, col);
}

interface TableInfo {
  fit: boolean;
  scrollWidth: number;
  clientWidth: number;
  rectWidth: number;
  contentWidth: number;
}

async function tableInfo(page: Page): Promise<TableInfo> {
  return page.evaluate(() => {
    const t = document.querySelector('#content table') as HTMLTableElement;
    const r = t.getBoundingClientRect();
    return {
      fit: t.classList.contains('md-table-fit'),
      scrollWidth: t.scrollWidth,
      clientWidth: t.clientWidth,
      rectWidth: r.width,
      contentWidth: (document.getElementById('content') as HTMLElement).clientWidth,
    };
  });
}

test.describe('US-19.25 table fit-mode', () => {
  test('OFF (default): wide table scrolls horizontally, no fit class', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 600 });
    await openEditor(page, makeTable(6, 4, WIDE)); // default tableFitMode:false
    await page.locator('#content table').waitFor();

    const m = await tableInfo(page);
    expect(m.fit).toBe(false);
    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth + 1); // overflows → scroll-island
  });

  test('ON: shrinks/wraps to fit when it can (no horizontal scroll) + fit class', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 600 });
    // 2 wide columns still fit at the 30ch readability floor → shrink+wrap, no scroll.
    await openEditor(page, makeTable(2, 4, WIDE), { tableFitMode: true });
    await page.locator('#content table').waitFor();

    await expect.poll(async () => (await tableInfo(page)).fit, { timeout: 3000 }).toBe(true);
    const m = await tableInfo(page);
    // Fits within the panel — the whole point (scrollWidth ≈ clientWidth, no overflow).
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth + 2);
    expect(m.rectWidth).toBeLessThanOrEqual(m.contentWidth + 2);
    // A long-content body cell must have WRAPPED (taller than the short header row).
    const wrapped = await page.evaluate(() => {
      const th = document.querySelector('#content table thead th') as HTMLElement;
      const td = document.querySelector('#content table tbody td') as HTMLElement;
      return td.getBoundingClientRect().height > th.getBoundingClientRect().height * 1.5;
    });
    expect(wrapped).toBe(true);
  });

  test('ON: an outlier column is capped so that cell wraps — once the panel runs out of room', async ({ page }) => {
    // US-19.26: the panel must be too narrow for Σmax-content (~680px here), otherwise
    // the cap is not allowed to fire at all (branch ①a — see the next test).
    await page.setViewportSize({ width: 560, height: 600 });
    await openEditor(page, makeTable(3, 4, OUTLIER), { tableFitMode: true });
    await expect.poll(async () => (await tableInfo(page)).fit, { timeout: 3000 }).toBe(true);

    // The outlier cell must have wrapped (height > a short cell's single-line height),
    // proving its column was capped below the outlier's max-content width.
    const r = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#content table tbody tr')) as HTMLTableRowElement[];
      const outlierCell = rows[1].cells[1];
      const shortCell = rows[0].cells[0];
      return {
        wrapped: outlierCell.getBoundingClientRect().height > shortCell.getBoundingClientRect().height * 1.5,
        shortColWidth: shortCell.getBoundingClientRect().width,
      };
    });
    expect(r.wrapped).toBe(true);
    // Short columns must stay near their content width — not inflated by the wide
    // panel or the outlier (the cap redistributed width, it didn't stretch neighbors).
    expect(r.shortColWidth).toBeLessThan(160);
    // US-19.26 branch ①b: the width the cap freed goes BACK to the capped column, so
    // the table fills the panel instead of leaving a gap beside the wrapped column.
    const m = await tableInfo(page);
    expect(m.rectWidth).toBeGreaterThan(m.contentWidth - 4);
  });

  test('ON: an outlier column is NOT capped while the panel still has room (US-19.26 ①a)', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 600 });
    await openEditor(page, makeTable(3, 4, OUTLIER), { tableFitMode: true });
    await page.locator('#content table').waitFor();
    await page.waitForTimeout(300);

    const r = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#content table tbody tr')) as HTMLTableRowElement[];
      const range = document.createRange();
      range.selectNodeContents(rows[1].cells[1]);
      return { outlierLines: range.getClientRects().length };
    });
    // Σmax-content fits the panel → no cap, no wrap: the long cell keeps one line.
    expect(r.outlierLines).toBe(1);
    // Still not stretched to full width (US-19.25 invariant kept).
    const m = await tableInfo(page);
    expect(m.rectWidth).toBeLessThan(m.contentWidth * 0.9);
  });

  test('ON: empty rows do not shrink a column (US-19.26 — p75 ignores empty cells)', async ({ page }) => {
    // Narrow enough that Σmax-content > budget (real capping territory, ①b/②) —
    // otherwise US-19.26's bail (plenty of room) would trivially pass this test
    // without ever exercising the p75-ignores-empty-cells fix it's meant to check.
    await page.setViewportSize({ width: 480, height: 600 });
    const head = '| # | Step | Description |\n| --- | --- | --- |\n';
    const filled =
      '| 1 | pick action | choose the "create leave request" action on the business list screen |\n' +
      '| 2 | fill it in | enter leave type, reason, and the start and end date of the leave |\n' +
      '| 3 | submit | the system generates the request code and stores the request |\n';
    const empties = '|  |  |  |\n'.repeat(20);

    await openEditor(page, head + filled, { tableFitMode: true });
    await expect.poll(async () => (await tableInfo(page)).fit, { timeout: 3000 }).toBe(true);
    const withoutEmpties = await bodyCellWidth(page, 2);

    await openEditor(page, head + filled + empties, { tableFitMode: true });
    await expect.poll(async () => (await tableInfo(page)).fit, { timeout: 3000 }).toBe(true);
    const withEmpties = await bodyCellWidth(page, 2);

    // Same content, 20 extra blank rows: the description column must not budge.
    // (Before US-19.26 the blank cells dragged p75 down to padding width, so the
    // outlier cap fired and cut this column back to the 30ch floor.)
    expect(Math.abs(withEmpties - withoutEmpties)).toBeLessThanOrEqual(2);
  });

  test('ON: no width jump crossing the ①a⇄①b boundary (US-19.26 continuity)', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 600 });
    await openEditor(page, makeTable(3, 4, OUTLIER), { tableFitMode: true });
    await page.locator('#content table').waitFor();
    await page.waitForTimeout(300);

    // Branch ①a → the table is exactly Σmax-content wide; derive the viewport width
    // whose budget lands just BELOW that sum (chrome = viewport − #content width).
    const m = await tableInfo(page);
    const naturalW = await bodyCellWidth(page, 1);
    // Precondition: we really are in ①a (uncapped), so the step below measures the
    // ①a→①b transition and not two already-capped states.
    const uncapped = await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents((document.querySelectorAll('#content table tbody tr')[1] as HTMLTableRowElement).cells[1]);
      return range.getClientRects().length === 1;
    });
    expect(uncapped).toBe(true);
    const justBelow = Math.round(m.rectWidth + (1400 - m.contentWidth)) - 20;

    await page.setViewportSize({ width: justBelow, height: 600 });
    await page.waitForTimeout(300);
    const cappedW = await bodyCellWidth(page, 1);

    // 20px short of fitting → the outlier column gives up ~20px, NOT a snap down to
    // the 30ch cap (which was a ~125px jump before US-19.26's ①b).
    expect(naturalW - cappedW).toBeLessThan(45);
    expect(cappedW).toBeLessThanOrEqual(naturalW + 2);
  });

  test('ON, table narrower than panel: not stretched to full width, and no fit-class pinning (US-19.26)', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 600 });
    await openEditor(page, makeTable(2, 3, SHORT), { tableFitMode: true });
    await page.locator('#content table').waitFor();
    await page.waitForTimeout(300);

    const m = await tableInfo(page);
    // US-19.26: plenty of room → applyFitColumns bails entirely (no cap needed), so
    // the table falls back to the natural default (no `.md-table-fit`, cells are not
    // pinned by max-width — typing more text can grow a column immediately instead
    // of waiting for a debounced re-fit).
    expect(m.fit).toBe(false);
    // Compact: the small table must NOT fill the wide panel either way.
    expect(m.rectWidth).toBeLessThan(m.contentWidth * 0.7);
  });

  test('ON: reflows when the panel is resized narrower', async ({ page }) => {
    // Narrow enough from the start that Σmax-content > budget (US-19.26 bails to the
    // default, uncapped, when there's room — this test wants to start already capped).
    await page.setViewportSize({ width: 520, height: 600 });
    await openEditor(page, makeTable(2, 4, WIDE), { tableFitMode: true });
    await expect.poll(async () => (await tableInfo(page)).fit, { timeout: 3000 }).toBe(true);

    await page.setViewportSize({ width: 420, height: 600 });
    // After the ResizeObserver reflow, the table still fits the new (narrower) panel.
    await expect
      .poll(async () => {
        const m = await tableInfo(page);
        return m.fit && m.scrollWidth <= m.clientWidth + 2 && m.clientWidth < 620;
      }, { timeout: 3000 })
      .toBe(true);
  });

  test('ON but Σ(min-content) > panel: horizontal scroll (no fit class)', async ({ page }) => {
    await page.setViewportSize({ width: 260, height: 600 });
    // Long UNBREAKABLE tokens → large min-content per column; 6 of them can't fit 260px.
    const longWord = (_r: number, c: number): string => `AAAAAAAAAAAAAAAAAAAA${c}`;
    await openEditor(page, makeTable(6, 3, longWord), { tableFitMode: true });
    await page.locator('#content table').waitFor();
    await page.waitForTimeout(300);

    const m = await tableInfo(page);
    expect(m.fit).toBe(false); // scroll-island, not fixed-fit
    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth + 1); // scrolls
  });

  test('ON: too many columns to fit readably → scrolls at the 30ch floor (not crushed)', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    // 6 wide columns: 6×~30ch floor > 900px → cannot fit readably → scroll AT the floor,
    // instead of crushing every column down to its min-content word width.
    await openEditor(page, makeTable(6, 4, WIDE), { tableFitMode: true });
    await page.locator('#content table').waitFor();
    await page.waitForTimeout(300);

    const r = await page.evaluate(() => {
      const t = document.querySelector('#content table') as HTMLTableElement;
      const widths = Array.from(t.tBodies[0].rows[0].cells).map((c) => c.getBoundingClientRect().width);
      return { fit: t.classList.contains('md-table-fit'), scrolls: t.scrollWidth - t.clientWidth > 1, minColW: Math.min(...widths) };
    });
    expect(r.scrolls).toBe(true); // scrolls rather than cramming
    expect(r.fit).toBe(false); // scroll-island, not fixed-fit
    expect(r.minColW).toBeGreaterThan(200); // ~30ch floor — NOT crushed to min-content
  });

  test('ON: no width jump crossing the fit⇄scroll boundary (continuity)', async ({ page }) => {
    const descrWidth = (): Promise<number> =>
      page.evaluate(() => Math.round((document.querySelector('#content table tbody td') as HTMLElement).getBoundingClientRect().width));
    const scrolls = (): Promise<boolean> =>
      page.evaluate(() => { const t = document.querySelector('#content table') as HTMLTableElement; return t.scrollWidth - t.clientWidth > 1; });

    // Just below the boundary → scrolls, columns pinned at the floor.
    await page.setViewportSize({ width: 1300, height: 600 });
    await openEditor(page, makeTable(6, 4, WIDE), { tableFitMode: true });
    await page.locator('#content table').waitFor();
    await page.waitForTimeout(300);
    const scrollW = await descrWidth();
    const didScroll = await scrolls();

    // Just above the boundary → fits (branch ②) at essentially the same width.
    await page.setViewportSize({ width: 1500, height: 600 });
    await page.waitForTimeout(300);
    const fitW = await descrWidth();
    const didFit = !(await scrolls());

    expect(didScroll).toBe(true);
    expect(didFit).toBe(true);
    expect(Math.abs(fitW - scrollW)).toBeLessThan(12); // column width barely moves → no visible jump
  });

  test('ON: never breaks mid-word and keeps a hyphenated date on one line', async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 600 });
    // Wide last column forces the table to shrink (branch ②). Without the per-word
    // floor, the narrow columns would break "Identifier" mid-word and wrap the date
    // at its '-'. With it, both stay whole.
    const md =
      '| Identifier | When | Description |\n' +
      '| --- | --- | --- |\n' +
      '| id-0001 | 2026-07-20 | a fairly long description that must wrap and take the slack so the other columns get squeezed |\n' +
      '| id-0002 | 2026-06-18 | another long description sentence here to keep this column wide enough to force overall shrinking |\n';
    await openEditor(page, md, { tableFitMode: true });
    await expect.poll(async () => (await tableInfo(page)).fit, { timeout: 3000 }).toBe(true);

    const r = await page.evaluate(() => {
      const lineCount = (cell: HTMLTableCellElement): number => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        return range.getClientRects().length;
      };
      const table = document.querySelector('#content table') as HTMLTableElement;
      const header = table.tHead!.rows[0];
      const body = table.tBodies[0].rows;
      return {
        headerWordLines: lineCount(header.cells[0]), // "Identifier" — one word
        dateLines: lineCount(body[0].cells[1]), // "2026-07-20"
        dateText: body[0].cells[1].textContent,
        descLines: lineCount(body[0].cells[2]), // sanity: this one DID wrap
      };
    });
    expect(r.headerWordLines).toBe(1); // word not split across lines
    expect(r.dateLines).toBe(1); // date not broken at '-'
    expect(r.dateText).toBe('2026-07-20');
    expect(r.descLines).toBeGreaterThan(1); // the wide column absorbed the shrink
  });

  test('ON: typing into a pinned narrow column re-fits it (debounced) so it grows with content', async ({ page }) => {
    // Narrow enough that Σmax-content > budget — genuinely pinned territory (①b/②),
    // not the US-19.26 bail (plenty of room), which is covered by the next test.
    await page.setViewportSize({ width: 560, height: 600 });
    // Col A starts tiny ("x") → pinned narrow by fit-mode; col B is long.
    const md = '| A | B |\n| --- | --- |\n| x | ' + 'long filler content keeping column B wide '.repeat(2) + '|\n';
    await openEditor(page, md, { tableFitMode: true });
    await expect.poll(async () => (await tableInfo(page)).fit, { timeout: 3000 }).toBe(true);

    const colAWidth = (): Promise<number> =>
      page.evaluate(() => Math.round((document.querySelector('#content table tbody td') as HTMLElement).getBoundingClientRect().width));
    const before = await colAWidth();

    // Put the caret at the end of col A's "x" cell and type a multi-word phrase.
    await page.evaluate(() => {
      const cell = document.querySelector('#content table tbody td') as HTMLElement;
      const r = document.createRange();
      r.selectNodeContents(cell);
      r.collapse(false);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    await page.keyboard.type(' alpha beta gamma delta epsilon');

    // The column is frozen (max-width pin) until the debounced re-fit fires; after it,
    // the column has grown to accommodate the typed content.
    await expect.poll(colAWidth, { timeout: 3000 }).toBeGreaterThan(before + 40);
  });

  test('ON: typing into a column grows it live when the table has room (US-19.26 — no premature pin)', async ({ page }) => {
    // Plenty of room → US-19.26 bails before pinning any width/max-width at all.
    await page.setViewportSize({ width: 1400, height: 600 });
    const md = '| A | B |\n| --- | --- |\n| x | short |\n';
    await openEditor(page, md, { tableFitMode: true });
    await page.locator('#content table').waitFor();
    await page.waitForTimeout(300);
    expect((await tableInfo(page)).fit).toBe(false); // confirms: bailed, nothing pinned

    const colAWidth = (): Promise<number> =>
      page.evaluate(() => Math.round((document.querySelector('#content table tbody td') as HTMLElement).getBoundingClientRect().width));
    const before = await colAWidth();

    await page.evaluate(() => {
      const cell = document.querySelector('#content table tbody td') as HTMLElement;
      const r = document.createRange();
      r.selectNodeContents(cell);
      r.collapse(false);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    await page.keyboard.type(' a fairly long phrase to widen this column');

    // No max-width was ever set on this cell, so the browser's own auto layout grows
    // the column as the text lands — no polling/waiting for the 200ms debounced
    // re-fit that the PINNED-column test above depends on. If a stale pin were
    // applied here, this assertion right after typing (no poll) would still see the
    // old, narrower width.
    const after = await colAWidth();
    expect(after).toBeGreaterThan(before + 60);
    expect((await tableInfo(page)).fit).toBe(false); // still not pinned into fit-mode
  });

  test('command toggles fit-mode on then off (reports back to host)', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 600 });
    await openEditor(page, makeTable(2, 4, WIDE)); // starts OFF (2 cols fit at the floor once ON)
    await page.locator('#content table').waitFor();
    expect((await tableInfo(page)).fit).toBe(false);

    await page.evaluate(() => window.postMessage({ type: 'runCommand', command: 'toggleTableFitMode' }, '*'));
    await expect.poll(async () => (await tableInfo(page)).fit, { timeout: 3000 }).toBe(true);
    // Reported to the host so it can persist the global + broadcast to other tabs.
    const postedOn = await page.evaluate(
      () => (window as unknown as { __posted: Array<{ type: string; on?: boolean }> }).__posted
        .filter((p) => p.type === 'tableFitModeChanged').at(-1)?.on
    );
    expect(postedOn).toBe(true);

    await page.evaluate(() => window.postMessage({ type: 'runCommand', command: 'toggleTableFitMode' }, '*'));
    await expect.poll(async () => (await tableInfo(page)).fit, { timeout: 3000 }).toBe(false);
  });
});
