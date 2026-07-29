/**
 * US-10.7 values, US-10.8 presentation: the TOC panel's reading readout — a 3px
 * progress bar plus a one-line meta row (read time · word count · percent).
 * Needs a real browser: the percent is driven by real scroll events riding the
 * existing rAF-throttled scroll path, which a hand-built DOM snapshot can't
 * reproduce.
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

test('progress bar tracks scroll and reaches 100% only at the true bottom', async ({ page }) => {
  await openToc(page, LONG_DOC);
  const bar = page.locator('#toc-progress');
  const fill = page.locator('#toc-progress .toc-progress-fill');
  const pct = page.locator('#toc-meta-pct');

  await expect(bar).toBeVisible();
  await expect(pct).toHaveText('0%');
  expect(await fill.evaluate((el) => el.style.width)).toBe('0%');
  // The bar is decorative — the meta row's text is the single accessible readout,
  // so labelling the bar too would announce the percent twice.
  await expect(bar).toHaveAttribute('aria-hidden', 'true');

  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => document.getElementById('toc-meta-pct')?.textContent !== '0%');
  const midPercent = Number((await pct.textContent())?.match(/(\d+)%/)?.[1]);
  expect(midPercent).toBeGreaterThan(0);
  expect(midPercent).toBeLessThan(100);
  // US-10.8: bar width and the meta row's percent are one value, not two readouts.
  expect(await fill.evaluate((el) => el.style.width)).toBe(`${midPercent}%`);

  await page.mouse.wheel(0, 100_000); // large delta — browser clamps to the true scroll max
  await expect(pct).toHaveText('100%');
  expect(await fill.evaluate((el) => el.style.width)).toBe('100%');
});

test('meta row collapses read time and word count onto one line', async ({ page }) => {
  await openToc(page, LONG_DOC);

  await expect(page.locator('#toc-meta-text')).toHaveText(/^\d+ min read · [\d,]+ words$/);
});

// Note: the "bar hidden when docHeight <= innerHeight" branch isn't asserted
// here — body's unconditional `padding-bottom: calc(50vh)` (markdown.css,
// mirrors real VS Code preview scroll-past-end behavior) makes the document
// always taller than the viewport, for any content/viewport size, so that
// state is unreachable in the real rendered page.
test('document with no readable prose hides the meta text but keeps the percent', async ({ page }) => {
  await openToc(page, '```\nsome code, not prose\n```\n');

  await expect(page.locator('#toc-meta-text')).toBeHidden();
  // Zero prose is not zero scroll: the percent follows the scrollable rule alone.
  await expect(page.locator('#toc-meta-pct')).toBeVisible();
});
