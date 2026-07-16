/**
 * Regression test for bug 0716 #10: clicking the Task List toolbar button
 * (#fmt-task) while the caret is on a plain paragraph (not inside any list)
 * must only convert THAT paragraph — never sweep unrelated `<li>`s/paragraphs
 * elsewhere in the document into task items too. See toggleTaskItem's
 * "not currently in a list" branch in media/webview/toolbar.ts and the
 * addCheckbox idempotency guard in media/webview/dom-utils.ts.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

/**
 * Place a collapsed caret inside the <p> whose text matches `text`. Looked up
 * by content (not index) because converting an earlier paragraph to a task
 * item removes it from the `<p>` list, shifting the indices of later ones.
 */
async function placeCaretIn(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.locator('#content').evaluate((el, needle) => {
    const p = Array.from(el.querySelectorAll('p')).find((candidate) => candidate.textContent === needle)!;
    const textNode = p.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, text);
}

test('Task List button on one paragraph, then on a separate later paragraph, does not touch anything in between', async ({ page }) => {
  await openEditor(page, 'Paragraph A\n\nParagraph B\n\nParagraph C');

  // Click Task List with the caret in paragraph A only.
  await placeCaretIn(page, 'Paragraph A');
  await clearPosted(page);
  await page.locator('#fmt-task').click();
  const mdAfterFirstClick = await waitForEdit(page);

  expect(mdAfterFirstClick).toMatch(/^-\s+\[ \]\s+Paragraph A$/m);
  expect(mdAfterFirstClick).toMatch(/^Paragraph B$/m);
  expect(mdAfterFirstClick).toMatch(/^Paragraph C$/m);
  // Only one checkbox token so far — B/C must still be plain paragraphs.
  expect((mdAfterFirstClick.match(/\[ \]/g) ?? []).length).toBe(1);

  // Click Task List again, this time with the caret in paragraph C (separate,
  // further down, with untouched paragraph B in between).
  await placeCaretIn(page, 'Paragraph C');
  await clearPosted(page);
  await page.locator('#fmt-task').click();
  const mdAfterSecondClick = await waitForEdit(page);

  // Paragraph A: still exactly one checkbox (not stacked/duplicated by the
  // second, unrelated click).
  expect(mdAfterSecondClick).toMatch(/^-\s+\[ \]\s+Paragraph A$/m);
  // Paragraph B: untouched — no checkbox ever added to it.
  expect(mdAfterSecondClick).toMatch(/^Paragraph B$/m);
  // Paragraph C: got exactly one checkbox from this click.
  expect(mdAfterSecondClick).toMatch(/^-\s+\[ \]\s+Paragraph C$/m);
  // Exactly two checkbox tokens total in the whole document (A and C only).
  expect((mdAfterSecondClick.match(/\[ \]/g) ?? []).length).toBe(2);
});

test('Task List button on a selection spanning a plain paragraph into an already-task-ified item does not stack a second checkbox on it', async ({ page }) => {
  // Reproduces the exact real-click path where addCheckbox's own idempotency
  // guard (media/webview/dom-utils.ts) is the thing that matters, not just the
  // sweep-boundary fix: when the selection's START is on a plain paragraph
  // (not inside any list), toggleTaskItem's "not in list" branch fires and
  // rebuilds EVERY top-level block spanned by the selection — including any
  // <ul>/<li> at the END — into one fresh <ul>, copying each existing <li>'s
  // innerHTML (checkbox included) verbatim before calling addCheckbox() on
  // every resulting item (toolbar.ts, "freshItems.forEach((li) =>
  // addCheckbox(li))"). Without addCheckbox's no-op guard, the already-task
  // item picked up by the sweep would get a SECOND checkbox stacked on top of
  // the one it already carries from the copied innerHTML.
  await openEditor(page, 'Paragraph A\n\nParagraph B');

  // First click: caret in B only -> B becomes a task item (single-item "not
  // in list" path, unrelated to A).
  await placeCaretIn(page, 'Paragraph B');
  await clearPosted(page);
  await page.locator('#fmt-task').click();
  await waitForEdit(page);

  // Second click: select from the start of (still plain) Paragraph A through
  // to the end of B's <li> text — start is NOT in a list, so getListSelection()
  // returns null and the "not in list" sweep branch runs again, this time
  // spanning both A and the already-task-ified B.
  await page.locator('#content').evaluate(() => {
    const p = Array.from(document.querySelectorAll('p')).find((c) => c.textContent === 'Paragraph A')!;
    const li = document.querySelector('li')!;
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    const liTextNode = walker.nextNode()!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.setEnd(liTextNode, liTextNode.textContent!.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await clearPosted(page);
  await page.locator('#fmt-task').click();
  const md = await waitForEdit(page);

  expect(md).toMatch(/^-\s+\[ \]\s+Paragraph A$/m);
  expect(md).toMatch(/^-\s+\[ \]\s+Paragraph B$/m);
  // Exactly two checkbox tokens total — B must not have picked up a second
  // one from the sweep re-processing its already-existing <li>.
  expect((md.match(/\[ \]/g) ?? []).length).toBe(2);
});
