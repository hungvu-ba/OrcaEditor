/**
 * Smoke test for the webview interaction harness (_harness.ts): proves a real
 * keyboard-driven document.execCommand flow works end-to-end in a real browser
 * engine — select text, press Ctrl/Cmd+B, verify the markdown serialized back to
 * the host. This is the class of bug test/roundtrip/ (domino, no event dispatch)
 * cannot cover.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

test('Ctrl/Cmd+B on selected text wraps it in **bold** and syncs to host', async ({ page }) => {
  await openEditor(page, 'hello world');
  const content = page.locator('#content');

  await content.evaluate((el) => {
    const textNode = el.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 11);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  await clearPosted(page);
  await content.press('ControlOrMeta+b');

  const md = await waitForEdit(page);
  expect(md.trim()).toBe('hello **world**');
});
