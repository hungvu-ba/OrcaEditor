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
import { openEditor, clearPosted, waitForEdit } from './_harness';

/** Place a collapsed caret one char into the <li> whose OWN direct text contains
 *  `itemText` (not a nested descendant's text — an ancestor <li>'s recursive
 *  textContent would false-match). Mirrors list-verbs-clean-target.spec.ts. */
function placeCaretInItem(el: HTMLElement, itemText: string): void {
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

/** How many 'edit' messages the webview has posted to the host so far. */
async function editCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'edit').length
  );
}

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

test('caret lands inside the edited bullet, not at the first bullet start', async ({ page }) => {
  await openEditor(page, 'placeholder');
  // A <ul> is one multi-line top-level block, so the exact-column path is skipped.
  // Before the fix the caret collapsed to the start of the FIRST bullet ("Alpha").
  // Undo result edits bullet #2; source col 5 = "- Bra" (2-char "- " marker + "Bra").
  await sendUndoUpdate(page, '- Alpha\n- Bravo\n- Charlie', 2, 5);

  const caret = await readCaret(page);
  expect(caret).not.toBeNull();
  expect(caret!.collapsed).toBe(true);
  expect(caret!.anchorText).toBe('Bravo'); // inside bullet #2, NOT "Alpha"
  expect(caret!.anchorOffset).toBe(3); // between "Bra" and "vo", marker "- " stripped
});

test('caret lands inside a nested bullet with leading indent stripped', async ({ page }) => {
  await openEditor(page, 'placeholder');
  // Nested bullet: source line "  - Bravo". Col 7 = 2 indent + "- " marker + "Bra".
  // The deepest <li> containing the line wins; indent + marker are both stripped.
  await sendUndoUpdate(page, '- Alpha\n  - Bravo\n- Charlie', 2, 7);

  const caret = await readCaret(page);
  expect(caret).not.toBeNull();
  expect(caret!.collapsed).toBe(true);
  expect(caret!.anchorText).toBe('Bravo'); // inside the nested bullet
  expect(caret!.anchorOffset).toBe(3); // 7 − 2 indent − 2 marker
});

test('multi-line list item restores caret to the item, not into a nested bullet', async ({ page }) => {
  await openEditor(page, 'placeholder');
  // The outer bullet spans two source lines (its own line + a nested child), so its
  // <li> is multi-line: the per-line column can't map cleanly onto the <li>'s joined
  // text. Inline `code` also inflates the source column (13) past the rendered
  // lead-text length (9). Editing the OUTER line must keep the caret in the OUTER
  // (top-level) bullet — the caret must NOT overflow into the nested "Nested" item.
  await sendUndoUpdate(page, '- `code` word\n  - Nested', 1, 13);

  const info = await page.evaluate(() => {
    const sel = window.getSelection();
    const n = sel && sel.rangeCount > 0 ? sel.anchorNode : null;
    const el = n && n.nodeType === 3 ? n.parentElement : (n as Element | null);
    const li = el ? el.closest('li') : null;
    let depth = 0;
    for (let p = li ? li.parentElement : null; p; p = p.parentElement) {
      if (p.tagName === 'LI') {
        depth++;
      }
    }
    return { hasLi: !!li, depth };
  });
  expect(info.hasLi).toBe(true);
  expect(info.depth).toBe(0); // top-level bullet, NOT the nested "Nested" child
});

/**
 * HLR 22 Phase 4.1 — undo granularity + Ctrl+Z/Y symmetry for the REPLACED
 * list/block verbs (indent/outdent/insertUnorderedList/insertOrderedList now go
 * through list-ops' compute-then-commit primitive). Undo is delegated entirely
 * to VS Code's TextDocument, never the browser's native execCommand stack (see
 * main.ts / provider.ts), so "exactly one undo step" here means the webview
 * posts exactly ONE 'edit' to the host per operation — a stray second sync would
 * split the op across two TextDocument edits, so Ctrl+Z would only half-undo it.
 * scheduleSync debounces, so multiple DOM mutations within one op coalesce; these
 * assert that no EXTRA edit fires after the debounce settles.
 *
 * The full host↔webview round-trip needs the real host (verified manually — see
 * this file's header). The webview HALF of it — faithfully re-rendering when the
 * host replays the pre-op / post-op text — is driven directly below via the same
 * 'update' message the host sends on Ctrl+Z / Ctrl+Y.
 */

// Long enough after the first edit lands that a stray second debounced sync
// (~250ms) would already have posted — so editCount === 1 is a real "no more".
const SETTLE_MS = 500;

test('indent (Tab) posts exactly one host edit — one undo step', async ({ page }) => {
  await openEditor(page, '- Alpha\n- Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Bravo');
  await clearPosted(page);
  await content.press('Tab');
  const md = await waitForEdit(page);
  expect(md).toMatch(/^\s+[*-]\s+Bravo/m); // Bravo indented under Alpha
  await page.waitForTimeout(SETTLE_MS);
  expect(await editCount(page)).toBe(1);
});

test('outdent (Shift+Tab) posts exactly one host edit — one undo step', async ({ page }) => {
  await openEditor(page, '- Alpha\n  - Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Bravo');
  await clearPosted(page);
  await content.press('Shift+Tab');
  const md = await waitForEdit(page);
  expect(md).toMatch(/^[*-]\s+Bravo/m); // Bravo now top-level
  await page.waitForTimeout(SETTLE_MS);
  expect(await editCount(page)).toBe(1);
});

test('toolbar Bullet (setBulletList) posts exactly one host edit — one undo step', async ({ page }) => {
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
  await clearPosted(page);
  await page.locator('#fmt-bullet').click();
  await waitForEdit(page);
  await page.waitForTimeout(SETTLE_MS);
  expect(await editCount(page)).toBe(1);
});

test('toolbar Numbered (setNumberedList) posts exactly one host edit — one undo step', async ({ page }) => {
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
  await clearPosted(page);
  await page.locator('#fmt-numbered').click();
  await waitForEdit(page);
  await page.waitForTimeout(SETTLE_MS);
  expect(await editCount(page)).toBe(1);
});

test('indent then host-replayed undo/redo restores the pre-op then post-op structure (Ctrl+Z/Y webview half)', async ({
  page,
}) => {
  const original = '- Alpha\n- Bravo';
  await openEditor(page, original);
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Bravo');
  await content.press('Tab');
  const afterIndent = await waitForEdit(page); // exact post-op markdown the host records

  // Match Bravo's OWN <li> by its direct text node — an ancestor <li>'s recursive
  // textContent also contains "Bravo" once it's nested, which would false-match
  // the outer item and report the wrong (shallower) depth.
  const nestDepth = () =>
    content.evaluate((el) => {
      const bravo = [...el.querySelectorAll('li')].find(
        (l) => l.firstChild?.nodeType === Node.TEXT_NODE && (l.firstChild.textContent ?? '').includes('Bravo')
      );
      let d = 0;
      for (let p = bravo?.parentElement ?? null; p && p !== el; p = p.parentElement) {
        if (p.tagName === 'LI') d++;
      }
      return d;
    });

  expect(await nestDepth()).toBe(1); // Bravo is a child bullet after indent

  // Ctrl+Z: host replays the ORIGINAL text. Webview must re-render to the flat list.
  await page.evaluate((text) => window.postMessage({ type: 'update', text, caretLine: 2, caretCol: 3 }, '*'), original);
  await expect.poll(nestDepth).toBe(0); // back to flat — undo restored the pre-op shape

  // Ctrl+Y: host replays the POST-op text (exactly what the op synced). Re-nests.
  await page.evaluate(
    (text) => window.postMessage({ type: 'update', text, caretLine: 1, caretCol: 1 }, '*'),
    afterIndent
  );
  await expect.poll(nestDepth).toBe(1); // redo restored the nested shape
});
