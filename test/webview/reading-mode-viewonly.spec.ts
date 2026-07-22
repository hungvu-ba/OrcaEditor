import { test, expect } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

/**
 * Bug: picking a Reading Mode / Focus / TOC from the toolbar routed through
 * invokeAction(), which unconditionally called syncNow(). For a document whose
 * freshly-loaded DOM re-serializes with any byte drift (e.g. "* " bullets ->
 * "*   "), that sync posted a spurious 'edit' and marked the file dirty even
 * though only the VIEW changed. Fixed via ToolbarItem/Entry `viewOnly`, which
 * makes invokeAction skip the post-action syncNow.
 *
 * `* one\n* two` is a known drift under this turndown ("* " -> "*   " + a
 * trailing space), so any spurious sync surfaces as an 'edit' here.
 */
const DRIFT_DOC = '* one\n* two\n\n```mermaid\ngraph TD; A-->B;\n```\n';

async function postedEdits(page: import('@playwright/test').Page): Promise<unknown[]> {
  return page.evaluate(
    () => (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'edit')
  );
}

test('picking a reading mode does not post an edit (view-only)', async ({ page }) => {
  await openEditor(page, DRIFT_DOC);
  await clearPosted(page);

  await page
    .locator('#reading-toggle')
    .locator('xpath=following-sibling::button[contains(@class,"split-caret")]')
    .click();
  await page.locator('.toolbar-popover-item[data-dropdown-value="sepia"]').click();
  await page.waitForTimeout(500);

  expect(await postedEdits(page), 'reading-mode switch must not dirty the file').toHaveLength(0);
});

test('clicking the main Reading button does not post an edit (view-only)', async ({ page }) => {
  await openEditor(page, DRIFT_DOC, { readability: { enabled: true, mode: 'sepia', fontFamily: '', zen: false } });
  await clearPosted(page);

  await page.locator('#reading-toggle').click(); // main face = reset to Standard
  await page.waitForTimeout(500);

  expect(await postedEdits(page), 'Reading main button must not dirty the file').toHaveLength(0);
});

test('the Focus toggle does not post an edit (view-only)', async ({ page }) => {
  await openEditor(page, DRIFT_DOC);
  await clearPosted(page);

  await page.locator('#zen-toggle').click();
  await page.waitForTimeout(500);

  expect(await postedEdits(page), 'Focus toggle must not dirty the file').toHaveLength(0);
});

test('the TOC toggle does not post an edit (view-only)', async ({ page }) => {
  await openEditor(page, DRIFT_DOC);
  await clearPosted(page);

  await page.locator('#toc-toggle').click();
  await page.waitForTimeout(500);

  expect(await postedEdits(page), 'TOC toggle must not dirty the file').toHaveLength(0);
});

test('a real edit still syncs (fix does not gag genuine edits)', async ({ page }) => {
  await openEditor(page, DRIFT_DOC);
  await clearPosted(page);

  // Land the caret inside the first list item's text, then type.
  await page.getByText('one', { exact: true }).click();
  await page.keyboard.type('X');
  await page.waitForTimeout(500);

  expect(await postedEdits(page), 'typing must still post an edit').not.toHaveLength(0);
});
