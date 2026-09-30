/**
 * T5.3 (Performance Low-End C-1 / C-9): a palette switch must not run a color
 * transition on every table cell, and ET Book ships as woff2.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('table cells have no transition; #content still does', async ({ page }) => {
  await openEditor(page, '| a | b |\n| - | - |\n| 1 | 2 |\n');
  const dur = (sel: string): Promise<string> =>
    page.locator(sel).first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(await dur('#content th')).toBe('0s');
  expect(await dur('#content td')).toBe('0s');
  expect(await dur('#content')).not.toBe('0s');
});

test('ET Book woff2 face loads', async ({ page }) => {
  await openEditor(page, 'hello');
  const loaded = await page.evaluate(async () => (await document.fonts.load('16px et-book')).length);
  expect(loaded).toBe(1);
});
