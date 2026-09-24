/**
 * Req 24 US-23.26 — a thread whose stored offsets clamp to an empty range in
 * the block it resolved to (e.g. AI-written whole-file offsets) re-finds its
 * quote in that block by text search, so Show Comments still washes it. A
 * stored caret stays a caret. Real resolver + CSS Custom Highlight API, so this
 * is the Playwright track (Plan/WEBVIEW_TEST.md).
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, seedCommentThreads } from './_harness';

/** The text of every range the passive "Show Comments" wash paints, exact and approximate alike. */
function washedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ['comment-anchor', 'comment-anchor-nonexact'].flatMap((name) => {
      const set = CSS.highlights.get(name);
      return set ? Array.from(set as unknown as Set<Range>).map((r) => r.toString()) : [];
    })
  );
}

async function seedOne(page: Page, recordedText: string, offsetStart: number, offsetEnd: number): Promise<void> {
  await seedCommentThreads(page, [{ threadId: 't-relocate', recordedText, offsetStart, offsetEnd, lastKnownLine: 3 }]);
  await expect(page.locator('#content p')).toHaveAttribute('data-comment-anchor-state', /exact|approximate/);
  await page.locator('#comment-highlight-toggle').click();
}

test('(a) Req 25 shape: raw-md recorded text + whole-file offsets washes the whole paragraph', async ({ page }) => {
  const raw =
    '**Open Questions:** None left here — raised as a review comment, see `Requirement - 25 Undo Redo Boundary Control.md.orca-comments.jsonl`.';
  const rendered =
    'Open Questions: None left here — raised as a review comment, see Requirement - 25 Undo Redo Boundary Control.md.orca-comments.jsonl.';
  await openEditor(page, '# Undo Redo\n\n' + raw + '\n');
  await seedOne(page, raw, 7647, 7785);
  await expect(page.locator('#content p')).toHaveAttribute('data-comment-anchor-state', 'exact');
  await expect.poll(() => washedTexts(page)).toEqual([rendered]);
});

test('(b) offsets past the new block re-find their quote inside it', async ({ page }) => {
  await openEditor(page, '# T\n\ndelta.\n');
  await seedOne(page, 'Alpha beta gamma delta.', 17, 22);
  await expect.poll(() => washedTexts(page)).toEqual(['delta']);
});

test('(c) a quote absent from the block washes the whole block', async ({ page }) => {
  await openEditor(page, '# T\n\nZeta.\n');
  await seedOne(page, 'Alpha beta gamma delta.', 6, 10);
  await expect.poll(() => washedTexts(page)).toEqual(['Zeta.']);
});

test('(d) a stored caret stays a caret — nothing washed', async ({ page }) => {
  await openEditor(page, '# T\n\nNu.\n');
  await seedOne(page, 'Alpha beta gamma delta.', 5, 5);
  // Let the toggle's rebuild land before asserting absence.
  await expect(page.locator('#comment-highlight-toggle')).toHaveAttribute('aria-pressed', 'true');
  expect(await washedTexts(page)).toEqual([]);
});
