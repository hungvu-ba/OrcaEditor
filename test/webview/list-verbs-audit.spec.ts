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
 *  - insertOrderedList (p->ol, no existing list): same <p><ol>...</ol></p> leak as insertUnorderedList — only
 *    the ul->ol CONVERSION case above is clean.
 *  - formatBlock (heading source, e.g. h2->p or h2->h3): CLEAN — no nesting/leak observed; the execCommand
 *    branch is used there for a DIFFERENT Chrome bug (nested-heading font-size compounding on repeated
 *    formatBlock calls, see dom-utils.ts:replaceBlockTag comment), not because the resulting DOM is malformed.
 *  - formatBlock('blockquote') (toolbar Blockquote add-quote, and input-rules.ts's '>' Space rule — same
 *    verb/tag, same DOM outcome): CLEAN <blockquote> wrapping, no p-in-blockquote/blockquote-in-p leak observed.
 *
 * Phase 0.2 (HLR 22) added the toolbar-button/input-rule-driven cases below the original 5, to characterize
 * the call sites Phase 2 actually replaces (not just raw execCommand calls). One site from the original code
 * plan's list is NOT characterized here: drag-drop.ts's list-item indent/outdent no longer calls execCommand
 * at all (it already moved to Range-based DOM ops for US-17.5 drag-triggered indent/outdent) — only the
 * Tab/Shift+Tab keyboard path (main.ts:1010) still does.
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

// --- Phase 0.2 (execCommand List/Block Verb Replacement, HLR 22): the remaining
// of the 14 sites not yet characterized above — driven through the REAL toolbar
// button/input-rule call sites (not raw execCommand calls) so the audit matches
// what Phase 2 actually has to replace. See
// Plan/execCommand List-Block Verb Replacement — Code Plan.md.

test('toolbar Bullet button (setBulletList) on plain paragraphs produces the same <p><ul> malformed shape as raw insertUnorderedList', async ({
  page,
}) => {
  await openEditor(page, 'First\n\nSecond');
  const content = page.locator('#content');
  await content.evaluate((el) => {
    const ps = el.querySelectorAll('p');
    const r = document.createRange();
    r.setStart(ps[0].firstChild!, 0);
    const last = ps[ps.length - 1].firstChild as Text;
    r.setEnd(last, last.length);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.locator('#fmt-bullet').click();
  const facts = await content.evaluate((el) => ({
    ulInP: !!el.querySelector('p > ul'),
    hasUl: !!el.querySelector('ul'),
  }));
  expect(facts.hasUl).toBe(true);
  expect(facts.ulInP).toBe(true); // malformed — same shape as the raw-execCommand case above
});

test('toolbar Numbered button (setNumberedList) on a plain paragraph (not converting an existing ul) also nests <ol> inside the leftover <p> — malformed', async ({
  page,
}) => {
  // Unlike the "ul -> ol conversion" case (clean, tested above), starting
  // insertOrderedList directly from a <p> behaves like insertUnorderedList:
  // Chrome leaves the <ol> nested inside a leftover <p> wrapper.
  await openEditor(page, 'Hello world');
  const content = page.locator('#content');
  await content.evaluate((el) => {
    const p = el.querySelector('p')!;
    const r = document.createRange();
    r.selectNodeContents(p);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.locator('#fmt-numbered').click();
  const facts = await content.evaluate((el) => ({
    hasOl: !!el.querySelector('ol'),
    olInP: !!el.querySelector('p > ol'),
  }));
  expect(facts.hasOl).toBe(true);
  expect(facts.olInP).toBe(true); // malformed — same p-wrapper leak as insertUnorderedList
});

test('Heading button toggled twice (h2 -> paragraph) uses execCommand(formatBlock) for the heading-source case — DOM shape', async ({
  page,
}) => {
  await openEditor(page, 'Hello world');
  const content = page.locator('#content');
  const placeCaret = async () =>
    content.evaluate((el) => {
      const p = el.querySelector('p, h2')!;
      const r = document.createRange();
      r.setStart(p.firstChild!, 1);
      r.collapse(true);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
  await placeCaret();
  await page.locator('#fmt-heading').click(); // p -> h2 (non-heading source, insertHTML path)
  await placeCaret();
  await page.locator('#fmt-heading').click(); // h2 -> p (heading source -> execCommand('formatBlock', 'p'))
  const facts = await content.evaluate((el) => ({
    html: el.innerHTML,
    pCount: el.querySelectorAll('p').length,
    headingCount: el.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
    nestedHeading: !!el.querySelector('h1 h1, h2 h2, h1 h2, h2 h1'),
  }));
  expect(facts.headingCount).toBe(0);
  expect(facts.pCount).toBeGreaterThanOrEqual(1);
  expect(facts.nestedHeading).toBe(false);
});

test('Blockquote button add-quote (toggleBlockquote) uses execCommand(formatBlock, blockquote) — DOM shape', async ({
  page,
}) => {
  await openEditor(page, 'Hello world');
  const content = page.locator('#content');
  await content.evaluate((el) => {
    const p = el.querySelector('p')!;
    const r = document.createRange();
    r.setStart(p.firstChild!, 1);
    r.collapse(true);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.locator('#fmt-blockquote').click();
  const facts = await content.evaluate((el) => ({
    hasBlockquote: !!el.querySelector('blockquote'),
    blockquoteInP: !!el.querySelector('p > blockquote'),
    pInBlockquote: !!el.querySelector('blockquote > p'),
  }));
  expect(facts.hasBlockquote).toBe(true);
});
