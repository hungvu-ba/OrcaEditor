/**
 * Req 24 US-23.12 — "Copy all as Markdown": the Comment tab's `⋯` menu item and
 * its host round trip.
 *
 * Playwright track (Plan/WEBVIEW_TEST.md): the menu item's disabled state is a
 * real `<button disabled>` only a real click can be blocked by, "Hide closed"
 * changing the disabled reason live needs the real toggle click, and the
 * in-flight guard needs two real clicks racing each other — none of which a
 * hand-built DOM snapshot can produce. The exported Markdown's own template,
 * escaping and timestamp formatting are covered as pure functions in
 * test/unit.ts; this file only proves the menu/message wiring around them.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  clearPosted,
  dismissAnchorLost,
  openCommentTab,
  openEditor,
  seedCommentThreads,
  type SeedThread,
} from './_harness';

const DOC = ['# Session expiry', '', 'The refund queue drains in enqueue order.', ''].join('\n');

const OPEN_1: SeedThread = {
  threadId: 't1',
  status: 'Open',
  author: 'reviewer',
  body: 'Why does this contradict US-23.4?',
  timestamp: '2026-07-26T06:42:00.000Z',
};
const OPEN_2: SeedThread = {
  threadId: 't2',
  status: 'Open',
  author: 'reviewer',
  body: 'Second thread.',
  timestamp: '2026-07-26T09:00:00.000Z',
};
const CLOSED_1: SeedThread = {
  threadId: 't3',
  status: 'Closed',
  author: 'reviewer',
  body: 'Already handled.',
  timestamp: '2026-07-17T09:00:00.000Z',
  statusChanges: [{ toStatus: 'Closed', author: 'reviewer', timestamp: '2026-07-24T09:00:00.000Z' }],
};

async function openWith(page: Page, threads: SeedThread[]): Promise<void> {
  await openEditor(page, DOC);
  await seedCommentThreads(page, threads);
  // US-23.11 AC1: an unmatched seeded thread floats and raises the anchor-lost
  // question, whose scrim would swallow the dock/menu clicks below.
  await dismissAnchorLost(page);
  await openCommentTab(page);
}

/** Opens the tab's `⋯` menu (shared shell — content follows the active tab). */
function menuButton(page: Page) {
  return page.locator('.right-dock-menu-btn');
}

function copyItem(page: Page) {
  return page.locator('.right-dock-menu-item', { hasText: 'Copy all as Markdown' });
}

async function lastPostedCopyMessage(page: Page): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(
    () =>
      (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted
        .filter((m) => m.type === 'copyCommentsAsMarkdown')
        .at(-1)
  );
}

async function postedCopyMessageCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted.filter(
        (m) => m.type === 'copyCommentsAsMarkdown'
      ).length
  );
}

async function postedEditCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted.filter(
        (m) => m.type === 'edit'
      ).length
  );
}

test('AC8: disabled with "No comments in this file to copy." when the file has none', async ({ page }) => {
  await openWith(page, []);
  await menuButton(page).click();
  await expect(copyItem(page)).toBeDisabled();
  await expect(copyItem(page)).toHaveAttribute('title', 'No comments in this file to copy.');
});

test('AC8: enabled once a thread exists, disabled again once "Hide closed" hides the only one', async ({ page }) => {
  await openWith(page, [CLOSED_1]);
  await menuButton(page).click();
  await expect(copyItem(page)).toBeEnabled();
  await page.locator('.right-dock-menu-item', { hasText: 'Hide closed' }).click();
  await menuButton(page).click();
  await expect(copyItem(page)).toBeDisabled();
  await expect(copyItem(page)).toHaveAttribute('title', /Closed/);
});

test('AC1/AC2/AC3: click posts the export with the right requestId, docUri and thread count', async ({ page }) => {
  await openWith(page, [OPEN_1, OPEN_2]);
  await clearPosted(page);
  await menuButton(page).click();
  await copyItem(page).click();

  const msg = await lastPostedCopyMessage(page);
  expect(msg).toBeDefined();
  expect(msg!.exportable).toBe(true);
  expect(msg!.docUri).toBe('file:///harness.md');
  expect(typeof msg!.requestId).toBe('number');
  expect(msg!.threadCount).toBe(2);
  const markdown = String(msg!.markdown);
  expect(markdown).toContain('## Review — harness.md · 2 threads · ');
  expect(markdown).toContain('Why does this contradict US-23.4?');
  expect(markdown).toContain('Second thread.');
});

test('AC1: "Hide closed" excluded count is named in the export payload', async ({ page }) => {
  await openWith(page, [OPEN_1, CLOSED_1]);
  await page.locator('.comment-panel-list').waitFor();
  await menuButton(page).click();
  await page.locator('.right-dock-menu-item', { hasText: 'Hide closed' }).click();
  await clearPosted(page);
  await menuButton(page).click();
  await copyItem(page).click();

  const msg = await lastPostedCopyMessage(page);
  expect(msg!.exportable).toBe(true);
  expect(msg!.threadCount).toBe(1);
  expect(msg!.hiddenClosedCount).toBe(1);
});

test('AC2: a second click while the first is still in flight is a no-op', async ({ page }) => {
  await openWith(page, [OPEN_1]);
  await clearPosted(page);
  await menuButton(page).click();
  await copyItem(page).click();
  // The menu closes on click (existing shell behaviour) — reopen and click
  // again before any `copyCommentsAsMarkdownResult` has been sent back.
  await menuButton(page).click();
  await expect(copyItem(page)).toBeEnabled();
  await copyItem(page).click();

  expect(await postedCopyMessageCount(page)).toBe(1);
});

test('AC7: copying never edits the document', async ({ page }) => {
  await openWith(page, [OPEN_1, OPEN_2]);
  await clearPosted(page);
  await menuButton(page).click();
  await copyItem(page).click();
  const msg = await lastPostedCopyMessage(page);
  await page.evaluate(
    (requestId) => window.postMessage({ type: 'copyCommentsAsMarkdownResult', requestId, ok: true }, '*'),
    msg!.requestId
  );
  await page.waitForTimeout(300);

  expect(await postedEditCount(page)).toBe(0);
});

// --- Review findings, 2026-07-28 (regression coverage) ----------------------

test('AC4: a non-floating textless anchor carries "(no anchored text)" on the heading', async ({ page }) => {
  // Tier-3 park: nothing matches recordedText (empty), but lastKnownLine
  // still covers a real block, so the thread resolves non-floating with no
  // anchored text to quote — the exact case AC4's fallback label is for.
  const TEXTLESS: SeedThread = {
    threadId: 't-textless',
    status: 'Open',
    author: 'reviewer',
    body: 'Comment on an image.',
    recordedText: '',
    lastKnownLine: 1,
  };
  await openWith(page, [TEXTLESS]);
  await clearPosted(page);
  await menuButton(page).click();
  await copyItem(page).click();
  const msg = await lastPostedCopyMessage(page);
  expect(String(msg!.markdown)).toContain('(no anchored text)');
});

test('AC4/AC5: an empty-string last-transition timestamp falls back to the creation time, never a dangling separator', async ({
  page,
}) => {
  const t: SeedThread = {
    ...OPEN_1,
    threadId: 't-blank-transition',
    status: 'Resolved',
    statusChanges: [{ toStatus: 'Resolved', author: 'reviewer', timestamp: '' }],
  };
  await openWith(page, [t]);
  await clearPosted(page);
  await menuButton(page).click();
  await copyItem(page).click();
  const msg = await lastPostedCopyMessage(page);
  const markdown = String(msg!.markdown);
  // A dangling separator would read "· reviewer · \n" (timestamp missing) —
  // assert the heading line instead ends with a real formatted timestamp.
  const heading = markdown.split('\n').find((line) => line.startsWith('#### Resolved'));
  expect(heading).toBeDefined();
  expect(heading).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}$/);
});
