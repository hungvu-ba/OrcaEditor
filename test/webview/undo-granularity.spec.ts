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

/**
 * Bug 0717b: the boundary check used to require inputType==='insertText' with
 * `data` being exactly one whitespace character. Vietnamese diacritic input
 * (Telex/VNI, OS-level IME) routinely commits a syllable — and sometimes the
 * following space — via composition or backspace+retype sequences, so the
 * browser's 'input' event for the space rarely arrives as a clean single-char
 * 'insertText'. The old heuristic silently missed those boundaries, so words
 * got absorbed into the next debounce window instead of committing on their
 * own — multiple words merged into one undo unit. The fix reads the actual
 * character sitting before the caret in the DOM (once composition has ended)
 * instead of trusting inputType/data.
 */
test('word boundary flush fires even when the space arrives via a non-insertText inputType (composed/IME text)', async ({
  page,
}) => {
  await openEditor(page, '');
  const content = page.locator('#content');
  await content.click();
  await clearPosted(page);

  await page.evaluate(() => {
    const p = document.querySelector('#content p') as HTMLElement;
    // Drop the ensureTrailingParagraph placeholder <br> before composing text —
    // real typing removes it too; leaving it in makes turndown emit a leading `\`.
    p.textContent = '';
    const textNode = document.createTextNode('nội ');
    p.appendChild(textNode);
    const range = document.createRange();
    range.setStart(textNode, textNode.length);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    // IME composition commit, not a plain single-char 'insertText' space.
    p.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'nội ', bubbles: true }));
  });

  // Synchronous flush (no debounce wait): if the boundary wasn't detected,
  // nothing would be posted yet at this point.
  const edits = await page.evaluate(() =>
    (window as unknown as { __posted: Posted[] }).__posted.filter((m) => m.type === 'edit').map((m) => m.text.trim())
  );
  expect(edits).toEqual(['nội']);
});

test('bug 0717b repro: consecutive composed words typed without a real pause each commit their own checkpoint', async ({
  page,
}) => {
  await openEditor(page, '');
  const content = page.locator('#content');
  await content.click();
  await clearPosted(page);

  await page.evaluate(() => {
    const p = document.querySelector('#content p') as HTMLElement;
    // Drop the ensureTrailingParagraph placeholder <br> before composing words —
    // real typing removes it too; leaving it in makes turndown emit a leading `\`.
    p.textContent = '';
    function commitWord(word: string): void {
      const textNode = document.createTextNode(word);
      p.appendChild(textNode);
      const range = document.createRange();
      range.setStart(textNode, textNode.length);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      p.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: word, bubbles: true }));
    }
    commitWord('nội ');
    commitWord('dung ');
    commitWord('test ');
  });

  const editTexts = await page.evaluate(() =>
    (window as unknown as { __posted: Posted[] }).__posted.filter((m) => m.type === 'edit').map((m) => m.text.trim())
  );
  // Each word its own checkpoint — NOT one merged "nội dung test" edit.
  expect(editTexts).toEqual(['nội', 'nội dung', 'nội dung test']);
});
