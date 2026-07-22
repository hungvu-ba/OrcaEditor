/**
 * Bug General #1: an entity link reveals its `caption::` declaration by WHOLE-DOC
 * TEXT SEARCH (not line-based, not index-based) so it works even when the target
 * file is outside the workspace. The host posts `scrollToPosition` with
 * `searchText: "caption::NS_ID"`; the webview finds it, scrolls to it, and — since
 * the declaration renders as a contenteditable=false `.md-caption` atom that a
 * text Selection can't land inside — flashes the badge. Needs a real browser
 * engine (atom behavior, layout-based scroll, real DOM), not a DOM snapshot.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('an entity link reveals + flashes its caption declaration via text search', async ({ page }) => {
  // The declaration sits far down so a real scroll has to happen to reach it.
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} lorem ipsum.`).join('\n\n');
  await openEditor(page, `# Title\n\n${filler}\n\ncaption::UC1\n`);

  const badge = page.locator('#content .md-caption');
  await expect(badge).toHaveCount(1);

  // Mirror what the host posts for an entity link: the declaration's text anchor.
  await page.evaluate(() => {
    window.postMessage({ type: 'scrollToPosition', searchText: 'caption::UC1' }, '*');
  });

  // The caption badge gets the transient reveal-flash highlight...
  await expect(badge).toHaveClass(/entity-reveal-flash/);
  // ...and the page actually scrolled down to bring it into view (poll — the
  // scroll may be smooth/animated).
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  // A different case in the fragment still matches (case-insensitive search).
  await expect
    .poll(async () => {
      await page.evaluate(() => window.postMessage({ type: 'scrollToPosition', searchText: 'CAPTION::uc1' }, '*'));
      return page.locator('#content .md-caption.entity-reveal-flash').count();
    })
    .toBeGreaterThan(0);
});
