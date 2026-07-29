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
import { dismissAnchorLost, openCommentTab, openEditor } from './_harness';

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

/** Same shape as SHORTER (thread keeps floating) but with a node name SHORTER does not contain,
 * so a picker row for it can only come from a walk done AFTER this document arrived. */
const RENAMED = '# Session expiry\n\n- Identifiers are recorded.\n- Freshly minted paragraph.\n';

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

/** The last `commentAnchorUpdate` posted (Req 24 US-23.13 AC1/AC2's `origin`). */
async function lastAnchorUpdate(page: Page): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(
    () =>
      (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted
        .filter((m) => m.type === 'commentAnchorUpdate')
        .at(-1)
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
  // US-23.11 AC1: floating now raises the anchor-lost question for whoever is at
  // the keyboard, and its scrim would swallow the clicks below.
  await dismissAnchorLost(page);
  await openCommentTab(page);
  await expect(floatingRows(page)).toHaveCount(count);
}

/** The computed `display` of the lost-anchor count badge — `none` means hidden. */
function badgeDisplay(page: Page): Promise<string> {
  return page
    .locator('#comment-highlight-toggle')
    .evaluate((el) => getComputedStyle(el, '::after').display);
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

test('the lost-anchor badge rides on Show Comments, and the ⚑ button is gone', async ({ page }) => {
  await openEditor(page, DOC);
  // The `⚑` entry point was retired: the Comment tab is reached from the dock's
  // own tab strip, so no toolbar button opens it any more.
  await expect(page.locator('#comment-panel-toggle')).toHaveCount(0);

  // "Show Comments" is always present — unlike `⚑` it does not appear with the
  // first comment. What it gains is the UNRESOLVED count (US-23.4's contract),
  // which is zero while every anchor holds.
  const showComments = page.locator('#comment-highlight-toggle');
  await expect(showComments).toBeVisible();
  await addComment(page, 0, 'Does drains mean FIFO?');
  await expect(showComments).toHaveAttribute('data-count', '0');
  // The count is a CSS ::after the a11y tree never sees, so the attribute alone
  // proves nothing — assert the badge is actually painted, and that the number
  // also travels in the name/tooltip the drawn tooltip reads (`data-tooltip`,
  // not the native `title` this webview cannot rely on).
  expect(await badgeDisplay(page)).toBe('none');
  await expect(showComments).toHaveAttribute('aria-label', 'Show Comments — Alt+Shift+C');

  await hostUpdate(page, GUTTED);
  await expect(showComments).toHaveAttribute('data-count', '1');
  expect(await badgeDisplay(page)).not.toBe('none');
  await expect(showComments).toHaveAttribute('data-tooltip', /1 comment lost their anchor/);
  await expect(showComments).toHaveAttribute('aria-label', /1 comment lost their anchor/);
});

test('a floated thread becomes a row saying so in its pill, with its opener and status', async ({ page }) => {
  await floatAndOpen(page, 1);

  const row = floatingRows(page);
  await expect(row).toHaveCount(1);
  await expect(row.locator('.comment-row-pill')).toHaveText('No anchor');
  // No line number — nothing is left to point at — but line 1 still carries the
  // comment, which is what makes the row identifiable at all.
  await expect(row.locator('.comment-row-snippet')).toHaveText('Comment 1.');
  await expect(row.locator('.comment-row-author')).toHaveText('reviewer');
  // Floating is orthogonal to status, so line 2 carries the resolve status.
  await expect(row.locator('.comment-row-where')).toHaveText('Open');
  await expect(row.locator('.comment-row-time')).not.toHaveText('');
});

test('every floated thread gets a row — no cap, no "+N more"', async ({ page }) => {
  await floatAndOpen(page, 2);
  await expect(floatingRows(page)).toHaveCount(2);
  await expect(page.locator('#comment-highlight-toggle')).toHaveAttribute('data-count', '2');
});

test('rows list newest transition first', async ({ page }) => {
  await openEditor(page, DOC);
  await addComment(page, 0, 'Older comment.', new Date(2026, 6, 24, 9, 0).toISOString());
  await addComment(page, 1, 'Newer comment.', new Date(2026, 6, 24, 11, 0).toISOString());
  await openCommentTab(page);

  // Each row carries the comment that was written on it, which is what makes the
  // ordering observable — and what a triage scan is actually reading for.
  const rows = page.locator('.comment-row .comment-row-snippet');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText('Newer comment.');
  await expect(rows.nth(1)).toHaveText('Older comment.');
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
  // Req 24 US-23.13 AC1: a deliberate re-attach is persisted with the manual
  // origin, so it survives a reload instead of floating again.
  expect((await lastAnchorUpdate(page))?.origin).toBe('manual');

  // US-23.11 AC3: the snapshot follows the anchor. Without the rewrite the thread
  // reads as permanently drifted against a paragraph that no longer exists, so it
  // would open with the "text may have changed" strip up on a node the user
  // deliberately chose. The offsets are dropped with it, so no stale quote either.
  await page.locator('.comment-row[data-group="open"]').first().click();
  await expect(page.locator('.comment-popover')).toBeVisible();
  await expect(page.locator('.comment-popover-drift')).toBeHidden();
  await expect(page.locator('.comment-popover-quote')).toBeHidden();
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

/**
 * Performance Audit P-6 follow-up: the picker's candidate list is walked once on open and
 * reused per keystroke. A host 'update' rebuilds #content wholesale without closing the picker,
 * so the cached nodes are all detached — every row would then be refused by attach()'s
 * `isConnected` guard until the user reopened the picker. buildPicker re-walks on that signal.
 */
test('the picker heals its candidate list after the document is rebuilt underneath it (P-6)', async ({
  page,
}) => {
  await floatAndOpen(page, 1, SHORTER, 1);

  await page.locator('.comment-panel-more').click();
  await expect(page.locator('.comment-reattach-picker')).toBeVisible();

  // The document is replaced while the picker stays open — content.innerHTML detaches every
  // node the picker cached on open.
  await hostUpdate(page, RENAMED);
  await dismissAnchorLost(page);
  await expect(page.locator('.comment-reattach-picker')).toBeVisible();

  // A node that exists only in the NEW document is offered, which the stale cache could not know.
  await page.locator('.comment-reattach-filter').fill('Freshly');
  await expect(page.locator('.comment-reattach-row')).toHaveCount(1);
  await expect(page.locator('.comment-reattach-row')).toContainText('Freshly minted paragraph.');

  // And it is a live node: the attach lands instead of showing "That location changed".
  await page.keyboard.press('Enter');
  await expect(page.locator('#wysiwyg-toast.show')).toHaveCount(0);
  await expect(floatingRows(page)).toHaveCount(0);
  await expect(page.locator('#content [data-comment-anchor-state="exact"]')).toHaveText(
    'Freshly minted paragraph.'
  );
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
  // the "Unresolved location" group is gone, and the lost-anchor badge with it.
  await expect(page.locator('.comment-group-label')).toHaveText('Open');
  await expect(page.locator('.comment-empty')).toHaveCount(0);
  await expect(page.locator('#comment-highlight-toggle')).toHaveAttribute('data-count', '0');
  // The badge and its wording both have to CLEAR, not just the count: a tooltip
  // stuck on "1 comment lost their anchor" outlives the condition it describes.
  expect(await badgeDisplay(page)).toBe('none');
  await expect(page.locator('#comment-highlight-toggle')).toHaveAttribute(
    'data-tooltip',
    'Show Comments — Alt+Shift+C'
  );
});
