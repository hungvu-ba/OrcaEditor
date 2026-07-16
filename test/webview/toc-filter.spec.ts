/**
 * US-10.6: TOC heading-level filter slider — filters .toc-item entries by
 * heading level, persists per-tab via vscode.setState() (tocMaxLevel), and
 * falls scrollspy back to the nearest visible ancestor when the actual
 * nearest heading is filtered out. Also a regression check for bug 0716 #7
 * (TOC drag & drop removed entirely): dragging a .toc-item must no longer
 * reorder document headings.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

/** Paragraph filler so the document is tall enough to actually scroll. */
function filler(section: string, lines = 30): string {
  return Array.from({ length: lines }, (_, i) => `${section} filler line ${i + 1}.`).join('\n\n');
}

// level<=2 heading count is 4 (H1 A, H2 A1, H2 A2, H1 B) — well under the
// >20 smart-fallback threshold, so the default slider position is always 2.
const DOC = `# H1 A

${filler('A')}

## H2 A1

${filler('A1')}

### H3 A1a

${filler('A1a')}

## H2 A2

${filler('A2')}

# H1 B

${filler('B')}
`;

async function openToc(page: Page, markdown = DOC): Promise<void> {
  await openEditor(page, markdown);
  // force: true — #toc-toggle is one of many toolbar buttons subject to the
  // toolbar's own width-based overflow logic (unrelated to this feature); under
  // parallel test workers its ResizeObserver recalc can lag, transiently
  // reporting the button "outside the viewport". force bypasses that
  // actionability wait and dispatches the click directly.
  await page.locator('#toc-toggle').click({ force: true });
}

async function setSlider(page: Page, value: 1 | 2 | 3): Promise<void> {
  await page.locator('#toc-filter-slider').evaluate((el, v) => {
    (el as HTMLInputElement).value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

test('defaults to H1-H2 (level 2) when heading count is below the smart-fallback threshold', async ({ page }) => {
  await openToc(page);
  await expect(page.locator('#toc-filter-slider')).toHaveValue('2');
  // H1 A, H2 A1, H2 A2, H1 B visible; H3 A1a hidden.
  await expect(page.locator('.toc-item')).toHaveCount(4);
  await expect(page.locator('.toc-item.toc-level-3')).toHaveCount(0);
});

test('dragging the slider to each stop filters visible .toc-item entries by level', async ({ page }) => {
  await openToc(page);

  await setSlider(page, 1);
  await expect(page.locator('.toc-item')).toHaveCount(2); // H1 A, H1 B
  await expect(page.locator('.toc-item.toc-level-2')).toHaveCount(0);
  await expect(page.locator('.toc-item.toc-level-3')).toHaveCount(0);

  await setSlider(page, 2);
  await expect(page.locator('.toc-item')).toHaveCount(4);
  await expect(page.locator('.toc-item.toc-level-3')).toHaveCount(0);

  await setSlider(page, 3);
  await expect(page.locator('.toc-item')).toHaveCount(5);
  await expect(page.locator('.toc-item.toc-level-3')).toHaveCount(1);
});

test('scrolling to an H3 while filtered to H1-H2 highlights the nearest visible ancestor', async ({ page }) => {
  await openToc(page);
  await expect(page.locator('#toc-filter-slider')).toHaveValue('2');

  await page.locator('h3', { hasText: 'H3 A1a' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));

  await expect(page.locator('.toc-item.active')).toHaveText('H2 A1');
});

test('editing content triggers a debounced rebuild and the filter level is preserved', async ({ page }) => {
  await openToc(page);
  await setSlider(page, 1);
  await expect(page.locator('.toc-item')).toHaveCount(2);

  await clearPosted(page);
  await page.locator('#content p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' extra text');
  await waitForEdit(page); // scheduleSync + toc.refresh() share the same 250ms debounce window

  await expect(page.locator('#toc-filter-slider')).toHaveValue('1');
  await expect(page.locator('.toc-item')).toHaveCount(2);
});

test('a .toc-item is not natively draggable (no native link-drag ghost)', async ({ page }) => {
  await openToc(page);
  const draggable = await page.locator('.toc-item').first().evaluate((el) => (el as HTMLAnchorElement).draggable);
  expect(draggable).toBe(false);
});

test('mousedown+move on a .toc-item no longer reorders headings (TOC-drag removed)', async ({ page }) => {
  await openToc(page);
  await setSlider(page, 3);
  await expect(page.locator('.toc-item')).toHaveCount(5);

  const headingsBefore = await page.locator('#content :is(h1, h2, h3)').allTextContents();

  const first = page.locator('.toc-item').first();
  const box = await first.boundingBox();
  if (!box) {
    throw new Error('TOC item has no bounding box');
  }
  await clearPosted(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 3 + 40, { steps: 10 });
  await page.mouse.up();

  // Give any (would-be) debounced sync a chance to fire, then confirm none did.
  await page.waitForTimeout(400);
  const posted = await page.evaluate(() => (window as unknown as { __posted: Array<{ type: string }> }).__posted);
  expect(posted.filter((m) => m.type === 'edit')).toHaveLength(0);

  const headingsAfter = await page.locator('#content :is(h1, h2, h3)').allTextContents();
  expect(headingsAfter).toEqual(headingsBefore);
});
