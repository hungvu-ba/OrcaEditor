/**
 * A host-driven `type: 'update'` re-render WITHOUT `caretLine` (an edit the host
 * writes itself — Add reference / a doc-mutating Execute command / an external
 * edit) used to rebuild the DOM and drop the caret to the top of the file. The
 * webview now snapshots the caret's source position before renderDocument and
 * restores it after, so the caret stays where the user was typing. (undo/redo
 * updates still carry `caretLine` and take precedence — unchanged.)
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

/** The block tag + text the collapsed caret currently sits in. */
async function caretBlock(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { tag: '(none)', text: '(none)', offset: -1 };
    const r = sel.getRangeAt(0);
    const el =
      r.startContainer.nodeType === Node.ELEMENT_NODE
        ? (r.startContainer as Element)
        : r.startContainer.parentElement;
    const block = el?.closest('#content p,#content h1,#content h2,#content h3,#content li');
    return { tag: block?.tagName ?? '(none)', text: block?.textContent ?? '(none)', offset: r.startOffset };
  });
}

/** Simulate the host pushing a caret-less re-render (same channel provider.ts uses). */
async function pushUpdate(page: import('@playwright/test').Page, text: string) {
  await page.evaluate((t) => window.postMessage({ type: 'update', text: t }, '*'), text);
}

test('caret-less update keeps the caret in the same paragraph (not top of file)', async ({ page }) => {
  await openEditor(page, 'First para\n\nSecond para\n\nThird para\n');
  // Caret at the end of the SECOND paragraph.
  await page.locator('#content').click();
  await page.locator('#content p').nth(1).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  // Host appends a `## References` section (Add reference) and pushes an update
  // with NO caretLine — the lines above the caret are unchanged.
  await pushUpdate(page, 'First para\n\nSecond para\n\nThird para\n\n## References\n\n- [x](y)\n');
  await page.waitForFunction(() => !!document.querySelector('#content h2'));

  const caret = await caretBlock(page);
  expect(caret.tag).toBe('P');
  expect(caret.text).toBe('Second para');
});

test('caret-less update restores column within a heading', async ({ page }) => {
  await openEditor(page, '# Title\n\nBody\n');
  // Caret after "Ti" (col 2 of rendered text) in the heading.
  await page.locator('#content h1').evaluate((el) => {
    const range = document.createRange();
    range.setStart(el.firstChild!, 2);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  await pushUpdate(page, '# Title\n\nBody\n\nAppended\n');
  await page.waitForFunction(() => document.querySelectorAll('#content p').length >= 2);

  const caret = await caretBlock(page);
  expect(caret.tag).toBe('H1');
  expect(caret.text).toBe('Title');
  expect(caret.offset).toBe(2);
});

test('update carrying caretLine still wins (undo/redo path unchanged)', async ({ page }) => {
  await openEditor(page, 'Alpha\n\nBravo\n\nCharlie\n');
  // Caret in the first paragraph.
  await page.locator('#content p').first().evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  // caretLine 5 (1-based) = "Charlie" — an undo/redo-style update must place the
  // caret there, not preserve the first paragraph.
  await page.evaluate(() =>
    window.postMessage(
      { type: 'update', text: 'Alpha\n\nBravo\n\nCharlie edited\n', caretLine: 5, caretCol: 0 },
      '*'
    )
  );
  await page.waitForFunction(() => !!document.querySelector('#content p:last-of-type'));

  const caret = await caretBlock(page);
  expect(caret.text).toBe('Charlie edited');
});
