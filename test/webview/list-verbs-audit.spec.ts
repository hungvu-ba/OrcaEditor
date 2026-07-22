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
 *  - indent:   CLEAN as of Phase 2.2 — Tab (main.ts:1010) now wires the collapsed-caret,
 *              has-a-previous-sibling case to computeIndent/commitListOp; always `li > ul`, never
 *              `ul > ul`. (Formerly malformed via raw `execCommand('indent')`; see git history for the shape.)
 *  - outdent:  CLEAN as of Phase 2.1 — Tab/Shift+Tab (main.ts:1010) now wires the collapsed-caret,
 *              nested-<li> case to computeOutdent/commitListOpDirect; no empty <ul>s, no styling-span
 *              artifact. (Formerly malformed via raw `execCommand('outdent')`; see git history for the shape.)
 *  - insertUnorderedList (multi-p):  <p><ul><li>First</li>...</ul></p>   → ul nested INSIDE the leftover <p> (invalid)
 *    (raw execCommand call, unaffected by Phase 2.3 -- see the toolbar-Bullet-button bullet below for the
 *    now-fixed toolbar-driven equivalent of this exact shape.)
 *  - insertUnorderedList (single-p): <p><ul><li>Hello world</li></ul></p> → same, even for one paragraph
 *  - insertUnorderedList (setBulletList !current branch, i.e. toolbar Bullet button on plain paragraphs not
 *    yet in a list): CLEAN as of Phase 2.3 -- now wired to computeToList/commitListOp; no <p><ul> leak.
 *    (Formerly the same malformed shape as the two raw-execCommand bullets right above.)
 *  - insertOrderedList (ul->ol):     <ol><li>Alpha</li><li>Bravo</li></ol> → CLEAN
 *  - insertOrderedList (p->ol, no existing list): same <p><ol>...</ol></p> leak as insertUnorderedList — only
 *    the ul->ol CONVERSION case above is clean.
 *  - formatBlock (heading source, e.g. h2->p or h2->h3): CLEAN — no nesting/leak observed; the execCommand
 *    branch is used there for a DIFFERENT Chrome bug (nested-heading font-size compounding on repeated
 *    formatBlock calls, see dom-utils.ts:replaceBlockTag comment), not because the resulting DOM is malformed.
 *  - formatBlock('blockquote') (toolbar Blockquote add-quote, and input-rules.ts's '>' Space rule — same
 *    verb/tag, same DOM outcome): CLEAN <blockquote> wrapping, no p-in-blockquote/blockquote-in-p leak observed.
 *  - insertUnorderedList (setBulletList toggle-off, caret in ONE item of a multi-item <ul>): CLEAN as of
 *    Phase 2.3 — now wired to computeUnwrapListRange/commitListOpDirect; only the targeted item unwraps to
 *    <p>, the untouched sibling stays in its own <ul>. (Formerly malformed via raw execCommand: left a
 *    `<span style="caret-color...">` artifact + `<br>` instead of a clean <p>, same family as the old
 *    outdent bug — see git history for the shape.)
 *  - insertUnorderedList (setBulletList OL→UL convert, caret in ONE item of a multi-item <ol>): CLEAN as of
 *    Phase 2.3 — now wired to computeRetagListRange/commitListOpDirect; only the targeted item retags to its
 *    own <ul>, the untouched sibling stays in its own <ol>.
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
  // Match on the <li>'s OWN direct text node, not the full (recursive) textContent --
  // for a nested item, an ANCESTOR <li>'s textContent also contains its descendants'
  // text (e.g. "Alpha\nBravo"), which would false-positive-match a nested itemText
  // against the wrong (outer) <li>.
  const li = [...el.querySelectorAll('li')].find((l) => {
    const first = l.firstChild;
    return first?.nodeType === Node.TEXT_NODE && (first.textContent ?? '').includes(itemText);
  })!;
  const r = document.createRange();
  r.setStart(li.firstChild!, 1);
  r.collapse(true);
  const s = window.getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
}

test('indent (Tab) is CLEAN — produces li > ul, never ul > ul (Phase 2.2 fixed)', async ({ page }) => {
  await openEditor(page, '- Alpha\n- Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Bravo');
  await content.press('Tab');
  const facts = await content.evaluate((el) => ({
    ulInUl: !!el.querySelector('ul > ul'),
    liInUl: !!el.querySelector('li > ul'),
  }));
  expect(facts.ulInUl).toBe(false);
  expect(facts.liInUl).toBe(true); // computeIndent/commitListOp now produces the valid nested form
});

test('outdent (Shift+Tab) is CLEAN — no empty <ul>s and no styling-span artifact (Phase 2.1 fixed)', async ({ page }) => {
  await openEditor(page, '- Alpha\n  - Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Bravo');
  await content.press('Shift+Tab');
  const facts = await content.evaluate((el) => ({
    emptyUl: [...el.querySelectorAll('ul')].some((u) => u.children.length === 0),
    stylingSpan: !!el.querySelector('span[style*="caret-color"]'),
  }));
  expect(facts.emptyUl).toBe(false);
  expect(facts.stylingSpan).toBe(false); // computeOutdent/commitListOpDirect no longer injects a styling span
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

test('toolbar Bullet button (setBulletList) on plain paragraphs is CLEAN — no <p><ul> leak (Phase 2.3 fixed)', async ({
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
  expect(facts.ulInP).toBe(false); // computeToList/commitListOp (Phase 2.3) no longer leaves a <p><ul> leak
});

test('toolbar Numbered button (setNumberedList) on a plain paragraph is CLEAN — no <p><ol> leak (Phase 2.4 fixed)', async ({
  page,
}) => {
  // Was malformed like insertUnorderedList (<ol> nested in a leftover <p>) when
  // starting from a plain <p>; Phase 2.4 routes this through
  // computeToList/commitListOp (list-ops.ts), same as setBulletList's 2.3 fix.
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
  expect(facts.olInP).toBe(false); // computeToList/commitListOp (Phase 2.4) no longer leaves a <p><ol> leak
});

test('Heading button toggled twice (h2 -> paragraph) is CLEAN — no nested heading, revert to <p> (Phase 2.5 fixed)', async ({
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
  await page.locator('#fmt-heading').click(); // p -> h2 (non-heading source, direct-insert path)
  await placeCaret();
  await page.locator('#fmt-heading').click(); // h2 -> p (heading source, now direct-insert, was formatBlock)
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

test('Blockquote button add-quote (toggleBlockquote) is CLEAN — canonical blockquote > p, no p > blockquote (Phase 2.6 fixed)', async ({
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
  expect(facts.blockquoteInP).toBe(false); // wrapInBlockquote (Phase 2.6) never nests inside a leftover <p>
  expect(facts.pInBlockquote).toBe(true); // canonical markdown-it shape — same as re-rendering "> Hello world"
});

// --- HLR 22 Phase 2.3: toolbar.ts:1330's setBulletList toggle-off/OL→UL-convert
// sites, previously uncharacterized (probed live during Phase 2.3 spec authoring,
// see Requirement - 22... "Phase 2.3" note and computeUnwrapListRange/
// computeRetagListRange in list-ops.ts). Per this file's own stated policy (top
// docstring: "a later P1 fix visibly flips these assertions"), and since Phase
// 2.3's wiring already landed before these tests were added, both assert the
// now-CLEAN shape directly (mirroring the indent/outdent tests above, which were
// flipped the same way once Phase 2.1/2.2 landed) rather than a malformed shape
// that the real button click can no longer reproduce.

test('toolbar Bullet button (setBulletList) toggling a targeted item off a multi-item <ul> is CLEAN — no styling-span artifact, untouched sibling stays in its own <ul> (Phase 2.3 fixed)', async ({
  page,
}) => {
  await openEditor(page, '- Alpha\n- Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Alpha');
  await page.locator('#fmt-bullet').click(); // caret already in a <ul> -> toggle off via computeUnwrapListRange
  const facts = await content.evaluate((el) => ({
    stylingSpan: !!el.querySelector('span[style*="caret-color"]'),
    alphaIsP: [...el.querySelectorAll('p')].some((p) => (p.textContent ?? '').includes('Alpha')),
    bravoStillInList: !!el.querySelector('ul li'),
  }));
  expect(facts.stylingSpan).toBe(false); // formerly a caret-color styling-span artifact via raw execCommand
  expect(facts.alphaIsP).toBe(true);
  expect(facts.bravoStillInList).toBe(true);
});

test('toolbar Bullet button (setBulletList) converting a targeted item of a multi-item <ol> to bullet is CLEAN — untouched sibling stays in its own <ol>, target becomes its own <ul> (Phase 2.3 fixed)', async ({
  page,
}) => {
  await openEditor(page, '1. Alpha\n2. Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Alpha');
  await page.locator('#fmt-bullet').click(); // caret in <ol> -> retag via computeRetagListRange
  const facts = await content.evaluate((el) => ({
    hasUl: !!el.querySelector('ul'),
    hasOl: !!el.querySelector('ol'),
    bravoInOl: [...el.querySelectorAll('ol li')].some((li) => (li.textContent ?? '').includes('Bravo')),
    alphaInUl: [...el.querySelectorAll('ul li')].some((li) => (li.textContent ?? '').includes('Alpha')),
  }));
  expect(facts.hasUl).toBe(true); // two sibling lists -- <ul> for the retagged target...
  expect(facts.hasOl).toBe(true); // ...and <ol> for the untouched sibling, correctly split
  expect(facts.bravoInOl).toBe(true);
  expect(facts.alphaInUl).toBe(true);
});
