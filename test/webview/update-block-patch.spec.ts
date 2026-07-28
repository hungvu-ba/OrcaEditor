/**
 * Performance Audit P-9: a host 'update' splices only the changed top-level
 * blocks into #content instead of rebuilding everything via innerHTML. These
 * tests pin the observable contract: untouched blocks keep their live node
 * IDENTITY (checked through a JS property — a property survives only on the
 * same node and, unlike an attribute, does not poison the block's render key),
 * kept blocks adopt the new render's data-line values, a document-global
 * change (a `[ref]:` definition) still re-renders the paragraph that uses it,
 * and serialization after a patched update stays byte-exact.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

type Page = import('@playwright/test').Page;

/** Simulate the host pushing a re-render (same channel provider.ts uses). */
async function pushUpdate(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => window.postMessage({ type: 'update', text: t }, '*'), text);
}

/** Stamp an identity marker (JS property, not attribute) on every #content child. */
async function markBlocks(page: Page): Promise<void> {
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('#content > *')).forEach((el, i) => {
      (el as HTMLElement & { __p9?: number }).__p9 = i;
    });
  });
}

/** [text, data-line, marker] for every top-level element that has a data-line. */
async function readBlocks(page: Page): Promise<Array<[string, string | null, number | null]>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#content > [data-line]')).map(
      (el) =>
        [el.textContent ?? '', el.getAttribute('data-line'), (el as HTMLElement & { __p9?: number }).__p9 ?? null] as [
          string,
          string | null,
          number | null,
        ]
    )
  );
}

test('editing one block keeps every other block\'s live node identity', async ({ page }) => {
  await openEditor(page, 'Alpha\n\nBravo\n\nCharlie\n\nDelta\n');
  await markBlocks(page);
  const blockIds = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('#content > [data-line]')).map((el) => el.getAttribute('data-block-id'))
    );
  const idsBefore = await blockIds();

  await pushUpdate(page, 'Alpha\n\nBravo EDITED\n\nCharlie\n\nDelta\n');
  await expect(page.locator('#content p').nth(1)).toHaveText('Bravo EDITED');

  const blocks = await readBlocks(page);
  expect(blocks).toEqual([
    ['Alpha', '1', 0], // kept — same node the marker was stamped on
    ['Bravo EDITED', '3', null], // the one replaced block: fresh node, no marker
    ['Charlie', '5', 2],
    ['Delta', '7', 3],
  ]);
  // AC1: kept blocks keep their data-block-id too.
  const idsAfter = await blockIds();
  expect([idsAfter[0], idsAfter[2], idsAfter[3]]).toEqual([idsBefore[0], idsBefore[2], idsBefore[3]]);
});

test('kept nested list items adopt shifted data-line values end-to-end (AC2)', async ({ page }) => {
  await openEditor(page, 'One\n\n- alpha\n- beta\n\nThree\n');
  await markBlocks(page);

  await pushUpdate(page, 'Zero\n\nOne\n\n- alpha\n- beta\n\nThree\n');
  await expect(page.locator('#content p').first()).toHaveText('Zero');

  const list = await page.evaluate(() => {
    const ul = document.querySelector('#content > ul') as HTMLElement & { __p9?: number };
    return {
      mark: ul.__p9 ?? null,
      line: ul.getAttribute('data-line'),
      liLines: Array.from(ul.querySelectorAll('li')).map((li) => li.getAttribute('data-line')),
    };
  });
  // The list moved from source line 3 to 5 while keeping its node (marker 1).
  expect(list).toEqual({ mark: 1, line: '5', liLines: ['5', '6'] });
});

test('an unrelated edit keeps a fitted table node untouched (AC4)', async ({ page }) => {
  await openEditor(page, 'Intro\n\n| a | b |\n| --- | --- |\n| one | two |\n');
  await markBlocks(page);

  await pushUpdate(page, 'Intro EDITED\n\n| a | b |\n| --- | --- |\n| one | two |\n');
  await expect(page.locator('#content p').first()).toHaveText('Intro EDITED');

  // The table was not among the inserted nodes, so it kept its live node
  // (and with it, its fitted column state — fitTableColumns only runs over
  // inserted nodes on a patched update).
  const mark = await page.evaluate(
    () => (document.querySelector('#content > table') as HTMLElement & { __p9?: number }).__p9 ?? null
  );
  expect(mark).toBe(1);
});

test('a poisoned raw-HTML block is swept when an update deletes it', async ({ page }) => {
  // A top-level html_block (raw <div>) carries no data-line. Once locally
  // mutated, its render key is poisoned — it must STAY in the patch diff so an
  // update that deletes it from the source removes it from the DOM (iter-1
  // review: a dropped key let the dead block survive and serialize back).
  await openEditor(page, 'Para one\n\n<div class="note">boxed</div>\n\nPara two\n');
  await expect(page.locator('#content > div.note')).toHaveCount(1);
  await page.locator('#content > div.note').evaluate((el) => el.setAttribute('data-poison', '1'));

  await pushUpdate(page, 'Para one\n\nPara two\n');
  await expect(page.locator('#content > div.note')).toHaveCount(0);
  await expect(page.locator('#content p[data-line]')).toHaveText(['Para one', 'Para two']);
});

test('an insertion keeps the following blocks and shifts their data-line', async ({ page }) => {
  await openEditor(page, 'One\n\nTwo\n\nThree\n');
  await markBlocks(page);

  await pushUpdate(page, 'Zero\n\nOne\n\nTwo\n\nThree\n');
  await expect(page.locator('#content p').first()).toHaveText('Zero');

  const blocks = await readBlocks(page);
  // Kept blocks moved from lines 1/3/5 to 3/5/7 — exactly what a full rebuild
  // would stamp — while keeping their original nodes (markers 0/1/2).
  expect(blocks).toEqual([
    ['Zero', '1', null],
    ['One', '3', 0],
    ['Two', '5', 1],
    ['Three', '7', 2],
  ]);
});

test('a pure blank-line shift keeps every node and still moves data-line', async ({ page }) => {
  await openEditor(page, 'A\n\nB\n');
  await markBlocks(page);

  await pushUpdate(page, 'A\n\n\nB\n');
  await expect(page.locator('#content p[data-line="4"]')).toHaveText('B');

  const blocks = await readBlocks(page);
  expect(blocks).toEqual([
    ['A', '1', 0],
    ['B', '4', 1], // same node, new source line
  ]);
});

test('a [ref]: definition edit re-renders the paragraph that uses it', async ({ page }) => {
  // The definition renders to nothing, but changing it changes the FIRST
  // paragraph's <a href> — a source-slice diff would miss that; the rendered
  // key must not.
  await openEditor(page, 'See [docs][r].\n\nMiddle\n\n[r]: https://a.example/\n');
  await markBlocks(page);

  await pushUpdate(page, 'See [docs][r].\n\nMiddle\n\n[r]: https://b.example/\n');
  await expect(page.locator('#content a').first()).toHaveAttribute('href', 'https://b.example/');

  // The unrelated middle paragraph was kept.
  const blocks = await readBlocks(page);
  expect(blocks[1]).toEqual(['Middle', '3', 1]);
});

test('typing after a patched update serializes the pushed text plus the edit', async ({ page }) => {
  await openEditor(page, 'First\n\nSecond\n');

  await pushUpdate(page, 'First\n\nSecond\n\nThird\n');
  await expect(page.locator('#content p').nth(2)).toHaveText('Third');

  // Caret at the end of the (kept) first paragraph, then type.
  await page.locator('#content p').first().evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    (el.closest('#content') as HTMLElement).focus();
  });
  await clearPosted(page);
  await page.keyboard.type(' plus');

  expect(await waitForEdit(page)).toBe('First plus\n\nSecond\n\nThird\n');
});
