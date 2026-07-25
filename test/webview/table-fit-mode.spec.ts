/**
 * US-19.25: Fit-mode — smart content-aware table column widths (global toggle).
 *
 * OFF (default) = today's US-19.3 scroll-island (wide table scrolls horizontally).
 * ON = columns shrink/wrap to fit the panel; a column dominated by one outlier
 * cell is capped so the outlier wraps; falls back to horizontal scroll only when
 * even min-content overflows. Needs real layout (Range/getBoundingClientRect,
 * ResizeObserver, table-layout:fixed wrapping), so it lives here, not roundtrip.
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

  test('ON, narrow panel: table fits the panel (no horizontal scroll) + fit class', async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 600 });
    await openEditor(page, makeTable(6, 4, WIDE), { tableFitMode: true });
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

  test('ON: an outlier column (one very long cell) is capped so that cell wraps', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    // Column 2 (index 1): 3 short rows + 1 very long row → outlier. Others short.
    const outlier = (r: number, c: number): string => {
      if (c === 1) return r === 1 ? 'this is a very very very long outlier value that dominates the column width' : 'ok';
      return SHORT(r, c);
    };
    await openEditor(page, makeTable(3, 4, outlier), { tableFitMode: true });
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
  });

  test('ON, table narrower than panel: not stretched to full width', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 600 });
    await openEditor(page, makeTable(2, 3, SHORT), { tableFitMode: true });
    await expect.poll(async () => (await tableInfo(page)).fit, { timeout: 3000 }).toBe(true);

    const m = await tableInfo(page);
    // Compact: the small table must NOT fill the wide panel (branch ①, no width:100%).
    expect(m.rectWidth).toBeLessThan(m.contentWidth * 0.7);
  });

  test('ON: reflows when the panel is resized narrower', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await openEditor(page, makeTable(6, 4, WIDE), { tableFitMode: true });
    await expect.poll(async () => (await tableInfo(page)).fit, { timeout: 3000 }).toBe(true);

    await page.setViewportSize({ width: 500, height: 600 });
    // After the ResizeObserver reflow, the table still fits the new (narrower) panel.
    await expect
      .poll(async () => {
        const m = await tableInfo(page);
        return m.fit && m.scrollWidth <= m.clientWidth + 2 && m.clientWidth < 560;
      }, { timeout: 3000 })
      .toBe(true);
  });

  test('ON but Σ(min-content) > panel: falls back to horizontal scroll (no fit class)', async ({ page }) => {
    await page.setViewportSize({ width: 260, height: 600 });
    // Long UNBREAKABLE tokens → large min-content per column; 6 of them can't fit 260px.
    const longWord = (_r: number, c: number): string => `AAAAAAAAAAAAAAAAAAAA${c}`;
    await openEditor(page, makeTable(6, 3, longWord), { tableFitMode: true });
    await page.locator('#content table').waitFor();
    await page.waitForTimeout(300);

    const m = await tableInfo(page);
    expect(m.fit).toBe(false); // fell back
    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth + 1); // scrolls
  });

  test('command toggles fit-mode on then off (reports back to host)', async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 600 });
    await openEditor(page, makeTable(6, 4, WIDE)); // starts OFF
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
