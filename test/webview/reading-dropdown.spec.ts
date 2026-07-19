/**
 * US-4.27 — Reading Mode dropdown: the 9 wireframe combos under 4 group
 * captions, a live swatch per row, and a "Previewing…" tag that follows the
 * hovered row. Needs a real engine: open the popover + hover-driven preview.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

const EXPECTED_IDS = [
  'comfortable-sepia', 'comfortable-light', 'comfortable-dark', 'comfortable-paper',
  'academic-paper', 'compact-dark', 'compact-light', 'dyslexia-sepia', 'dyslexia-light',
];

async function openDropdown(page: import('@playwright/test').Page) {
  await page.locator('#reading-toggle ~ .split-caret').click();
  await expect(page.locator('.toolbar-popover[data-for-id="reading-toggle"]')).toBeVisible();
}

test('reading dropdown lists the 9 combos in group order, with 4 captions and a swatch per row', async ({ page }) => {
  await openEditor(page, '# hi');
  await openDropdown(page);
  const pop = page.locator('.toolbar-popover[data-for-id="reading-toggle"]');
  const styleRows = pop.locator('.toolbar-popover-item[data-dropdown-value]:not([data-dropdown-value="off"])');

  expect(await styleRows.evaluateAll((els) => els.map((e) => e.getAttribute('data-dropdown-value')))).toEqual(EXPECTED_IDS);
  expect(await pop.locator('.toolbar-popover-caption').evaluateAll((els) => els.map((e) => e.textContent))).toEqual([
    'Comfortable Reading', 'Academic Paper', 'Compact', 'Dyslexia-friendly',
  ]);
  expect(await styleRows.locator('.toolbar-popover-swatch').count()).toBe(9);
  // swatch previews the target palette, not the current theme (sepia row → sepia bg)
  const sepiaSwatchBg = await pop.locator('[data-dropdown-value="comfortable-sepia"] .toolbar-popover-swatch').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(sepiaSwatchBg).toBe('rgb(244, 236, 216)'); // #f4ecd8
});

test('the "Previewing…" tag follows the hovered row', async ({ page }) => {
  await openEditor(page, '# hi');
  await openDropdown(page);
  const pop = page.locator('.toolbar-popover[data-for-id="reading-toggle"]');
  const row = pop.locator('[data-dropdown-value="comfortable-dark"]');
  const row2 = pop.locator('[data-dropdown-value="academic-paper"]');

  await row.hover();
  await expect(row).toHaveClass(/is-previewing/); // waits out the preview debounce
  await expect(row.locator('.toolbar-popover-previewing')).toBeVisible();

  await row2.hover();
  await expect(row2).toHaveClass(/is-previewing/);
  await expect(row).not.toHaveClass(/is-previewing/); // tag moved, not duplicated

  await page.mouse.move(0, 0); // leave the popover → tag clears
  await expect(row2).not.toHaveClass(/is-previewing/);
});

test('closing during the preview debounce leaves no stuck preview or stale tag', async ({ page }) => {
  await openEditor(page, '# hi');
  await openDropdown(page);
  const pop = page.locator('.toolbar-popover[data-for-id="reading-toggle"]');

  await pop.locator('[data-dropdown-value="comfortable-dark"]').hover();
  await page.keyboard.press('Escape'); // close (pointer still on row → no mouseleave)
  await page.waitForTimeout(200); // outlast the ~120ms preview debounce

  // the debounced preview must not fire against the closed popover
  await expect(page.locator('body')).not.toHaveClass(/reading-mode/);
  await openDropdown(page);
  await expect(pop.locator('.toolbar-popover-item.is-previewing')).toHaveCount(0);
});
