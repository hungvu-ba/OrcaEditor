/**
 * Req 23 US-23.4 AC4 — the two routes back into the document for a thread whose
 * anchor is lost, re-pointed by US-23.9 at their new host: the "Unresolved
 * location" GROUP inside the Comment tab, not the standalone `<aside>` that used
 * to fight the TOC for the dock. Every behaviour asserted here is unchanged —
 * that the drag, the picker and the Space/↑↓/Enter walk still work from inside
 * the tab is exactly what US-23.9 AC3 requires this file to prove.
 *
 * Playwright track (Plan/WEBVIEW_TEST.md): a row is dragged with real pointer
 * events onto a real rendered node, the picker is driven with real keyboard
 * input, and a thread only floats after a real re-render — none of which a
 * hand-built DOM snapshot can produce. Drags use raw `page.mouse.move/down/up`,
 * the convention every other drag spec here follows.
 */
import { test, expect, type Page } from '@playwright/test';
import { openCommentTab, openEditor } from './_harness';

const DOC = [
  '# Session expiry',
  '',
  'The refund queue drains in enqueue order.',
  '',
  'Identifiers are recorded for later audit.',
  '',
].join('\n');

/** The document with everything after the heading deleted — floats every thread. */
const GUTTED = '# Session expiry\n';

/**
 * A replacement document whose blocks all sit ABOVE the second paragraph's old
 * line, so a comment anchored there still floats (tier 3 only parks a thread on
 * a block that still spans its last known line) while there are real nodes to
 * re-attach to. Its two items also give the picker something to rank.
 */
const SHORTER = '# Session expiry\n\n- Identifiers are recorded.\n- Something unrelated entirely.\n';

/** Create a comment on the nth paragraph and let the host confirm it, as US-23.1 does. */
async function addComment(
  page: Page,
  pIndex: number,
  body: string,
  timestamp = new Date(2026, 6, 24, 10, 12).toISOString()
): Promise<string> {
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

  const create = await page.evaluate(
    () =>
      (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted
        .filter((m) => m.type === 'createComment')
        .at(-1)!
  );
  await page.evaluate(
    ({ requestId, timestamp }) =>
      window.postMessage(
        { type: 'createCommentResult', requestId, ok: true, author: 'reviewer', timestamp },
        '*'
      ),
    { requestId: create.requestId, timestamp }
  );
  await expect(page.locator(`[data-comment-anchor-id="${create.anchorId}"]`)).toHaveAttribute(
    'data-comment-anchor-state',
    'exact'
  );
  return String(create.anchorId);
}

/** Every 'edit' message posted to the host so far — re-attaching must never add to this. */
async function postedEditCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted.filter(
        (m) => m.type === 'edit'
      ).length
  );
}

async function hostUpdate(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => window.postMessage({ type: 'update', text: value }, '*'), text);
  await page.waitForTimeout(450);
}

/** Float `count` threads (commenting from `startIndex`), replace the document, open the tab. */
async function floatAndOpen(page: Page, count: number, replacement = GUTTED, startIndex = 0): Promise<void> {
  await openEditor(page, DOC);
  for (let i = 0; i < count; i++) {
    await addComment(page, startIndex + i, `Comment ${i + 1}.`);
  }
  await hostUpdate(page, replacement);
  await openCommentTab(page);
  await expect(floatingRows(page)).toHaveCount(count);
}

/** The rows of the "Unresolved location" group — what used to be the whole panel. */
function floatingRows(page: Page) {
  return page.locator('.comment-row[data-group="floating"]');
}

/** Drag a row by its centre onto `targetSelector`, optionally cancelling with Escape. */
async function dragCardOnto(page: Page, cardIndex: number, targetSelector: string, cancel = false): Promise<void> {
  const card = floatingRows(page).nth(cardIndex);
  const from = (await card.boundingBox())!;
  const to = (await page.locator(targetSelector).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await expect(page.locator('.comment-drop-chip')).toBeVisible();
  if (cancel) {
    await page.keyboard.press('Escape');
    await page.mouse.up();
    return;
  }
  await page.mouse.up();
}

test('the toolbar button appears with the first comment and counts only the floating ones', async ({ page }) => {
  await openEditor(page, DOC);
  await expect(page.locator('#comment-panel-toggle')).toBeHidden();

  // US-23.9: the button is the Comment TAB's entry point, so it appears as soon
  // as the file has a thread to browse — but its badge is still the UNRESOLVED
  // count (US-23.4's contract), which is zero while every anchor holds.
  await addComment(page, 0, 'Does drains mean FIFO?');
  await expect(page.locator('#comment-panel-toggle')).toBeVisible();
  await expect(page.locator('#comment-panel-toggle')).toHaveAttribute('data-count', '0');

  await hostUpdate(page, GUTTED);
  await expect(page.locator('#comment-panel-toggle')).toHaveAttribute('data-count', '1');
});

test('a floated thread becomes a row saying so in words, with its opener and status', async ({ page }) => {
  await floatAndOpen(page, 1);

  const row = floatingRows(page);
  await expect(row).toHaveCount(1);
  await expect(row.locator('.comment-row-pill')).toHaveText('No anchor');
  // No snippet and no line number: there is no anchored text left to quote, and
  // the row says that rather than showing an empty pair of quotes (AC5).
  await expect(row.locator('.comment-row-snippet')).toHaveText('Unresolved location');
  await expect(row.locator('.comment-row-author')).toHaveText('reviewer');
  // Floating is orthogonal to status, so line 2 carries the resolve status.
  await expect(row.locator('.comment-row-where')).toHaveText('Open');
  await expect(row.locator('.comment-row-time')).not.toHaveText('');
});

test('every floated thread gets a row — no cap, no "+N more"', async ({ page }) => {
  await floatAndOpen(page, 2);
  await expect(floatingRows(page)).toHaveCount(2);
  await expect(page.locator('#comment-panel-toggle')).toHaveAttribute('data-count', '2');
});

test('rows list newest transition first', async ({ page }) => {
  await openEditor(page, DOC);
  await addComment(page, 0, 'Older comment.', new Date(2026, 6, 24, 9, 0).toISOString());
  await addComment(page, 1, 'Newer comment.', new Date(2026, 6, 24, 11, 0).toISOString());
  await openCommentTab(page);

  // Both anchors still hold, so both rows carry their anchored text — which is
  // what makes the ordering observable at all (a floating row shows no snippet).
  const rows = page.locator('.comment-row .comment-row-snippet');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Identifiers are recorded for later audit.');
  await expect(rows.nth(1)).toContainText('The refund queue drains in enqueue order.');
});

test('dragging a row onto a node re-attaches it and empties the floating group', async ({ page }) => {
  await floatAndOpen(page, 1, SHORTER, 1);
  const editsBefore = await postedEditCount(page);

  await dragCardOnto(page, 0, '#content li >> nth=0');

  // The group is omitted entirely once it empties (US-23.9 AC4) and the thread
  // reappears under Open — it was never deleted, only re-anchored.
  await expect(floatingRows(page)).toHaveCount(0);
  await expect(page.locator('.comment-group-label')).toHaveText('Open');
  await expect(page.locator('.comment-row[data-group="open"]')).toHaveCount(1);
  // The thread now sits on the node it was dropped on, as an exact anchor.
  await expect(page.locator('#content li').first()).toHaveAttribute('data-comment-anchor-state', 'exact');
  await expect(page.locator('.comment-drop-chip')).toHaveCount(0);
  // Re-attaching only rewrites session-only data-comment-anchor-* attributes
  // (stripped by turndown's TRANSIENT_ATTRS) — it must not dirty the document.
  expect(await postedEditCount(page)).toBe(editsBefore);
});

test('Escape mid-drag cancels — the thread stays floating', async ({ page }) => {
  await floatAndOpen(page, 1, SHORTER, 1);

  await dragCardOnto(page, 0, '#content li >> nth=0', true);

  await expect(floatingRows(page)).toHaveCount(1);
  await expect(page.locator('.comment-drop-chip')).toHaveCount(0);
  await expect(page.locator('#content [data-comment-anchor-state="exact"]')).toHaveCount(0);
});

test('the Re-attach… picker ranks by similarity, shows the score, and Enter attaches', async ({ page }) => {
  await floatAndOpen(page, 1, SHORTER, 1);

  await page.locator('.comment-panel-more').click();
  await expect(page.locator('.comment-reattach-picker')).toBeVisible();
  await expect(page.locator('.comment-reattach-group').first()).toHaveText('Suggested');

  // The closest surviving node leads, with its similarity — ranked, not applied.
  const suggested = page.locator('.comment-reattach-row').first();
  await expect(suggested.locator('.comment-reattach-score')).toContainText('%');
  await expect(suggested.locator('.comment-reattach-text')).toContainText('Identifiers are recorded.');
  // Opening previews the current row rather than committing to it.
  await expect(page.locator('.comment-drop-chip')).toBeVisible();
  await expect(floatingRows(page)).toHaveCount(1);

  await page.keyboard.press('Enter');

  await expect(floatingRows(page)).toHaveCount(0);
  await expect(page.locator('#content [data-comment-anchor-state="exact"]')).toHaveText('Identifiers are recorded.');
});

test('the picker filter narrows the list', async ({ page }) => {
  await floatAndOpen(page, 1, SHORTER, 1);

  await page.locator('.comment-panel-more').click();
  await page.locator('.comment-reattach-filter').fill('unrelated');
  await expect(page.locator('.comment-reattach-row')).toHaveCount(1);
  await expect(page.locator('.comment-reattach-row')).toContainText('Something unrelated entirely.');

  await page.locator('.comment-reattach-filter').fill('zzz');
  await expect(page.locator('.comment-reattach-row')).toHaveCount(0);
  await expect(page.locator('.comment-reattach-empty')).toBeVisible();
});

test('the keyboard route attaches exactly like a drop — Space, arrows, Enter', async ({ page }) => {
  await floatAndOpen(page, 1, SHORTER, 1);
  const editsBefore = await postedEditCount(page);

  await floatingRows(page).focus();
  await page.keyboard.press(' ');
  await expect(page.locator('.comment-drop-chip')).toBeVisible();
  // First target is the heading; one step down lands on the first list item.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await expect(floatingRows(page)).toHaveCount(0);
  await expect(page.locator('#content [data-comment-anchor-state="exact"]')).toHaveText('Identifiers are recorded.');
  expect(await postedEditCount(page)).toBe(editsBefore);
});

test('re-attaching the last floating thread retires the group, it does not empty the tab', async ({ page }) => {
  await floatAndOpen(page, 1, SHORTER, 1);
  await dragCardOnto(page, 0, '#content h1');

  // The tab lists every thread, so the file is not suddenly commentless — only
  // the "Unresolved location" group is gone, and the ⚑ badge with it.
  await expect(page.locator('.comment-group-label')).toHaveText('Open');
  await expect(page.locator('.comment-empty')).toHaveCount(0);
  await expect(page.locator('#comment-panel-toggle')).toHaveAttribute('data-count', '0');
});
