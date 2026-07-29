/**
 * Req 23 US-23.3 — two-step resolve (Open → Resolved → Closed): the popover's
 * action bar, the live drift suggestion, and the anchor-lost confirmation, all
 * as revised by US-23.11 (no identity gate anywhere, the full transition trail
 * on the thread, one-directional drift, Open-or-Resolved arming).
 *
 * Playwright track (Plan/WEBVIEW_TEST.md): every case needs a real popover
 * opened by a real click on a real positioned gutter pin, and the drift/
 * anchor-lost cases need a real re-resolution pass over a really-edited
 * `#content` — none of which a hand-built DOM snapshot can produce.
 *
 * The observable contract asserted here is what the webview POSTS
 * (`changeCommentStatus`) plus what it renders, never an internal registry. The
 * host's own validation of those messages is covered in test/unit.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  clearPosted,
  openBlankHarness,
  openCommentTab,
  openEditor,
  postInit,
  seedCommentThreads,
  DEFAULT_DOC_URI,
} from './_harness';

/** Paragraphs share no wording, so a tier-2 miss below is a real miss. */
const DOC = [
  '# Session expiry', // line 1
  '', // 2
  'The refund queue drains in enqueue order.', // 3
  '', // 4
  'Identifiers are recorded for later audit.', // 5
  '', // 6
].join('\n');

const ANCHOR_TEXT = 'The refund queue drains in enqueue order.';
/** The harness's configured `orcaEditor.comments.authorName`. */
const ME = 'harness-user';
const SOMEONE_ELSE = 'mai.tran';
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

/**
 * Create a thread on the nth paragraph through the real right-click + composer
 * flow, then let the (simulated) host confirm it. `author` is what the host
 * recorded — pass someone else to put the viewer in the Reviewer's seat.
 */
async function createThread(
  page: Page,
  pIndex: number,
  body: string,
  author = ME,
  /** Which nodes `pIndex` counts — `td` for the same-line cluster case below. */
  selector = 'p'
): Promise<{ threadId: string; anchorId: string }> {
  await page.locator('#content').evaluate(
    (el, { index, selector }) => {
      const node = el.querySelectorAll(selector)[index].firstChild!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 3);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { index: pIndex, selector }
  );
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await page.locator('.comment-composer-input').fill(body);
  await page.locator('.comment-composer-submit').click();

  const create = (await postedOfType(page, 'createComment')).at(-1)!;
  await simulate(page, {
    type: 'createCommentResult',
    requestId: create.requestId,
    ok: true,
    author,
    timestamp: CREATED_AT,
  });
  // The thread is not registered (nor its node stamped) until the webview handles
  // the reply — waiting on the stamp keeps every case below deterministic.
  await expect(page.locator(`[data-comment-anchor-id="${create.anchorId}"]`)).toHaveAttribute(
    'data-comment-anchor-state',
    'exact'
  );
  return { threadId: String(create.threadId), anchorId: String(create.anchorId) };
}

/** Settle window for asserting that something did NOT happen (postMessage is async). */
const SETTLE_MS = 250;

interface StatusOpts {
  /** Who the thread's original comment is recorded against. US-23.11 AC1: no longer gates anything. */
  commentAuthor?: string;
  /** Who performed the transition — what the trail's newest row reads from. */
  actor?: string;
  at?: string;
  /** US-23.11 AC2: the whole trail, when a case needs more than the one transition it just made. */
  trail?: Array<{ toStatus: 'Open' | 'Resolved' | 'Closed'; author: string; timestamp: string }>;
}

/**
 * Push the authoritative per-document snapshot the real provider pushes
 * (`syncCommentThreads`) — how a transition performed anywhere (this popover,
 * a second panel, the native Comments UI) reaches every surface.
 */
async function hostSyncStatus(
  page: Page,
  threadId: string,
  status: 'Open' | 'Resolved' | 'Closed',
  opts: StatusOpts = {}
): Promise<void> {
  const transitioned = status !== 'Open' || opts.actor !== undefined;
  // US-23.11 AC2: the snapshot carries the applied trail, not a last-transition
  // pair. One entry unless a case supplies its own.
  const statusChanges =
    opts.trail ??
    (transitioned
      ? [{ toStatus: status, author: opts.actor ?? SOMEONE_ELSE, timestamp: opts.at ?? CREATED_AT }]
      : []);
  await simulate(page, {
    type: 'commentThreadsSync',
    docUri: DEFAULT_DOC_URI,
    threads: [
      {
        threadId,
        status,
        author: opts.commentAuthor ?? ME,
        timestamp: CREATED_AT,
        body: 'Does drains mean FIFO?',
        recordedText: ANCHOR_TEXT,
        offsetStart: 0,
        offsetEnd: 3,
        lastKnownLine: 3,
        nearestHeading: 'Session expiry',
        replies: [],
        statusChanges,
      },
    ],
  });
  if (await page.locator('.comment-popover').isVisible()) {
    await expect(page.locator('.comment-popover-status')).toHaveText(status);
  } else {
    // No popover open to observe: give the snapshot a beat to reach the registry.
    await page.waitForTimeout(SETTLE_MS);
  }
}

/** Stand in for the host answering a transition this popover just requested, then syncing. */
async function hostAppliedStatus(
  page: Page,
  threadId: string,
  status: 'Open' | 'Resolved' | 'Closed',
  opts: StatusOpts = {}
): Promise<void> {
  const request = (await postedOfType(page, 'changeCommentStatus')).at(-1)!;
  await simulate(page, {
    type: 'changeCommentStatusResult',
    requestId: request.requestId,
    ok: true,
    status,
    author: opts.actor ?? SOMEONE_ELSE,
    timestamp: opts.at ?? CREATED_AT,
  });
  await hostSyncStatus(page, threadId, status, opts);
}

/** Re-render the document from the host, then wait out the debounced re-resolution. */
async function hostUpdate(page: Page, text: string): Promise<void> {
  await simulate(page, { type: 'update', text });
  await page.waitForTimeout(450);
}

async function openPopover(page: Page): Promise<void> {
  await page.locator('.comment-gutter-pin').first().click();
  await expect(page.locator('.comment-popover')).toBeVisible();
}

const action = (page: Page, name: 'resolve' | 'close' | 'reopen') =>
  page.locator(`.comment-popover-action-${name}`);

test.describe('action bar — the two-step flow', () => {
  test('AC1: the Author gets "Mark as Resolved" and no Close; resolving posts the transition and the pill follows the host', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);

    await expect(page.locator('.comment-popover-status')).toHaveText('Open');
    await expect(action(page, 'resolve')).toBeVisible();
    // The design's own point: the Author's one move instead of a dead Close.
    await expect(action(page, 'close')).toHaveCount(0);
    await expect(page.locator('.comment-popover-action-note')).toHaveText('Moves the thread to Resolved');

    await clearPosted(page);
    await action(page, 'resolve').click();
    const posted = await postedOfType(page, 'changeCommentStatus');
    expect(posted).toHaveLength(1);
    expect(posted[0].action).toBe('resolve');
    expect(posted[0].threadId).toBe(threadId);

    // Nothing moves until the sidecar line is durable — the host's snapshot is
    // what flips the pill, never an optimistic local mutation.
    await hostAppliedStatus(page, threadId, 'Resolved', { actor: ME, commentAuthor: ME });
  });

  test('US-23.11 AC1: a thread recorded against someone else offers the SAME actions — no identity gate', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    // Recorded against someone else: under US-23.3 this viewer got a dead Close
    // and no Resolve at all. AC1 removed that gate — the action set is a function
    // of the status alone.
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?', SOMEONE_ELSE);
    await openPopover(page);

    await expect(action(page, 'resolve')).toBeVisible();
    await expect(action(page, 'resolve')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(action(page, 'close')).toHaveCount(0);

    await clearPosted(page);
    await action(page, 'resolve').click();
    const posted = await postedOfType(page, 'changeCommentStatus');
    expect(posted).toHaveLength(1);
    expect(posted[0].action).toBe('resolve');
    expect(posted[0].threadId).toBe(threadId);
  });

  test('US-23.11 AC5: no disabled status control is ever rendered — an illegal action is simply absent', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);

    // Open → Resolve only.
    await expect(action(page, 'resolve')).toBeVisible();
    await expect(action(page, 'close')).toHaveCount(0);
    await expect(action(page, 'reopen')).toHaveCount(0);
    // Resolved → Close and Reopen.
    await hostSyncStatus(page, threadId, 'Resolved', { actor: ME });
    await expect(action(page, 'resolve')).toHaveCount(0);
    await expect(action(page, 'close')).toBeVisible();
    await expect(action(page, 'reopen')).toBeVisible();
    // Closed → Reopen.
    await hostSyncStatus(page, threadId, 'Closed', { actor: ME });
    await expect(action(page, 'resolve')).toHaveCount(0);
    await expect(action(page, 'close')).toHaveCount(0);
    await expect(action(page, 'reopen')).toBeVisible();

    expect(await page.locator('.comment-popover-action[aria-disabled="true"]').count()).toBe(0);
  });

  test('AC1/AC4: a Reviewer closes a Resolved thread, and the transition records who and when', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?', SOMEONE_ELSE);
    await openPopover(page);

    // Arrive at Resolved the way the real system does — the Author resolved it
    // elsewhere (another panel, or the native Comments UI) and the host synced.
    await hostSyncStatus(page, threadId, 'Resolved', { commentAuthor: SOMEONE_ELSE, actor: SOMEONE_ELSE });
    // US-23.11 AC2: the acting user and timestamp, as a row of the trail.
    await expect(page.locator('.comment-popover-transition')).toHaveCount(1);
    await expect(page.locator('.comment-popover-transition')).toContainText(`Resolved · ${SOMEONE_ELSE}`);
    await expect(page.locator('.comment-popover-transition')).toContainText('Jul 24');

    await expect(action(page, 'close')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(action(page, 'reopen')).toBeVisible();

    await clearPosted(page);
    await action(page, 'close').click();
    const posted = await postedOfType(page, 'changeCommentStatus');
    expect(posted).toHaveLength(1);
    expect(posted[0].action).toBe('close');
  });

  test('US-23.11 AC1: the thread\'s own author may Close and Reopen it — the inverted nudge is gone', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await action(page, 'resolve').click();
    await hostAppliedStatus(page, threadId, 'Resolved', { actor: ME, commentAuthor: ME });

    const close = action(page, 'close');
    const reopen = action(page, 'reopen');
    await expect(close).not.toHaveAttribute('aria-disabled', 'true');
    await expect(reopen).not.toHaveAttribute('aria-disabled', 'true');

    // Both are live, not merely un-styled: US-23.3 left this viewer with neither.
    await clearPosted(page);
    await close.click();
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(1);
    await hostAppliedStatus(page, threadId, 'Closed', { actor: ME, commentAuthor: ME });

    // ...and the lockout AC1 names: a Closed thread had no reply box, no Reopen
    // and only "delete the whole thread" left. Reopen is the way out now.
    await clearPosted(page);
    await action(page, 'reopen').click();
    const posted = await postedOfType(page, 'changeCommentStatus');
    expect(posted).toHaveLength(1);
    expect(posted[0].action).toBe('reopen');
  });

  test('US-23.11 AC2: every transition is listed, oldest first — Resolve and Close by two people are distinguishable', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    // A thread that has never left Open lists nothing and keeps the design's hint.
    await expect(page.locator('.comment-popover-transitions')).toBeHidden();
    await expect(page.locator('.comment-popover-action-note')).toHaveText('Moves the thread to Resolved');

    await hostSyncStatus(page, threadId, 'Closed', {
      trail: [
        { toStatus: 'Resolved', author: ME, timestamp: CREATED_AT },
        { toStatus: 'Closed', author: SOMEONE_ELSE, timestamp: CREATED_AT },
      ],
    });

    const rows = page.locator('.comment-popover-transition');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(`Resolved · ${ME}`);
    await expect(rows.nth(1)).toContainText(`Closed · ${SOMEONE_ELSE}`);
    // A Reopen lands on Open; naming it by the bare status would read as authorship.
    await hostSyncStatus(page, threadId, 'Open', {
      trail: [
        { toStatus: 'Resolved', author: ME, timestamp: CREATED_AT },
        { toStatus: 'Closed', author: SOMEONE_ELSE, timestamp: CREATED_AT },
        { toStatus: 'Open', author: ME, timestamp: CREATED_AT },
      ],
    });
    await expect(page.locator('.comment-popover-transition')).toHaveCount(3);
    await expect(page.locator('.comment-popover-transition').nth(2)).toContainText(`Reopened · ${ME}`);
  });

  test('AC5: Reopen takes a Closed thread straight back to Open in one step, and the reply box returns', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?', SOMEONE_ELSE);
    await openPopover(page);
    // Already Closed when the Reviewer opens it — no request of ours to answer.
    await hostSyncStatus(page, threadId, 'Closed', { commentAuthor: SOMEONE_ELSE });

    // A closed thread is a record: no reply box, and Close is gone (US-23.2's gate).
    await expect(page.locator('.comment-popover-reply-box')).toBeHidden();
    await expect(page.locator('.comment-popover-closed-notice')).toBeVisible();
    await expect(action(page, 'close')).toHaveCount(0);

    await clearPosted(page);
    await action(page, 'reopen').click();
    const posted = await postedOfType(page, 'changeCommentStatus');
    expect(posted).toHaveLength(1);
    // One step, not Closed → Resolved → Open.
    expect(posted[0].action).toBe('reopen');

    await hostAppliedStatus(page, threadId, 'Open', { commentAuthor: SOMEONE_ELSE });
    await expect(page.locator('.comment-popover-closed-notice')).toBeHidden();
    await expect(page.locator('.comment-popover-reply-box')).toBeVisible();
    // US-23.11 AC1: Open offers Resolve to whoever is looking, author or not.
    await expect(action(page, 'resolve')).toBeVisible();
  });

  test('AC5/AC4: Reopen from Resolved returns the thread to Open and still reports who reopened it', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?', SOMEONE_ELSE);
    await openPopover(page);
    await hostSyncStatus(page, threadId, 'Resolved', { commentAuthor: SOMEONE_ELSE, actor: SOMEONE_ELSE });

    await clearPosted(page);
    await action(page, 'reopen').click();
    const posted = await postedOfType(page, 'changeCommentStatus');
    expect(posted).toHaveLength(1);
    expect(posted[0].action).toBe('reopen');

    await hostAppliedStatus(page, threadId, 'Open', { commentAuthor: SOMEONE_ELSE, actor: ME });
    // The actor and timestamp of EVERY transition are shown. A Reopen lands on
    // Open, so reporting by status alone ("Moves the thread to Resolved") threw
    // the reopen away entirely.
    await expect(page.locator('.comment-popover-transition').last()).toContainText(`Reopened · ${ME}`);
    await expect(page.locator('.comment-popover-transition').last()).toContainText('Jul 24');
  });

  test('US-23.11 AC8: a refused transition surfaces the reason, keeps the status, and leaves the control live for a retry', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await action(page, 'resolve').click();

    const request = (await postedOfType(page, 'changeCommentStatus')).at(-1)!;
    await simulate(page, {
      type: 'changeCommentStatusResult',
      requestId: request.requestId,
      ok: false,
      error: 'Disk full',
    });
    await expect(page.locator('#wysiwyg-toast')).toHaveText('Disk full');
    await expect(page.locator('.comment-popover-status')).toHaveText('Open');

    // AC8's last clause: "the control is re-enabled for retry — never a silent
    // no-op that leaves the user clicking a live-looking button". The in-flight
    // slot has to have been released by the refusal, or every later action dies.
    await clearPosted(page);
    await action(page, 'resolve').click();
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(1);
  });

  test('US-23.11 AC7: clicking Resolve twice before the host replies posts one transition, not two', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await clearPosted(page);

    // Two clicks with no host reply in between — the same dedup shape US-23.1
    // applies to create and US-23.8 to reply. The host carries its own guard for
    // the popover-then-native-menu race this surface cannot see.
    await action(page, 'resolve').click();
    await action(page, 'resolve').click();
    await page.waitForTimeout(SETTLE_MS);
    const posted = await postedOfType(page, 'changeCommentStatus');
    expect(posted).toHaveLength(1);
    expect(posted[0].threadId).toBe(threadId);

    // ...and the guard is released by the reply, not stuck for the session.
    await hostAppliedStatus(page, threadId, 'Resolved', { actor: ME, commentAuthor: ME });
    await clearPosted(page);
    await action(page, 'close').click();
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(1);
  });

  test('US-23.6: no status action ever reaches the document edit path', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await clearPosted(page);

    await action(page, 'resolve').click();
    await hostAppliedStatus(page, threadId, 'Resolved', { actor: ME, commentAuthor: ME });
    await page.waitForTimeout(SETTLE_MS);

    // A comment action must never occupy a slot in the document's undo stack.
    expect(await postedOfType(page, 'edit')).toHaveLength(0);
  });
});

test.describe('AC2 / US-23.11 AC3 — the live drift suggestion', () => {
  test('US-23.11 AC3: appending a sentence to the commented paragraph is NOT drift', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await expect(page.locator('.comment-popover-drift')).toBeHidden();

    // The bug this AC exists for: the recorded snapshot is the whole paragraph,
    // and the old symmetric score divided by the LONGER string — so typing more
    // prose into the paragraph read as drift even though every recorded word was
    // still there. Text added after the comment is text outside the comment.
    await hostUpdate(
      page,
      DOC.replace(ANCHOR_TEXT, `${ANCHOR_TEXT} Held entries replay after re-authentication.`)
    );
    await openPopover(page);
    await expect(page.locator('.comment-popover-drift')).toBeHidden();

    // ...while removing the recorded text still is drift.
    await hostUpdate(page, DOC.replace(ANCHOR_TEXT, 'The refund queue.'));
    await openPopover(page);
    await expect(page.locator('.comment-popover-drift')).toBeVisible();
  });

  test('US-23.11 AC3: a floating thread shows no drift strip — the anchor-lost dialog owns that question', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    // Float it while CLOSED, so the anchor-lost dialog (AC4) never opens and the
    // popover is reachable.
    await hostSyncStatus(page, threadId, 'Closed', { actor: ME });
    await hostUpdate(page, '# Session expiry\n');
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();

    await openCommentTab(page);
    await page.locator('.comment-row[data-group="floating"]').first().click();
    await expect(page.locator('.comment-popover')).toBeVisible();
    await expect(page.locator('.comment-popover-drift')).toBeHidden();
  });

  test('an in-place edit of the anchored text shows the suggestion even though tier 1 still resolves the node', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { anchorId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await expect(page.locator('.comment-popover-drift')).toBeHidden();

    // Retype the paragraph's whole text in place. The DOM node — and its
    // structural id — survives, so tier 1 keeps resolving it as `exact`: reading
    // the tier alone would report no drift at all, which is exactly the case AC2
    // exists for.
    //
    // Clicking into `#content` dismisses the popover (outside-mousedown), so it is
    // reopened after the edit rather than before — which also proves the strip is
    // derived at render time, not latched when the popover happened to be open.
    await page.locator('#content p').first().click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.type('Totally unrelated prose about billing addresses.');
    await page.waitForTimeout(450);
    await openPopover(page);

    await expect(page.locator(`[data-comment-anchor-id="${anchorId}"]`)).toHaveAttribute(
      'data-comment-anchor-state',
      'exact'
    );
    await expect(page.locator('.comment-popover-drift')).toBeVisible();
    await expect(page.locator('.comment-popover-drift')).toContainText('may have changed');
    // The Author is the one who can act on it, so they get the suggestion itself.
    await expect(page.locator('.comment-popover-drift')).toContainText('mark as resolved?');
  });

  test('the suggestion leaves on its own when the text matches again — no dismiss control exists', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await hostUpdate(page, DOC.replace(ANCHOR_TEXT, 'Nothing like it at all.'));
    await openPopover(page);
    await expect(page.locator('.comment-popover-drift')).toBeVisible();
    // Purely derived: there is no dismiss affordance to click.
    expect(await page.locator('.comment-popover-drift button').count()).toBe(0);

    // The Author undoes the rewrite; the recorded text is back.
    await hostUpdate(page, DOC);
    await expect(page.locator('.comment-popover-drift')).toBeHidden();
  });

  test('the suggestion is suppressed once the thread reaches Resolved', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await hostUpdate(page, DOC.replace(ANCHOR_TEXT, 'Nothing like it at all.'));
    await openPopover(page);
    await expect(page.locator('.comment-popover-drift')).toBeVisible();

    await action(page, 'resolve').click();
    await hostAppliedStatus(page, threadId, 'Resolved', { actor: ME, commentAuthor: ME });
    await expect(page.locator('.comment-popover-drift')).toBeHidden();
  });
});

test.describe('AC3 / US-23.11 AC4 — the anchor-lost notice', () => {
  /** Delete everything from the anchored paragraph down, so no tier can place it. */
  async function floatThread(page: Page): Promise<void> {
    await hostUpdate(page, '# Session expiry\n');
    await expect(page.locator('.comment-anchor-lost')).toBeVisible();
  }

  test('US-23.11: the notice offers NO status action — "This was resolved" is gone at every status', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await clearPosted(page);
    await floatThread(page);

    // PO decision 2026-07-27: one answer, and it writes nothing. The old
    // "This was resolved" answer posted `resolve`, which US-23.11 AC5's matrix
    // allows only from Open — so on a Resolved thread (a state AC4 newly arms) it
    // was refused by the host and re-raised by the still-armed flag, forever.
    await expect(page.locator('.comment-anchor-lost-answer')).toHaveCount(1);
    await expect(page.locator('.comment-anchor-lost-answer')).toHaveText('This comment lost its anchor');
    await expect(page.locator('.comment-anchor-lost-consequence')).toHaveCount(1);

    await page.locator('.comment-anchor-lost-answer').click();
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(0);

    // The same holds for a Resolved thread — the state that used to dead-end.
    await hostUpdate(page, DOC);
    await hostSyncStatus(page, threadId, 'Resolved', { actor: ME });
    await hostUpdate(page, '# Session expiry\n');
    await expect(page.locator('.comment-anchor-lost')).toBeVisible();
    await expect(page.locator('.comment-anchor-lost-answer')).toHaveCount(1);
    await page.locator('.comment-anchor-lost-answer').click();
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(0);
  });

  test('"This comment lost its anchor" changes no resolve state and leaves it in the floating list', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await clearPosted(page);
    await floatThread(page);

    await page.locator('.comment-anchor-lost-answer', { hasText: 'lost its anchor' }).click();
    await page.waitForTimeout(SETTLE_MS);
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
    // AC3: this answer moves it to the Unresolved-location list "instead of
    // changing its resolve state" — so it must write nothing at all.
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(0);
    // Still floating, and still listed: the Comment tab's "Unresolved location"
    // group is the route back into the text (US-23.9 absorbed the old panel).
    await openCommentTab(page);
    await expect(page.locator('.comment-row[data-group="floating"]')).toHaveCount(1);
  });

  test('the three no-decision exits decide nothing and do not re-raise the dialog', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await clearPosted(page);
    await floatThread(page);

    await page.locator('.comment-anchor-lost-later').click();
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(0);

    // Not re-raised for the same episode. The thread is STILL floating, so this
    // has to survive further resolution passes: the Author carries on editing
    // elsewhere, which re-runs the tiers. A dialog re-armed by "is it floating?"
    // rather than by the transition into floating would reappear here on every
    // settled keystroke — unescapable while the text stays deleted.
    await page.locator('#content h1').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' rules');
    await page.waitForTimeout(450);
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(0);
  });

  test('Escape leaves without deciding', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await clearPosted(page);
    await floatThread(page);

    await page.keyboard.press('Escape');
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(0);
  });

  test('US-23.11 AC1: whoever is at the keyboard is asked, even about a thread recorded against someone else', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    // Under US-23.3 the dialog filtered on `sameAuthor`, so the one person
    // looking at the broken anchor was often the one person never asked.
    await createThread(page, 0, 'Does drains mean FIFO?', SOMEONE_ELSE);
    await clearPosted(page);
    await hostUpdate(page, '# Session expiry\n');

    await expect(page.locator('.comment-anchor-lost')).toBeVisible();
    await expect(page.locator('.comment-anchor-lost-body')).toHaveText('Does drains mean FIFO?');
  });

  test('US-23.11 AC4: a thread that floats while RESOLVED is still asked; a Closed one never is', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await action(page, 'resolve').click();
    await hostAppliedStatus(page, threadId, 'Resolved', { actor: ME, commentAuthor: ME });

    // AC4 widens the arming state from Open to Open-or-Resolved: a Resolved
    // thread whose text is then deleted still owes the same answer.
    await clearPosted(page);
    await hostUpdate(page, '# Session expiry\n');
    await expect(page.locator('.comment-anchor-lost')).toBeVisible();
    await page.locator('.comment-anchor-lost-later').click();
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();

    // Closed is the exit: the question is never raised again.
    await hostUpdate(page, DOC);
    await hostSyncStatus(page, threadId, 'Closed', { actor: SOMEONE_ELSE });
    await hostUpdate(page, '# Session expiry\n');
    await page.waitForTimeout(SETTLE_MS);
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(0);
  });

  test('a Reopen of an already-anchorless thread asks the question, even though it never re-enters floating', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await action(page, 'resolve').click();
    await hostAppliedStatus(page, threadId, 'Resolved', { actor: ME, commentAuthor: ME });

    // Closed first (US-23.11 AC4's one exit), so the anchored text can be deleted
    // without the question being raised at all.
    await hostSyncStatus(page, threadId, 'Closed', { commentAuthor: ME, actor: ME });
    await clearPosted(page);
    await hostUpdate(page, '# Session expiry\n');
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();

    // Now a Reviewer reopens it from another surface. The thread is Open AND
    // anchorless — exactly AC3's condition — but it never crosses INTO floating
    // again, so arming on that transition alone would never ask.
    await hostSyncStatus(page, threadId, 'Open', { commentAuthor: ME, actor: SOMEONE_ELSE });
    await expect(page.locator('.comment-anchor-lost')).toBeVisible();
    await expect(page.locator('.comment-anchor-lost-body')).toHaveText('Does drains mean FIFO?');
  });

  test('a thread promoted back out by an undo takes the dialog down with it', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await clearPosted(page);
    await floatThread(page);

    // The Author undoes the deletion before answering — the question no longer stands.
    await hostUpdate(page, DOC);
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(0);
  });

  test('a mass deletion asks about each floated thread in turn — never one answer for all', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'On the queue.');
    await createThread(page, 1, 'On the identifiers.');
    await clearPosted(page);
    await floatThread(page);

    // One dialog at a time, and answering the first raises the second rather than
    // deciding it (design handoff: no "apply to all"). Asserted on the comment
    // BODY, not on the element count: the card is created once at init and only
    // its scrim toggles, so `toHaveCount(1)` holds even with the dialog never
    // opened — and it cannot tell the second thread's question from the first's
    // being re-raised.
    const body = page.locator('.comment-anchor-lost-body');
    // Order between the two is not asserted — they share a creation timestamp, so
    // `floatingThreads()`'s newest-first sort ties. What matters is that BOTH are
    // asked about, each exactly once: one answer must never stand in for the other.
    const first = await body.textContent();
    await page.locator('.comment-anchor-lost-answer', { hasText: 'lost its anchor' }).click();
    await expect(page.locator('.comment-anchor-lost')).toBeVisible();
    const second = await body.textContent();
    expect(new Set([first, second])).toEqual(new Set(['On the queue.', 'On the identifiers.']));
    await page.locator('.comment-anchor-lost-answer', { hasText: 'lost its anchor' }).click();
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
  });

  test('the × button and a scrim click are the other two no-decision exits', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await clearPosted(page);
    await floatThread(page);

    await page.locator('.comment-anchor-lost-close').click();
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(0);

    // Re-raise it by leaving and re-entering the floating state, then dismiss via
    // the scrim. A mousedown inside the card must NOT dismiss it.
    await hostUpdate(page, DOC);
    await floatThread(page);
    await page.locator('.comment-anchor-lost-body').click();
    await expect(page.locator('.comment-anchor-lost')).toBeVisible();
    await page.locator('.comment-anchor-lost-scrim').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(0);
  });

  test('US-23.11 AC4: resolving a floating thread from the popover does not re-raise its own notice', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await clearPosted(page);
    await floatThread(page);
    await page.locator('.comment-anchor-lost-later').click();
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();

    // The thread is Open, floating and Resolved from the Comment tab. AC4 re-arms
    // on a REOPEN and on nothing else: re-arming on any status change put the
    // notice back up on the snapshot that carried the user's own answer.
    await openCommentTab(page);
    await page.locator('.comment-row[data-group="floating"]').first().click();
    await expect(page.locator('.comment-popover')).toBeVisible();
    await action(page, 'resolve').click();
    await hostAppliedStatus(page, threadId, 'Resolved', { actor: ME, commentAuthor: ME });
    await page.waitForTimeout(SETTLE_MS);
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();

    // ...but a Reopen of a still-anchorless thread genuinely does re-raise it.
    await hostSyncStatus(page, threadId, 'Open', { actor: SOMEONE_ELSE });
    await expect(page.locator('.comment-anchor-lost')).toBeVisible();
  });
});

test.describe('US-23.8 AC1/AC6/AC7 — the reload/load-time resolve pass', () => {
  test('AC1: a thread seeded fresh via commentThreadsSync (no live anchorId) resolves through tier 2 before its pin draws', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    // Never created this session (`register`) — only ever seeded, exactly like a
    // thread persisted before the file was last closed (US-23.5) reaching the
    // webview through `commentThreadsSync`.
    await seedCommentThreads(page, [
      { threadId: 'reload-1', recordedText: ANCHOR_TEXT, lastKnownLine: 3, body: 'Reload check.' },
    ]);
    const anchored = page.locator('[data-comment-anchor-state="exact"]');
    await expect(anchored).toHaveCount(1);
    await expect(anchored).toHaveText(ANCHOR_TEXT);
    await expect(page.locator('.comment-gutter-pin')).toHaveCount(1);
  });

  test('AC6: a commentThreadsSync racing the first render is deferred, never resolved against an empty #content', async ({
    page,
  }) => {
    // No 'init' posted yet: `#content` is still empty and `currentDocUri` is
    // still '' — the exact race AC6 guards (the host's early sync can reach the
    // webview before its first render). Both the sync and the later init below
    // use the SAME docUri ('') — main.ts's 'init' handler treats an ACTUAL
    // docUri change as switching documents and prunes every resolver thread
    // via `syncAll([])` before rendering, which is a separate, pre-existing
    // concern this AC does not own; matching them isolates the resolver's own
    // readiness gate from that unrelated reset.
    const config = await openBlankHarness(page);
    await seedCommentThreads(page, [{ threadId: 'race-1', recordedText: ANCHOR_TEXT, lastKnownLine: 3 }], undefined, '');
    await page.waitForTimeout(SETTLE_MS);
    // Deferred, not resolved against nothing — no pin drawn yet.
    await expect(page.locator('.comment-gutter-pin')).toHaveCount(0);

    // The real render now happens — the deferred pass must flush against it.
    await postInit(page, DOC, config, '');
    const anchored = page.locator('[data-comment-anchor-state="exact"]');
    await expect(anchored).toHaveCount(1);
    await expect(page.locator('.comment-gutter-pin')).toHaveCount(1);
  });

  test('AC7: a load seeding more threads than the batch threshold still resolves every one of them', async ({ page }) => {
    await openEditor(page, DOC);
    const BULK = 35; // over ANCHOR_LOAD_BATCH_THRESHOLD (30) — forces the chunked pass
    await seedCommentThreads(
      page,
      Array.from({ length: BULK }, (_, i) => ({
        threadId: `bulk-${i}`,
        recordedText: ANCHOR_TEXT,
        lastKnownLine: 3,
        body: `Bulk ${i}`,
      }))
    );
    // All BULK threads land on the SAME node (identical recorded text — the
    // design's own "several threads sharing one anchor is permitted" rule), so a
    // fully-converged pass draws ONE cluster pin counting every thread, not a
    // partial count stuck mid-batch.
    await expect(page.locator('.comment-gutter-pin-cluster')).toHaveText(`+${BULK}`);
  });
});

test.describe('US-23.8 AC2 — non-exact anchor state, marked on all three surfaces', () => {
  test('a tier-3 (approximate) thread is marked on the gutter pin, the inline highlight, and the popover — and clears once exact again', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await clearPosted(page);

    // Rewrite the anchored paragraph in place — the DOM node (and its structural
    // id) survives, but the recorded text no longer matches closely enough for
    // tier 2, so it parks on the covering block at tier 3 (comment-anchor.spec.ts's
    // own "tier 3" recipe).
    await hostUpdate(page, DOC.replace(ANCHOR_TEXT, 'Nothing like it.'));

    const anchored = page.locator('[data-comment-anchor-state="approximate"]');
    await expect(anchored).toHaveCount(1);

    // Gutter: the badge class plus a non-colour glyph, never colour alone.
    const pin = page.locator('.comment-gutter-pin');
    await expect(pin).toHaveClass(/comment-gutter-pin-nonexact/);
    await expect(pin.locator('.comment-gutter-pin-nonexact-badge')).toHaveCount(1);
    await expect(pin).toHaveAttribute('title', /Approximate location/);

    // Popover: the requirement's own wording, next to the status pill. Opened
    // BEFORE the highlight check below — the highlight overlay only ever draws
    // for the toggle's passive set (off by default in this harness) or the
    // thread whose popover is currently open (US-23.2 AC3; Req 24 US-23.8 AC5:
    // the active thread's own independent registration), so its own thread
    // needs to be active for the registry to hold anything to inspect at all.
    await openPopover(page);
    await expect(page.locator('.comment-popover-anchor-state')).toHaveText('Approximate location');

    // Inline highlight: a SEPARATE Custom Highlight API registration from the
    // exact one — no DOM class exists for it, so read the registry directly.
    // With the toggle off, an active non-exact thread draws through AC5's own
    // active/non-exact registration, not the toggle-gated one.
    const highlightState = await page.evaluate(() => ({
      exact: CSS.highlights.has('comment-anchor'),
      nonexact: CSS.highlights.has('comment-anchor-nonexact'),
      activeExact: CSS.highlights.has('comment-anchor-open'),
      activeNonexact: CSS.highlights.has('comment-anchor-open-nonexact'),
    }));
    expect(highlightState.activeNonexact).toBe(true);
    expect(highlightState.exact).toBe(false);
    expect(highlightState.nonexact).toBe(false);
    expect(highlightState.activeExact).toBe(false);

    // The Author restores the original text — back to exact, and every mark clears.
    await hostUpdate(page, DOC);
    await expect(page.locator(`[data-comment-anchor-state="approximate"]`)).toHaveCount(0);
    await expect(pin).not.toHaveClass(/comment-gutter-pin-nonexact/);
    await expect(page.locator('.comment-popover-anchor-state')).toBeHidden();
    const clearedHighlight = await page.evaluate(() => CSS.highlights.has('comment-anchor-open-nonexact'));
    expect(clearedHighlight).toBe(false);
  });

  test('a cluster pin is marked non-exact only when EVERY thread in it is', async ({ page }) => {
    // Clustering is same-line only, and two INDEPENDENT anchors share one line
    // exactly when they sit in one table: a `<td>` carries no `data-line`, so
    // both cells report the table's start line while staying distinct nodes with
    // distinct anchor ids, whose resolutions never interact. If cells are ever
    // given per-row lines, this premise goes with them — the case then needs
    // another shape of same-line pair, not a wider cluster rule.
    const LEFT = 'Queue drains first';
    const RIGHT = 'Audit trail follows';
    const TABLE_DOC = ['# Session expiry', '', '| Left | Right |', '| --- | --- |', `| ${LEFT} | ${RIGHT} |`, ''].join(
      '\n'
    );
    await openEditor(page, TABLE_DOC);
    await createThread(page, 0, 'First.', ME, 'td');
    await createThread(page, 1, 'Second.', ME, 'td');
    await clearPosted(page);
    const pin = page.locator('.comment-gutter-pin-cluster');
    await expect(pin).toHaveCount(1); // sanity: they did cluster

    // Only the left cell relocates — one exact, one approximate in the cluster,
    // so the pin must NOT read as if both are non-exact.
    await hostUpdate(page, TABLE_DOC.replace(LEFT, 'Nothing like it'));
    await expect(pin).not.toHaveClass(/comment-gutter-pin-nonexact/);

    // The right cell relocates too — now every thread in the cluster is
    // non-exact, and the pin must say so.
    await hostUpdate(page, TABLE_DOC.replace(LEFT, 'Nothing like it').replace(RIGHT, 'Totally different now'));
    await expect(pin).toHaveClass(/comment-gutter-pin-nonexact/);
  });
});

test.describe('US-23.8 AC3 — reply guard hardening', () => {
  test('AC3: clicking Submit twice before the host replies posts exactly one reply, not two', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await page.locator('.comment-popover-reply-input').fill('Following up.');
    await clearPosted(page);

    const submit = page.locator('.comment-popover-reply-submit');
    await submit.click();
    await submit.dispatchEvent('click'); // a second trigger before any result — no re-render disables it first
    await page.waitForTimeout(SETTLE_MS);
    expect(await postedOfType(page, 'replyToComment')).toHaveLength(1);
  });

  test('AC3(i): Cancel during an in-flight reply abandons it — a late result stays silent and a fresh resubmit is never stuck', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await page.locator('.comment-popover-reply-input').fill('Following up.');
    await clearPosted(page);
    await page.locator('.comment-popover-reply-submit').click();
    const [firstRequest] = await postedOfType(page, 'replyToComment');
    expect(firstRequest).toBeTruthy();

    // Cancel while the host has not answered yet.
    await page.locator('.comment-popover-reply-cancel').click();
    await expect(page.locator('.comment-popover-reply-box')).toBeHidden();

    // A late failure for the ABANDONED request must land nowhere visible —
    // before the fix, this wrote into `.comment-popover-reply-error` inside
    // the now-hidden box, silently losing the "never silent" guarantee.
    await simulate(page, { type: 'replyResult', requestId: firstRequest.requestId, ok: false, error: 'Too late.' });
    await page.waitForTimeout(SETTLE_MS);
    await expect(page.locator('.comment-popover-reply-error')).toBeHidden();

    // A fresh reply must not be blocked by the abandoned request's guard.
    await page.locator('.comment-popover-reply-open').click();
    await page.locator('.comment-popover-reply-input').fill('Second attempt.');
    await clearPosted(page);
    await page.locator('.comment-popover-reply-submit').click();
    expect(await postedOfType(page, 'replyToComment')).toHaveLength(1);
  });

  test('AC3(i): a reply that never gets a result times out, releases the guard, and surfaces a failure', async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await page.locator('.comment-popover-reply-input').fill('Following up.');
    await clearPosted(page);
    await page.locator('.comment-popover-reply-submit').click();
    expect(await postedOfType(page, 'replyToComment')).toHaveLength(1);
    const isReadOnly = () =>
      page.locator('.comment-popover-reply-input').evaluate((el) => (el as HTMLTextAreaElement).readOnly);
    // Busy while in flight — the shipped US-23.10 AC5 behavior this guard reuses.
    expect(await isReadOnly()).toBe(true);

    // No `replyResult` ever arrives — host busy, panel disposed, message dropped.
    await page.waitForTimeout(10_300);
    await expect(page.locator('.comment-popover-reply-error')).toBeVisible();
    expect(await isReadOnly()).toBe(false);

    // The guard is actually released, not just visually — a fresh submit goes through.
    await clearPosted(page);
    await page.locator('.comment-popover-reply-submit').click();
    expect(await postedOfType(page, 'replyToComment')).toHaveLength(1);
  });
});

test.describe('US-23.13 AC4/AC5 — merge survives as two threads, empty text skips tier 2', () => {
  test('AC5: a thread with empty recorded_text skips tier 2 and resolves via tier 3, not floating', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    // Reload path (US-23.4 AC1): tier 1 is unreachable for a freshly-synced
    // thread (anchorId ''), so this exercises tier 2 (must be skipped for an
    // empty snapshot — scoring '' against anything is undefined or trivially
    // 1.0) then tier 3 (must land on whatever block still covers line 3).
    await seedCommentThreads(page, [{ threadId: 't-empty', recordedText: '', lastKnownLine: 3 }]);

    await expect(page.locator('[data-comment-anchor-state="approximate"]')).toHaveCount(1);
    await expect(page.locator('[data-comment-anchor-state="floating"]')).toHaveCount(0);
    await openCommentTab(page);
    await expect(page.locator('.comment-row[data-group="floating"]')).toHaveCount(0);
  });

  test('AC4: two separately-anchored threads survive as two distinct threads when their nodes merge into one', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const a = await createThread(page, 0, 'First.');
    const b = await createThread(page, 1, 'Second.');
    await clearPosted(page);

    // Backspace-join shape: the blank line and the second paragraph collapse
    // into the first, so both recorded snippets now live on ONE merged node.
    await hostUpdate(
      page,
      DOC.replace(
        `${ANCHOR_TEXT}\n\nIdentifiers are recorded for later audit.`,
        `${ANCHOR_TEXT} Identifiers are recorded for later audit.`
      )
    );

    // Neither thread was dropped nor silently merged into the other: both
    // still resolve (approximate or exact, never floating) and both are still
    // independently listed and openable with their own body text.
    await expect(page.locator('[data-comment-anchor-state="floating"]')).toHaveCount(0);
    await openCommentTab(page);
    await expect(page.locator('.comment-row[data-group="open"]')).toHaveCount(2);
    await page.locator(`.comment-row[data-thread-id="${a.threadId}"]`).click();
    await expect(page.locator('.comment-popover-body-text')).toHaveText('First.');
    await page.keyboard.press('Escape');
    await page.locator(`.comment-row[data-thread-id="${b.threadId}"]`).click();
    await expect(page.locator('.comment-popover-body-text')).toHaveText('Second.');
  });
});
