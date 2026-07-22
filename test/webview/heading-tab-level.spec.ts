/**
 * Bug_General #9 — Tab / Shift+Tab change heading level for the whole section.
 *
 * With the caret inside a heading, Tab DEMOTES it (level +1) and Shift+Tab
 * PROMOTES it (level -1), applying the same delta to every DESCENDANT heading
 * in that heading's section (up to, not including, the next same-or-higher
 * heading). Demoting past H6 turns the heading into a normal paragraph;
 * promoting an H1 is a no-op. Non-heading content and the list/table-cell Tab
 * behavior are untouched. See media/webview/main.ts (Tab keydown handler) and
 * drag-drop.ts (computeHeadingSectionSpan / headingLevel).
 *
 * Interactive keyboard + Selection API → real Chromium via the webview harness
 * (test/roundtrip/ domino can't dispatch key events).
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

/** Collapse the caret inside the first block (heading/paragraph/li) whose trimmed text equals `text`. */
async function placeCaretIn(page: Page, text: string, collapseToEnd = false): Promise<void> {
  await page.locator('#content').evaluate(
    (content, args) => {
      const target = Array.from(content.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li')).find(
        (b) => (b.textContent ?? '').trim() === args.text
      ) as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(!args.collapseToEnd);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { text, collapseToEnd }
  );
}

/** Tag names of #content's top-level blocks, in order. */
async function topLevelTags(page: Page): Promise<string[]> {
  return page.locator('#content').evaluate((content) => Array.from(content.children).map((c) => c.tagName));
}

/** The block (heading/paragraph) currently holding the caret — tag + text — or null. */
async function caretBlock(page: Page): Promise<{ tag: string; text: string } | null> {
  return page.locator('#content').evaluate((content) => {
    const node = window.getSelection()?.anchorNode ?? null;
    const el = node ? (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)) : null;
    const block = el && content.contains(el) ? el.closest('h1,h2,h3,h4,h5,h6,p') : null;
    return block ? { tag: block.tagName, text: (block.textContent ?? '').trim() } : null;
  });
}

test('Tab demotes a heading and every descendant heading in its section', async ({ page }) => {
  await openEditor(page, '## A\n\n### B\n\n# C');
  await placeCaretIn(page, 'A');
  await clearPosted(page);
  await page.keyboard.press('Tab');
  const md = await waitForEdit(page);

  // A (h2→h3) and its child B (h3→h4) shift; C (h1, same/higher → section end) is untouched.
  expect(await topLevelTags(page)).toEqual(['H3', 'H4', 'H1']);
  expect(md).toMatch(/^### A$/m);
  expect(md).toMatch(/^#### B$/m);
  expect(md).toMatch(/^# C$/m);
  // Caret stays in the (re-tagged) target heading.
  expect(await caretBlock(page)).toEqual({ tag: 'H3', text: 'A' });
});

test('Tab on an H6 turns it into a normal paragraph', async ({ page }) => {
  await openEditor(page, '###### A');
  await placeCaretIn(page, 'A');
  await clearPosted(page);
  await page.keyboard.press('Tab');
  const md = await waitForEdit(page);

  const aTag = await page
    .locator('#content')
    .evaluate((content) => Array.from(content.children).find((c) => (c.textContent ?? '').trim() === 'A')?.tagName);
  expect(aTag).toBe('P');
  expect(md).not.toContain('#');
  expect(md).toContain('A');
  expect(await caretBlock(page)).toEqual({ tag: 'P', text: 'A' });
});

test('Demoting an H5 whose child is H6 drops that child H6 to a paragraph', async ({ page }) => {
  await openEditor(page, '##### A\n\n###### B');
  await placeCaretIn(page, 'A');
  await clearPosted(page);
  await page.keyboard.press('Tab');
  const md = await waitForEdit(page);

  // A: h5→h6; child B: h6→ (would be h7) → paragraph.
  expect(await topLevelTags(page)).toEqual(['H6', 'P']);
  expect(md).toMatch(/^###### A$/m);
  expect(md).not.toMatch(/^###### B$/m);
  expect(md).toMatch(/^B$/m);
});

test('Shift+Tab promotes a heading and its descendant headings', async ({ page }) => {
  await openEditor(page, '## A\n\n### B');
  await placeCaretIn(page, 'A');
  await clearPosted(page);
  await page.keyboard.press('Shift+Tab');
  const md = await waitForEdit(page);

  expect(await topLevelTags(page)).toEqual(['H1', 'H2']);
  expect(md).toMatch(/^# A$/m);
  expect(md).toMatch(/^## B$/m);
  expect(await caretBlock(page)).toEqual({ tag: 'H1', text: 'A' });
});

test('Shift+Tab on an H1 is a no-op', async ({ page }) => {
  await openEditor(page, '# A\n\n## B');
  await placeCaretIn(page, 'A');
  await page.keyboard.press('Shift+Tab');

  // The handler returns synchronously without re-tagging or scheduling an edit.
  expect(await topLevelTags(page)).toEqual(['H1', 'H2']);
  expect(await caretBlock(page)).toEqual({ tag: 'H1', text: 'A' });
});

test('Tab in a plain paragraph does not create a heading', async ({ page }) => {
  await openEditor(page, 'plain text');
  await placeCaretIn(page, 'plain text');
  await page.keyboard.press('Tab');

  const hasHeading = await page
    .locator('#content')
    .evaluate((content) => !!content.querySelector('h1,h2,h3,h4,h5,h6'));
  expect(hasHeading).toBe(false);
});

test('Tab inside a list item still indents (heading branch does not steal list Tab)', async ({ page }) => {
  await openEditor(page, '- a\n- b');
  await placeCaretIn(page, 'b');
  await clearPosted(page);
  await page.keyboard.press('Tab');
  const md = await waitForEdit(page);

  // "b" nests under "a" — existing list-indent behavior, unaffected by #9.
  // (turndown preserves the source bullet style, e.g. `-   a`, so match loosely.)
  expect(md).toMatch(/^-\s+a$/m);
  expect(md).toMatch(/^\s{2,}-\s+b$/m);
  expect(await page.locator('#content').evaluate((content) => !!content.querySelector('li li'))).toBe(true);
});

test('Tab inside a table cell still navigates cells (heading branch does not interfere)', async ({ page }) => {
  await openEditor(page, '| a | b |\n| - | - |\n| c | d |');
  // Caret in the first header cell "a".
  await page.locator('#content').evaluate((content) => {
    const cell = Array.from(content.querySelectorAll('th,td')).find((c) => (c.textContent ?? '').trim() === 'a')!;
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.press('Tab');

  // Caret moved to the next cell "b" (existing cell-nav), and no heading was created.
  const cellText = await page.locator('#content').evaluate((content) => {
    const node = window.getSelection()?.anchorNode ?? null;
    const el = node ? (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)) : null;
    return el && content.contains(el) ? (el.closest('th,td')?.textContent ?? '').trim() : null;
  });
  expect(cellText).toBe('b');
  expect(await page.locator('#content').evaluate((c) => !!c.querySelector('h1,h2,h3,h4,h5,h6'))).toBe(false);
});

test('Tab in a blockquoted heading does not corrupt unrelated top-level headings', async ({ page }) => {
  // A blockquoted heading is NOT a direct child of #content, so the branch must be
  // skipped — otherwise computeHeadingSectionSpan (given content.children that do
  // not contain it) scans from doc start and re-tags the unrelated top-level
  // heading (edge-case-hunter blocker). The top-level heading is a DEEPER level
  // (H2) than the blockquoted H1 so the buggy span would actually reach and demote
  // it — a same-level top heading would stop the span early and hide the bug.
  await openEditor(page, '## Real\n\n> # Quoted');
  await placeCaretIn(page, 'Quoted');
  await page.keyboard.press('Tab');

  const state = await page.locator('#content').evaluate((content) => ({
    top: (content.children[0] as HTMLElement).tagName,
    quoted:
      content.querySelector('blockquote h1,blockquote h2,blockquote h3,blockquote h4,blockquote h5,blockquote h6')
        ?.tagName ?? null,
  }));
  expect(state.top).toBe('H2'); // unrelated top-level heading untouched (not demoted to H3)
  expect(state.quoted).toBe('H1'); // the blockquoted heading itself unchanged
});
