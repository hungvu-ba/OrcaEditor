/**
 * Performance Audit P-7 — per-block serialization in the REAL browser.
 *
 * `test/roundtrip/incremental-serialize.ts` already proves the join is
 * byte-identical to the whole-document pass. What it cannot cover is the half that
 * only exists in a live webview: a MutationObserver decides which block is dirty,
 * and its records arrive as a microtask — after `syncNow()` has already run when the
 * sync comes from `execCommand` in the same task. A block wrongly considered clean
 * silently ships stale markdown to the host, so every case here edits ONE block of a
 * multi-block document and asserts the posted `.md` is exactly right — the untouched
 * blocks included.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

const DOC = [
  '# Title',
  '',
  'First paragraph.',
  '',
  // Two spaces after the box: the serializer's canonical task-item form, so this
  // document is a fixed point and any diff below is caused by the edit under test.
  '-   [ ]  todo item',
  '-   plain item',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  'Last paragraph.',
  '',
].join('\n');

/** Wait until the LAST posted edit is exactly `expected`. */
async function waitForExactEdit(page: Page, expected: string): Promise<void> {
  await page.waitForFunction(
    (text) => {
      const posted = (window as unknown as { __posted: Array<{ type: string; text: string }> }).__posted;
      return posted.filter((m) => m.type === 'edit').at(-1)?.text === text;
    },
    expected,
    { timeout: 4000 }
  );
}

/** The markdown of the last posted 'edit', for a diffable assertion. */
async function lastEdit(page: Page): Promise<string> {
  return page.evaluate(() => {
    const posted = (window as unknown as { __posted: Array<{ type: string; text: string }> }).__posted;
    return posted.filter((m) => m.type === 'edit').at(-1)?.text ?? '(no edit posted)';
  });
}

/**
 * Assert the FINAL posted markdown. `scheduleSync` debounces, so typing posts
 * several intermediate edits — waiting for one that merely CONTAINS a needle would
 * assert an intermediate string and could pass while the last keystroke shipped a
 * stale block, which is exactly the failure this file exists to catch. Poll for the
 * exact text, then re-assert so a failure shows the diff instead of a bare timeout.
 */
async function expectFinalEdit(page: Page, expected: string): Promise<void> {
  await waitForExactEdit(page, expected).catch(() => undefined);
  expect(await lastEdit(page)).toBe(expected);
}

/**
 * Fill the per-block markdown cache before the case under test. Without this every
 * block is a cache MISS (a fresh render replaces the whole DOM), so the incremental
 * path would serialize everything and no staleness could ever show up — the tests
 * would pass against a broken dirty-tracker. One edit, then its undo, leaves the
 * document at `DOC` again with every block cached.
 */
async function warmCache(page: Page): Promise<void> {
  await caretAtEndOf(page, '#content > h1');
  await page.keyboard.type('Z');
  await waitForExactEdit(page, DOC.replace('# Title', '# TitleZ'));
  await page.keyboard.press('Backspace');
  await waitForExactEdit(page, DOC);
}

/** Put the caret at the end of the element matched by `selector`. */
async function caretAtEndOf(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel2 = window.getSelection();
    sel2?.removeAllRanges();
    sel2?.addRange(range);
    el.focus();
  }, selector);
}

test('typing in one paragraph leaves every other block byte-identical', async ({ page }) => {
  await openEditor(page, DOC);
  await warmCache(page);
  await clearPosted(page);
  await caretAtEndOf(page, '#content > p:first-of-type');
  await page.keyboard.type(' edited ');
  await expectFinalEdit(page, DOC.replace('First paragraph.', 'First paragraph. edited'));
});

test('typing in a table cell keeps the surrounding blocks intact', async ({ page }) => {
  await openEditor(page, DOC);
  await warmCache(page);
  await clearPosted(page);
  await caretAtEndOf(page, '#content table tbody td:first-child');
  await page.keyboard.type('9 ');
  await expectFinalEdit(page, DOC.replace('| 1 | 2 |', '| 19 | 2 |'));
});

test('a task checkbox click reaches the .md (attribute-only mutation)', async ({ page }) => {
  await openEditor(page, DOC);
  await warmCache(page);
  await clearPosted(page);
  await page.locator('#content input[type="checkbox"]').first().click();
  await expectFinalEdit(page, DOC.replace('-   [ ]  todo item', '-   [x]  todo item'));
});

test('Enter splits a paragraph into two blocks, both serialized', async ({ page }) => {
  await openEditor(page, DOC);
  await warmCache(page);
  await clearPosted(page);
  await caretAtEndOf(page, '#content > p:first-of-type');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second paragraph.');
  await expectFinalEdit(page, DOC.replace('First paragraph.', 'First paragraph.\n\nSecond paragraph.'));
});

test('deleting a whole block drops it from the .md', async ({ page }) => {
  await openEditor(page, DOC);
  await warmCache(page);
  await clearPosted(page);
  await page.evaluate(() => {
    const table = document.querySelector('#content table') as HTMLElement;
    table.remove();
    document.querySelector('#content')?.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await expectFinalEdit(page, DOC.replace('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n', ''));
});

test('a toolbar action syncing in the same task as its execCommand is not lost', async ({ page }) => {
  await openEditor(page, DOC);
  await warmCache(page);
  await clearPosted(page);
  // Bold the last paragraph: invokeAction runs execCommand and syncNow() in ONE
  // task, before the MutationObserver callback's microtask — serialize() must drain
  // the pending records itself or the block still looks clean.
  await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('#content > p')).at(-1) as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    p.focus();
  });
  await page.locator('#fmt-bold').click();
  await expectFinalEdit(page, DOC.replace('Last paragraph.', '**Last paragraph.**'));
});

test('typing after a host update re-render does not serve cached blocks of the old document', async ({ page }) => {
  await openEditor(page, DOC);
  await warmCache(page); // caches every block of DOC…
  const REPLACED = '# Other\n\nAlpha.\n\nBravo.\n';
  await page.evaluate((text) => window.postMessage({ type: 'update', text }, '*'), REPLACED);
  await page.waitForFunction(() => document.querySelector('#content > h1')?.textContent === 'Other');
  await clearPosted(page);
  // …every one of which is now detached. Editing one block must not resurrect them.
  await caretAtEndOf(page, '#content > p:first-of-type');
  await page.keyboard.type(' edited ');
  await expectFinalEdit(page, REPLACED.replace('Alpha.', 'Alpha. edited'));
});

test('a document with a top-level indented code block keeps it indented (full pass)', async ({ page }) => {
  // turndown re-fences an indented block that follows a list, reading a sibling the
  // per-block wrapper cannot show it — so the whole document must take the full pass.
  const INDENTED = 'Intro.\n\n    indented code\n\nOutro.\n';
  await openEditor(page, INDENTED);
  await clearPosted(page);
  await caretAtEndOf(page, '#content > p:first-of-type');
  await page.keyboard.type(' more ');
  await expectFinalEdit(page, INDENTED.replace('Intro.', 'Intro. more'));
});
