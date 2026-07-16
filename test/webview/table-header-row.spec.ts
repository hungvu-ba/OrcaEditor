/**
 * Coverage for bug 0716 round 2: the header row had no row handle at all
 * (findRowAt only scanned tbody rows), and there was no way to manually
 * promote a data row to become the header. Real hover/click/drag behavior —
 * not reducible to a hand-built DOM snapshot (Plan/WEBVIEW_TEST.md).
 */
import { test, expect } from '@playwright/test';
import { openEditor, waitForEdit } from './_harness';

const DOC = `| A | B |
| --- | --- |
| r1c1 | r1c2 |
| r2c1 | r2c2 |
`;

test('the header row gets a row handle on hover, like any other row', async ({ page }) => {
  await openEditor(page, DOC);
  await page.locator('th', { hasText: 'A' }).hover();

  await expect(page.locator('.dd-row-handle')).toHaveCSS('display', 'flex');
});

test('clicking a data row handle offers "Set as header row" and swaps it in', async ({ page }) => {
  await openEditor(page, DOC);
  const r2Row = page.locator('tr', { hasText: 'r2c1' });
  await r2Row.locator('td, th').first().hover();

  const rowHandle = page.locator('.dd-row-handle');
  const box = await rowHandle.boundingBox();
  if (!box) {
    throw new Error('row handle has no bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  const popup = page.locator('.dd-row-menu-popup');
  await expect(popup).toBeVisible();
  await popup.locator('.dd-menu-item', { hasText: 'Set as header row' }).click();

  const md = await waitForEdit(page);
  const rows = md
    .trim()
    .split('\n')
    .filter((l) => l.trim().startsWith('|'));
  // New header is r2's old content; r1 keeps its position; old header ("A"/"B") takes r2's old spot.
  expect(rows[0]).toContain('r2c1');
  expect(rows[2]).toContain('r1c1');
  expect(rows[3]).toContain('| A |');
});

test('clicking the header row\'s own handle opens no menu (already the header)', async ({ page }) => {
  await openEditor(page, DOC);
  await page.locator('th', { hasText: 'A' }).hover();

  const rowHandle = page.locator('.dd-row-handle');
  const box = await rowHandle.boundingBox();
  if (!box) {
    throw new Error('row handle has no bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);

  await expect(page.locator('.dd-row-menu-popup')).toBeHidden();
});

test('dragging the header row handle does not reorder anything', async ({ page }) => {
  await openEditor(page, DOC);
  await page.locator('th', { hasText: 'A' }).hover();

  const rowHandle = page.locator('.dd-row-handle');
  const box = await rowHandle.boundingBox();
  const r2Box = await page.locator('tr', { hasText: 'r2c1' }).boundingBox();
  if (!box || !r2Box) {
    throw new Error('missing bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, r2Box.y + r2Box.height + 5, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  await expect(page.locator('thead th', { hasText: 'A' })).toHaveCount(1);
  await expect(page.locator('tbody tr')).toHaveCount(2);
});
