/**
 * Bug #8 — smart gap on inline paste. Pasting inline text right next to an
 * existing word used to glue them ("foo" + paste "bar" → "foobar"). The paste
 * path (main.ts applySmartGap) now inserts a single space before/after the
 * pasted text when the immediate neighbor is a real word char — skipping
 * whitespace and punctuation neighbors, block-level pastes, non-collapsed
 * selections, and carets inside code. Needs a real browser: execCommand +
 * Selection + a real ClipboardEvent, none of which the domino roundtrip can do.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

/** Place a collapsed caret at char `offset` inside the first text node of the given selector. */
async function caretAt(page: Page, selector: string, offset: number): Promise<void> {
  await page.locator(selector).first().evaluate((el, off) => {
    const range = document.createRange();
    range.setStart(el.firstChild!, off);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    (el as HTMLElement).closest<HTMLElement>('#content')?.focus();
  }, offset);
}

/** Dispatch a real paste event carrying `text` as text/plain onto #content. */
async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.getElementById('content')!.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    );
  }, text);
}

test('inline paste mid-word inserts a smart gap on both sides', async ({ page }) => {
  await openEditor(page, 'foobar\n');
  await caretAt(page, '#content p', 3); // between "foo" and "bar"
  await clearPosted(page);
  await paste(page, 'X');
  const md = await waitForEdit(page);
  expect(md).toContain('foo X bar');
});

test('no doubled space when the neighbor is already whitespace', async ({ page }) => {
  await openEditor(page, 'foo bar\n');
  await caretAt(page, '#content p', 3); // right after "foo", before the existing space
  await clearPosted(page);
  await paste(page, 'X');
  const md = await waitForEdit(page);
  // Leading side: neighbor "o" is a word char → gap added. Trailing side:
  // neighbor is the existing space → suppressed (no second space).
  expect(md).toContain('foo X bar');
  expect(md).not.toMatch(/ {2,}/); // never a doubled space
});

test('no gap next to punctuation', async ({ page }) => {
  await openEditor(page, '()\n');
  await caretAt(page, '#content p', 1); // between "(" and ")"
  await clearPosted(page);
  await paste(page, 'x');
  const md = await waitForEdit(page);
  expect(md).toContain('(x)');
});

test('block-level paste is inserted unchanged (no injected leading space)', async ({ page }) => {
  await openEditor(page, 'foo\n');
  await caretAt(page, '#content p', 3); // end of "foo"
  await clearPosted(page);
  await paste(page, '# Heading');
  const md = await waitForEdit(page);
  expect(md).toContain('# Heading');
  expect(md).not.toContain(' # Heading');
});

test('no phantom leading gap from a sibling list item (neighbor read stays within the caret line)', async ({ page }) => {
  await openEditor(page, '- foo\n- bar\n');
  await caretAt(page, '#content li:nth-child(2)', 0); // start of the SECOND bullet's text
  await clearPosted(page);
  await paste(page, 'X');
  await waitForEdit(page);
  // Neighbor read must be scoped to this <li>: before-caret is empty (start of
  // line) so NO leading gap; after-caret is "b" so a trailing gap → "X bar".
  // Without the leaf-block scoping this would read "foo" from the first <li>
  // and inject a spurious leading space.
  const liText = (await page.locator('#content li').nth(1).textContent()) ?? '';
  const NBSP = String.fromCharCode(0x00a0);
  expect(liText.startsWith(' ') || liText.startsWith(NBSP)).toBe(false); // no phantom leading gap
  expect(liText.replaceAll(NBSP, ' ')).toBe('X bar'); // trailing gap only (live DOM keeps NBSP until serialize)
});

test('no gap when the pasted text itself begins with punctuation', async ({ page }) => {
  await openEditor(page, 'foo\n');
  await caretAt(page, '#content p', 3); // end of "foo"
  await clearPosted(page);
  await paste(page, ',bar');
  const md = await waitForEdit(page);
  expect(md).toContain('foo,bar'); // no space forced in front of the comma
  expect(md).not.toContain('foo ,');
});
