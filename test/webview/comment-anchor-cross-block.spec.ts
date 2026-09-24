/**
 * Req 24 US-23.25 AC2 — a new comment never anchors to `#content`: a selection
 * crossing top-level blocks anchors to the top-level block holding its start,
 * `offsetStart` measured in that block and `offsetEnd` clamped to its end.
 * Real Selection API + real menu events, so this is the Playwright track
 * (Plan/WEBVIEW_TEST.md).
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

const P1 = 'Alpha paragraph text.';
const DOC = `# Heading one\n\n${P1}\n\nBeta paragraph text.\n`;
const LIST_DOC = '- Item one\n- Item two\n\nAfter paragraph.\n';
// The empty `<p>` the editor inserts before every top-level `<hr>` is a caret
// trap with no `data-line` — not a markdown block.
const HR_DOC = 'Alpha paragraph.\n\n---\n\nBeta paragraph.\n';

/** Select from (`startSel`'s first text node, `from`) to (`endSel`'s first text node, `to`) inside `#content`. */
async function selectAcross(page: Page, startSel: string, from: number, endSel: string, to: number): Promise<void> {
  await page.locator('#content').evaluate(
    (el, { startSel, from, endSel, to }) => {
      const firstText = (sel: string): Node => {
        const host = el.querySelector(sel)!;
        return document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode() ?? host;
      };
      const range = document.createRange();
      range.setStart(firstText(startSel), from);
      range.setEnd(firstText(endSel), to);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { startSel, from, endSel, to }
  );
}

function postedCreates(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() =>
    (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'createComment')
  ) as Promise<Array<Record<string, unknown>>>;
}

async function openContextMenu(page: Page): Promise<void> {
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await expect(page.locator('.comment-context-menu')).toBeVisible();
}

/** Comment on the live selection, confirm the create like the host would, return the posted message. */
async function commentOnSelection(page: Page): Promise<Record<string, unknown>> {
  await clearPosted(page);
  await openContextMenu(page);
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await expect(page.locator('.comment-composer')).toBeVisible();
  await page.locator('.comment-composer-input').fill('Across blocks.');
  await page.locator('.comment-composer-submit').click();
  const msgs = await postedCreates(page);
  expect(msgs).toHaveLength(1);
  const [msg] = msgs;
  await page.evaluate(
    (requestId) => window.postMessage({ type: 'createCommentResult', requestId, ok: true }, '*'),
    msg.requestId
  );
  await expect(page.locator(`[data-comment-anchor-id="${String(msg.anchorId)}"]`)).toHaveAttribute(
    'data-comment-anchor-state',
    'exact'
  );
  return msg;
}

test('(a) paragraph 1 mid -> paragraph 2 mid anchors to paragraph 1, quote runs to its end', async ({ page }) => {
  await openEditor(page, DOC);
  const from = P1.indexOf('paragraph');
  const expectedQuote = P1.slice(from);
  await selectAcross(page, 'p:nth-of-type(1)', from, 'p:nth-of-type(2)', 4);

  await clearPosted(page);
  await openContextMenu(page);
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  // The composer shows the first block's line and the clamped quote.
  await expect(page.locator('.comment-composer-target')).toHaveText('on selection · Ln 3');
  await expect(page.locator('.comment-composer-quote-text')).toHaveText(`“${expectedQuote}”`);
  await page.locator('.comment-composer-input').fill('Across blocks.');
  await page.locator('.comment-composer-submit').click();
  const msgs = await postedCreates(page);
  expect(msgs).toHaveLength(1);
  const msg = msgs[0];
  await page.evaluate(
    (requestId) => window.postMessage({ type: 'createCommentResult', requestId, ok: true }, '*'),
    msg.requestId
  );

  const first = page.locator('#content > p').first();
  await expect(first).toHaveAttribute('data-comment-anchor-id', String(msg.anchorId));
  await expect(first).toHaveAttribute('data-comment-anchor-state', 'exact');
  expect(await page.locator('#content').getAttribute('data-comment-anchor-id')).toBeNull();
  expect(msg.recordedText).toBe(P1);
  expect(msg.offsetStart).toBe(from);
  expect(msg.offsetEnd).toBe(P1.length);
  expect(msg.line).toBe(3);

  // Pin on paragraph 1's line, not the document's first line (the heading).
  await expect(page.locator('.comment-gutter-pin')).toHaveCount(1);
  const pinTop = (await page.locator('.comment-gutter-pin').boundingBox())!.y;
  const pTop = (await first.boundingBox())!.y;
  const hTop = (await page.locator('#content h1').boundingBox())!.y;
  expect(Math.abs(pinTop - pTop)).toBeLessThan(Math.abs(pinTop - hTop));
});

test('(b) a list item -> the next paragraph anchors to the list', async ({ page }) => {
  await openEditor(page, LIST_DOC);
  await selectAcross(page, 'li:nth-of-type(2)', 2, 'p', 3);

  const msg = await commentOnSelection(page);
  const carrier = page.locator(`[data-comment-anchor-id="${String(msg.anchorId)}"]`);
  expect(await carrier.evaluate((el) => el.tagName)).toBe('UL');
  const recorded = String(msg.recordedText);
  expect(recorded).toContain('Item two');
  expect(recorded).not.toContain('After');
  expect(msg.offsetEnd).toBe(recorded.length);
  const quote = recorded.slice(Number(msg.offsetStart), Number(msg.offsetEnd));
  expect(quote.startsWith('em two')).toBe(true);
  expect(await page.locator('#content').getAttribute('data-comment-anchor-id')).toBeNull();
});

test('(c) a selection starting in the caret-trap block disables "Add Comment"', async ({ page }) => {
  await openEditor(page, HR_DOC);
  // Precondition: the trap `<p>` sits right before the `<hr>` and carries no line.
  const trap = page.locator('#content > hr').locator('xpath=preceding-sibling::*[1]');
  expect(await trap.evaluate((el) => el.tagName)).toBe('P');
  expect(await trap.getAttribute('data-line')).toBeNull();

  await page.locator('#content').evaluate((el) => {
    const trapP = el.querySelector(':scope > hr')!.previousElementSibling!;
    const beta = Array.from(el.querySelectorAll(':scope > p')).find((p) => p.textContent === 'Beta paragraph.')!;
    const range = document.createRange();
    range.setStart(trapP, 0);
    range.setEnd(beta.firstChild!, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await openContextMenu(page);

  const item = page.locator('.comment-menu-item', { hasText: 'Add Comment' });
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await clearPosted(page);
  await item.dispatchEvent('click');
  await expect(page.locator('.comment-composer')).toBeHidden();
  expect(await postedCreates(page)).toHaveLength(0);
});
