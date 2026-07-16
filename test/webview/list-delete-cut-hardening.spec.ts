/**
 * P0.5 (HLR 22, execCommand List/Block Verb Replacement — Code Plan Phase 0):
 * characterizes that Backspace/Cmd+X across a list-item/nested-sublist boundary
 * still needs — and still gets — the hardening layer's live-DOM self-heal
 * (`fixOrphanNestedListItems`, main.ts) after the 14 execCommand verb sites are
 * replaced. These are native browser operations, NOT among the 14 sites being
 * replaced (see the code plan's constraint #2), so this must stay GREEN
 * unconditionally throughout the whole refactor — it is the guard proving Rule
 * C / `findOrphanNestedListPair` / `fixOrphanNestedListItems` cannot be removed
 * in Phase 3.
 */
import { test, expect } from '@playwright/test';
import { openEditor, waitForEdit } from './_harness';

/** Place a collapsed caret at offset 0 of the <li> whose OWN text (its direct
 * text/<p> child, not a nested sub-list's descendant text) is `itemText`.
 * `li.textContent` is recursive, so for a nested item like "Alpha" containing a
 * sub-list with "Bravo", Alpha's own li.textContent would ALSO include "Bravo"
 * — a naive `.includes()` match over all `<li>` would pick the wrong (ancestor)
 * one. Must be passed as an evaluate arg (Playwright serializes the fn; no
 * closures cross). */
function placeCaretAtStartOfOwnLi(el: HTMLElement, itemText: string): void {
  const ownText = (li: Element) =>
    Array.from(li.childNodes).find((n) => n.nodeType === 3 || n.nodeName === 'P')?.textContent ?? '';
  const li = [...el.querySelectorAll('li')].find((l) => ownText(l).includes(itemText))!;
  const textNode = (Array.from(li.childNodes).find((n) => n.nodeType === 3 || n.nodeName === 'P') ?? li.firstChild!) as Node;
  const target = textNode.nodeName === 'P' ? textNode.firstChild! : textNode;
  const r = document.createRange();
  r.setStart(target, 0);
  r.collapse(true);
  const s = window.getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
}

/** Same lookup as above, but selects the WHOLE own-text range of the <li> (for Cut). */
function selectOwnLiContents(el: HTMLElement, itemText: string): void {
  const ownText = (li: Element) =>
    Array.from(li.childNodes).find((n) => n.nodeType === 3 || n.nodeName === 'P')?.textContent ?? '';
  const li = [...el.querySelectorAll('li')].find((l) => ownText(l).includes(itemText))!;
  const r = document.createRange();
  r.selectNodeContents(li);
  const s = window.getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
}

test('Backspace at the start of a nested list item, merging it into its parent, self-heals to a valid li>ul shape and serializes correctly', async ({
  page,
}) => {
  await openEditor(page, '- Alpha\n  - Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretAtStartOfOwnLi, 'Bravo');
  await content.press('Backspace');
  const facts = await content.evaluate((el) => ({
    liInLi: !!el.querySelector('li > li'),
    ulInUl: !!el.querySelector('ul > ul'),
  }));
  expect(facts.liInLi).toBe(false);
  expect(facts.ulInUl).toBe(false);
  const md = await waitForEdit(page);
  expect(md).toMatch(/AlphaBravo|Alpha Bravo/);
});

test('Cut (Cmd/Ctrl+X) removing a nested list item leaves the remaining structure self-healed, no li>li/ul>ul artifact', async ({
  page,
}) => {
  await openEditor(page, '- Alpha\n  - Bravo\n- Charlie');
  const content = page.locator('#content');
  await content.evaluate(selectOwnLiContents, 'Bravo');
  await page.evaluate(() => document.execCommand('delete'));
  const facts = await content.evaluate((el) => ({
    liInLi: !!el.querySelector('li > li'),
    ulInUl: !!el.querySelector('ul > ul'),
  }));
  expect(facts.liInLi).toBe(false);
  expect(facts.ulInUl).toBe(false);
  const md = await waitForEdit(page);
  expect(md).toMatch(/^-\s+Alpha/m);
  expect(md).toMatch(/^-\s+Charlie/m);
});
