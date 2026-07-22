/**
 * Regression (2026-07-20): the Reading Mode width engine constrains #content to
 * --reading-container (80ch) and centers it via margin auto. A stray star-slash
 * inside the syntax-token comment right above the rule (a "selector-star / link"
 * class list, once written without the space) closed that comment early, and the
 * trailing garbage swallowed the whole "body.reading-mode #content" width block
 * that followed — so #content rendered full-width, left-aligned, with all the
 * slack piling up as a wide right gutter.
 *
 * These assert the computed max-width / margins (the outcome a dropped rule
 * silently regresses) rather than the CSS text, so any future comment/parse
 * breakage that eats the rule fails here.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

const DOC = '# Reading Mode Width\n\nSome body prose to fill the reading column.\n';

test('Reading Mode constrains and centers #content (container width applies)', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openEditor(page, DOC, { readability: { enabled: true, mode: 'sepia', fontFamily: '', zen: false } });

  const box = await page.locator('#content').evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      maxWidth: cs.maxWidth,
      marginLeft: parseFloat(cs.marginLeft),
      marginRight: parseFloat(cs.marginRight),
      clientWidth: el.clientWidth,
    };
  });

  // The container cap must actually resolve (not the initial `none`).
  expect(box.maxWidth).not.toBe('none');
  // 80ch at 16px reading font ≈ 806px — far below the 1348px available, so the
  // column is genuinely narrowed rather than filling the viewport.
  expect(box.clientWidth).toBeLessThan(1000);
  // margin: auto centers it — both side margins are non-zero and roughly equal.
  expect(box.marginLeft).toBeGreaterThan(10);
  expect(Math.abs(box.marginLeft - box.marginRight)).toBeLessThan(2);
});
