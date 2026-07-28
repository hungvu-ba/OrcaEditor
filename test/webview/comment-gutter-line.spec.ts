/**
 * Req 23 US-23.2 AC1 — which LINE a gutter pin binds to, and when two pins are
 * allowed to collapse into one "+N" cluster.
 *
 * Two defects this file pins down:
 *  1. A comment inside a *loose* list item (`<li><p>…</p></li>` — what a
 *     blank-line-separated bullet list renders as) anchored to the inner `<p>`,
 *     which carries no `data-line`, and so reported its whole `<ul>`'s first
 *     line: every comment in the list shared one line, one pin, and one line in
 *     the Comment tab.
 *  2. Threads on DIFFERENT lines clustered whenever the lines were close (the
 *     old blank-gap window), so two independent items 2 lines apart merged.
 *
 * Playwright track (Plan/WEBVIEW_TEST.md): the line only exists after a real
 * markdown-it render, and a pin only after real positioning of real DOM — a
 * hand-built DOM snapshot has neither.
 */
import { test, expect, type Page } from '@playwright/test';
import { openCommentTab, openEditor } from './_harness';

/**
 * A LOOSE list (blank line between the items, so each item's text is wrapped in
 * a `<p>`), two paragraphs 2 lines apart, and a TIGHT list whose text sits
 * directly in the `<li>`.
 */
const DOC = [
  '# Bug list', // line 1
  '', // 2
  '-   Alpha item text.', // 3
  '', // 4
  '-   Beta item text.', // 5
  '', // 6
  'Param one paragraph.', // 7
  '', // 8
  'Param two paragraph.', // 9
  '', // 10
  '-   Tight one item.', // 11
  '-   Tight two item.', // 12
].join('\n');

/** A nested blockquote whose only `data-line` carrier is a bullet BELOW the quoted paragraph. */
const QUOTE_DOC = [
  '# Bug list', // line 1
  '', // 2
  '> Outer quote line.', // 3
  '>', // 4
  '> > Inner quote line.', // 5
  '> > -   Bullet in quote', // 6
].join('\n');

interface Posted {
  type: string;
  [key: string]: unknown;
}

async function simulate(page: Page, msg: unknown): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, '*'), msg);
}

/**
 * Create a comment on the nth match of `selector` inside `#content`, through the
 * real right-click + composer flow, then let the (simulated) host confirm it.
 * `selector` (not a paragraph index) is what lets a case target a `<p>` nested
 * inside a list item as opposed to a top-level one.
 */
async function createThreadIn(page: Page, selector: string, nth: number, body: string): Promise<void> {
  await page.locator('#content').evaluate(
    (el, { selector, nth }) => {
      const node = el.querySelectorAll<HTMLElement>(selector)[nth].firstChild!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 5);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { selector, nth }
  );
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await page.locator('.comment-composer-input').fill(body);
  await page.locator('.comment-composer-submit').click();

  const create = (
    await page.evaluate(() =>
      (window as unknown as { __posted: Posted[] }).__posted.filter((m) => m.type === 'createComment')
    )
  ).at(-1)!;
  await simulate(page, {
    type: 'createCommentResult',
    requestId: create.requestId,
    ok: true,
    author: 'harness-user',
    timestamp: new Date(2026, 6, 24, 10, 12).toISOString(),
  });
  // Nothing is registered (nor the node stamped) until the webview handles the
  // reply — waiting on the stamp keeps the pin assertions deterministic.
  await expect(page.locator(`[data-comment-anchor-id="${create.anchorId}"]`)).toHaveAttribute(
    'data-comment-anchor-state',
    'exact'
  );
}

test.describe('gutter pin line — the anchored node’s own line, not its block’s', () => {
  test('comments in two different loose-list items get one pin each, on the items’ own lines', async ({ page }) => {
    await openEditor(page, DOC);
    // Both anchors are the `<p>` INSIDE a list item: no `data-line` of its own,
    // so the line has to come from the enclosing `<li>` (Ln 3 / Ln 5) — falling
    // through to the top-level `<ul>` reports Ln 3 for both.
    await createThreadIn(page, 'li p', 0, 'On Alpha.');
    await createThreadIn(page, 'li p', 1, 'On Beta.');

    await expect(page.locator('.comment-gutter-pin')).toHaveCount(2);
    await expect(page.locator('.comment-gutter-pin-cluster')).toHaveCount(0);

    // The Comment tab reads the same line, so the two rows are distinguishable
    // instead of both pointing at the list's first line.
    await openCommentTab(page);
    await expect(page.locator('.comment-row-where')).toHaveCount(2);
    await expect(page.locator('.comment-row-where', { hasText: 'Ln 3' })).toHaveCount(1);
    await expect(page.locator('.comment-row-where', { hasText: 'Ln 5' })).toHaveCount(1);
  });

  test('a comment anchored to the list item itself keeps that item’s line', async ({ page }) => {
    await openEditor(page, DOC);
    // A TIGHT item puts its text directly in the `<li>`, so the anchored node is
    // the `<li>` itself — the branch where the node carries its own `data-line`.
    await createThreadIn(page, 'li', 2, 'On the tight item.');

    await openCommentTab(page);
    await expect(page.locator('.comment-row-where')).toHaveText('Ln 11');
  });

  test('an anchor inside a nested container never adopts a line from a node BELOW it', async ({ page }) => {
    await openEditor(page, QUOTE_DOC);
    // The nested `<blockquote>` carries no `data-line`, but it CONTAINS a `<li>`
    // that does. Climbing must read each ancestor's OWN line only — reading
    // through to a descendant hands this comment the bullet's line (Ln 6),
    // putting its pin below its own text and clustering it with the bullet's
    // own thread.
    await createThreadIn(page, 'blockquote blockquote p', 0, 'On the inner quote.');
    await createThreadIn(page, 'blockquote li', 0, 'On the bullet.');

    await expect(page.locator('.comment-gutter-pin')).toHaveCount(2);
    await expect(page.locator('.comment-gutter-pin-cluster')).toHaveCount(0);
    await openCommentTab(page);
    // Ln 3 = the outer blockquote, the nearest ancestor that has a line of its
    // own; Ln 6 = the bullet.
    await expect(page.locator('.comment-row-where', { hasText: 'Ln 3' })).toHaveCount(1);
    await expect(page.locator('.comment-row-where', { hasText: 'Ln 6' })).toHaveCount(1);
  });
});

test.describe('gutter pin clustering — same line only', () => {
  test('two threads 2 lines apart stay two separate pins', async ({ page }) => {
    await openEditor(page, DOC);
    await createThreadIn(page, ':scope > p', 0, 'Param one.'); // Ln 7
    await createThreadIn(page, ':scope > p', 1, 'Param two.'); // Ln 9

    await expect(page.locator('.comment-gutter-pin')).toHaveCount(2);
    await expect(page.locator('.comment-gutter-pin-cluster')).toHaveCount(0);
    // Each badge counts its own thread's messages, never the pair.
    await expect(page.locator('.comment-gutter-pin-count').first()).toHaveText('1');
    await expect(page.locator('.comment-gutter-pin-count').last()).toHaveText('1');

    // Two pins now sit one line apart where a single cluster pin used to — each
    // must still be its own hit target, not one covering the other.
    const body = page.locator('.comment-popover-original .comment-popover-body-text');
    await page.locator('.comment-gutter-pin').first().click();
    await expect(body).toHaveText('Param one.');
    await page.locator('.comment-gutter-pin').last().click();
    await expect(body).toHaveText('Param two.');
  });

  test('two threads on the SAME line still collapse into one +2 pin', async ({ page }) => {
    await openEditor(page, DOC);
    await createThreadIn(page, ':scope > p', 0, 'First on Ln 7.');
    await createThreadIn(page, ':scope > p', 0, 'Second on Ln 7.');

    await expect(page.locator('.comment-gutter-pin')).toHaveCount(1);
    await expect(page.locator('.comment-gutter-pin-cluster')).toHaveCount(1);
    await expect(page.locator('.comment-gutter-pin-count')).toHaveText('+2');
  });
});
