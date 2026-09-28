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

/** Long enough to wrap to 3+ lines at the default width, and to re-wrap on any narrowing. */
const WRAP_TEXT = `Wrap me: ${'lorem ipsum dolor sit amet consectetur '.repeat(12)}end.`;

const PARAGRAPHS = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');

const DOC = `# Heading

1. First item
2. Second item
   - Nested item
3. Third item

${WRAP_TEXT}

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

// ---------------------------------------------------------------------------
// T1.2: a shown handle follows its target through every layout change, with
// the mouse never moved after the hover (so the hover path never re-measures).
// ---------------------------------------------------------------------------

/** Toggle the TOC via a genuine element click, with no locator auto-scroll (as in toc-toggle-caret-scroll.spec.ts). */
function toggleToc(page: Page): Promise<void> {
  return page.evaluate(() => (document.getElementById('toc-toggle') as HTMLElement).click());
}

/** Handle top/height minus target top/height, rounded — `[0, 0]` when the handle spans the target. */
async function verticalDrift(handle: Locator, target: Locator): Promise<[number, number]> {
  const h = await boxOf(handle);
  const t = await boxOf(target);
  return [Math.round(h.y - t.y), Math.round(h.height - t.height)];
}

test('block handle follows a paragraph re-wrapped by a viewport resize', async ({ page }) => {
  const paragraph = page.locator('p', { hasText: 'Wrap me:' });
  await hoverCenter(page, paragraph);
  const handle = page.locator(BLOCK_HANDLE_SELECTOR);
  await expect(handle).toHaveCSS('display', 'flex');
  const before = await boxOf(paragraph);

  const size = page.viewportSize();
  await page.setViewportSize({ width: Math.round((size?.width ?? 1280) * 0.6), height: size?.height ?? 720 });
  await expect.poll(async () => (await boxOf(paragraph)).height).toBeGreaterThan(before.height);

  await expect.poll(() => verticalDrift(handle, paragraph)).toEqual([0, 0]);
});

test('block handle follows a paragraph re-wrapped by opening the TOC', async ({ page }) => {
  const paragraph = page.locator('p', { hasText: 'Wrap me:' });
  await hoverCenter(page, paragraph);
  const handle = page.locator(BLOCK_HANDLE_SELECTOR);
  await expect(handle).toHaveCSS('display', 'flex');
  const before = await boxOf(paragraph);

  await toggleToc(page);
  // Polls through the 0.3 s body padding transition.
  await expect.poll(async () => (await boxOf(paragraph)).height).toBeGreaterThan(before.height);
  await expect.poll(() => verticalDrift(handle, paragraph)).toEqual([0, 0]);
});

test('table-level handle follows its table through a scroll', async ({ page }) => {
  const table = page.locator('table');
  const tableBox = await boxOf(table);
  // Above the corner, so a few px of scroll keeps the pointer inside the corner zone.
  await page.mouse.move(tableBox.x + 2, tableBox.y - 10);
  const handle = page.locator('.dd-table-handle');
  await expect(handle).toHaveCSS('display', 'flex');

  await page.evaluate(() => window.scrollBy(0, 8));
  await expect.poll(async () => (await boxOf(table)).y).toBeLessThan(tableBox.y);

  await expect
    .poll(async () => {
      const h = await boxOf(handle);
      const t = await boxOf(table);
      return [Math.round(h.x + h.width - t.x), Math.round(h.y + h.height - t.y)];
    })
    .toEqual([0, 0]);
});

test('row handle follows its row through a viewport resize', async ({ page }) => {
  const cell = page.locator('td', { hasText: 'a1' });
  await hoverCenter(page, cell);
  const handle = page.locator('.dd-row-handle');
  await expect(handle).toHaveCSS('display', 'flex');
  const row = page.locator('tr', { has: cell });
  const before = await boxOf(row);

  const size = page.viewportSize();
  await page.setViewportSize({ width: Math.round((size?.width ?? 1280) * 0.6), height: size?.height ?? 720 });
  // The wrapped paragraph above the table grows, pushing the row down.
  await expect.poll(async () => (await boxOf(row)).y).toBeGreaterThan(before.y);

  await expect.poll(() => verticalDrift(handle, row)).toEqual([0, 0]);
});

test('an edit that detaches the hovered table hides its row/column handles instead of measuring it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await hoverCenter(page, page.locator('td', { hasText: 'a1' }));
  const rowHandle = page.locator('.dd-row-handle');
  await expect(rowHandle).toHaveCSS('display', 'flex');

  // #content shrinks -> the ResizeObserver reposition runs with the hovered targets detached.
  await page.evaluate(() => document.querySelector('#content table')?.remove());

  await expect(rowHandle).toHaveCSS('display', 'none');
  await expect(page.locator('.dd-col-handle')).toHaveCSS('display', 'none');
  expect(errors).toEqual([]);
});
