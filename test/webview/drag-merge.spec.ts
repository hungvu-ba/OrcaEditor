/**
 * Playwright regression coverage for bug 0716 round 3: `applyBlockMove`
 * (sibling-move.ts) replaces `execCommand('insertHTML')` with
 * `Range.deleteContents()` + `Range.insertNode()` for top-level block moves,
 * because WebKit's `ReplaceSelectionCommand` smart-merge silently folded an
 * untouched trailing sibling into the moved span whenever the move's end
 * boundary landed next to it — reproduced even for the simplest case
 * (swapping two adjacent paragraphs), not just the originally-reported
 * blockquote/mermaid/math cases. None of this is reducible to a hand-built
 * DOM snapshot (test/roundtrip/) — it only reproduces via a real drag
 * (mousedown/mousemove/mouseup) against the real compiled bundle
 * (Plan/WEBVIEW_TEST.md).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { openEditor, waitForEdit } from './_harness';

/** Same selector as drag-handle.spec.ts — the plain block handle only ever carries the
 * base class, the li/row/col handles each add a second class on top of it. */
const BLOCK_HANDLE_SELECTOR = '.dd-handle:not(.dd-li-handle):not(.dd-row-handle):not(.dd-col-handle):not(.dd-table-handle)';

async function hoverCenter(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('locator has no bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/** Hover `source` to reveal its block handle, then drag that handle to a point just below
 * `target`'s bottom edge — lands the drop gap right after `target` (same technique as
 * drag-handle.spec.ts's "dragging the block handle past the threshold" test). */
async function dragBlockAfter(page: Page, source: Locator, target: Locator): Promise<void> {
  await hoverCenter(page, source);
  const handleBox = await page.locator(BLOCK_HANDLE_SELECTOR).boundingBox();
  const targetBox = await target.boundingBox();
  if (!handleBox || !targetBox) {
    throw new Error('missing bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, targetBox.y + targetBox.height + 10, { steps: 10 });
  await page.mouse.up();
}

/** Every top-level block gets a `data-block-id` from the initial render's Block Map
 * (block-map.ts) — a move must never end up with two elements sharing one. */
async function blockIds(page: Page): Promise<string[]> {
  return page
    .locator('#content > [data-block-id]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id') ?? ''));
}

function assertNoDuplicateIds(ids: string[]): void {
  expect(new Set(ids).size, `ids=${JSON.stringify(ids)}`).toBe(ids.length);
}

/** Guards against BOTH corruption symptoms the WebKit smart-merge bug produced: a
 * duplicated id (element split into two) AND a silently dropped id (element swallowed
 * into a sibling). `assertNoDuplicateIds` alone only catches the former — a merge that
 * drops one id while keeping the rest unique would slip through it undetected. */
function assertSameIdSet(before: string[], after: string[]): void {
  assertNoDuplicateIds(after);
  expect(after.length, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`).toBe(before.length);
  expect(new Set(after), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`).toEqual(new Set(before));
}

test('adjacent-paragraph swap: dragging P1 after P2 leaves 4 distinct paragraphs, none merged', async ({ page }) => {
  const doc = `Paragraph A.

Paragraph B.

Paragraph C.

Paragraph D.
`;
  await openEditor(page, doc);
  const idsBefore = await blockIds(page);

  const paraB = page.locator('p', { hasText: 'Paragraph B.' });
  const paraC = page.locator('p', { hasText: 'Paragraph C.' });
  await dragBlockAfter(page, paraB, paraC);

  const md = await waitForEdit(page);
  const lines = md.trim().split('\n').filter(Boolean);
  expect(lines).toEqual(['Paragraph A.', 'Paragraph C.', 'Paragraph B.', 'Paragraph D.']);

  assertSameIdSet(idsBefore, await blockIds(page));
});

test('blockquote dragged past 2 paragraphs lands flat, not nested, no duplicate id', async ({ page }) => {
  const doc = `> Quoted line.

Paragraph One.

Paragraph Two.
`;
  await openEditor(page, doc);
  const idsBefore = await blockIds(page);

  const quote = page.locator('blockquote');
  const paraTwo = page.locator('p', { hasText: 'Paragraph Two.' });
  await dragBlockAfter(page, quote, paraTwo);

  await waitForEdit(page);

  // Flat siblings under #content — the blockquote keeps only its OWN intrinsic <p>
  // (normal markdown structure), it must not swallow Paragraph One/Two as extra children.
  await expect(page.locator('#content > blockquote')).toHaveCount(1);
  await expect(page.locator('#content > blockquote > p')).toHaveCount(1);
  await expect(page.locator('blockquote')).toHaveText('Quoted line.');
  await expect(page.locator('#content > p')).toHaveCount(2);

  assertSameIdSet(idsBefore, await blockIds(page));
});

test('code block (pre) dragged past 2 paragraphs lands flat, content preserved, no duplicate id', async ({ page }) => {
  const doc = '```\nconsole.log("hi");\n```\n\nParagraph One.\n\nParagraph Two.\n';
  await openEditor(page, doc);
  const idsBefore = await blockIds(page);

  const pre = page.locator('pre');
  const paraTwo = page.locator('p', { hasText: 'Paragraph Two.' });
  await dragBlockAfter(page, pre, paraTwo);

  await waitForEdit(page);

  await expect(page.locator('#content > pre')).toHaveCount(1);
  await expect(page.locator('#content > p pre')).toHaveCount(0);
  await expect(page.locator('pre')).toContainText('console.log("hi");');
  await expect(page.locator('#content > p')).toHaveCount(2);

  assertSameIdSet(idsBefore, await blockIds(page));
});

test('mermaid block actually moves past a trailing paragraph', async ({ page }) => {
  const doc = 'Paragraph One.\n\n```mermaid\ngraph TD; A-->B;\n```\n\nParagraph Two.\n';
  await openEditor(page, doc);
  const idsBefore = await blockIds(page);

  const mermaid = page.locator('.md-mermaid');
  const paraTwo = page.locator('p', { hasText: 'Paragraph Two.' });
  await dragBlockAfter(page, mermaid, paraTwo);

  const md = await waitForEdit(page);
  expect(md.indexOf('Paragraph One.')).toBeGreaterThanOrEqual(0);
  expect(md.indexOf('Paragraph Two.')).toBeLessThan(md.indexOf('```mermaid'));

  await expect(page.locator('.md-mermaid')).toHaveCount(1);
  assertSameIdSet(idsBefore, await blockIds(page));
});

test('math block dragged next to a mermaid block yields exactly one .md-math-block', async ({ page }) => {
  const doc = '```mermaid\ngraph TD; A-->B;\n```\n\nParagraph.\n\n$$x^2$$\n';
  await openEditor(page, doc);
  const idsBefore = await blockIds(page);

  const math = page.locator('.md-math-block');
  const mermaid = page.locator('.md-mermaid');
  await dragBlockAfter(page, math, mermaid);

  await waitForEdit(page);

  await expect(page.locator('.md-math-block')).toHaveCount(1);
  await expect(page.locator('.md-mermaid')).toHaveCount(1);
  assertSameIdSet(idsBefore, await blockIds(page));
});

test('moving the first paragraph to the true end of the document (no following sibling) still works', async ({
  page,
}) => {
  // The one gap with no untouched sibling after the moved span — the smart-merge bug
  // never had a boundary to trigger against here, so this is the non-regression-risk
  // control case: confirms the new Range deleteContents/insertNode path didn't break it.
  const doc = `Paragraph A.

Paragraph B.

Paragraph C.
`;
  await openEditor(page, doc);
  const idsBefore = await blockIds(page);

  const paraA = page.locator('p', { hasText: 'Paragraph A.' });
  const paraC = page.locator('p', { hasText: 'Paragraph C.' });
  await dragBlockAfter(page, paraA, paraC);

  const md = await waitForEdit(page);
  const lines = md.trim().split('\n').filter(Boolean);
  expect(lines).toEqual(['Paragraph B.', 'Paragraph C.', 'Paragraph A.']);

  assertSameIdSet(idsBefore, await blockIds(page));
});

test('heading-section move still carries its trailing paragraph along', async ({ page }) => {
  const doc = `# Heading One

Intro one.

# Heading Two

Intro two.
`;
  await openEditor(page, doc);
  const idsBefore = await blockIds(page);

  const headingOne = page.locator('h1', { hasText: 'Heading One' });
  const introTwo = page.locator('p', { hasText: 'Intro two.' });
  await dragBlockAfter(page, headingOne, introTwo);

  const md = await waitForEdit(page);
  const iTwo = md.indexOf('# Heading Two');
  const iIntroTwo = md.indexOf('Intro two.');
  const iOne = md.indexOf('# Heading One');
  const iIntroOne = md.indexOf('Intro one.');
  expect(iTwo).toBeGreaterThanOrEqual(0);
  expect(iTwo).toBeLessThan(iIntroTwo);
  expect(iIntroTwo).toBeLessThan(iOne);
  expect(iOne).toBeLessThan(iIntroOne);

  assertSameIdSet(idsBefore, await blockIds(page));
});
