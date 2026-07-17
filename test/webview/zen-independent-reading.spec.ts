/**
 * bug_General #1: toggling Zen / Focus mode must NOT change the current Reading
 * Mode. The old US-19.9 design coupled them — `stylingActive() = enabled || zen`
 * — so entering Zen with Reading Mode OFF forced the whole `reading-mode`
 * styling (typography/palette/measure) on, which the user read as "Zen changed
 * Reading Mode". The fix gates reading styling on `enabled` only; Zen just hides
 * the toolbar/gutter via the independent `reading-zen` class.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('entering Zen with Reading Mode OFF does not turn on reading styling', async ({ page }) => {
  // Default harness config: Reading Mode disabled, Zen off.
  await openEditor(page, '# hello');
  await expect(page.locator('body')).not.toHaveClass(/reading-mode/);

  await page.locator('#zen-toggle').click();

  // Zen chrome is on...
  await expect(page.locator('body')).toHaveClass(/reading-zen/);
  // ...but reading styling stays OFF (this is the bug: it used to flip on).
  await expect(page.locator('body')).not.toHaveClass(/reading-mode/);
  // The Reading Mode button must not light up either.
  await expect(page.locator('#reading-toggle')).not.toHaveClass(/active/);
});

test('toggling Zen keeps Reading Mode ON when it was already ON', async ({ page }) => {
  await openEditor(page, '# hello', {
    readability: { enabled: true, preset: 'default', palette: 'followTheme', fontFamily: '', zen: false },
  });
  await expect(page.locator('body')).toHaveClass(/reading-mode/);

  // Enter Zen — reading styling must be preserved.
  await page.locator('#zen-toggle').click();
  await expect(page.locator('body')).toHaveClass(/reading-zen/);
  await expect(page.locator('body')).toHaveClass(/reading-mode/);

  // Exit Zen — reading styling must still be there.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.body.classList.contains('reading-zen'));
  await expect(page.locator('body')).toHaveClass(/reading-mode/);
});
