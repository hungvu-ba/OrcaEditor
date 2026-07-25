/**
 * US-19.24: floating always-visible horizontal scrollbar for wide tables.
 *
 * A wide table's native h-scrollbar sits at the table's own bottom (US-19.3
 * scroll-island), so on a tall table you must scroll to the very bottom to reach
 * it. table-sticky-header.ts adds a `position:fixed` proxy scrollbar pinned to the
 * viewport bottom, column-aligned to the table crossing the viewport bottom edge,
 * two-way synced with table.scrollLeft. Needs a real layout/scroll engine (the
 * proxy overflow + real scroll events), so it lives here, not in test/roundtrip/.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

/** A markdown table with `cols` wide columns and `rows` body rows. */
function makeTable(cols: number, rows: number): string {
  const header = '| ' + Array.from({ length: cols }, (_, c) => `Long column header number ${c + 1}`).join(' | ') + ' |';
  const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
  const body = Array.from({ length: rows }, (_, r) =>
    '| ' + Array.from({ length: cols }, (_, c) => `long cell content row ${r + 1} col ${c + 1}`).join(' | ') + ' |'
  ).join('\n');
  return `${header}\n${sep}\n${body}\n`;
}

interface BarMetrics {
  visible: boolean;
  barLeft: number;
  barWidth: number;
  barBottom: number;
  spacerWidth: number;
  proxyScrollLeft: number;
  tableLeft: number;
  tableClientLeft: number;
  tableClientWidth: number;
  tableScrollWidth: number;
  tableScrollLeft: number;
  tableBottom: number;
  innerHeight: number;
}

/** Read the floating-scrollbar + first-table geometry in one layout pass. */
async function metrics(page: Page): Promise<BarMetrics> {
  return page.evaluate(() => {
    const bar = document.getElementById('sticky-table-scrollbar') as HTMLElement;
    const spacer = bar.firstElementChild as HTMLElement;
    const table = document.querySelector('#content table') as HTMLTableElement;
    const barRect = bar.getBoundingClientRect();
    const tRect = table.getBoundingClientRect();
    return {
      visible: bar.classList.contains('visible'),
      barLeft: barRect.left,
      barWidth: barRect.width,
      barBottom: barRect.bottom,
      spacerWidth: spacer.getBoundingClientRect().width,
      proxyScrollLeft: bar.scrollLeft,
      tableLeft: tRect.left,
      tableClientLeft: table.clientLeft,
      tableClientWidth: table.clientWidth,
      tableScrollWidth: table.scrollWidth,
      tableScrollLeft: table.scrollLeft,
      tableBottom: tRect.bottom,
      innerHeight: window.innerHeight,
    };
  });
}

test.describe('US-19.24 floating horizontal scrollbar', () => {
  test('wide + tall table: bar visible, column-aligned, native bar off-screen', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 420 });
    await openEditor(page, makeTable(6, 24));

    await expect
      .poll(async () => (await metrics(page)).visible, { timeout: 3000 })
      .toBe(true);

    const m = await metrics(page);
    // Precondition: the table really overflows horizontally and crosses the fold.
    expect(m.tableScrollWidth).toBeGreaterThan(m.tableClientWidth + 1);
    expect(m.tableBottom).toBeGreaterThan(m.innerHeight); // native bottom bar below the fold

    // Column-aligned to the table's inner box; spacer = full scrollable width.
    expect(Math.abs(m.barLeft - (m.tableLeft + m.tableClientLeft))).toBeLessThanOrEqual(2);
    expect(Math.abs(m.barWidth - m.tableClientWidth)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.spacerWidth - m.tableScrollWidth)).toBeLessThanOrEqual(2);
    // Pinned to the viewport bottom.
    expect(Math.abs(m.barBottom - m.innerHeight)).toBeLessThanOrEqual(2);
  });

  test('dragging the proxy scrolls the table horizontally', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 420 });
    await openEditor(page, makeTable(6, 24));
    await expect.poll(async () => (await metrics(page)).visible, { timeout: 3000 }).toBe(true);

    const before = await metrics(page);
    const target = Math.round((before.tableScrollWidth - before.tableClientWidth) / 2);
    expect(target).toBeGreaterThan(10);

    // Emulate a thumb drag by setting the proxy's scrollLeft (fires a real scroll event).
    await page.evaluate((x) => {
      (document.getElementById('sticky-table-scrollbar') as HTMLElement).scrollLeft = x;
    }, target);

    await expect
      .poll(async () => (await metrics(page)).tableScrollLeft, { timeout: 2000 })
      .toBeGreaterThan(target - 3);
    const after = await metrics(page);
    expect(Math.abs(after.tableScrollLeft - target)).toBeLessThanOrEqual(3);
  });

  test('scrolling the table syncs the proxy thumb back', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 420 });
    await openEditor(page, makeTable(6, 24));
    await expect.poll(async () => (await metrics(page)).visible, { timeout: 3000 }).toBe(true);

    const before = await metrics(page);
    const target = Math.round((before.tableScrollWidth - before.tableClientWidth) / 2);

    // Scroll the table's own scroll-island; the proxy must follow (via updateScrollbar).
    await page.evaluate((x) => {
      (document.querySelector('#content table') as HTMLTableElement).scrollLeft = x;
    }, target);

    await expect
      .poll(async () => (await metrics(page)).proxyScrollLeft, { timeout: 2000 })
      .toBeGreaterThan(target - 3);
  });

  test('non-overflowing table: bar hidden', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 420 });
    await openEditor(page, makeTable(2, 24));

    // Give the controller a chance to run; it must decide "hidden".
    await page.waitForTimeout(300);
    const m = await metrics(page);
    expect(m.tableScrollWidth).toBeLessThanOrEqual(m.tableClientWidth + 1); // fits — no overflow
    expect(m.visible).toBe(false);
  });

  test('wide but short table fully in view (native bar visible): bar hidden', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 600 });
    await openEditor(page, makeTable(6, 3));

    await page.waitForTimeout(300);
    const m = await metrics(page);
    expect(m.tableScrollWidth).toBeGreaterThan(m.tableClientWidth + 1); // still overflows horizontally
    expect(m.tableBottom).toBeLessThan(m.innerHeight); // whole table on-screen → native bar reachable
    expect(m.visible).toBe(false);
  });

  test('sticky-header clone translateX follows the proxy scroll', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 420 });
    await openEditor(page, makeTable(6, 24));

    // Scroll the page so the table header passes the sticky line → BOTH the sticky
    // header clone and the floating bar engage (spec task b: they must stay synced).
    await page.evaluate(() => {
      const t = document.querySelector('#content table') as HTMLElement;
      window.scrollBy(0, t.getBoundingClientRect().top + 60);
    });
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.getElementById('sticky-table-header')!.classList.contains('visible') &&
              document.getElementById('sticky-table-scrollbar')!.classList.contains('visible')
          ),
        { timeout: 3000 }
      )
      .toBe(true);

    const target = await page.evaluate(() => {
      const t = document.querySelector('#content table') as HTMLTableElement;
      return Math.round((t.scrollWidth - t.clientWidth) / 2);
    });
    await page.evaluate((x) => {
      (document.getElementById('sticky-table-scrollbar') as HTMLElement).scrollLeft = x;
    }, target);

    // The header clone's translateX must track -table.scrollLeft (columns stay aligned).
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const clone = document.querySelector('#sticky-table-header table') as HTMLElement;
            const t = document.querySelector('#content table') as HTMLTableElement;
            const tr = getComputedStyle(clone).transform;
            const m = tr === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(tr);
            return t.scrollLeft > 5 && Math.abs(m.m41 - -t.scrollLeft) <= 2;
          }),
        { timeout: 2000 }
      )
      .toBe(true);
  });

  test('floating bar never overlaps the native bottom bar across the fold', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 420 });
    await openEditor(page, makeTable(6, 24));
    await expect.poll(async () => (await metrics(page)).visible, { timeout: 3000 }).toBe(true);

    // Step the page down through the band where the table bottom crosses the fold.
    // Invariant: whenever the floating bar shows, the table's own bottom bar must NOT
    // be reachable yet (table bottom deeper than one bar-height below the fold) —
    // otherwise the two horizontal bars would stack.
    const BAR = 14;
    for (let step = 0; step < 30; step++) {
      await page.evaluate(() => window.scrollBy(0, 40));
      await page.waitForTimeout(40); // let the rAF-coalesced update settle
      const m = await metrics(page);
      if (m.visible) {
        expect(m.tableBottom).toBeGreaterThan(m.innerHeight + BAR - 1);
      }
    }
  });
});
