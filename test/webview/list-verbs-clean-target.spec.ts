/**
 * P0.3 (HLR 22, execCommand List/Block Verb Replacement — Code Plan Phase 0):
 * asserts the CLEAN DOM shape each replaced verb must produce once the shared
 * compute-then-commit-via-insertHTML primitive (Phase 1/2) replaces the raw
 * execCommand call. Tests here start out RED (`test.fail()` — Playwright's
 * "expected to fail" marker, so the suite stays green while the gap is explicit)
 * against the malformed shapes locked in by list-verbs-audit.spec.ts; as each
 * Phase-2 sub-step replaces its site, remove that test's `test.fail()` wrapper
 * so it starts asserting for real (outdent's wrapper came off in Phase 2.1 —
 * the remaining tests below are still RED until their own sub-step lands). A
 * test in here unexpectedly passing while still wrapped in `test.fail()` would
 * itself be reported as a failure by Playwright — that's the signal a verb's
 * replacement is already done and the wrapper can come off.
 *
 * Valid nested list shape: `li > ul` (never `ul > ul` sibling). No block should
 * ever end up nested inside a leftover `<p>` (`p > ul`/`p > ol`). No styling-only
 * `<span style="...">` artifact should be left behind by outdent.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

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

/** Same match rule as placeCaretInItem, but collapses at the END of the item's own
 *  text -- `.press('End')` right after a JS-set Selection is unreliable in this
 *  harness (observed to leave the caret at the stale JS-set offset), so callers
 *  needing "caret at end of item, about to press Enter" use this directly instead. */
function placeCaretAtEndOfItem(el: HTMLElement, itemText: string): void {
  const li = [...el.querySelectorAll('li')].find((l) => {
    const first = l.firstChild;
    return first?.nodeType === Node.TEXT_NODE && (first.textContent ?? '').includes(itemText);
  })!;
  const text = li.firstChild as Text;
  const r = document.createRange();
  r.setStart(text, text.data.length);
  r.collapse(true);
  const s = window.getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
}

test('indent (Tab) produces li > ul, not ul > ul', async ({ page }) => {
  await openEditor(page, '- Alpha\n- Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Bravo');
  await content.press('Tab');
  const facts = await content.evaluate((el) => ({
    ulInUl: !!el.querySelector('ul > ul'),
    liInUl: !!el.querySelector('li > ul'),
  }));
  expect(facts.ulInUl).toBe(false);
  expect(facts.liInUl).toBe(true);
});

test('outdent (Shift+Tab) leaves no empty <ul> and no styling-span artifact', async ({ page }) => {
  await openEditor(page, '- Alpha\n  - Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Bravo');
  await content.press('Shift+Tab');
  const facts = await content.evaluate((el) => ({
    emptyUl: [...el.querySelectorAll('ul')].some((u) => u.children.length === 0),
    stylingSpan: !!el.querySelector('span[style*="caret-color"]'),
  }));
  expect(facts.emptyUl).toBe(false);
  expect(facts.stylingSpan).toBe(false);
});

test('toolbar Bullet button (setBulletList) never nests <ul> inside a leftover <p>', async ({ page }) => {
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
  expect(facts.ulInP).toBe(false);
});

test('toolbar Numbered button (setNumberedList) on a plain paragraph never nests <ol> inside a leftover <p>', async ({
  page,
}) => {
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
  expect(facts.olInP).toBe(false);
});

// HLR 22 Phase 2.3: toolbar.ts:1330's setBulletList toggle-off/OL→UL-convert
// sites, now wired to computeUnwrapListRange/computeRetagListRange (list-ops.ts).
// The two !current-branch <p><ul>/<p><ol> leak cases above (setBulletList in 2.3,
// setNumberedList in 2.4) are now both migrated to computeToList, so they run as
// plain (non-test.fail()) assertions, matching the indent/outdent tests above.

test('toolbar Bullet button (setBulletList) toggling a targeted item off a multi-item <ul> leaves no styling-span artifact, untouched sibling stays in its own <ul>', async ({
  page,
}) => {
  await openEditor(page, '- Alpha\n- Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Alpha');
  await page.locator('#fmt-bullet').click();
  const facts = await content.evaluate((el) => ({
    stylingSpan: !!el.querySelector('span[style*="caret-color"]'),
    alphaIsP: [...el.querySelectorAll('p')].some((p) => (p.textContent ?? '').includes('Alpha')),
    bravoStillInList: !!el.querySelector('ul li'),
  }));
  expect(facts.stylingSpan).toBe(false);
  expect(facts.alphaIsP).toBe(true);
  expect(facts.bravoStillInList).toBe(true);
});

test('toolbar Bullet button (setBulletList) converting a targeted item of a multi-item <ol> to bullet keeps the untouched sibling in its own <ol>, target in its own <ul>', async ({
  page,
}) => {
  await openEditor(page, '1. Alpha\n2. Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Alpha');
  await page.locator('#fmt-bullet').click();
  const facts = await content.evaluate((el) => ({
    hasUl: !!el.querySelector('ul'),
    hasOl: !!el.querySelector('ol'),
    bravoInOl: [...el.querySelectorAll('ol li')].some((li) => (li.textContent ?? '').includes('Bravo')),
    alphaInUl: [...el.querySelectorAll('ul li')].some((li) => (li.textContent ?? '').includes('Alpha')),
  }));
  expect(facts.hasUl).toBe(true);
  expect(facts.hasOl).toBe(true);
  expect(facts.bravoInOl).toBe(true);
  expect(facts.alphaInUl).toBe(true);
});

// HLR 22 Phase 2.4: setNumberedList's in-list branches (now on
// computeRetagListRange/computeUnwrapListRange), the ordered mirror of the two
// setBulletList cases above.

test('toolbar Numbered button (setNumberedList) converting a targeted item of a multi-item <ul> to numbered keeps the untouched sibling in its own <ul>, target in its own <ol>', async ({
  page,
}) => {
  await openEditor(page, '- Alpha\n- Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Alpha');
  await page.locator('#fmt-numbered').click();
  const facts = await content.evaluate((el) => ({
    stylingSpan: !!el.querySelector('span[style*="caret-color"]'),
    hasUl: !!el.querySelector('ul'),
    hasOl: !!el.querySelector('ol'),
    bravoInUl: [...el.querySelectorAll('ul li')].some((li) => (li.textContent ?? '').includes('Bravo')),
    alphaInOl: [...el.querySelectorAll('ol li')].some((li) => (li.textContent ?? '').includes('Alpha')),
  }));
  expect(facts.stylingSpan).toBe(false);
  expect(facts.hasUl).toBe(true);
  expect(facts.hasOl).toBe(true);
  expect(facts.bravoInUl).toBe(true);
  expect(facts.alphaInOl).toBe(true);
});

test('toolbar Numbered button (setNumberedList) toggling a targeted item off a multi-item <ol> leaves no styling-span artifact, untouched sibling stays in its own <ol>', async ({
  page,
}) => {
  await openEditor(page, '1. Alpha\n2. Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Alpha');
  await page.locator('#fmt-numbered').click();
  const facts = await content.evaluate((el) => ({
    stylingSpan: !!el.querySelector('span[style*="caret-color"]'),
    alphaIsP: [...el.querySelectorAll('p')].some((p) => (p.textContent ?? '').includes('Alpha')),
    bravoStillInList: [...el.querySelectorAll('ol li')].some((li) => (li.textContent ?? '').includes('Bravo')),
  }));
  expect(facts.stylingSpan).toBe(false);
  expect(facts.alphaIsP).toBe(true);
  expect(facts.bravoStillInList).toBe(true);
});

// HLR 22 Phase 2.3 review: toolbar.ts:1453's toggleTaskItem single-item
// toggle-off site (also wired to computeUnwrapListRange) had no dedicated
// end-to-end coverage -- setBulletList's two sites above did, this one didn't.
test('Task List button removing the checkbox on a solo task item unwraps cleanly to a plain paragraph, no styling-span artifact', async ({
  page,
}) => {
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
  await page.locator('#fmt-task').click();
  await page.locator('#fmt-task').click();
  const facts = await content.evaluate((el) => ({
    stylingSpan: !!el.querySelector('span[style*="caret-color"]'),
    hasUl: !!el.querySelector('ul'),
    textIsInP: [...el.querySelectorAll('p')].some((p) => (p.textContent ?? '').includes('Hello world')),
  }));
  expect(facts.stylingSpan).toBe(false);
  expect(facts.hasUl).toBe(false);
  expect(facts.textIsInP).toBe(true);
});

// Bug ExcelCmd #3: converting the MIDDLE item of a multi-item <ol> to a task
// list used to just addCheckbox in place, leaving "2. [ ] Bravo" (numbered
// marker + checkbox) inside the <ol> and dropping contains-task-list on the
// whole <ol> (markdown.css shrinks its padding, shifting Alpha/Charlie left).
// Now it splits like setBulletList: Alpha/Charlie stay a clean <ol>, Bravo
// becomes a task item in its own <ul class="contains-task-list">.
test('Task List button converting a targeted item of a multi-item <ol> splits it into its own task <ul>, siblings stay a clean <ol> (bug ExcelCmd #3)', async ({
  page,
}) => {
  await openEditor(page, '1. Alpha\n2. Bravo\n3. Charlie');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Bravo');
  await clearPosted(page);
  await page.locator('#fmt-task').click();
  const facts = await content.evaluate((el) => ({
    stylingSpan: !!el.querySelector('span[style*="caret-color"]'),
    bravoInTaskUl: [...el.querySelectorAll('ul.contains-task-list > li.task-list-item')].some(
      (li) => (li.textContent ?? '').includes('Bravo')
    ),
    bravoHasCheckbox: [...el.querySelectorAll('li.task-list-item')].some(
      (li) => (li.textContent ?? '').includes('Bravo') && !!li.querySelector('input[type="checkbox"]')
    ),
    alphaInOl: [...el.querySelectorAll('ol li')].some((li) => (li.textContent ?? '').includes('Alpha')),
    charlieInOl: [...el.querySelectorAll('ol li')].some((li) => (li.textContent ?? '').includes('Charlie')),
    olHasTaskClass: !!el.querySelector('ol.contains-task-list'),
  }));
  expect(facts.stylingSpan).toBe(false);
  expect(facts.bravoInTaskUl).toBe(true);
  expect(facts.bravoHasCheckbox).toBe(true);
  expect(facts.alphaInOl).toBe(true);
  expect(facts.charlieInOl).toBe(true);
  expect(facts.olHasTaskClass).toBe(false);
  // Raw markdown must not carry a numbered-marker-plus-checkbox line.
  const md = await waitForEdit(page);
  expect(md).not.toMatch(/^\s*\d+\.\s+\[[ xX]\]/m);
  expect(md).toMatch(/^\s*(?:[-*+])\s+\[[ xX]\]\s+Bravo/m);
});

// User-reported regression (2026-07-17): Tab pressed immediately after Enter
// -- indenting a fresh, still-EMPTY <li> -- silently indented into the WRONG
// item instead (caret jumped back to the previous item, whose text then got
// the newly-typed characters appended to it). Root cause: commitListOp/
// commitListOpDirect's caret restore counted characters across the whole
// stableRoot; an empty <li> contributes zero characters, making "end of the
// previous item" and "start of the empty new item" the exact same offset --
// dom-utils.ts's locateOffset (text-node-only TreeWalker) always resolved to
// the former. Fixed via list-ops.ts's `caretAnchor` (restore precisely inside
// the item actually being moved, not stableRoot-wide). This only reproduces
// with a genuinely EMPTY item (freshly created by Enter, before typing into
// it) -- items loaded from a file always already have text, which is why the
// user could not reproduce it by editing an already-open file.
// scheduleSync fires an intermediate 'edit' right after Shift+Tab (empty item)
// before "Charlie" is typed, so plain waitForEdit can return that stale one --
// poll for the settled edit that actually reflects the typed text.
async function waitForEditContaining(page: import('@playwright/test').Page, needle: string): Promise<string> {
  const handle = await page.waitForFunction(
    (n) =>
      (window as unknown as { __posted: Array<{ type: string; text: string }> }).__posted
        .filter((m) => m.type === 'edit' && m.text.includes(n))
        .at(-1),
    needle,
    { timeout: 2000 }
  );
  return ((await handle.jsonValue()) as { text: string }).text;
}

// `listDepth` = number of ancestor <ul>/<ol> between the <li> and #content --
// asserting text identity alone (as these tests originally did) can't tell whether
// the fresh item ended up at the RIGHT nesting level or serializes clean, which
// is the actual outcome the Group Targeting bug (bug 0717 round3.md #2/#4) was
// about. We assert depth AND the serialized markdown so a targeting/serialization
// regression that leaves text intact but nests wrong or emits a stray `\` fails here.
function itemFacts(el: HTMLElement) {
  const ownText = (l: Element) => (l.firstChild?.nodeType === Node.TEXT_NODE ? l.firstChild.textContent : null);
  const listDepth = (l: Element) => {
    let d = 0;
    let p: Element | null = l.parentElement;
    while (p && p !== el) {
      if (p.nodeName === 'UL' || p.nodeName === 'OL') d++;
      p = p.parentElement;
    }
    return d;
  };
  const lis = [...el.querySelectorAll('li')];
  const byText = (t: string) => lis.find((l) => ownText(l) === t)!;
  return {
    bravoOwnText: ownText(byText('Bravo')),
    charlieOwnText: ownText(byText('Charlie')),
    bravoDepth: listDepth(byText('Bravo')),
    charlieDepth: listDepth(byText('Charlie')),
  };
}

test('Tab pressed right after Enter (fresh empty item) indents into that SAME item, not the previous one', async ({
  page,
}) => {
  await openEditor(page, '- Alpha\n- Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretAtEndOfItem, 'Bravo');
  await clearPosted(page);
  await content.press('Enter');
  await content.press('Tab');
  await content.pressSequentially('Charlie');
  const facts = await content.evaluate(itemFacts);
  expect(facts.bravoOwnText).toBe('Bravo');
  expect(facts.charlieOwnText).toBe('Charlie');
  // Charlie is the freshly-indented item: it must nest UNDER Bravo (depth 2),
  // with Bravo itself still top-level (depth 1) -- not a no-op, not indenting Bravo.
  expect(facts.bravoDepth).toBe(1);
  expect(facts.charlieDepth).toBe(2);
  expect(await waitForEditContaining(page, 'Charlie')).toBe('-   Alpha\n-   Bravo\n    -   Charlie\n');
});

// bug_ExcelCommand #2 (Undo khi indent ở TC2.2c): the SAME gesture as above but
// WITHOUT typing into the new item. The freshly-indented item stays a genuinely
// empty <li><br></li> nested under Bravo. That empty child used to serialize as
// "-   Bravo\n    -", and a lone "-" line under a paragraph is a setext H2
// underline, so on the next render (e.g. after Undo, which re-renders the doc
// wholesale) "Bravo" came back as an <h2> heading. The serialized markdown must
// carry NO such trap and must re-render with no heading; Alpha (never touched)
// must stay a plain top-level bullet, not grow a phantom child. This drives the
// real dist bundle end-to-end, which a hand-built roundtrip snapshot can't.
test('Tab-indenting a fresh EMPTY item (no typing) under a "-" list serializes with no setext-heading trap (bug_ExcelCommand #2)', async ({
  page,
}) => {
  await openEditor(page, '- Alpha\n- Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretAtEndOfItem, 'Bravo');
  await clearPosted(page);
  await content.press('Enter');
  await content.press('Tab');
  const md = await waitForEdit(page);
  // No indented lone "-"/"=" line (the setext-underline shape) survives.
  expect(md.split('\n').some((l) => /^\s+[-=]+\s*$/.test(l))).toBe(false);
  // Alpha stays a clean top-level bullet, Bravo too — no phantom nested child.
  expect(/^-\s+Alpha$/m.test(md)).toBe(true);
  expect(/^-\s+Bravo$/m.test(md)).toBe(true);
  // Re-render that serialized markdown the way Undo/redo does (host 'update'
  // message → renderDocument re-parses the whole doc): the reported symptom was
  // Alpha/Bravo coming back as <h2>. Assert the live DOM has no heading.
  await page.evaluate((text) => window.postMessage({ type: 'update', text }, '*'), md);
  await expect(content.locator('h1, h2, h3, h4, h5, h6')).toHaveCount(0);
  // Bravo comes back as a list item, not a heading.
  await expect(content.locator('li', { hasText: 'Bravo' })).toHaveCount(1);
});

test('Shift+Tab pressed right after Enter (fresh empty nested item) outdents that SAME item, not the previous one', async ({
  page,
}) => {
  await openEditor(page, '- Alpha\n  - Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretAtEndOfItem, 'Bravo');
  await clearPosted(page);
  await content.press('Enter');
  await content.press('Shift+Tab');
  await content.pressSequentially('Charlie');
  const facts = await content.evaluate(itemFacts);
  expect(facts.bravoOwnText).toBe('Bravo');
  expect(facts.charlieOwnText).toBe('Charlie');
  // Charlie is the freshly-outdented item: it must become Alpha's own sibling
  // (depth 1), with Bravo still nested (depth 2) -- not stuck as Bravo's sibling.
  expect(facts.bravoDepth).toBe(2);
  expect(facts.charlieDepth).toBe(1);
  expect(await waitForEditContaining(page, 'Charlie')).toBe('-   Alpha\n    -   Bravo\n-   Charlie\n');
});

// HLR 22 Phase 2.6: blockquote add-quote sites (toolbar toggleBlockquote +
// input-rules "> " Space rule), now on dom-utils' wrapInBlockquote — canonical
// <blockquote><p> shape, no ReplaceSelectionCommand/formatBlock involved.

test('Blockquote button on a plain paragraph wraps as canonical blockquote > p, and toggling off restores a clean <p>', async ({
  page,
}) => {
  await openEditor(page, 'Hello world');
  const content = page.locator('#content');
  const placeCaret = async () =>
    content.evaluate((el) => {
      const target = el.querySelector('blockquote p, blockquote, p')!;
      const r = document.createRange();
      r.setStart(target.firstChild!, 1);
      r.collapse(true);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
  await placeCaret();
  await page.locator('#fmt-blockquote').click();
  const afterAdd = await content.evaluate((el) => ({
    pInBlockquote: !!el.querySelector('blockquote > p'),
    blockquoteInP: !!el.querySelector('p > blockquote'),
    nestedQuote: !!el.querySelector('blockquote blockquote'),
  }));
  expect(afterAdd.pInBlockquote).toBe(true);
  expect(afterAdd.blockquoteInP).toBe(false);
  expect(afterAdd.nestedQuote).toBe(false);

  // Toggle off: unwrap branch moves the inner <p> back out — clean paragraph,
  // no leftover blockquote and no bare text node at #content top level.
  await placeCaret();
  await page.locator('#fmt-blockquote').click();
  const afterRemove = await content.evaluate((el) => ({
    hasBlockquote: !!el.querySelector('blockquote'),
    helloInP: [...el.querySelectorAll('p')].some((p) => (p.textContent ?? '').includes('Hello world')),
  }));
  expect(afterRemove.hasBlockquote).toBe(false);
  expect(afterRemove.helloInP).toBe(true);
});

// Bug 0717 round3 #3 (Group IndentCollapse): indenting a top-level item onto a
// previous sibling's EXISTING sublist corrupted the DOM when the list was LOOSE
// (items <p>-wrapped -- blank lines between them in the source). computeIndent
// builds a correct single-<li> replacement, but committing it via
// execCommand('insertHTML') (commitListOp) routed the 2-<li>-into-1 collapse
// through WebKit's ReplaceSelectionCommand, which left phantom empty <li>s and
// stray leading/trailing bullet lines. Fixed by committing indent via
// commitListOpDirect (Range surgery) -- same move already made for outdent. A
// hand-built domino snapshot can't stand in for this (no execCommand/Selection
// API), so it must live here. Tight lists were never affected -- guarded below.
test('indent onto an existing sublist in a LOOSE list stays clean (no phantom bullets)', async ({ page }) => {
  await openEditor(page, '- Alpha\n\n  - existing child\n\n- Bravo\n');
  const content = page.locator('#content');
  await content.evaluate((el) => {
    // Bravo is <p>-wrapped in a loose list -- match the <li> whose own <p> text is "Bravo".
    const li = [...el.querySelectorAll('li')].find(
      (l) => (l.querySelector(':scope > p')?.textContent ?? '').includes('Bravo')
    )!;
    const p = li.querySelector(':scope > p')!;
    const r = document.createRange();
    r.setStart(p.firstChild!, 1);
    r.collapse(true);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await clearPosted(page);
  await content.press('Tab');
  const md = await waitForEditContaining(page, 'Bravo');
  const facts = await content.evaluate((el) => {
    const bravoLi = [...el.querySelectorAll('li')].find(
      (l) => (l.querySelector(':scope > p')?.textContent ?? '').includes('Bravo')
    )!;
    const alphaLi = [...el.querySelectorAll('li')].find(
      (l) => (l.querySelector(':scope > p')?.textContent ?? '').includes('Alpha')
    )!;
    return {
      liCount: el.querySelectorAll('li').length,
      bravoInsideAlphaSublist: alphaLi.querySelector(':scope > ul')?.contains(bravoLi) ?? false,
    };
  });
  // Exactly three real items -- no phantom empty <li> from the corrupt collapse.
  expect(facts.liCount).toBe(3);
  expect(facts.bravoInsideAlphaSublist).toBe(true);
  // No stray leading/trailing bullet line (the old execCommand corruption emitted
  // a leading "-   " and a trailing "-"); every bullet line must carry real text.
  const bulletLines = md.split('\n').filter((l) => /^\s*-\s/.test(l));
  expect(bulletLines.length).toBe(3);
  for (const line of bulletLines) {
    expect(line.replace(/^\s*-\s*/, '').trim().length).toBeGreaterThan(0);
  }
});

// Bug 0717 round3 #3 edge coverage: the computeIndent branch where the item being
// indented ALREADY carries its own nested sublist -- that sublist must travel with
// it, and committing via commitListOpDirect (Range surgery) must keep the caret in
// the moved item, not lose it (deleteContents removes the original <li> -- unlike the
// old execCommand path there is no browser-provided fallback caret). Live-only:
// domino has no Selection API to catch a lost/misplaced caret.
test('indent an item that already has its own sublist keeps it nested and the caret in it', async ({ page }) => {
  await openEditor(page, '- Alpha\n- Bravo\n  - Child\n');
  const content = page.locator('#content');
  await content.evaluate((el) => {
    const li = [...el.querySelectorAll('li')].find(
      (l) => l.firstChild?.nodeType === Node.TEXT_NODE && (l.firstChild.textContent ?? '').includes('Bravo')
    )!;
    const r = document.createRange();
    r.setStart(li.firstChild!, 1);
    r.collapse(true);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await clearPosted(page);
  await content.press('Tab');
  const md = await waitForEditContaining(page, 'Child');
  const facts = await content.evaluate((el) => {
    const depth = (text: string) => {
      const li = [...el.querySelectorAll('li')].find(
        (l) => l.firstChild?.nodeType === Node.TEXT_NODE && (l.firstChild.textContent ?? '').includes(text)
      )!;
      let d = 0;
      let p: Element | null = li.parentElement;
      while (p && p !== el) {
        if (p.nodeName === 'UL' || p.nodeName === 'OL') d++;
        p = p.parentElement;
      }
      return d;
    };
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    const caretLi = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest('li');
    return {
      liCount: el.querySelectorAll('li').length,
      staleAnchorAttrs: el.querySelectorAll('[data-list-op-caret-anchor]').length,
      bravoDepth: depth('Bravo'),
      childDepth: depth('Child'),
      caretInBravo: (caretLi?.firstChild?.textContent ?? '').includes('Bravo'),
    };
  });
  expect(facts.liCount).toBe(3); // no phantom <li> from the collapse
  expect(facts.staleAnchorAttrs).toBe(0); // caret-anchor marker stripped after commit
  expect(facts.bravoDepth).toBe(2); // Bravo now under Alpha's sublist
  expect(facts.childDepth).toBe(3); // Child's own sublist travelled with Bravo
  expect(facts.caretInBravo).toBe(true); // caret preserved in the moved item, not lost
  expect(md).toBe('-   Alpha\n    -   Bravo\n        -   Child\n');
});

test('"> " input rule converts the paragraph into canonical blockquote > p', async ({ page }) => {
  await openEditor(page, 'Hello world');
  const content = page.locator('#content');
  await content.evaluate((el) => {
    const p = el.querySelector('p')!;
    const r = document.createRange();
    r.setStart(p.firstChild!, 0);
    r.collapse(true);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.keyboard.type('> ');
  const facts = await content.evaluate((el) => ({
    pInBlockquote: !!el.querySelector('blockquote > p'),
    blockquoteInP: !!el.querySelector('p > blockquote'),
    text: el.querySelector('blockquote')?.textContent?.trim() ?? '',
  }));
  expect(facts.pInBlockquote).toBe(true);
  expect(facts.blockquoteInP).toBe(false);
  expect(facts.text).toBe('Hello world');
});
