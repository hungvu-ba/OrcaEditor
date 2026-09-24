/**
 * Column drag on a wide scroll-island table (US-19.3) must not reset its
 * horizontal scroll. The old `finishColMove` swapped the whole <table> via
 * execCommand('insertHTML'), so the fresh element started at scrollLeft 0 and
 * the view jumped back to the first column. Needs a real layout/scroll engine
 * plus real mouse drag, so it lives here, not in test/roundtrip/.
 */
import { test, expect } from '@playwright/test';
import { openEditor, waitForEdit } from './_harness';

const COLS = 8;
const header = '| ' + Array.from({ length: COLS }, (_, c) => `Long column header number ${c + 1}`).join(' | ') + ' |';
const sep = '| ' + Array.from({ length: COLS }, () => '---').join(' | ') + ' |';
const body = Array.from({ length: 3 }, (_, r) =>
  '| ' + Array.from({ length: COLS }, (_, c) => `long cell content row ${r + 1} col ${c + 1}`).join(' | ') + ' |'
).join('\n');
// Heading + paragraph first so the column handle (above the header row) clears the sticky toolbar.
const WIDE_DOC = `# Heading\n\nSome paragraph to push the table down away from the toolbar.\n\n${header}\n${sep}\n${body}\n`;

test('dragging a column in a horizontally scrolled table keeps the same table element and its scroll position', async ({
  page,
}) => {
  await openEditor(page, WIDE_DOC);

  // Scroll the island to the middle and tag the live <table> so a replacement is detectable.
  const { scrollLeft, fromIdx, widths } = await page.evaluate(() => {
    const table = document.querySelector('#content table') as HTMLTableElement;
    (table as unknown as { __tag: string }).__tag = 'original';
    table.scrollLeft = Math.floor((table.scrollWidth - table.clientWidth) / 2);
    const tRect = table.getBoundingClientRect();
    const cells = Array.from(table.tHead!.rows[0].cells);
    // First header cell fully visible inside the scrolled viewport whose right neighbor is also visible.
    const idx = cells.findIndex((c, i) => {
      const r = c.getBoundingClientRect();
      const next = cells[i + 1]?.getBoundingClientRect();
      return r.left >= tRect.left && !!next && next.right <= tRect.right;
    });
    return { scrollLeft: table.scrollLeft, fromIdx: idx, widths: cells.map((c) => c.getBoundingClientRect().width) };
  });
  expect(scrollLeft).toBeGreaterThan(0);
  expect(fromIdx).toBeGreaterThanOrEqual(0);

  const fromCell = page.locator('#content thead th').nth(fromIdx);
  const nextCell = page.locator('#content thead th').nth(fromIdx + 1);
  await fromCell.hover();
  const colHandle = page.locator('.dd-col-handle');
  await expect(colHandle).toHaveCSS('display', 'flex');
  const handleBox = await colHandle.boundingBox();
  const nextBox = await nextCell.boundingBox();
  if (!handleBox || !nextBox) {
    throw new Error('missing bounding box');
  }

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  // Land in the right half of the neighbor so the column drops after it.
  await page.mouse.move(nextBox.x + nextBox.width - 4, nextBox.y + nextBox.height / 2, { steps: 10 });
  await page.mouse.up();

  const md = await waitForEdit(page);
  const headerLine = md.split('\n').find((l) => l.includes('Long column header number 1'))!;
  expect(headerLine.indexOf(`number ${fromIdx + 2} `)).toBeLessThan(headerLine.indexOf(`number ${fromIdx + 1} `));

  const after = await page.evaluate(() => {
    const table = document.querySelector('#content table') as HTMLTableElement;
    return {
      tag: (table as unknown as { __tag?: string }).__tag,
      scrollLeft: table.scrollLeft,
      widths: Array.from(table.tHead!.rows[0].cells).map((c) => c.getBoundingClientRect().width),
    };
  });
  expect(after.tag).toBe('original');
  expect(Math.abs(after.scrollLeft - scrollLeft)).toBeLessThanOrEqual(1);
  // Column widths travel with their cells (no re-fit pass): the two swapped columns trade widths.
  const expected = [...widths];
  [expected[fromIdx], expected[fromIdx + 1]] = [expected[fromIdx + 1], expected[fromIdx]];
  after.widths.forEach((w, i) => expect(Math.abs(w - expected[i])).toBeLessThanOrEqual(1));
});
