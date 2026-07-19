/**
 * US-10.7: reading-stats header (progress ring + read-time/word-count) on
 * the TOC panel. Needs a real browser: the ring's percent is driven by real
 * scroll events riding the existing rAF-throttled scroll path, which a
 * hand-built DOM snapshot can't reproduce.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

/** Paragraph filler so the document is tall enough to actually scroll past the viewport. */
function filler(section: string, lines = 40): string {
  return Array.from({ length: lines }, (_, i) => `${section} filler line ${i + 1}.`).join('\n\n');
}

const LONG_DOC = `# Heading A

${filler('A')}

## Heading B

${filler('B')}
`;

async function openToc(page: Page, markdown: string): Promise<void> {
  await openEditor(page, markdown);
  // force: true — see toc-filter.spec.ts: #toc-toggle's toolbar overflow logic
  // can transiently report it "outside the viewport" under parallel workers.
  await page.locator('#toc-toggle').click({ force: true });
}

test('progress ring tracks scroll and reaches 100% only at the true bottom', async ({ page }) => {
  await openToc(page, LONG_DOC);
  const ring = page.locator('#toc-progress-ring');

  await expect(ring).toBeVisible();
  await expect(ring).toHaveAttribute('aria-label', 'Reading progress: 0%');

  await page.mouse.wheel(0, 400);
  await page.waitForFunction(
    () => document.querySelector('#toc-progress-ring')?.getAttribute('aria-label') !== 'Reading progress: 0%'
  );
  const midLabel = await ring.getAttribute('aria-label');
  const midPercent = Number(midLabel?.match(/(\d+)%/)?.[1]);
  expect(midPercent).toBeGreaterThan(0);
  expect(midPercent).toBeLessThan(100);

  await page.mouse.wheel(0, 100_000); // large delta — browser clamps to the true scroll max
  await expect(ring).toHaveAttribute('aria-label', 'Reading progress: 100%');
});

// Note: the "ring hidden when docHeight <= innerHeight" branch isn't asserted
// here — body's unconditional `padding-bottom: calc(50vh)` (markdown.css,
// mirrors real VS Code preview scroll-past-end behavior) makes the document
// always taller than the viewport, for any content/viewport size, so that
// state is unreachable in the real rendered page.
test('document with no readable prose hides the stats lines', async ({ page }) => {
  await openToc(page, '```\nsome code, not prose\n```\n');

  await expect(page.locator('.toc-stats-minutes')).toBeHidden();
  await expect(page.locator('.toc-stats-words')).toBeHidden();
});
