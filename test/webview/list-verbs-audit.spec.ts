/**
 * P2 AUDIT (execCommand tech-debt): characterizes the ACTUAL DOM that Chromium's
 * list verbs produce in the real webview engine, to decide whether replacing
 * indent/outdent/insert*List (P1, "compute-then-commit-via-insertHTML") is worth
 * it. This is a CHARACTERIZATION test: it locks in the *current* (malformed)
 * shapes so a later P1 fix visibly flips these assertions — at which point update
 * each to assert the CORRECT shape. Valid nested list = `li > ul`; the malformed
 * forms below are what dom-serialize-prep.ts::normalizeListDom + serialize repair.
 *
 * Observed shapes (Chromium via Playwright, this file's inputs):
 *  - indent:   <ul><li>Alpha</li><ul><li>Bravo</li></ul></ul>          → ul child of ul (not of li)
 *  - outdent:  <ul><li><ul></ul></li></ul><span style="caret-color">Alpha</span>
 *              <ul><li>Bravo</li></ul><ul></ul>                          → text ripped out of <li> + empty <ul>s + styling-span artifact
 *  - insertUnorderedList (multi-p):  <p><ul><li>First</li>...</ul></p>   → ul nested INSIDE the leftover <p> (invalid)
 *  - insertUnorderedList (single-p): <p><ul><li>Hello world</li></ul></p> → same, even for one paragraph
 *  - insertOrderedList (ul->ol):     <ol><li>Alpha</li><li>Bravo</li></ol> → CLEAN
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

/** Place a collapsed caret inside the <li> whose text contains `itemText`. `itemText`
 * MUST be passed as an evaluate arg — Playwright serializes the fn, so closures don't cross. */
function placeCaretInItem(el: HTMLElement, itemText: string): void {
  const li = [...el.querySelectorAll('li')].find((l) => l.textContent!.includes(itemText))!;
  const r = document.createRange();
  r.setStart(li.firstChild!, 1);
  r.collapse(true);
  const s = window.getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
}

test('indent (Tab) produces a <ul> as a direct child of <ul> — malformed (should be li > ul)', async ({ page }) => {
  await openEditor(page, '- Alpha\n- Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Bravo');
  await content.press('Tab');
  const facts = await content.evaluate((el) => ({
    ulInUl: !!el.querySelector('ul > ul'),
    liInUl: !!el.querySelector('li > ul'),
  }));
  expect(facts.ulInUl).toBe(true); // malformed shape confirmed
  expect(facts.liInUl).toBe(false); // NOT the valid nested form
});

test('outdent (Shift+Tab) rips text out of its <li> and leaves empty <ul>s + a styling-span artifact', async ({ page }) => {
  await openEditor(page, '- Alpha\n  - Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Bravo');
  await content.press('Shift+Tab');
  const facts = await content.evaluate((el) => ({
    emptyUl: [...el.querySelectorAll('ul')].some((u) => u.children.length === 0),
    stylingSpan: !!el.querySelector('span[style*="caret-color"]'),
  }));
  expect(facts.emptyUl).toBe(true);
  expect(facts.stylingSpan).toBe(true); // Chromium injects a bare styling span
});

test('insertUnorderedList on a MULTI-paragraph selection nests <ul> inside the leftover <p> — malformed', async ({ page }) => {
  await openEditor(page, 'First\n\nSecond\n\nThird');
  const content = page.locator('#content');
  const ulInP = await content.evaluate((el) => {
    const ps = el.querySelectorAll('p');
    const r = document.createRange();
    r.setStart(ps[0].firstChild!, 0);
    const last = ps[ps.length - 1].firstChild as Text;
    r.setEnd(last, last.length);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    document.execCommand('insertUnorderedList');
    return !!el.querySelector('p > ul');
  });
  expect(ulInP).toBe(true);
});

test('insertUnorderedList on a SINGLE paragraph also nests <ul> inside the leftover <p> — malformed', async ({ page }) => {
  await openEditor(page, 'Hello world');
  const content = page.locator('#content');
  const ulInP = await content.evaluate((el) => {
    const p = el.querySelector('p')!;
    const r = document.createRange();
    r.selectNodeContents(p);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    document.execCommand('insertUnorderedList');
    return !!el.querySelector('p > ul');
  });
  expect(ulInP).toBe(true);
});

test('insertOrderedList converting an existing bullet list is CLEAN (<ol> with flat <li>s, no p/ol nesting)', async ({ page }) => {
  await openEditor(page, '- Alpha\n- Bravo');
  const content = page.locator('#content');
  const facts = await content.evaluate((el) => {
    const ul = el.querySelector('ul')!;
    const r = document.createRange();
    r.selectNodeContents(ul);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    document.execCommand('insertOrderedList');
    return {
      hasOl: !!el.querySelector('ol'),
      olInP: !!el.querySelector('p > ol'),
      olInOl: !!el.querySelector('ol > ol'),
      stylingSpan: !!el.querySelector('span[style*="caret-color"]'),
    };
  });
  expect(facts.hasOl).toBe(true);
  expect(facts.olInP).toBe(false);
  expect(facts.olInOl).toBe(false);
  expect(facts.stylingSpan).toBe(false); // clean — no artifact
});
