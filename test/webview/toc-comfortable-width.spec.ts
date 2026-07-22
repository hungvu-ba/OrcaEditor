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
  // At 700px the panel reflows to round(700*0.35)=245, so threshold = 560 + 245
  // + 26 = 831; 700 < 831 → narrow → auto-close.
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(page.locator('#toc-panel')).toBeHidden();
});

test('stays open when the tab shrinks but stays above the threshold', async ({ page }) => {
  await openTocWide(page);
  // 1000px > 886 → still wide → stays open.
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(page.locator('#toc-panel')).toBeVisible();
});

/** The live --toc-width custom property (survives even when the panel is hidden).
 *  Polled via expect.poll because the width is applied by main.ts's async resize
 *  handler — a one-shot read can race ahead of it. */
function tocWidth(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--toc-width').trim());
}

test('panel width is capped to ~35% of the window and restores when it grows back', async ({ page }) => {
  await openTocWide(page); // 1200px tab, default preferred 300 → min(300, 420) = 300
  await expect.poll(() => tocWidth(page)).toBe('300px');

  // Shrink below 300/0.35≈857: at 700 the cap is round(700*0.35)=245, so the
  // panel narrows proportionally to 245 (whether or not it then auto-hides).
  await page.setViewportSize({ width: 700, height: 800 });
  await expect.poll(() => tocWidth(page)).toBe('245px');

  // Grow back: cap min(300, round(1200*0.35)=420)=300 → the preferred width is
  // restored exactly (the shrink never overwrote the preference).
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(() => tocWidth(page)).toBe('300px');
});
