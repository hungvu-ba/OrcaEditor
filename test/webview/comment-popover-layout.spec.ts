/**
 * Req 24 US-23.24 — Keep a thread's comments visible under a long anchor: the
 * popover's anchored quote is clamped to 2 lines, the message list keeps a
 * minimum of min(5 body lines, its content), and a band too small for that
 * card never clips the reply box.
 *
 * Playwright track (Plan/WEBVIEW_TEST.md): every assertion is about real
 * layout — line clamping, flex shrinking, and the card's viewport placement —
 * none of which a hand-built DOM snapshot can compute.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

const LONG_ANCHOR = Array.from({ length: 30 }, (_, i) => `Anchor sentence number ${i + 1} runs on for a while.`).join(' ');

const DOC = [
  '# Session expiry', // 1
  '', // 2
  LONG_ANCHOR, // 3
  '', // 4
  'Short paragraph text.', // 5
].join('\n');

const TEN_LINE_BODY = Array.from({ length: 12 }, (_, i) => `Body line ${i + 1}`).join('\n');

interface Posted {
  type: string;
  [key: string]: unknown;
}

/** Comment on the whole nth `<p>` via the real right-click + composer flow, then confirm it as the host would. */
async function commentOnParagraph(page: Page, pIndex: number, body: string): Promise<void> {
  await page.locator('#content').evaluate((el, i) => {
    const range = document.createRange();
    range.selectNodeContents(el.querySelectorAll('p')[i]);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, pIndex);
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await page.locator('.comment-composer-input').fill(body);
  await page.locator('.comment-composer-submit').click();
  const create = (await page.evaluate(() => (window as unknown as { __posted: Posted[] }).__posted))
    .filter((m) => m.type === 'createComment')
    .at(-1)!;
  await page.evaluate(
    (m) => window.postMessage(m, '*'),
    { type: 'createCommentResult', requestId: create.requestId, ok: true, author: 'harness-user', timestamp: '2026-07-24T10:12:00.000Z' }
  );
}

async function openPopover(page: Page): Promise<void> {
  await page.locator('.comment-gutter-pin').first().click();
  await expect(page.locator('.comment-popover')).toBeVisible();
}

/** Height of the element as laid out, plus what its own box needs to show everything. */
async function boxOf(page: Page, selector: string): Promise<{ height: number; clientHeight: number; scrollHeight: number; lineHeight: number }> {
  return page.locator(selector).evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
  }));
}

test.describe('Req 24 US-23.24 — a long anchor never hides the thread\'s comments', () => {
  test('AC1: a 10+ line anchor shows as at most 2 quote lines, and a 10+ line body keeps a list of at least 5 body lines that scrolls', async ({
    page,
  }) => {
    // 70vh (350px) is below the card's own minimum here, so the flex column has to
    // shrink something — the list is the only child that can, and without its own
    // minimum it collapses to a sliver.
    await page.setViewportSize({ width: 1280, height: 500 });
    await openEditor(page, DOC);
    await commentOnParagraph(page, 0, TEN_LINE_BODY);
    await openPopover(page);

    // The whole quote stays in the DOM (contract 1) — the clamp is display-only.
    expect(await page.locator('.comment-popover-quote-text').textContent()).toBe(`“${LONG_ANCHOR}”`);
    const quote = await boxOf(page, '.comment-popover-quote-text');
    expect(quote.scrollHeight).toBeGreaterThan(10 * quote.lineHeight);
    expect(quote.height).toBeLessThanOrEqual(2 * quote.lineHeight + 1);

    const list = await boxOf(page, '.comment-popover-list');
    expect(list.height).toBeGreaterThanOrEqual(100);
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  });

  test('AC2: a 1-line body sizes the list to its content, not to the 5-line minimum', async ({ page }) => {
    await openEditor(page, DOC);
    await commentOnParagraph(page, 0, 'One line.');
    await openPopover(page);

    const list = await boxOf(page, '.comment-popover-list');
    expect(list.height).toBeLessThan(100);
    expect(Math.abs(list.clientHeight - list.scrollHeight)).toBeLessThanOrEqual(1);
  });

  test('AC3: a band between 200px and the card\'s minimum keeps the reply box fully inside the card', async ({ page }) => {
    await openEditor(page, DOC);
    await commentOnParagraph(page, 0, TEN_LINE_BODY);

    // Size the viewport so the band below the anchor is 300px and the band above
    // is smaller: too small for the ~400px card, too big for the old 200px floor.
    const para = await page.locator('#content p').first().evaluate((p) => p.getBoundingClientRect().toJSON() as DOMRect);
    const gapAndMargin = 12;
    const height = Math.ceil(para.bottom + gapAndMargin + 300);
    await page.setViewportSize({ width: 1280, height });
    const above = para.top - gapAndMargin;
    const below = height - para.bottom - gapAndMargin;
    expect(Math.max(above, below)).toBeGreaterThan(200);
    expect(Math.max(above, below)).toBeLessThan(400);

    await openPopover(page);
    const [card, replyBox] = await Promise.all([
      page.locator('.comment-popover').evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect),
      page.locator('.comment-popover-reply-box').evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect),
    ]);
    expect(replyBox.height).toBeGreaterThan(0);
    expect(replyBox.top).toBeGreaterThanOrEqual(card.top);
    expect(replyBox.bottom).toBeLessThanOrEqual(card.bottom + 0.5);
  });
});
