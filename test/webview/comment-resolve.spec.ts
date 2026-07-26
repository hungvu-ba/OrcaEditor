/**
 * Req 23 US-23.3 — two-step resolve (Open → Resolved → Closed): the popover's
 * action bar and its Author/Reviewer gating, the live drift suggestion, and the
 * anchor-lost confirmation.
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
import { clearPosted, openEditor, DEFAULT_DOC_URI } from './_harness';

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
  author = ME
): Promise<{ threadId: string; anchorId: string }> {
  await page.locator('#content').evaluate(
    (el, index) => {
      const node = el.querySelectorAll('p')[index].firstChild!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 3);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    pIndex
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

interface StatusOpts {
  /** Who the thread's original comment is recorded against (decides Author vs Reviewer). */
  commentAuthor?: string;
  /** Who performed the transition — what AC4's "Resolved by …" line reads from. */
  actor?: string;
  at?: string;
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
        ...(transitioned
          ? { lastTransitionAuthor: opts.actor ?? SOMEONE_ELSE, lastTransitionTimestamp: opts.at ?? CREATED_AT }
          : {}),
      },
    ],
  });
  await expect(page.locator('.comment-popover-status')).toHaveText(status);
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

/** Settle window for asserting that something did NOT happen (postMessage is async). */
const SETTLE_MS = 250;

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

  test('AC1: a Reviewer looking at an Open thread sees Close disabled with the reason in place', async ({ page }) => {
    await openEditor(page, DOC);
    // Recorded against someone else, so the viewer is the Reviewer here.
    await createThread(page, 0, 'Does drains mean FIFO?', SOMEONE_ELSE);
    await openPopover(page);

    await expect(action(page, 'resolve')).toHaveCount(0);
    const close = action(page, 'close');
    await expect(close).toHaveAttribute('aria-disabled', 'true');
    await expect(close).toHaveAttribute('title', 'Resolve the thread before closing');

    // Disabled means inert, not merely styled. Forced past Playwright's own
    // enabled check on purpose: the assertion is that NO handler is attached, not
    // that the harness declined to click.
    await clearPosted(page);
    await close.click({ force: true });
    await page.waitForTimeout(SETTLE_MS);
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(0);
  });

  test('AC1/AC4: a Reviewer closes a Resolved thread, and the transition records who and when', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?', SOMEONE_ELSE);
    await openPopover(page);

    // Arrive at Resolved the way the real system does — the Author resolved it
    // elsewhere (another panel, or the native Comments UI) and the host synced.
    await hostSyncStatus(page, threadId, 'Resolved', { commentAuthor: SOMEONE_ELSE, actor: SOMEONE_ELSE });
    // AC4: the acting user and timestamp, shown alongside the thread.
    await expect(page.locator('.comment-popover-action-note')).toContainText(`Resolved by ${SOMEONE_ELSE}`);
    await expect(page.locator('.comment-popover-action-note')).toContainText('Jul 24');

    await expect(action(page, 'close')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(action(page, 'reopen')).toBeVisible();

    await clearPosted(page);
    await action(page, 'close').click();
    const posted = await postedOfType(page, 'changeCommentStatus');
    expect(posted).toHaveLength(1);
    expect(posted[0].action).toBe('close');
  });

  test('AC6: the self-close nudge disables Close AND Reopen for the thread\'s own author, with the reason in the tooltip', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await action(page, 'resolve').click();
    await hostAppliedStatus(page, threadId, 'Resolved', { actor: ME, commentAuthor: ME });

    const close = action(page, 'close');
    await expect(close).toHaveAttribute('aria-disabled', 'true');
    await expect(close).toHaveAttribute('title', 'You can’t close your own comment');
    // AC5 makes Reopen Reviewer-only too, so the same nudge applies — the static
    // design file left it enabled, the requirement's own wording does not.
    const reopen = action(page, 'reopen');
    await expect(reopen).toHaveAttribute('aria-disabled', 'true');
    await expect(reopen).toHaveAttribute('title', 'You can’t reopen your own comment');

    await clearPosted(page);
    await close.click({ force: true });
    await reopen.click({ force: true });
    await page.waitForTimeout(SETTLE_MS);
    expect(await postedOfType(page, 'changeCommentStatus')).toHaveLength(0);
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
    await expect(action(page, 'resolve')).toHaveCount(0); // still the Reviewer's view
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
    // AC4 requires the actor and timestamp of EVERY transition to be shown. A
    // Reopen lands on Open, so reporting by status alone ("Moves the thread to
    // Resolved") threw the reopen away entirely.
    await expect(page.locator('.comment-popover-action-note')).toContainText(`Reopened by ${ME}`);
    await expect(page.locator('.comment-popover-action-note')).toContainText('Jul 24');
  });

  test('a refused transition surfaces the reason and leaves the status where it was', async ({ page }) => {
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

test.describe('AC2 — the live drift suggestion', () => {
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

test.describe('AC3 — the anchor-lost confirmation', () => {
  /** Delete everything from the anchored paragraph down, so no tier can place it. */
  async function floatThread(page: Page): Promise<void> {
    await hostUpdate(page, '# Session expiry\n');
    await expect(page.locator('.comment-anchor-lost')).toBeVisible();
  }

  test('"This was resolved" asks the host to resolve it; the Reviewer\'s Close is still required', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await clearPosted(page);
    await floatThread(page);

    // Both answers at identical weight, and a consequence line under each.
    await expect(page.locator('.comment-anchor-lost-answer')).toHaveCount(2);
    await expect(page.locator('.comment-anchor-lost-consequence').first()).toContainText(
      'reviewer still has to close it'
    );

    await page.locator('.comment-anchor-lost-answer', { hasText: 'This was resolved' }).click();
    const posted = await postedOfType(page, 'changeCommentStatus');
    expect(posted).toHaveLength(1);
    expect(posted[0].action).toBe('resolve');
    expect(posted[0].threadId).toBe(threadId);
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
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
    // Still floating, and still listed: the panel is the route back into the text.
    await page.locator('#comment-panel-toggle').click();
    await expect(page.locator('.comment-panel-card')).toHaveCount(1);
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

  test('a Reviewer is never asked — the decision is the Author\'s, and the thread is still in their panel', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?', SOMEONE_ELSE);
    await clearPosted(page);
    await hostUpdate(page, '# Session expiry\n');

    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
    await page.locator('#comment-panel-toggle').click();
    await expect(page.locator('.comment-panel-card')).toHaveCount(1);
  });

  test('a Reopen of an already-anchorless thread asks the question, even though it never re-enters floating', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Does drains mean FIFO?');
    await openPopover(page);
    await action(page, 'resolve').click();
    await hostAppliedStatus(page, threadId, 'Resolved', { actor: ME, commentAuthor: ME });

    // The anchored text is deleted while the thread is RESOLVED: nothing to decide
    // yet, so no dialog — the question only applies to an Open thread.
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

  test('a refused "This was resolved" is reported and the question is asked again', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Does drains mean FIFO?');
    await clearPosted(page);
    await floatThread(page);

    await page.locator('.comment-anchor-lost-answer', { hasText: 'This was resolved' }).click();
    await expect(page.locator('.comment-anchor-lost')).toBeHidden();
    const request = (await postedOfType(page, 'changeCommentStatus')).at(-1)!;

    // The sidecar refused the append (read-only file, disk full, already resolved
    // elsewhere). The Author's decision must not vanish with the dialog.
    await simulate(page, {
      type: 'changeCommentStatusResult',
      requestId: request.requestId,
      ok: false,
      error: 'Disk full',
    });
    await expect(page.locator('#wysiwyg-toast')).toHaveText('Disk full');
    // Still Open, still anchorless — so the question genuinely still stands.
    await expect(page.locator('.comment-anchor-lost')).toBeVisible();
    await expect(page.locator('.comment-anchor-lost-body')).toHaveText('Does drains mean FIFO?');
  });
});
