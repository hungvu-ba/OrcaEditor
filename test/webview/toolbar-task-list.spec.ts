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

  expect(mdAfterFirstClick).toMatch(/^\*\s+\[ \]\s+Paragraph A$/m);
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
  expect(mdAfterSecondClick).toMatch(/^\*\s+\[ \]\s+Paragraph A$/m);
  // Paragraph B: untouched — no checkbox ever added to it.
  expect(mdAfterSecondClick).toMatch(/^Paragraph B$/m);
  // Paragraph C: got exactly one checkbox from this click.
  expect(mdAfterSecondClick).toMatch(/^\*\s+\[ \]\s+Paragraph C$/m);
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

  expect(md).toMatch(/^\*\s+\[ \]\s+Paragraph A$/m);
  expect(md).toMatch(/^\*\s+\[ \]\s+Paragraph B$/m);
  // Exactly two checkbox tokens total — B must not have picked up a second
  // one from the sweep re-processing its already-existing <li>.
  expect((md.match(/\[ \]/g) ?? []).length).toBe(2);
});

/**
 * Place a collapsed caret inside the <li> whose text contains `needle` — inside
 * the text node after the checkbox <input> (task items are
 * `<li><input …> text</li>`), so getListSelection resolves to that one item.
 */
async function placeCaretInLi(page: import('@playwright/test').Page, needle: string): Promise<void> {
  await page.locator('#content').evaluate((el, text) => {
    const li = Array.from(el.querySelectorAll('li')).find((c) => (c.textContent ?? '').includes(text))!;
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let target = node;
    while (node) {
      target = node;
      if ((node.textContent ?? '').includes(text)) {
        break;
      }
      node = walker.nextNode();
    }
    const range = document.createRange();
    range.setStart(target!, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, needle);
}

/**
 * Bug ExcelCmd #5: clicking Task List again to strip a task item must return it
 * to NORMAL TEXT (a <p>), not leave it as a plain bullet. The old code only
 * unwrapped to <p> when the item was alone in its <ul> (list.children.length
 * === 1); a task item WITH siblings just lost its checkbox and stayed a bullet,
 * and the whole list wrongly lost `contains-task-list`. Fix routes every strip
 * through computeUnwrapListRange, splitting the list around the target and
 * carrying `contains-task-list` back onto the still-task siblings.
 */
test('Task List strip on a task item among siblings turns it into a plain paragraph and keeps the siblings task items', async ({
  page,
}) => {
  await openEditor(page, '- [ ] Alpha\n- [ ] Bravo\n- [ ] Charlie\n');
  const content = page.locator('#content');
  await placeCaretInLi(page, 'Bravo');
  await clearPosted(page);
  await page.locator('#fmt-task').click();

  const facts = await content.evaluate((el) => {
    const topUls = [...el.querySelectorAll(':scope > ul')];
    const paras = [...el.querySelectorAll(':scope > p')];
    const alphaUl = topUls.find((ul) => (ul.textContent ?? '').includes('Alpha'));
    const charlieUl = topUls.find((ul) => (ul.textContent ?? '').includes('Charlie'));
    return {
      bravoIsTopLevelParagraph: paras.some((p) => (p.textContent ?? '').trim() === 'Bravo'),
      bravoStillInAnyLi: [...el.querySelectorAll('li')].some((li) => (li.textContent ?? '').includes('Bravo')),
      topLevelUlCount: topUls.length,
      alphaHasCheckbox: !!alphaUl?.querySelector('li input[type="checkbox"]'),
      charlieHasCheckbox: !!charlieUl?.querySelector('li input[type="checkbox"]'),
      alphaUlIsTaskList: !!alphaUl?.classList.contains('contains-task-list'),
      charlieUlIsTaskList: !!charlieUl?.classList.contains('contains-task-list'),
    };
  });

  // Bravo becomes a normal paragraph — the core of the bug.
  expect(facts.bravoIsTopLevelParagraph).toBe(true);
  expect(facts.bravoStillInAnyLi).toBe(false);
  // The list splits around Bravo into two task lists; siblings keep checkboxes.
  expect(facts.topLevelUlCount).toBe(2);
  expect(facts.alphaHasCheckbox).toBe(true);
  expect(facts.charlieHasCheckbox).toBe(true);
  expect(facts.alphaUlIsTaskList).toBe(true);
  expect(facts.charlieUlIsTaskList).toBe(true);

  const md = await waitForEdit(page);
  expect(md).toMatch(/^\*\s+\[ \]\s+Alpha$/m);
  expect(md).toMatch(/^Bravo$/m); // plain paragraph line — no bullet, no checkbox
  expect(md).toMatch(/^\*\s+\[ \]\s+Charlie$/m);
  // Only Alpha and Charlie carry a checkbox token now.
  expect((md.match(/\[ \]/g) ?? []).length).toBe(2);
});

/**
 * Bug ExcelCmd #5 (review, F1/F2): a LOOSE task list (items separated by blank
 * lines → markdown-it renders `<li><p>…</p></li>`) must strip cleanly. Two
 * regressions the review caught: computeUnwrapListRange used to wrap the item's
 * innerHTML (`<p>…</p>`) in another `<p>` → `<p><p>…</p></p>` → a stray empty
 * paragraph; and the multi-item `shouldAdd` check was tight-only so a loose
 * selection silently no-op'd. Both are fixed; this guards them end-to-end.
 */
test('Task List strip on a LOOSE task list item produces a clean paragraph with no stray empty <p>', async ({
  page,
}) => {
  await openEditor(page, '- [ ] Alpha\n\n- [ ] Bravo\n\n- [ ] Charlie\n');
  const content = page.locator('#content');
  // Confirm the list really rendered loose (checkbox inside a child <p>).
  const isLoose = await content.evaluate(
    (el) => !![...el.querySelectorAll('li')].find((l) => (l.textContent ?? '').includes('Bravo'))?.querySelector(':scope > p')
  );
  expect(isLoose).toBe(true);

  await placeCaretInLi(page, 'Bravo');
  await clearPosted(page);
  await page.locator('#fmt-task').click();

  const facts = await content.evaluate((el) => ({
    bravoIsParagraph: [...el.querySelectorAll(':scope > p')].some((p) => (p.textContent ?? '').trim() === 'Bravo'),
    emptyParagraphs: [...el.querySelectorAll('p')].filter((p) => (p.textContent ?? '').trim() === '').length,
    nestedParagraph: !!el.querySelector('p > p'),
    alphaHasCheckbox: [...el.querySelectorAll('ul.contains-task-list')].some(
      (ul) => (ul.textContent ?? '').includes('Alpha') && !!ul.querySelector('input[type="checkbox"]')
    ),
  }));
  expect(facts.bravoIsParagraph).toBe(true);
  expect(facts.emptyParagraphs).toBe(0); // no stray empty <p> from double-wrapping
  expect(facts.nestedParagraph).toBe(false);
  expect(facts.alphaHasCheckbox).toBe(true);
});

test('Task List strip on a lone task item still returns to a plain paragraph (regression guard)', async ({ page }) => {
  await openEditor(page, '- [ ] Solo\n');
  const content = page.locator('#content');
  await placeCaretInLi(page, 'Solo');
  await clearPosted(page);
  await page.locator('#fmt-task').click();

  const facts = await content.evaluate((el) => ({
    isParagraph: [...el.querySelectorAll(':scope > p')].some((p) => (p.textContent ?? '').trim() === 'Solo'),
    anyList: !!el.querySelector('ul, ol'),
  }));
  expect(facts.isParagraph).toBe(true);
  expect(facts.anyList).toBe(false);

  const md = await waitForEdit(page);
  expect(md).toMatch(/^Solo$/m);
  expect(md).not.toContain('[ ]');
});

test('Task List strip over a multi-item task selection turns each into a paragraph and splits around them', async ({
  page,
}) => {
  await openEditor(page, '- [ ] Alpha\n- [ ] Bravo\n- [ ] Charlie\n');
  const content = page.locator('#content');
  // Select from the start of Alpha's text through the end of Bravo's text — the
  // first two of three items (Charlie stays a task item after the split).
  await content.evaluate((el) => {
    const lis = [...el.querySelectorAll('li')];
    const alpha = lis.find((li) => (li.textContent ?? '').includes('Alpha'))!;
    const bravo = lis.find((li) => (li.textContent ?? '').includes('Bravo'))!;
    const r = document.createRange();
    r.setStart(alpha, 0);
    r.setEnd(bravo, bravo.childNodes.length);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await clearPosted(page);
  await page.locator('#fmt-task').click();

  const facts = await content.evaluate((el) => ({
    paragraphTexts: [...el.querySelectorAll(':scope > p')].map((p) => (p.textContent ?? '').trim()),
    charlieStillTask: [...el.querySelectorAll('ul.contains-task-list > li')].some(
      (li) => (li.textContent ?? '').includes('Charlie') && !!li.querySelector('input[type="checkbox"]')
    ),
  }));
  expect(facts.paragraphTexts).toContain('Alpha');
  expect(facts.paragraphTexts).toContain('Bravo');
  expect(facts.charlieStillTask).toBe(true);

  const md = await waitForEdit(page);
  expect(md).toMatch(/^Alpha$/m);
  expect(md).toMatch(/^Bravo$/m);
  expect(md).toMatch(/^\*\s+\[ \]\s+Charlie$/m);
  expect((md.match(/\[ \]/g) ?? []).length).toBe(1);
});
