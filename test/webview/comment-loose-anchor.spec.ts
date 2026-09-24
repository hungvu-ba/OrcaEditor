/**
 * Req 24 US-23.27 — a thread seeded from a loose sidecar anchor (only a quote
 * near a line) is placed exact on the block holding the quote, and that
 * floating -> exact transition posts exactly one `commentAnchorUpdate` with
 * origin 'resolved' carrying the canonical anchor. Real resolver + CSS Custom
 * Highlight API, so this is the Playwright track (Plan/WEBVIEW_TEST.md).
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, DEFAULT_DOC_URI } from './_harness';

interface AnchorUpdate {
  type: string;
  origin?: string;
  recordedText: string;
  offsetStart: number;
  offsetEnd: number;
}

/** One literal `commentThreadsSync` thread; `looseAnchor` is what the host sends for a loose sidecar anchor. */
async function seedLooseThread(page: Page, quote: string, lastKnownLine: number, looseAnchor = true): Promise<void> {
  await page.evaluate(
    ({ docUri, quote, lastKnownLine, looseAnchor }) =>
      window.postMessage(
        {
          type: 'commentThreadsSync',
          docUri,
          threads: [
            {
              threadId: 't-loose',
              status: 'Open',
              author: 'reviewer',
              timestamp: '2026-09-24T09:00:00.000Z',
              body: 'Body.',
              recordedText: quote,
              offsetStart: 0,
              offsetEnd: 0,
              lastKnownLine,
              nearestHeading: '',
              replies: [],
              statusChanges: [],
              ...(looseAnchor ? { looseAnchor: true } : {}),
            },
          ],
        },
        '*'
      ),
    { docUri: DEFAULT_DOC_URI, quote, lastKnownLine, looseAnchor }
  );
}

function anchorUpdates(page: Page): Promise<AnchorUpdate[]> {
  return page.evaluate(() =>
    (window as unknown as { __posted: AnchorUpdate[] }).__posted.filter((m) => m.type === 'commentAnchorUpdate')
  );
}

async function persisted(page: Page): Promise<AnchorUpdate[]> {
  return (await anchorUpdates(page)).filter((m) => m.origin !== undefined);
}

/** The text of every range the passive "Show Comments" wash paints, exact and approximate alike. */
function washedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ['comment-anchor', 'comment-anchor-nonexact'].flatMap((name) => {
      const set = CSS.highlights.get(name);
      return set ? Array.from(set as unknown as Set<Range>).map((r) => r.toString()) : [];
    })
  );
}

test('(a) a raw-md quote resolves exact, washes its rendered text and persists once as resolved', async ({ page }) => {
  await openEditor(page, '# T\n\nIntro line.\n\nThe **held** queue drains via `flush()` today.\n');
  await seedLooseThread(page, 'The **held** queue drains via `flush()`', 5);
  const target = page.locator('#content p').nth(1);
  await expect(target).toHaveAttribute('data-comment-anchor-state', 'exact');
  await page.locator('#comment-highlight-toggle').click();
  await expect.poll(() => washedTexts(page)).toEqual(['The held queue drains via flush()']);
  const updates = await persisted(page);
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    origin: 'resolved',
    recordedText: 'The held queue drains via flush() today.',
    offsetStart: 0,
    offsetEnd: 33,
  });
});

test('(b) a quote in two blocks resolves to the one covering lastKnownLine', async ({ page }) => {
  await openEditor(page, '# T\n\nFirst: shared phrase here.\n\nSecond: shared phrase there.\n');
  await seedLooseThread(page, 'shared phrase', 5);
  await expect(page.locator('#content p').nth(1)).toHaveAttribute('data-comment-anchor-state', 'exact');
  await expect(page.locator('#content p').nth(0)).not.toHaveAttribute('data-comment-anchor-state', /.+/);
  const updates = await persisted(page);
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ origin: 'resolved', recordedText: 'Second: shared phrase there.' });
});

test('(c) an absent quote stays floating and persists nothing', async ({ page }) => {
  await openEditor(page, '# T\n\nNothing to see.\n');
  await seedLooseThread(page, 'not in this file', 3);
  // Let a debounced pass land too before asserting absence.
  await page.waitForTimeout(600);
  await expect(page.locator('#content p')).not.toHaveAttribute('data-comment-anchor-state', /.+/);
  expect(await persisted(page)).toEqual([]);
  // Seeded floating, so it never crosses INTO floating: no anchor-lost question.
  await expect(page.locator('.comment-anchor-lost')).toBeHidden();
});

test('(d) a non-loose seed posts no origin', async ({ page }) => {
  await openEditor(page, '# T\n\nAlpha beta gamma.\n');
  await seedLooseThread(page, 'Alpha beta gamma.', 3, false);
  await expect(page.locator('#content p')).toHaveAttribute('data-comment-anchor-state', 'exact');
  await expect.poll(async () => (await anchorUpdates(page)).length).toBeGreaterThan(0);
  expect(await persisted(page)).toEqual([]);
});
