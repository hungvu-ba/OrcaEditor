/**
 * Playwright coverage for T1.1 (Drag Handle Position, defect 1): every
 * position:fixed handle computes `right`/`bottom` from
 * `document.documentElement.clientWidth/clientHeight`, not
 * `window.innerWidth/innerHeight`. The two differ only under a classic
 * (non-overlay) scrollbar, which VS Code webviews always have — so each case
 * runs with Chromium's `--hide-scrollbars` removed and a 10px
 * `::-webkit-scrollbar` rule; `html { overflow-x: scroll }` adds the matching
 * horizontal scrollbar so the `bottom`-anchored handles are exercised too.
 * Edges are asserted against the hovered block, not handle-vs-handle
 * (Plan/drag-handle-position-analysis.md "## Contracts" 4).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { openEditor } from './_harness';

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const SCROLLBAR_PX = 10;
/** `LI_HANDLE_MARKER_COVER_PAD_PX` in drag-drop.ts — same hand-kept copy as drag-handle.spec.ts. */
const MARKER_COVER_PAD_PX = 2;

const BLOCK_HANDLE_SELECTOR =
  '.dd-handle:not(.dd-li-handle):not(.dd-row-handle):not(.dd-col-handle):not(.dd-table-handle)';

const PARAGRAPHS = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');

const DOC = `# Heading

1. First item
2. Second item
   - Nested item
3. Third item

| Col A | Col B |
| --- | --- |
| a1 | b1 |

${PARAGRAPHS}
`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((px) => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = `::-webkit-scrollbar{width:${px}px;height:${px}px} html{overflow-x:scroll}`;
      document.head.appendChild(style);
    });
  }, SCROLLBAR_PX);
  await openEditor(page, DOC);
  // Premise: a classic scrollbar on both axes, else the cases below cannot tell the two widths apart.
  const gap = await page.evaluate(() => ({
    x: window.innerWidth - document.documentElement.clientWidth,
    y: window.innerHeight - document.documentElement.clientHeight,
  }));
  expect(gap).toEqual({ x: SCROLLBAR_PX, y: SCROLLBAR_PX });
});

async function hoverCenter(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('locator has no bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('locator has no bounding box');
  }
  return box;
}

test('block handle sits flush against the paragraph left edge and stays on-screen', async ({ page }) => {
  const paragraph = page.locator('p', { hasText: 'Paragraph 1.' }).first();
  await hoverCenter(page, paragraph);
  const handle = page.locator(BLOCK_HANDLE_SELECTOR);
  await expect(handle).toHaveCSS('display', 'flex');

  const handleBox = await boxOf(handle);
  const paragraphBox = await boxOf(paragraph);
  expect(Math.abs(handleBox.x + handleBox.width - paragraphBox.x)).toBeLessThanOrEqual(1);
  expect(handleBox.x).toBeGreaterThanOrEqual(0);
});

test('row handle right edge sits at the table left edge', async ({ page }) => {
  await hoverCenter(page, page.locator('td', { hasText: 'a1' }));
  const handle = page.locator('.dd-row-handle');
  await expect(handle).toHaveCSS('display', 'flex');

  const handleBox = await boxOf(handle);
  const tableBox = await boxOf(page.locator('table'));
  expect(Math.abs(handleBox.x + handleBox.width - tableBox.x)).toBeLessThanOrEqual(1);
});

test('column handle bottom edge sits at the table top edge', async ({ page }) => {
  await hoverCenter(page, page.locator('td', { hasText: 'a1' }));
  const handle = page.locator('.dd-col-handle');
  await expect(handle).toHaveCSS('display', 'flex');

  const handleBox = await boxOf(handle);
  const tableBox = await boxOf(page.locator('table'));
  expect(Math.abs(handleBox.y + handleBox.height - tableBox.y)).toBeLessThanOrEqual(1);
});

test('table-level handle corner sits at the table top-left', async ({ page }) => {
  const tableBox = await boxOf(page.locator('table'));
  await page.mouse.move(tableBox.x + 2, tableBox.y + 2);
  const handle = page.locator('.dd-table-handle');
  await expect(handle).toHaveCSS('display', 'flex');

  const handleBox = await boxOf(handle);
  expect(Math.abs(handleBox.x + handleBox.width - tableBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(handleBox.y + handleBox.height - tableBox.y)).toBeLessThanOrEqual(1);
});

test('li handle covers the marker instead of sitting beside it', async ({ page }) => {
  const item = page.locator('li', { hasText: 'Third item' });
  await hoverCenter(page, item);
  const handle = page.locator('.dd-li-handle');
  await expect(handle).toHaveCSS('display', 'flex');

  const handleBox = await boxOf(handle);
  const itemBox = await boxOf(item);
  const listBox = await boxOf(page.locator('ol'));
  expect(Math.round(handleBox.x + handleBox.width)).toBe(Math.round(itemBox.x + MARKER_COVER_PAD_PX));
  expect(handleBox.x + handleBox.width).toBeGreaterThan(listBox.x);
});
