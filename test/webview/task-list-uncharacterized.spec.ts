/**
 * Bug 0717 round3 #11 (Group TaskListFallback): clicking Task List over a
 * selection that spans a content-bearing block outside the P/UL/OL set
 * (a <table>/<pre>/<blockquote>/heading) used to fall back to the native
 * document.execCommand('insertUnorderedList'), which live-corrupted the DOM —
 * it silently extended an UNRELATED pre-existing <ul> and demoted an
 * intervening heading, entangling a later Ctrl+Z with earlier edits.
 *
 * The fix routes that case through computeToListAroundAtoms + commitListOpDirect
 * instead: convertible blocks (incl. headings) become <li>s while each atom
 * block is kept verbatim so the list splits AROUND it, and a selection with no
 * convertible block (e.g. inside a table cell) is a safe no-op — never native
 * execCommand. These behaviours need real click/Selection/execCommand geometry,
 * so they live here (Playwright) not in a hand-built DOM snapshot.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

/** Select from the start of the block whose text includes `startText` through the
 *  end of the block whose text includes `endText` — spanning everything between. */
function selectAcross(el: HTMLElement, [startText, endText]: string[]): void {
  const blocks = [...el.children] as HTMLElement[];
  const startBlock = blocks.find((b) => (b.textContent ?? '').includes(startText))!;
  const endBlock = blocks.find((b) => (b.textContent ?? '').includes(endText))!;
  const r = document.createRange();
  r.setStart(startBlock, 0);
  r.setEnd(endBlock, endBlock.childNodes.length);
  const s = window.getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
}

async function lastEdit(page: import('@playwright/test').Page): Promise<string> {
  const handle = await page.waitForFunction(
    () => (window as unknown as { __posted: Array<{ type: string; text: string }> }).__posted
      .filter((m) => m.type === 'edit')
      .at(-1),
    undefined,
    { timeout: 2000 }
  );
  return ((await handle.jsonValue()) as { text: string }).text;
}

test('Task List over a Before/table/After span splits around the table and never merges an unrelated earlier list', async ({
  page,
}) => {
  await openEditor(
    page,
    '- [ ] Alpha\n- [ ] Bravo\n\n### Section\n\nBefore\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter\n'
  );
  const content = page.locator('#content');
  await clearPosted(page);
  await content.evaluate(selectAcross, ['Before', 'After']);
  await page.locator('#fmt-task').click();

  const facts = await content.evaluate((el) => {
    const lists = [...el.querySelectorAll(':scope > ul')];
    const earlier = lists.find((ul) => (ul.textContent ?? '').includes('Alpha'))!;
    const beforeList = lists.find((ul) => (ul.textContent ?? '').includes('Before'))!;
    const afterList = lists.find((ul) => (ul.textContent ?? '').includes('After'))!;
    return {
      topLevelUlCount: lists.length,
      earlierItems: [...earlier.querySelectorAll(':scope > li')].map((li) => (li.textContent ?? '').trim()),
      earlierHasBefore: (earlier.textContent ?? '').includes('Before'),
      tableStillTopLevel: !!el.querySelector(':scope > table'),
      tableSwallowed: !!el.querySelector('li table'),
      headingStillH3: !!el.querySelector(':scope > h3'),
      beforeIsTask: !!beforeList?.querySelector('li input[type="checkbox"]'),
      afterIsTask: !!afterList?.querySelector('li input[type="checkbox"]'),
    };
  });

  // The earlier task list must be a SEPARATE node, untouched (the core #11 bug).
  expect(facts.earlierItems).toEqual(['Alpha', 'Bravo']);
  expect(facts.earlierHasBefore).toBe(false);
  // The list splits around the table; the table is neither swallowed nor moved.
  expect(facts.tableStillTopLevel).toBe(true);
  expect(facts.tableSwallowed).toBe(false);
  // Before/After became their own task lists.
  expect(facts.beforeIsTask).toBe(true);
  expect(facts.afterIsTask).toBe(true);
  // three top-level <ul>s: earlier, Before, After.
  expect(facts.topLevelUlCount).toBe(3);
  // The heading between the earlier list and the selection was NOT selected, so
  // it must survive untouched (native execCommand used to demote it).
  expect(facts.headingStillH3).toBe(true);

  const md = await lastEdit(page);
  expect(md).toContain('### Section');
  expect(md).toContain('| a | b |');
  expect(md).toContain('[ ] Before');
  expect(md).toContain('[ ] After');
});

test('Task List converts a heading INSIDE the selection into a list item (never demoted/absorbed)', async ({
  page,
}) => {
  await openEditor(page, 'Before\n\n### Middle\n\nAfter\n');
  const content = page.locator('#content');
  await clearPosted(page);
  await content.evaluate(selectAcross, ['Before', 'After']);
  await page.locator('#fmt-task').click();

  const facts = await content.evaluate((el) => ({
    items: [...el.querySelectorAll('ul > li')].map((li) => (li.textContent ?? '').trim()),
    anyHeadingLeft: !!el.querySelector('h1, h2, h3, h4, h5, h6'),
    allTasks: [...el.querySelectorAll('ul > li')].every((li) => !!li.querySelector('input[type="checkbox"]')),
  }));
  expect(facts.items).toEqual(['Before', 'Middle', 'After']);
  expect(facts.anyHeadingLeft).toBe(false);
  expect(facts.allTasks).toBe(true);

  const md = await lastEdit(page);
  expect(md).toContain('[ ] Middle');
  expect(md).not.toContain('### Middle');
});

test('Task List after Select-All (selection boundary on the #content root) builds a list, not a no-op', async ({
  page,
}) => {
  await openEditor(page, 'One\n\nTwo\n\nThree\n');
  const content = page.locator('#content');
  await clearPosted(page);
  await content.evaluate((el) => {
    // selectNodeContents(#content) is the Ctrl+A shape: the boundaries land ON
    // #content itself, which used to resolve to null → silent no-op.
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.locator('#fmt-task').click();
  const facts = await content.evaluate((el) => ({
    items: [...el.querySelectorAll('ul > li')].map((li) => (li.textContent ?? '').trim()),
    allTasks: [...el.querySelectorAll('ul > li')].every((li) => !!li.querySelector('input[type="checkbox"]')),
  }));
  expect(facts.items).toEqual(['One', 'Two', 'Three']);
  expect(facts.allTasks).toBe(true);
});

test('Task List with the caret inside a table cell is a safe no-op (no list, table untouched)', async ({
  page,
}) => {
  await openEditor(page, '| a | b |\n| - | - |\n| 1 | 2 |\n');
  const content = page.locator('#content');
  const before = await content.evaluate((el) => el.querySelector('table')!.outerHTML);
  await content.evaluate((el) => {
    const cell = el.querySelector('td')!;
    const r = document.createRange();
    r.selectNodeContents(cell);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.locator('#fmt-task').click();

  const facts = await content.evaluate((el, prev) => ({
    hasList: !!el.querySelector('ul, ol'),
    tableUnchanged: el.querySelector('table')!.outerHTML === prev,
  }), before);
  expect(facts.hasList).toBe(false);
  expect(facts.tableUnchanged).toBe(true);
});
