/**
 * bug General #10 (follow-up): the TOC must rebuild whenever a heading changes,
 * regardless of HOW it changed:
 *  - editing heading text directly in the editor (fires an `input` event), and
 *  - changing a block's heading level via the toolbar (raw-DOM replaceBlockTag,
 *    which does NOT fire `input`) — the toolbar path was the gap: formatHeading
 *    manipulated the DOM + scheduleSync'd but never triggered toc.refresh(), so
 *    the panel kept showing the stale heading set.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

const DOC = `# Title One

Some paragraph text here.

## Section Two

More body text.
`;

async function openToc(page: Page, markdown = DOC): Promise<void> {
  await openEditor(page, markdown);
  await page.locator('#toc-toggle').click({ force: true });
}

/** Put the caret at the end of the given element's text. */
async function caretAtEndOf(page: Page, selector: string): Promise<void> {
  await page.locator(selector).click();
  await page.keyboard.press('End');
}

test('editing heading text in the editor rebuilds the TOC entry', async ({ page }) => {
  await openToc(page);
  await expect(page.locator('.toc-item')).toHaveCount(2);

  await caretAtEndOf(page, '#content h1');
  await page.keyboard.type(' Edited');

  await expect(page.locator('.toc-item').first()).toHaveText('Title One Edited');
});

test('TOC card text is not styled as a hyperlink (no underline on hover)', async ({ page }) => {
  await openToc(page);
  const item = page.locator('.toc-item').first();
  await item.hover();
  const decoration = await item.evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(decoration).toBe('none');
});

test('changing a block to a heading via the toolbar rebuilds the TOC', async ({ page }) => {
  await openToc(page);
  await expect(page.locator('.toc-item')).toHaveCount(2);

  // Caret into the plain paragraph, then click the Heading toolbar button
  // (default H2 when the caret is not already in a heading).
  await page.locator('#content p', { hasText: 'Some paragraph text here.' }).click();
  await page.locator('#fmt-heading .split-main, #fmt-heading').first().click({ force: true });

  // The paragraph is now an H2 → the TOC must show 3 entries.
  await expect(page.locator('.toc-item')).toHaveCount(3);
});
