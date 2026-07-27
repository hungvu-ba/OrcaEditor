/**
 * Req 23 US-23.9 — the Comment tab: every thread in the file, grouped by status,
 * inside US-23.7's shared right dock.
 *
 * Playwright track (Plan/WEBVIEW_TEST.md): the four groups only exist after real
 * anchor resolution has run against a real rendered document, a Closed thread
 * can only be reached by a host snapshot, and the tab-switch/←→/restore clauses
 * are keyboard and focus behaviour — none of which a hand-built DOM snapshot can
 * produce. Threads are seeded through `commentThreadsSync`, the same message the
 * host pushes, rather than by driving the create flow: only a snapshot can carry
 * a Resolved/Closed status, an orphaned line, or a foreign-sidecar report.
 *
 * This file also closes the three US-23.7 AC that a one-tab dock could not
 * exhibit — tab switching, ←/→ traversal and last-tab restore — since this is
 * the story that supplies the second tab.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  dismissAnchorLost,
  openCommentTab,
  openEditor,
  presetWebviewState,
  readWebviewState,
  seedCommentThreads,
  type SeedThread,
} from './_harness';

/** Line numbers matter: they are what tier 3 uses to park an approximate anchor. */
const DOC = [
  '# Session expiry', // 1
  '', // 2
  'The refund queue drains in enqueue order.', // 3
  '', // 4
  'Identifiers are recorded for later audit.', // 5
  '', // 6
  'Held entries replay after re-authentication.', // 7
  '', // 8
  'A reason code is written for every entry.', // 9
  '', // 10
  'Retries stop once the session expires.', // 11
  '',
].join('\n');

const OPEN_OLD: SeedThread = {
  threadId: 'open-old',
  status: 'Open',
  recordedText: 'The refund queue drains in enqueue order.',
  lastKnownLine: 3,
  timestamp: '2026-07-20T09:00:00.000Z',
};
const OPEN_NEW: SeedThread = {
  threadId: 'open-new',
  status: 'Open',
  author: 'mai.tran',
  recordedText: 'Identifiers are recorded for later audit.',
  lastKnownLine: 5,
  timestamp: '2026-07-26T09:00:00.000Z',
};
const RESOLVED: SeedThread = {
  threadId: 'resolved-1',
  status: 'Resolved',
  recordedText: 'Held entries replay after re-authentication.',
  lastKnownLine: 7,
  // Deliberately long past: `formatRelative` switches to an absolute stamp after
  // two days, so a date near "now" would make this assertion drift day by day.
  timestamp: '2020-01-05T09:00:00.000Z',
  statusChanges: [{ toStatus: 'Resolved', author: 'author', timestamp: '2020-03-11T09:00:00.000Z' }],
};
const CLOSED: SeedThread = {
  threadId: 'closed-1',
  status: 'Closed',
  recordedText: 'A reason code is written for every entry.',
  lastKnownLine: 9,
  timestamp: '2026-07-17T09:00:00.000Z',
  statusChanges: [
    { toStatus: 'Resolved', author: 'author', timestamp: '2026-07-23T09:00:00.000Z' },
    { toStatus: 'Closed', author: 'reviewer', timestamp: '2026-07-24T09:00:00.000Z' },
  ],
};
/** Recorded text nothing matches, but its last known line is still covered → tier 3. */
const APPROX: SeedThread = {
  threadId: 'approx-1',
  status: 'Open',
  recordedText: 'Wording that no longer exists anywhere.',
  lastKnownLine: 11,
  timestamp: '2026-07-19T09:00:00.000Z',
};
/** Nothing matches and the document does not reach line 99 → tier 4, floating. */
const FLOATING: SeedThread = {
  threadId: 'float-1',
  status: 'Open',
  author: 'mai.tran',
  recordedText: 'Text that was cut from a much longer document.',
  lastKnownLine: 99,
  timestamp: '2026-07-22T09:00:00.000Z',
};

const ALL = [OPEN_OLD, OPEN_NEW, RESOLVED, CLOSED, APPROX, FLOATING];

/** Boot, seed a snapshot, and open the dock on the Comment tab. */
async function openWith(page: Page, threads: SeedThread[], sidecar?: Parameters<typeof seedCommentThreads>[2]): Promise<void> {
  await openEditor(page, DOC);
  await seedCommentThreads(page, threads, sidecar);
  // US-23.11 AC1: a seeded floating thread now raises the anchor-lost question
  // whoever authored it, and its scrim would swallow the dock click below.
  await dismissAnchorLost(page);
  await openCommentTab(page);
}

function rows(page: Page) {
  return page.locator('#comment-tabpanel .comment-row');
}

function groups(page: Page) {
  return page.locator('#comment-tabpanel .comment-group-label');
}

/** Open the Comment tab's own `⋯` menu (its items, not the TOC's depth control). */
async function openTabMenu(page: Page): Promise<void> {
  await page.locator('.right-dock-menu-btn').click();
  await expect(page.locator('.right-dock-menu')).toBeVisible();
}

test('groups every thread by status in the fixed order, omitting the empty groups', async ({ page }) => {
  await openWith(page, ALL);

  // Open → Unresolved location → Resolved → Closed: live work first, archive
  // last. Nothing is filtered away — the tab shows the whole file.
  await expect(groups(page)).toHaveText(['Open', 'Unresolved location', 'Resolved', 'Closed']);
  await expect(rows(page)).toHaveCount(6);
  await expect(page.locator('.comment-group', { hasText: 'Open' }).first().locator('.comment-group-count')).toHaveText('3');

  // Within a group: newest transition first, and an Open thread has none, so it
  // falls back to its creation stamp.
  const openSnippets = page.locator('.comment-row[data-group="open"] .comment-row-snippet');
  await expect(openSnippets.nth(0)).toContainText('Identifiers are recorded');
  await expect(openSnippets.nth(1)).toContainText('The refund queue drains');
  await expect(openSnippets.nth(2)).toContainText('Wording that no longer exists');
});

test('a file with only closed threads shows one group, not four', async ({ page }) => {
  await openWith(page, [CLOSED]);

  await expect(groups(page)).toHaveText(['Closed']);
  await expect(rows(page)).toHaveCount(1);
});

test('a row is a status pill, the anchored text, and opener · line · last transition', async ({ page }) => {
  await openWith(page, [RESOLVED]);

  const row = rows(page).first();
  await expect(row.locator('.comment-row-pill')).toHaveText('Resolved');
  // The ANCHORED text, never the comment body — that is what the popover is for.
  await expect(row.locator('.comment-row-snippet')).toContainText('Held entries replay after re-authentication.');
  // The thread's OPENER, not whoever made the last transition.
  await expect(row.locator('.comment-row-author')).toHaveText('reviewer');
  await expect(row.locator('.comment-row-where')).toHaveText('Ln 7');
  // The stamp is the LAST TRANSITION, not creation: created in January, resolved
  // in March, and it is March that a reviewer scans for.
  await expect(row.locator('.comment-row-time')).toHaveText(/11/);
  await expect(row.locator('.comment-row-time')).not.toHaveText(/Jan/);
});

test('Closed threads are listed by default — the tab exists to reach them', async ({ page }) => {
  await openWith(page, ALL);

  const closed = page.locator('.comment-row[data-group="closed"]');
  await expect(closed).toHaveCount(1);
  await expect(closed.locator('.comment-row-pill')).toHaveText('Closed');
  // The group says why it exists: these threads have given up their gutter pin.
  await expect(page.locator('.comment-group', { hasText: 'Closed' }).locator('.comment-group-note')).toHaveText(
    'no gutter pin'
  );
});

test('"Hide closed" is opt-in, and the state it can empty offers the way back', async ({ page }) => {
  await openWith(page, [CLOSED]);
  await expect(rows(page)).toHaveCount(1);

  await openTabMenu(page);
  const hideClosed = page.locator('.right-dock-menu-item', { hasText: 'Hide closed' });
  await expect(hideClosed).toHaveAttribute('aria-checked', 'false');
  await hideClosed.click();

  // Not "No comments in this file": threads exist, a control is hiding them, and
  // the empty state has to say which — with the control to undo it.
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('.comment-empty-title')).toHaveText('No comments to show');
  await page.locator('.comment-empty-action').click();
  await expect(rows(page)).toHaveCount(1);
});

test('the ⋯ menu holds a sort group and a toggle, and sorting is live', async ({ page }) => {
  await openWith(page, ALL);
  await openTabMenu(page);

  // Two sections in one menu — the per-item selection mode US-23.9 added to the
  // dock. US-23.12's "Copy all as Markdown" slots in beside them.
  await expect(page.locator('.right-dock-menu-title')).toHaveText(['Sort', 'Show']);
  await expect(page.locator('.right-dock-menu-item[role="menuitemradio"]')).toHaveCount(2);
  await expect(page.locator('.right-dock-menu-item[role="menuitemcheckbox"]')).toHaveCount(1);

  await page.locator('.right-dock-menu-item', { hasText: 'Oldest first' }).click();
  const openSnippets = page.locator('.comment-row[data-group="open"] .comment-row-snippet');
  await expect(openSnippets.nth(0)).toContainText('Wording that no longer exists');
  await expect(openSnippets.nth(2)).toContainText('Identifiers are recorded');
});

test('an approximate anchor is never presented silently', async ({ page }) => {
  await openWith(page, ALL);

  const approx = page.locator('.comment-row', { has: page.locator('.comment-row-approx') });
  await expect(approx).toHaveCount(1);
  // It keeps its snippet and line number — it is a guess about WHERE, not about
  // whether the thread exists — but says so, distinct from an exact row.
  // The snippet is the text the comment was WRITTEN against, not whatever now
  // occupies the block it was parked on — that is the point of the marker.
  await expect(approx.locator('.comment-row-snippet')).toContainText('Wording that no longer exists anywhere.');
  await expect(approx.locator('.comment-row-where')).toHaveText('Ln 11');
  await expect(approx.locator('.comment-row-approx')).toHaveText('Approximate');
  await expect(page.locator('.comment-row[data-group="open"] .comment-row-approx')).toHaveCount(1);
});

test('a floating row says so in words and carries its own resolve status', async ({ page }) => {
  await openWith(page, ALL);

  const floating = page.locator('.comment-row[data-group="floating"]');
  await expect(floating.locator('.comment-row-pill')).toHaveText('No anchor');
  await expect(floating.locator('.comment-row-snippet')).toHaveText('Unresolved location');
  // Floating is orthogonal to status and never replaces it.
  await expect(floating.locator('.comment-row-where')).toHaveText('Open');
});

test('a snippet is text, never markup, and a textless anchor is labelled', async ({ page }) => {
  await openWith(page, [
    { threadId: 'html-1', recordedText: '<img src=x onerror=alert(1)> and a caption', lastKnownLine: 3 },
    { threadId: 'blank-1', recordedText: '', lastKnownLine: 1 },
  ]);

  // A recorded anchor legitimately holds raw HTML — Req 08 stores sized/dropped
  // images as literal `<img src>` in the `.md` — and the row must render it as
  // characters: inserted via textContent, never innerHTML.
  const html = page.locator('.comment-row[data-thread-id="html-1"] .comment-row-snippet');
  await expect(html).toContainText('<img src=x onerror=alert(1)>');
  expect(await html.evaluate((el) => el.querySelectorAll('*').length)).toBe(0);
  await expect(page.locator('#comment-tabpanel img')).toHaveCount(0);

  // A caret anchor / image / diagram has no text at all — a stated label, not a
  // blank cell or an empty pair of quotes.
  const blank = page.locator('.comment-row[data-thread-id="blank-1"] .comment-row-snippet');
  await expect(blank).toHaveText('No anchored text');
  await expect(blank).toHaveClass(/\bempty\b/);
});

test('the tab-strip badge counts threads and disappears at zero', async ({ page }) => {
  await openEditor(page, DOC);
  await seedCommentThreads(page, []);
  // AC1: the badge appears only when the file has threads, so an uncommented
  // file still shows a Comment tab — just a bare one.
  await expect(page.locator('.right-dock-tab', { hasText: 'Comment' })).toHaveCount(1);
  await expect(page.locator('.right-dock-tab-badge')).toHaveCount(0);

  await seedCommentThreads(page, ALL);
  await expect(page.locator('.right-dock-tab-badge')).toHaveText('6');

  await seedCommentThreads(page, []);
  await expect(page.locator('.right-dock-tab-badge')).toHaveCount(0);
});

test('the four empty states are distinguishable', async ({ page }) => {
  // (d) no snapshot yet — a loading state, not a flash of "no comments".
  await openEditor(page, DOC);
  await openCommentTab(page);
  await expect(page.locator('.comment-empty-title')).toHaveText('Loading comments…');

  // (a) the file genuinely has no comments.
  await seedCommentThreads(page, []);
  await expect(page.locator('.comment-empty-title')).toHaveText('No comments in this file');
  await expect(page.locator('.comment-empty-note')).toContainText('Add comment');

  // (c) the sidecar failed, or this document can hold none — the reason, never
  // "no comments", which would read as a fact about the file.
  await seedCommentThreads(page, [], { problem: 'Save the file first to comment on it.' });
  await expect(page.locator('.comment-empty-title')).toHaveText('Comments unavailable');
  await expect(page.locator('.comment-empty-note')).toHaveText('Save the file first to comment on it.');
  await expect(page.locator('.comment-empty')).toHaveAttribute('data-kind', 'problem');
});

test('a foreign sidecar gets one banner, not N unexplained floating rows', async ({ page }) => {
  await openWith(page, [FLOATING], { foreign: true });

  await expect(page.locator('.comment-tab-banner')).toBeVisible();
  await expect(page.locator('.comment-tab-banner')).toContainText('may describe a different document');
  await expect(page.locator('.comment-row[data-group="floating"]')).toHaveCount(1);
});

test('orphaned reply/status lines are listed read-only after Closed', async ({ page }) => {
  await openWith(page, [CLOSED], {
    orphans: [
      { id: 'o1', kind: 'reply', author: 'mai.tran', timestamp: '2026-07-23T09:00:00.000Z', detail: 'Agreed.' },
      { id: 'o2', kind: 'status-change', author: 'author', timestamp: '2026-07-23T10:00:00.000Z', detail: 'Resolved' },
    ],
  });

  // Merge-orphaned content stays recoverable rather than held invisibly in host
  // memory — last group, same header pattern.
  await expect(groups(page)).toHaveText(['Closed', 'Orphaned']);
  const orphans = page.locator('.comment-row.orphan');
  await expect(orphans).toHaveCount(2);
  await expect(orphans.nth(0).locator('.comment-row-pill')).toHaveText('Reply');
  await expect(orphans.nth(0).locator('.comment-row-snippet')).toHaveText('Agreed.');
  await expect(orphans.nth(1).locator('.comment-row-where')).toHaveText('No parent comment');
});

test('activating a row opens the thread popover against its anchor', async ({ page }) => {
  await openWith(page, [RESOLVED]);

  await rows(page).first().click();
  await expect(page.locator('.comment-popover')).toBeVisible();
  // Positioned against the anchored node, not the row: the popover reveals a
  // connected carrier and re-measures before placing itself.
  const [popoverBox, anchorBox] = await Promise.all([
    page.locator('.comment-popover').boundingBox(),
    page.locator('#content [data-comment-anchor-state]').first().boundingBox(),
  ]);
  expect(Math.abs(popoverBox!.y - anchorBox!.y)).toBeLessThan(200);
  // The row marks itself as the current one so a re-render can restore it.
  await expect(rows(page).first()).toHaveClass(/\bselected\b/);
});

test('a Closed thread is reachable from a row even though it has no gutter pin', async ({ page }) => {
  await openWith(page, [CLOSED]);
  await expect(page.locator('.comment-gutter-pin')).toHaveCount(0);

  await rows(page).first().click();
  await expect(page.locator('.comment-popover')).toBeVisible();
});

test('closing the popover returns focus to the row that opened it', async ({ page }) => {
  await openWith(page, [RESOLVED]);

  await rows(page).first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.comment-popover')).toBeVisible();

  // Move focus into the popover, then dismiss: focus must come back to the row
  // rather than being orphaned on a card that is about to be hidden.
  await page.locator('.comment-popover').locator('button, textarea').first().focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.comment-popover')).toBeHidden();
  await expect(rows(page).first()).toBeFocused();
});

test('a floating row opens in place, offers re-attach, and never raises the anchor-lost dialog', async ({
  page,
}) => {
  await openWith(page, [FLOATING]);
  const floating = page.locator('.comment-row[data-group="floating"]');

  await floating.click();
  await expect(page.locator('.comment-popover')).toBeVisible();
  // AC9: that dialog is armed only on the transition INTO floating and is
  // Author-only — a Reviewer reaching the thread from this list must never see it.
  // (The dialog node is built once at init and kept hidden, so assert on
  // visibility — its presence in the DOM says nothing.)
  await expect(page.locator('.comment-anchor-lost')).toBeHidden();
  // Opened in place: there is nowhere to scroll to, so the popover is positioned
  // against the row's own box rather than a document node.
  const [popover, row] = await Promise.all([
    page.locator('.comment-popover').boundingBox(),
    floating.boundingBox(),
  ]);
  expect(Math.abs(popover!.y - row!.y)).toBeLessThan(200);

  // Cancelling a re-attach leaves the list exactly as it was.
  await expect(floating).toHaveClass(/\bselected\b/);
  await floating.locator('.comment-panel-more').click();
  await expect(page.locator('.comment-reattach-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.comment-reattach-picker')).toBeHidden();
  await expect(page.locator('.comment-row[data-group="floating"]')).toHaveCount(1);
  await expect(page.locator('.comment-row[data-group="floating"]')).toHaveClass(/\bselected\b/);
});

test('a deleted thread hands focus to the row that replaced it, never to <body>', async ({ page }) => {
  await openWith(page, [OPEN_OLD, OPEN_NEW, RESOLVED]);

  // Focus the second Open row, then push a snapshot without its thread.
  const target = page.locator('.comment-row[data-group="open"]').nth(1);
  await target.focus();
  await seedCommentThreads(page, [OPEN_NEW, RESOLVED]);

  await expect(rows(page)).toHaveCount(2);
  // AC10: "a row whose thread left the snapshot is removed … focus moved to the
  // next row" — losing focus to <body> would also disarm the dock's Escape.
  await expect(page.locator('#comment-tabpanel .comment-row:focus')).toHaveCount(1);
});

test('scroll position and focus survive a re-render (US-23.7 AC4/AC10)', async ({ page }) => {
  await openWith(page, ALL);

  await rows(page).nth(1).focus();
  // A second snapshot — a teammate's reply, a reload — must not move the user.
  await seedCommentThreads(page, ALL);
  await expect(rows(page)).toHaveCount(6);
  await expect(rows(page).nth(1)).toBeFocused();
});

// --- The three US-23.7 clauses a one-tab dock could not exhibit ---------------

test('US-23.7 AC4: activating a tab header swaps the bodies, exactly one visible', async ({ page }) => {
  await openEditor(page, DOC);
  await page.locator('#toc-toggle').click({ force: true });
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '300px');
  await expect(page.locator('#toc-tabpanel')).toBeVisible();
  await expect(page.locator('#comment-tabpanel')).toBeHidden();

  await page.locator('.right-dock-tab', { hasText: 'Comment' }).click();
  await expect(page.locator('#comment-tabpanel')).toBeVisible();
  await expect(page.locator('#toc-tabpanel')).toBeHidden();
  await expect(page.locator('.right-dock-tab[aria-selected="true"]')).toHaveCount(1);
  // Nothing else moves: the dock keeps its width and the panel stays open.
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '300px');
});

test('US-23.7 AC6: ←/→ walk the strip and it stays one tab stop', async ({ page }) => {
  await openEditor(page, DOC);
  await page.locator('#toc-toggle').click({ force: true });
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '300px');

  await page.locator('.right-dock-tab').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#comment-tabpanel')).toBeVisible();
  await expect(page.locator('.right-dock-tab').nth(1)).toBeFocused();
  await expect(page.locator('.right-dock-tab').nth(1)).toHaveAttribute('tabindex', '0');
  await expect(page.locator('.right-dock-tab').first()).toHaveAttribute('tabindex', '-1');

  // Wraps both ways: two tabs make → and ← the same journey.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#toc-tabpanel')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#comment-tabpanel')).toBeVisible();
});

test('US-23.7 AC7: the last-selected tab is remembered and restored', async ({ page }) => {
  await openEditor(page, DOC);
  await page.locator('#toc-toggle').click({ force: true });
  await page.locator('.right-dock-tab', { hasText: 'Comment' }).click();
  expect((await readWebviewState(page)).rightDockTab).toBe('comment');

  // A fresh boot with that record restores the tab as it registers — while
  // `#toc-toggle` still always opens on TOC (AC4), which is why the restore is
  // asserted on the strip rather than through that button.
  await presetWebviewState(page, { rightDockTab: 'comment' });
  await openEditor(page, DOC);
  await expect(page.locator('.right-dock-tab[aria-selected="true"]')).toHaveText('Comment');

  await page.locator('#toc-toggle').click({ force: true });
  await expect(page.locator('#toc-tabpanel')).toBeVisible();
  await expect(page.locator('#comment-tabpanel')).toBeHidden();
});
