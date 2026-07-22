/**
 * bug_General Mention Declare #7: pressing Enter around a declaration pill used
 * to propagate its `.md-caption` styling onto the following text (plain
 * paragraphs rendered as green pills). The fix makes the pill a non-editable
 * atom (contenteditable=false), so native Enter can neither split the badge nor
 * carry its class. This test presses Enter right after the pill and types —
 * the new text must be an ordinary paragraph, never wrapped in `.md-caption`.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('Enter after a declaration pill yields a plain paragraph, no pill propagation', async ({ page }) => {
  await openEditor(page, 'caption::UC1');

  const badge = page.locator('#content .md-caption');
  await expect(badge).toHaveCount(1);

  // Caret at the very end of the paragraph (right after the badge).
  await page.locator('#content').evaluate((content) => {
    const p = content.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false); // end
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    (content as HTMLElement).focus();
  });

  await page.keyboard.press('Enter');
  await page.keyboard.type('plain text');

  // Still exactly one pill, and the typed text is NOT inside one.
  await expect(badge).toHaveCount(1);
  const typedInsidePill = await page.locator('#content').evaluate((content) => {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if ((n.textContent ?? '').includes('plain text')) {
        return !!(n.parentElement && n.parentElement.closest('.md-caption'));
      }
    }
    return null;
  });
  expect(typedInsidePill).toBe(false);
});
