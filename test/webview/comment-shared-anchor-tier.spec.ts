/**
 * US-23.1 permits several threads to share one anchor id: a second comment on the
 * same node adopts the id already stamped there. US-23.4's tier 1 then resolves a
 * thread by looking that id up in the live DOM — and `resolveAll` walks the
 * threads one at a time, placing and stamping each as it goes.
 *
 * Those two facts collide inside a single pass. When a re-render re-mints every
 * structural id, tier 1 must miss for BOTH threads of a shared cluster and both
 * must fall to tier 3, which parks them on the covering block and marks them
 * `approximate`. But the first thread's tier-3 placement stamps the shared id onto
 * that block, so the second thread's own tier-1 lookup — running later in the SAME
 * pass — finds the id its sibling just wrote, mistakes a guess for a match, and
 * re-stamps the node `exact`. The cluster can then never show as non-exact, and
 * the "this comment may be misplaced" signal is lost for every thread in it.
 *
 * Playwright track (Plan/WEBVIEW_TEST.md): needs a real create flow through the
 * gutter/composer, a real host re-render, and the real debounced re-resolution.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

/** Paragraphs share no wording, so a tier-2 miss is a real miss. */
const DOC = [
  '# Session expiry', // line 1
  '', // 2
  'The refund queue drains in enqueue order.', // 3
  '', // 4
  'Identifiers are recorded for later audit.', // 5
  '', // 6
].join('\n');

const ANCHOR_TEXT = 'The refund queue drains in enqueue order.';
const CREATED_AT = new Date(2026, 6, 24, 10, 12).toISOString();

interface Posted {
  type: string;
  [key: string]: unknown;
}

async function postedOfType(page: Page, type: string): Promise<Posted[]> {
  return page.evaluate(
    (wanted) => (window as unknown as { __posted: Posted[] }).__posted.filter((m) => m.type === wanted),
    type
  );
}

async function simulate(page: Page, msg: unknown): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, '*'), msg);
}

/** Create a thread on the nth paragraph through the real right-click + composer flow. */
async function createThread(page: Page, pIndex: number, body: string): Promise<{ threadId: string; anchorId: string }> {
  await page.locator('#content').evaluate((el, index) => {
    const node = el.querySelectorAll('p')[index].firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 3);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, pIndex);
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await page.locator('.comment-composer-input').fill(body);
  await page.locator('.comment-composer-submit').click();

  const create = (await postedOfType(page, 'createComment')).at(-1)!;
  await simulate(page, {
    type: 'createCommentResult',
    requestId: create.requestId,
    ok: true,
    author: 'harness-user',
    timestamp: CREATED_AT,
  });
  await expect(page.locator(`[data-comment-anchor-id="${create.anchorId}"]`)).toHaveAttribute(
    'data-comment-anchor-state',
    'exact'
  );
  return { threadId: String(create.threadId), anchorId: String(create.anchorId) };
}

/** Re-render the document from the host, then wait out the debounced re-resolution. */
async function hostUpdate(page: Page, text: string): Promise<void> {
  await simulate(page, { type: 'update', text });
  await page.waitForTimeout(450);
}

test('two threads sharing one anchor both stay approximate — the second must not re-mark the node exact', async ({
  page,
}) => {
  await openEditor(page, DOC);

  // Same node, same offsets, so the second create adopts the first's id — the
  // shared-anchor cluster US-23.1 allows.
  const first = await createThread(page, 0, 'Does drains mean FIFO?');
  const second = await createThread(page, 0, 'Which queue is this?');
  expect(second.anchorId).toBe(first.anchorId);

  // Replace that paragraph's text from the host. `renderDocument` re-mints every
  // structural id, so tier 1 must miss for both threads; the recorded text is gone,
  // so tier 2 must miss too; the line still exists, so tier 3 parks both on the
  // covering block and marks them `approximate`.
  await hostUpdate(page, DOC.replace(ANCHOR_TEXT, 'Totally unrelated prose about billing addresses.'));

  const carrier = page.locator(`[data-comment-anchor-id="${first.anchorId}"]`);
  await expect(carrier).toHaveCount(1);
  await expect(carrier).toHaveAttribute('data-comment-anchor-state', 'approximate');
});
