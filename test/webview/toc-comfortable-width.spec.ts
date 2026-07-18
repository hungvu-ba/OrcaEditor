/**
 * bug_General #4: TOC auto-hide threshold. The TOC panel used to auto-close when
 * the tab dropped below HALF the physical screen (window.screen.width / 2) —
 * arbitrary and monitor-dependent. It now closes when the tab is no longer wide
 * enough to show the content column at Comfortable Reading size WITH the panel
 * open: threshold = 560px (70ch prose @ 16px) + live --toc-width + 26px gutter.
 * With the default --toc-width of 300px that is ~886px.
 *
 * These drive the real resize handler in main.ts via page.setViewportSize (which
 * fires a genuine 'resize' event) — a hand-built DOM snapshot can't exercise it.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

const DOC = `# Heading A

Some body text under A.

## Heading B

Some body text under B.
`;

/** Open the editor at a wide viewport and toggle the TOC panel open. */
async function openTocWide(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 800 });
  await openEditor(page, DOC);
  // force: true — same reason as toc-filter.spec.ts: the toolbar's own overflow
  // logic can transiently report #toc-toggle as outside the viewport.
  await page.locator('#toc-toggle').click({ force: true });
  await expect(page.locator('#toc-panel')).toBeVisible();
}

test('auto-closes when the tab shrinks below the Comfortable-Reading threshold', async ({ page }) => {
  await openTocWide(page);
  // 700px < 560 + 300 + 26 (886) → narrow → auto-close.
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(page.locator('#toc-panel')).toBeHidden();
});

test('stays open when the tab shrinks but stays above the threshold', async ({ page }) => {
  await openTocWide(page);
  // 1000px > 886 → still wide → stays open.
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(page.locator('#toc-panel')).toBeVisible();
});

test('threshold tracks the live --toc-width (grows when the panel is widened)', async ({ page }) => {
  await openTocWide(page);
  // Widen the panel: threshold becomes 560 + 600 + 26 = 1186px. A 1000px tab is
  // wide with the default 300 panel but narrow with a 600 panel — so the TOC
  // must close, proving the check reads --toc-width live (not a hardcoded 300).
  await page.evaluate(() => document.documentElement.style.setProperty('--toc-width', '600px'));
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(page.locator('#toc-panel')).toBeHidden();
});
