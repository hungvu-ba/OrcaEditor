/**
 * Bug: while typing in the editor, the TOC's active-heading highlight kept
 * flickering / auto-scrolling the rail, even though the active heading never
 * changed. Root cause: build() (rebuilt on a 250ms debounce for every
 * keystroke) unconditionally reset activeIndex to -1 before recreating the
 * entries, so updateActive() always saw a "new" active index and replayed
 * setActive()'s scrollLinkIntoView() — snapping the TOC rail's own scroll
 * position back to reveal the active entry even when the user had scrolled
 * the rail elsewhere.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

function manyHeadingsDoc(count: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= count; i++) {
    parts.push(`# Heading ${i}\n\nBody text for section ${i}.\n`);
  }
  return parts.join('\n');
}

test('typing elsewhere does not snap the TOC rail scroll back to the active entry', async ({ page }) => {
  await openEditor(page, manyHeadingsDoc(30));
  await page.locator('#toc-toggle').click({ force: true });
  await expect(page.locator('.toc-item')).toHaveCount(30);
  await expect(page.locator('.toc-item.active')).toHaveCount(1);
  await expect(page.locator('.toc-item').first()).toHaveClass(/active/);

  // Scroll the TOC rail itself away from the active (first) entry.
  await page.locator('#toc-list').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const scrolledTop = await page.locator('#toc-list').evaluate((el) => el.scrollTop);
  expect(scrolledTop).toBeGreaterThan(0);

  // Type in a nearby section's body text (still within the viewport, so the
  // editor itself does not scroll) — the active heading (the first one)
  // does not change, only unrelated content mutates.
  await page.locator('#content p', { hasText: 'Body text for section 2.' }).click();
  await page.keyboard.type(' edited');

  // Past the 250ms rebuild debounce.
  await page.waitForTimeout(400);

  await expect(page.locator('.toc-item.active').first()).toHaveText('Heading 1');
  const rebuiltTop = await page.locator('#toc-list').evaluate((el) => el.scrollTop);
  expect(rebuiltTop).toBe(scrolledTop);
});
