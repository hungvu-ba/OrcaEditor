/**
 * Undo granularity: undo delegates to the TextDocument, whose granularity equals
 * the number of 'edit' messages the webview posts. Without word boundaries a fast
 * continuous burst never fires the 250ms sync debounce, so the whole burst lands
 * as ONE edit → one Ctrl+Z wipes everything. main.ts flushes a checkpoint on
 * every word boundary (space/Enter) so each word is its own edit = its own undo
 * step. This asserts that checkpoint signal (the host-side undo itself needs the
 * real VS Code host and is verified manually).
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

type Posted = { type: string; text: string };

test('typing across a word boundary commits a separate undo checkpoint per word', async ({ page }) => {
  await openEditor(page, '');
  const content = page.locator('#content');
  await content.click(); // focus + place caret in the empty paragraph
  await clearPosted(page);

  await page.keyboard.type('alpha beta');

  // Wait until the full text has synced (last word flushes on the sync debounce).
  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some((m) => m.type === 'edit' && m.text.trim() === 'alpha beta')
  );

  const editTexts = await page.evaluate(() =>
    (window as unknown as { __posted: Posted[] }).__posted.filter((m) => m.type === 'edit').map((m) => m.text.trim())
  );

  // The space after "alpha" flushed a checkpoint BEFORE "beta" was typed, so the
  // burst is not a single coalesced edit: "alpha" is committed on its own first.
  expect(editTexts).toContain('alpha');
  expect(editTexts).toContain('alpha beta');
  expect(new Set(editTexts).size).toBeGreaterThanOrEqual(2);
});
