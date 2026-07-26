/**
 * Req 23 US-23.1 — "Add Comment": the right-click menu, the anchor it mints,
 * and the composer that posts it. Real Selection API + real `contextmenu`/click
 * events, so this belongs on the Playwright track (Plan/WEBVIEW_TEST.md), not a
 * hand-built DOM snapshot: the anchor is computed from a live Range and the
 * menu/composer only exist after real event dispatch.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

const DOC = '# Heading one\n\nAlpha paragraph text.\n\nBeta paragraph text.\n';

/** Select `text` inside the nth `<p>` (or place a bare caret at `caretAt` when given). */
async function selectIn(page: Page, pIndex: number, from: number, to: number): Promise<void> {
  await page.locator('#content').evaluate(
    (el, { pIndex, from, to }) => {
      const node = el.querySelectorAll('p')[pIndex].firstChild!;
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { pIndex, from, to }
  );
}

/** Select across two different paragraphs — the multi-node case. */
async function selectAcrossParagraphs(page: Page): Promise<void> {
  await page.locator('#content').evaluate((el) => {
    const ps = el.querySelectorAll('p');
    const range = document.createRange();
    range.setStart(ps[0].firstChild!, 2);
    range.setEnd(ps[1].firstChild!, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

async function openContextMenu(page: Page): Promise<void> {
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await expect(page.locator('.comment-context-menu')).toBeVisible();
}

/** Open the menu on the current selection and pick "Add Comment". */
async function openComposer(page: Page): Promise<void> {
  await openContextMenu(page);
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await expect(page.locator('.comment-composer')).toBeVisible();
}

function postedCreates(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() =>
    (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'createComment')
  ) as Promise<Array<Record<string, unknown>>>;
}

test('right-click over a selection anchors the comment to that node with within-node offsets', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 0, 6, 15); // "paragraph" inside "Alpha paragraph text."
  await clearPosted(page);
  await openComposer(page);

  // The quote shows exactly what the anchor covers.
  await expect(page.locator('.comment-composer-quote-text')).toHaveText('“paragraph”');

  await page.locator('.comment-composer-input').fill('Why this wording?');
  await page.locator('.comment-composer-submit').click();

  const [msg] = await postedCreates(page);
  expect(msg).toBeTruthy();
  expect(msg.body).toBe('Why this wording?');
  expect(msg.offsetStart).toBe(6);
  expect(msg.offsetEnd).toBe(15);
  expect(String(msg.anchorId)).toMatch(/^comment-anchor-\d+$/);
  // 1-based source line of the anchored paragraph, not a document-wide offset.
  expect(msg.line).toBe(3);

  // The anchor id is stamped on the paragraph itself, not on #content.
  const stamped = await page
    .locator('#content p')
    .first()
    .getAttribute('data-comment-anchor-id');
  expect(stamped).toBe(msg.anchorId);
});

test('a bare caret is a valid anchor — collapsed offsets, same path as a range', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 1, 5, 5); // collapsed caret inside "Beta paragraph text."
  await clearPosted(page);
  await openComposer(page);

  // No selected text — the composer shows no quote block.
  await expect(page.locator('.comment-composer-quote')).toBeHidden();

  await page.locator('.comment-composer-input').fill('Caret anchored.');
  await page.locator('.comment-composer-submit').click();

  const [msg] = await postedCreates(page);
  expect(msg.offsetStart).toBe(5);
  expect(msg.offsetEnd).toBe(5);
  expect(msg.line).toBe(5);
});

test('a selection crossing two paragraphs anchors to their common ancestor, not a split', async ({ page }) => {
  await openEditor(page, DOC);
  await selectAcrossParagraphs(page);
  await clearPosted(page);
  await openComposer(page);

  await page.locator('.comment-composer-input').fill('Spans both.');
  await page.locator('.comment-composer-submit').click();

  const msgs = await postedCreates(page);
  // One thread for the whole selection — never one per crossed node.
  expect(msgs).toHaveLength(1);
  const anchorId = String(msgs[0].anchorId);
  const stampedOnContent = await page.locator('#content').getAttribute('data-comment-anchor-id');
  expect(stampedOnContent).toBe(anchorId);
});

test('empty and whitespace-only bodies are a no-op — nothing posted, the composer stays open', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 0, 0, 5);
  await clearPosted(page);
  await openComposer(page);

  // dispatchEvent, not click(): Playwright refuses to click an aria-disabled
  // control, and the point here is exactly that a click on it does nothing.
  const submit = page.locator('.comment-composer-submit');
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await submit.dispatchEvent('click');
  expect(await postedCreates(page)).toHaveLength(0);
  await expect(page.locator('.comment-composer')).toBeVisible();

  await page.locator('.comment-composer-input').fill('   ');
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await submit.dispatchEvent('click');
  expect(await postedCreates(page)).toHaveLength(0);
  await expect(page.locator('.comment-composer')).toBeVisible();

  // Real text flips it live.
  await page.locator('.comment-composer-input').fill('real');
  await expect(submit).toHaveAttribute('aria-disabled', 'false');
});

test('"Add Comment" is disabled when there is no addressable node under the cursor', async ({ page }) => {
  await openEditor(page, DOC);
  // Selection collapsed outside #content — nothing addressable to anchor to.
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await openContextMenu(page);

  const item = page.locator('.comment-menu-item', { hasText: 'Add Comment' });
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await expect(item).toHaveAttribute('title', 'No commentable block under the cursor');

  // Clicking it does nothing — no composer, no message.
  await clearPosted(page);
  await item.dispatchEvent('click');
  await expect(page.locator('.comment-composer')).toBeHidden();
  expect(await postedCreates(page)).toHaveLength(0);
});

test('submitting twice before the host replies creates only one thread', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 0, 0, 5);
  await clearPosted(page);
  await openComposer(page);
  await page.locator('.comment-composer-input').fill('Only once.');
  await page.locator('.comment-composer-submit').click();

  // Re-trigger while the first create is still in flight (no host reply yet).
  await selectIn(page, 1, 0, 4);
  await openContextMenu(page);
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await expect(page.locator('.comment-composer')).toBeHidden();

  expect(await postedCreates(page)).toHaveLength(1);
});

test('a host refusal is surfaced and releases the guard so the Reviewer can retry', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 0, 0, 5);
  await clearPosted(page);
  await openComposer(page);
  await page.locator('.comment-composer-input').fill('First try.');
  await page.locator('.comment-composer-submit').click();

  const first = (await postedCreates(page))[0];
  await page.evaluate(
    (requestId) =>
      window.postMessage(
        { type: 'createCommentResult', requestId, ok: false, error: 'That location changed.' },
        '*'
      ),
    first.requestId
  );
  await expect(page.locator('#wysiwyg-toast')).toHaveText('That location changed.');

  // Guard released — a second attempt goes through.
  await selectIn(page, 1, 0, 4);
  await openComposer(page);
  await page.locator('.comment-composer-input').fill('Second try.');
  await page.locator('.comment-composer-submit').click();
  expect(await postedCreates(page)).toHaveLength(2);
});

test('the anchor attribute never reaches the serialized .md', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 0, 6, 15);
  await openComposer(page);
  await page.locator('.comment-composer-input').fill('Anchored.');
  await page.locator('.comment-composer-submit').click();

  // Serialize through the same path the host sync uses.
  const stamped = await page.locator('#content p').first().getAttribute('data-comment-anchor-id');
  expect(stamped).toBeTruthy();
  await clearPosted(page);
  await page.locator('#content').evaluate((el) => {
    const p = el.querySelectorAll('p')[1];
    p.textContent = p.textContent + '!';
    p.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  const md = await page.waitForFunction(
    () =>
      (window as unknown as { __posted: Array<{ type: string; text: string }> }).__posted
        .filter((m) => m.type === 'edit')
        .at(-1)?.text,
    undefined,
    { timeout: 2000 }
  );
  expect(await md.jsonValue()).not.toContain('data-comment-anchor-id');
});
