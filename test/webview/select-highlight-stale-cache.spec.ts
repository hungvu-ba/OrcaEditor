/**
 * US-9.3 (Feature A): selecting text highlights every other occurrence of it
 * elsewhere in the document via a cached text-position map (`haystackCache` in
 * select-highlight.ts), rebuilt only on a full re-render. An ordinary local
 * edit (a real keystroke through contentEditable) never triggers a full
 * re-render, so the cache went stale the moment any text elsewhere changed
 * length — the next selection then painted the highlight over unrelated text
 * instead of the real other occurrence (reported live: selecting "US-23.22"
 * highlighted "21"/"Nên" on a different line).
 */
import { test } from '@playwright/test';
import { openEditor } from './_harness';

type PWPage = import('@playwright/test').Page;

/** Select the substring `word` inside the paragraph whose full text is `pText`, and focus `#content`. */
async function selectSubstring(page: PWPage, pText: string, word: string): Promise<void> {
  await page.locator('#content').evaluate(
    (el, [text, needle]) => {
      const p = Array.from(el.querySelectorAll('p')).find((n) => n.textContent === text)!;
      const textNode = p.firstChild as Text;
      const idx = textNode.data.indexOf(needle);
      const range = document.createRange();
      range.setStart(textNode, idx);
      range.setEnd(textNode, idx + needle.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      el.focus();
    },
    [pText, word]
  );
}

/** Collapsed caret at the very start of the paragraph whose full text is `pText`, and focus `#content`. */
async function caretAtStartOfParagraph(page: PWPage, pText: string): Promise<void> {
  await page.locator('#content').evaluate((el, text) => {
    const p = Array.from(el.querySelectorAll('p')).find((n) => n.textContent === text)!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    el.focus();
  }, pText);
}

/** Wait for the `select-match` CSS highlight to contain a range whose text is exactly `expected`. */
async function waitForSelectMatch(page: PWPage, expected: string, timeoutMs = 2000): Promise<void> {
  await page.waitForFunction(
    (text) => {
      const hl = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get('select-match');
      if (!hl) return false;
      return Array.from(hl).some((r) => r.toString() === text);
    },
    expected,
    { timeout: timeoutMs }
  );
}

test('select-highlight repaints the real other occurrence after a local edit elsewhere, not a stale one', async ({ page }) => {
  await openEditor(page, 'Alpha target one\n\nBravo target two\n');

  // Baseline: selecting "target" in the first paragraph highlights its one
  // other occurrence, in the second paragraph — proves the cache/mechanism
  // works before any edit.
  await selectSubstring(page, 'Alpha target one', 'target');
  await waitForSelectMatch(page, 'target');

  // A local edit in the SECOND paragraph (the one the highlight lands in) —
  // a real keystroke through contentEditable, exactly like ordinary typing.
  // This never triggers select-highlight.ts's own renderDocument()-only
  // invalidation path.
  await caretAtStartOfParagraph(page, 'Bravo target two');
  await page.keyboard.type('XXXX');

  // Reselect the exact same query in the first paragraph (unaffected by the
  // edit). Without invalidating the stale cache, the highlight's stored
  // node/offset pair no longer lines up with the now-longer second paragraph
  // and paints over the wrong characters instead of "target".
  await selectSubstring(page, 'Alpha target one', 'target');
  await waitForSelectMatch(page, 'target');
});
