/**
 * Caret restore after an undo/redo-driven re-render. When undo/redo delegates to
 * the TextDocument, the host sends an 'update' carrying the new text plus the
 * source position of the change (caretLine/caretCol). renderDocument rebuilds the
 * whole DOM (caret lost), so main.ts's restoreCaretAtSource must put the caret
 * back. This exercises the real Selection API in a real browser engine — the
 * class of behavior test/roundtrip/ (domino, no selection) cannot cover.
 *
 * The host↔webview undo round-trip itself needs the real VS Code host and is
 * verified manually; here we drive the webview half directly by posting the same
 * 'update' message the host would send.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

/** Post the host 'update' message (as sent after undo/redo) and wait for the re-render to land. */
async function sendUndoUpdate(
  page: import('@playwright/test').Page,
  text: string,
  caretLine: number,
  caretCol: number
): Promise<void> {
  await page.evaluate(
    ({ text, caretLine, caretCol }) => window.postMessage({ type: 'update', text, caretLine, caretCol }, '*'),
    { text, caretLine, caretCol }
  );
  // Wait until the re-render has replaced the initial "placeholder" content
  // (render + caret restore run synchronously in the 'update' handler, but
  // postMessage delivery is a turn of the event loop). textContent !== markdown
  // source (it's rendered HTML), so key off the placeholder disappearing.
  await page.waitForFunction(() => !document.querySelector('#content')?.textContent?.includes('placeholder'));
}

/** Read the current collapsed-caret position from the real Selection. */
async function readCaret(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return null;
    }
    const n = sel.anchorNode;
    let pre: Node | null = n;
    while (pre && pre.nodeName !== 'PRE') {
      pre = pre.parentNode;
    }
    return {
      collapsed: sel.isCollapsed,
      anchorText: n?.textContent ?? null,
      anchorOffset: sel.anchorOffset,
      inPre: !!pre,
    };
  });
}

test('caret lands at the exact column at the end of a single-line paragraph', async ({ page }) => {
  await openEditor(page, 'placeholder');
  // Simulate an undo whose result is "hello world", caret at the end (col 11).
  await sendUndoUpdate(page, 'hello world', 1, 11);

  const caret = await readCaret(page);
  expect(caret).not.toBeNull();
  expect(caret!.collapsed).toBe(true);
  expect(caret!.anchorText).toBe('hello world');
  expect(caret!.anchorOffset).toBe(11);
});

test('caret lands at the exact column in the middle of a single-line paragraph', async ({ page }) => {
  await openEditor(page, 'placeholder');
  // Simulate an undo that removed "XYZ " from "aaa XYZ bbb" → caret where it was (col 4).
  await sendUndoUpdate(page, 'aaa bbb', 1, 4);

  const caret = await readCaret(page);
  expect(caret).not.toBeNull();
  expect(caret!.collapsed).toBe(true);
  expect(caret!.anchorText).toBe('aaa bbb');
  expect(caret!.anchorOffset).toBe(4); // after "aaa ", before "bbb"
});

test('caret lands at the right column inside a heading (markdown "##### " prefix stripped)', async ({ page }) => {
  await openEditor(page, 'placeholder');
  // Level-5 heading. Source col includes the 6-char "##### " prefix, but the
  // rendered <h5> text does NOT — the caret must map to the rendered offset, not
  // overshoot to the end (the reported bug: caret flew to the end of the heading).
  // Undo result "##### abcdef", caret after "abc": source offset 9 (6 prefix + 3).
  await sendUndoUpdate(page, '##### abcdef', 1, 9);

  const caret = await readCaret(page);
  expect(caret).not.toBeNull();
  expect(caret!.collapsed).toBe(true);
  expect(caret!.anchorText).toBe('abcdef');
  expect(caret!.anchorOffset).toBe(3); // between "abc" and "def", NOT 6 (the end)
});

test('multi-line block (fenced code) falls back to caret at the block start', async ({ page }) => {
  await openEditor(page, 'placeholder');
  // A fenced code block spans several source lines → column can't map cleanly to
  // the DOM, so the caret falls back to the start of the block, not lost.
  await sendUndoUpdate(page, '```\nnew code\n```', 2, 1);

  const caret = await readCaret(page);
  expect(caret).not.toBeNull();
  expect(caret!.collapsed).toBe(true);
  expect(caret!.inPre).toBe(true); // caret sits inside the rebuilt <pre>, at its start
});
