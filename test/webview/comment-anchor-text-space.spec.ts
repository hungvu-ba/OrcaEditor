/**
 * Req 24 US-23.25 AC1 — a comment anchor measures its carrier's text with
 * editor chrome (`[data-md-chrome]`: the code-block language label / Wrap /
 * Copy header) excluded, so recordedText, offsets, quote, highlight and the
 * resolver all agree with the raw `.md`. Real Selection API + real menu
 * events, so this is the Playwright track (Plan/WEBVIEW_TEST.md).
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted, seedCommentThreads } from './_harness';

const CODE = 'const refundQueue = drainInEnqueueOrder(pendingRefunds);';
const DOC = '# Refunds\n\nIntro paragraph.\n\n```ts\n' + CODE + '\n```\n';
// Selected code text: from the start of the block up to the end of the call.
const SELECTED = CODE.slice(0, CODE.indexOf(';'));
const TO = SELECTED.length;

/**
 * Select from the `<pre>`'s own start (before its header chrome, as a
 * whole-block selection does) to offset `to` of the `<code>` text, via a Range
 * — pointer drag cannot select in this harness. The common ancestor is then the
 * `<pre>`, which holds the header. Walks text nodes because syntax highlighting
 * splits the code into spans.
 */
async function selectCodeFromBlockStart(page: Page, to: number): Promise<void> {
  await page.locator('#content pre').evaluate((pre, to) => {
    const walker = document.createTreeWalker(pre.querySelector('code')!, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    range.setStart(pre, 0);
    let consumed = 0;
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const len = (n as Text).data.length;
      if (to <= consumed + len) {
        range.setEnd(n, to - consumed);
        break;
      }
      consumed += len;
    }
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, to);
}

function postedCreates(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() =>
    (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'createComment')
  ) as Promise<Array<Record<string, unknown>>>;
}

/** Comment on the selected code text, confirm the create like the host would, return the posted message. */
async function commentOnCode(page: Page): Promise<Record<string, unknown>> {
  await selectCodeFromBlockStart(page, TO);
  await clearPosted(page);
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await expect(page.locator('.comment-composer')).toBeVisible();
  await expect(page.locator('.comment-composer-quote-text')).toHaveText(`“${SELECTED}”`);
  await page.locator('.comment-composer-input').fill('Is this FIFO?');
  await page.locator('.comment-composer-submit').click();
  const [msg] = await postedCreates(page);
  expect(msg).toBeTruthy();
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

test('(a) a comment on code records the code text only, never the header chrome', async ({ page }) => {
  await openEditor(page, DOC);
  // Precondition: the header chrome is really there, inside the anchorable <pre>.
  await expect(page.locator('#content pre [data-md-chrome]')).toContainText('Copy');

  const msg = await commentOnCode(page);
  // The reported case: the anchor lands on the <pre> that holds the header.
  const carrierTag = await page
    .locator(`[data-comment-anchor-id="${String(msg.anchorId)}"]`)
    .evaluate((el) => el.tagName);
  expect(carrierTag).toBe('PRE');
  const recorded = String(msg.recordedText);
  expect(recorded).not.toContain('Copy');
  expect(recorded).not.toContain('Wrap');
  expect(recorded).not.toContain('TypeScript');
  expect(recorded.trim()).toBe(CODE);
  expect(recorded.slice(Number(msg.offsetStart), Number(msg.offsetEnd))).toBe(SELECTED);
});

/** The text of every range the passive "Show Comments" wash paints. */
function washedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const set = CSS.highlights.get('comment-anchor');
    return set ? Array.from(set as unknown as Set<Range>).map((r) => r.toString()) : [];
  });
}

test('(b) Show Comments washes exactly the selected code characters', async ({ page }) => {
  await openEditor(page, DOC);
  await commentOnCode(page);
  await page.locator('#comment-highlight-toggle').click();

  expect(await washedTexts(page)).toEqual([SELECTED]);
});

test('(c) a seeded thread with a chrome-free code anchor resolves exact and washes its own offsets', async ({ page }) => {
  await openEditor(page, DOC);
  const recordedText = await page.locator('#content pre code').evaluate((code) => code.textContent ?? '');
  await seedCommentThreads(page, [
    { threadId: 't-code', recordedText, offsetStart: 0, offsetEnd: TO, lastKnownLine: 5 },
  ]);
  await expect(page.locator('#content pre')).toHaveAttribute('data-comment-anchor-state', 'exact');
  // The stored offsets name code characters, not header chrome.
  await page.locator('#comment-highlight-toggle').click();
  expect(await washedTexts(page)).toEqual([SELECTED]);
});
