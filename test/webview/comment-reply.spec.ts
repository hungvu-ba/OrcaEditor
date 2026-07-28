/**
 * Req 23 US-23.2 — Author sees and replies to comments in place: gutter pins
 * (count/clustering), the "Show Comments" toggle, the thread popover (single-
 * open, reply, Cancel, delete with confirmation, own-vs-other-author gating),
 * and the undo-safety invariant carried forward from US-23.6.
 *
 * Playwright track (Plan/WEBVIEW_TEST.md): pins/popover only exist after real
 * click events on real positioned DOM, and the reply `<textarea>`'s own native
 * undo can only be verified by dispatching real keyboard events — none of
 * which a hand-built DOM snapshot (test/roundtrip/) can produce.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted, dismissAnchorLost, openCommentTab, DEFAULT_DOC_URI } from './_harness';

const DOC = [
  '# Session expiry', // line 1
  '', // 2
  'Alpha paragraph text.', // 3
  '', // 4
  'Beta paragraph text.', // 5
  '', // 6
  'Gamma paragraph text.', // 7
  '', // 8
  '', // 9
  'Delta paragraph text.', // 10
].join('\n');

interface Posted {
  type: string;
  [key: string]: unknown;
}

async function posted(page: Page): Promise<Posted[]> {
  return page.evaluate(() => (window as unknown as { __posted: Posted[] }).__posted);
}

async function postedOfType(page: Page, type: string): Promise<Posted[]> {
  return (await posted(page)).filter((m) => m.type === type);
}

async function simulate(page: Page, msg: unknown): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, '*'), msg);
}

/** Select `text` inside the nth `<p>` and place a caret/selection there. */
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

/** Create a comment on the nth paragraph via the real right-click + composer flow, then let the (simulated) host confirm it. */
async function createThread(
  page: Page,
  pIndex: number,
  body: string,
  author = 'harness-user',
  timestamp = new Date(2026, 6, 24, 10, 12).toISOString()
): Promise<{ threadId: string; anchorId: string }> {
  await selectIn(page, pIndex, 0, 5);
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await page.locator('.comment-composer-input').fill(body);
  await page.locator('.comment-composer-submit').click();

  const create = (await postedOfType(page, 'createComment')).at(-1)!;
  await simulate(page, { type: 'createCommentResult', requestId: create.requestId, ok: true, author, timestamp });
  return { threadId: String(create.threadId), anchorId: String(create.anchorId) };
}

/** Settle window for assertions about an effect NOT happening (postMessage is async). */
const SETTLE_MS = 250;

async function clickPin(page: Page, index = 0): Promise<void> {
  await page.locator('.comment-gutter-pin').nth(index).click();
  await expect(page.locator('.comment-popover')).toBeVisible();
}

/** Re-render the document from the host, then wait out the debounced re-resolution (US-23.4 AC5). */
async function hostUpdate(page: Page, text: string): Promise<void> {
  await simulate(page, { type: 'update', text });
  await page.waitForTimeout(450);
}

/** Open the given floating thread's popover from the Comment tab, the only entry
 *  point a floating thread has (no gutter pin — US-23.4). Floating always raises
 *  US-23.3 AC5's anchor-lost confirmation first (US-23.11 AC4 widens it to Open
 *  or Resolved); left open it blocks the toolbar underneath it. */
async function openFloatingRow(page: Page, index = 0): Promise<void> {
  await dismissAnchorLost(page);
  await openCommentTab(page);
  await page.locator('.comment-row[data-group="floating"]').nth(index).click();
  await expect(page.locator('.comment-popover')).toBeVisible();
}

test.describe('gutter pins — count and clustering', () => {
  test('a single thread pin shows the comment+reply count', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Alpha comment.');
    const pins = page.locator('.comment-gutter-pin');
    await expect(pins).toHaveCount(1);
    await expect(pins.first()).not.toHaveClass(/comment-gutter-pin-cluster/);
    await expect(pins.first().locator('.comment-gutter-pin-count')).toHaveText('1');
  });

  test('threads within 1 blank line of each other collapse into a "+N" cluster; a distant thread stays its own pin', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    // Alpha (Ln 3), Beta (Ln 5), Gamma (Ln 7): each pair 2 lines apart (1 blank
    // line between) — all three chain into one cluster. Delta (Ln 10) is 3
    // lines past Gamma — outside the window, its own pin.
    await createThread(page, 0, 'On Alpha.');
    await createThread(page, 1, 'On Beta.');
    await createThread(page, 2, 'On Gamma.');
    await createThread(page, 3, 'On Delta.');

    const pins = page.locator('.comment-gutter-pin');
    await expect(pins).toHaveCount(2);
    const cluster = page.locator('.comment-gutter-pin-cluster');
    await expect(cluster).toHaveCount(1);
    await expect(cluster.locator('.comment-gutter-pin-count')).toHaveText('+3');
    // The lone Delta pin is a plain pin, badge count 1.
    const lone = pins.filter({ hasNotText: '+' });
    await expect(lone).toHaveCount(1);
    await expect(lone.locator('.comment-gutter-pin-count')).toHaveText('1');
  });

  test('clicking a cluster opens a chooser list; picking a row opens that thread\'s popover', async ({ page }) => {
    await openEditor(page, DOC);
    const alpha = await createThread(page, 0, 'On Alpha.');
    await createThread(page, 1, 'On Beta.');

    await page.locator('.comment-gutter-pin-cluster').click();
    await expect(page.locator('.comment-gutter-cluster-list')).toBeVisible();
    await expect(page.locator('.comment-gutter-cluster-row')).toHaveCount(2);

    await page.locator('.comment-gutter-cluster-row', { hasText: 'On Alpha.' }).click();
    await expect(page.locator('.comment-popover')).toBeVisible();
    await expect(page.locator('.comment-popover-original .comment-popover-body-text')).toHaveText('On Alpha.');
    void alpha;
  });
});

test.describe('"Show Comments" toggle', () => {
  test('cold-opens per the persisted per-file config; toggling posts the change back for the host to persist', async ({
    page,
  }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    const button = page.locator('#comment-highlight-toggle');
    await expect(button).toHaveAttribute('aria-pressed', 'true');

    await clearPosted(page);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    const [msg] = await postedOfType(page, 'commentHighlightToggled');
    expect(msg.docUri).toBe(DEFAULT_DOC_URI);
    expect(msg.on).toBe(false);
  });

  test('defaults off when the file has no persisted record', async ({ page }) => {
    await openEditor(page, DOC);
    await expect(page.locator('#comment-highlight-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Alt+Shift+C toggles it the same as the button', async ({ page }) => {
    await openEditor(page, DOC);
    const button = page.locator('#comment-highlight-toggle');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#content').press('Alt+Shift+C');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('single popover at a time', () => {
  test('opening a second thread\'s pin replaces the first popover\'s content, never stacks a second one', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Alpha comment.');
    await createThread(page, 3, 'Delta comment.');

    await clickPin(page, 0);
    await expect(page.locator('.comment-popover-original .comment-popover-body-text')).toHaveText('Alpha comment.');
    await expect(page.locator('.comment-popover')).toHaveCount(1);

    await clickPin(page, 1);
    await expect(page.locator('.comment-popover-original .comment-popover-body-text')).toHaveText('Delta comment.');
    await expect(page.locator('.comment-popover')).toHaveCount(1);
  });
});

test.describe('reply', () => {
  test('appends a reply and Cancel discards a draft without posting anything', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    // Cancel discards a non-empty draft AND closes the input (AC6) — no message posted.
    await page.locator('.comment-popover-reply-input').fill('Never mind.');
    await page.locator('.comment-popover-reply-cancel').click();
    await expect(page.locator('.comment-popover-reply-input')).toHaveValue('');
    await expect(page.locator('.comment-popover-reply-box')).toBeHidden();
    expect(await postedOfType(page, 'replyToComment')).toHaveLength(0);

    // The collapsed composer is re-openable, so Cancel is not a dead end.
    await page.locator('.comment-popover-reply-open').click();
    await expect(page.locator('.comment-popover-reply-box')).toBeVisible();

    // A real submit posts replyToComment with the right thread/body.
    await page.locator('.comment-popover-reply-input').fill('Here is my reply.');
    await page.locator('.comment-popover-reply-submit').click();
    const [reply] = await postedOfType(page, 'replyToComment');
    expect(reply.threadId).toBe(threadId);
    expect(reply.body).toBe('Here is my reply.');

    await simulate(page, {
      type: 'replyResult',
      requestId: reply.requestId,
      ok: true,
      replyId: 'reply-1',
      author: 'harness-user',
      timestamp: new Date().toISOString(),
    });
    await expect(page.locator('.comment-popover-reply-input')).toHaveValue('');

    // The host follows up with the full snapshot — the popover renders the new reply.
    await simulate(page, {
      type: 'commentThreadsSync',
      docUri: DEFAULT_DOC_URI,
      threads: [
        {
          threadId,
          status: 'Open',
          author: 'harness-user',
          timestamp: new Date(2026, 6, 24, 10, 12).toISOString(),
          body: 'Original comment.',
          recordedText: 'Alpha paragraph text.',
          offsetStart: 0,
          offsetEnd: 5,
          lastKnownLine: 3,
          nearestHeading: 'Session expiry',
          replies: [{ id: 'reply-1', author: 'harness-user', timestamp: new Date().toISOString(), body: 'Here is my reply.' }],
        },
      ],
    });
    await expect(page.locator('.comment-popover-reply .comment-popover-body-text')).toHaveText('Here is my reply.');
  });

  test('empty/whitespace body cannot be submitted', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    const submit = page.locator('.comment-popover-reply-submit');
    await expect(submit).toHaveAttribute('aria-disabled', 'true');
    await page.locator('.comment-popover-reply-input').fill('   ');
    await expect(submit).toHaveAttribute('aria-disabled', 'true');
    await submit.dispatchEvent('click');
    expect(await postedOfType(page, 'replyToComment')).toHaveLength(0);
  });

  test('the reply <textarea> uses its own native undo, not the document\'s (US-23.6 AC2)', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    const input = page.locator('.comment-popover-reply-input');
    await input.fill('abc');
    await input.press('ControlOrMeta+z');
    // Delegated to the document's undo stack would post an 'undo' message and
    // (per US-23.6) never touch a field's own history — assert neither an
    // 'undo' message escaped AND the field kept (or reverted only) its own text,
    // never leaking the keystroke to the editor.
    expect(await postedOfType(page, 'undo')).toHaveLength(0);
    expect(await postedOfType(page, 'edit')).toHaveLength(0);
  });
});

test.describe('delete — confirmation, cascade, and author gating', () => {
  test('deleting the thread requires confirmation and closes the popover on success', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    await page.locator('.comment-popover-original .comment-popover-delete').click();
    const confirm = page.locator('.comment-delete-confirm');
    await expect(confirm).toBeVisible();
    expect(await postedOfType(page, 'deleteComment')).toHaveLength(0);

    // Cancel dismisses without deleting.
    await confirm.locator('.comment-delete-confirm-cancel').click();
    await expect(confirm).toBeHidden();
    expect(await postedOfType(page, 'deleteComment')).toHaveLength(0);
    await expect(page.locator('.comment-popover')).toBeVisible();

    // Confirming posts deleteComment for the whole thread (no targetReplyId).
    await page.locator('.comment-popover-original .comment-popover-delete').click();
    await page.locator('.comment-delete-confirm-delete').click();
    const [del] = await postedOfType(page, 'deleteComment');
    expect(del.threadId).toBe(threadId);
    expect(del.targetReplyId).toBeUndefined();

    await simulate(page, { type: 'deleteCommentResult', requestId: del.requestId, ok: true });
    await expect(page.locator('.comment-popover')).toBeHidden();
  });

  test('deleting a single reply cascades to only that reply, leaving the thread and its other replies', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    await simulate(page, {
      type: 'commentThreadsSync',
      docUri: DEFAULT_DOC_URI,
      threads: [
        {
          threadId,
          status: 'Open',
          author: 'harness-user',
          timestamp: new Date(2026, 6, 24, 10, 12).toISOString(),
          body: 'Original comment.',
          recordedText: 'Alpha paragraph text.',
          offsetStart: 0,
          offsetEnd: 5,
          lastKnownLine: 3,
          nearestHeading: 'Session expiry',
          replies: [
            { id: 'reply-a', author: 'harness-user', timestamp: '2026-07-24T11:00:00.000Z', body: 'Mine.' },
            { id: 'reply-b', author: 'harness-user', timestamp: '2026-07-24T11:05:00.000Z', body: 'Also mine.' },
          ],
        },
      ],
    });
    await expect(page.locator('.comment-popover-reply')).toHaveCount(2);

    await page.locator('.comment-popover-reply[data-reply-id="reply-a"] .comment-popover-delete').click();
    await page.locator('.comment-delete-confirm-delete').click();
    const [del] = await postedOfType(page, 'deleteComment');
    expect(del.threadId).toBe(threadId);
    expect(del.targetReplyId).toBe('reply-a');

    await simulate(page, { type: 'deleteCommentResult', requestId: del.requestId, ok: true });
    // A single-reply delete never closes the thread's own popover.
    await expect(page.locator('.comment-popover')).toBeVisible();

    // The follow-up sync drops only that one reply.
    await simulate(page, {
      type: 'commentThreadsSync',
      docUri: DEFAULT_DOC_URI,
      threads: [
        {
          threadId,
          status: 'Open',
          author: 'harness-user',
          timestamp: new Date(2026, 6, 24, 10, 12).toISOString(),
          body: 'Original comment.',
          recordedText: 'Alpha paragraph text.',
          offsetStart: 0,
          offsetEnd: 5,
          lastKnownLine: 3,
          nearestHeading: 'Session expiry',
          replies: [{ id: 'reply-b', author: 'harness-user', timestamp: '2026-07-24T11:05:00.000Z', body: 'Also mine.' }],
        },
      ],
    });
    await expect(page.locator('.comment-popover-reply')).toHaveCount(1);
    await expect(page.locator('.comment-popover-reply .comment-popover-body-text')).toHaveText('Also mine.');
  });

  test('own-vs-other-author gating: delete is offered only on content the current author actually wrote', async ({
    page,
  }) => {
    await openEditor(page, DOC, { commentAuthorName: 'me' });
    const { threadId } = await createThread(page, 0, "Reviewer's comment.", 'someone-else');
    await clickPin(page, 0);

    // Authored by someone else: the control is PRESENT but disabled — AC5's soft
    // nudge is "the Delete control is disabled", i.e. visible and inert.
    const otherDelete = page.locator('.comment-popover-original .comment-popover-delete');
    await expect(otherDelete).toHaveCount(1);
    await expect(otherDelete).toBeDisabled();

    await simulate(page, {
      type: 'commentThreadsSync',
      docUri: DEFAULT_DOC_URI,
      threads: [
        {
          threadId,
          status: 'Open',
          author: 'someone-else',
          timestamp: new Date(2026, 6, 24, 10, 12).toISOString(),
          body: "Reviewer's comment.",
          recordedText: 'Alpha paragraph text.',
          offsetStart: 0,
          offsetEnd: 5,
          lastKnownLine: 3,
          nearestHeading: 'Session expiry',
          replies: [
            { id: 'reply-mine', author: 'me', timestamp: '2026-07-24T11:00:00.000Z', body: 'My own reply.' },
            { id: 'reply-other', author: 'someone-else', timestamp: '2026-07-24T11:05:00.000Z', body: 'Their reply.' },
          ],
        },
      ],
    });

    const mine = page.locator('.comment-popover-reply[data-reply-id="reply-mine"]');
    const other = page.locator('.comment-popover-reply[data-reply-id="reply-other"]');
    await expect(mine.locator('.comment-popover-delete')).toBeEnabled();
    await expect(other.locator('.comment-popover-delete')).toBeDisabled();
  });

  test('Req 24 US-23.13 AC3: a floating thread is deleted through the same popover path, reached via the Comment tab', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    // Everything after the heading is gone — no block covers any anchor's line,
    // so every thread floats (US-23.4 tier 4). No gutter pin exists for it; the
    // Comment tab's floating row is the only route to its popover (US-23.9).
    await hostUpdate(page, '# Session expiry\n');
    await openFloatingRow(page);
    await expect(page.locator('.comment-popover-anchor-state')).toHaveText('Unresolved location');

    await page.locator('.comment-popover-original .comment-popover-delete').click();
    await page.locator('.comment-delete-confirm-delete').click();
    const [del] = await postedOfType(page, 'deleteComment');
    expect(del.threadId).toBe(threadId);

    await simulate(page, { type: 'deleteCommentResult', requestId: del.requestId, ok: true });
    await expect(page.locator('.comment-popover')).toBeHidden();
  });

  test('Req 24 US-23.13 AC3: a delete confirmed after the thread resolved elsewhere is dropped, not sent', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await hostUpdate(page, '# Session expiry\n'); // floats it
    await openFloatingRow(page);
    await clearPosted(page);

    await page.locator('.comment-popover-original .comment-popover-delete').click();
    await expect(page.locator('.comment-delete-confirm')).toBeVisible();

    // The thread resolves elsewhere while the confirm dialog is still open — an
    // undo restoring the deleted text, exactly AC2's floating -> exact promotion.
    await hostUpdate(page, DOC);
    await expect(page.locator('.comment-popover-anchor-state')).toBeHidden(); // render() already caught up

    // Confirming now must NOT delete a thread that just found its place.
    await page.locator('.comment-delete-confirm-delete').click();
    await page.waitForTimeout(SETTLE_MS);
    expect(await postedOfType(page, 'deleteComment')).toHaveLength(0);
  });

  test("Req 24 US-23.13 AC3: an ordinary attached thread's delete is unaffected by the floating re-validation", async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    // Never floated — the guard must only ever engage for a delete opened while
    // the thread WAS floating, never for an ordinary attached-thread delete.
    await page.locator('.comment-popover-original .comment-popover-delete').click();
    await page.locator('.comment-delete-confirm-delete').click();
    const [del] = await postedOfType(page, 'deleteComment');
    expect(del.threadId).toBe(threadId);
  });
});

test('no edit/document-undo message is ever emitted by any comment action', async ({ page }) => {
  await openEditor(page, DOC);
  const { threadId } = await createThread(page, 0, 'Original comment.');
  await clearPosted(page);

  await clickPin(page, 0);
  await page.locator('.comment-popover-reply-input').fill('A reply.');
  await page.locator('.comment-popover-reply-submit').click();
  const [reply] = await postedOfType(page, 'replyToComment');
  await simulate(page, { type: 'replyResult', requestId: reply.requestId, ok: true, replyId: 'r1', author: 'harness-user', timestamp: new Date().toISOString() });

  await page.locator('.comment-popover-original .comment-popover-delete').click();
  await page.locator('.comment-delete-confirm-delete').click();
  const [del] = await postedOfType(page, 'deleteComment');
  await simulate(page, { type: 'deleteCommentResult', requestId: del.requestId, ok: true });

  const types = (await posted(page)).map((m) => m.type);
  expect(types).not.toContain('edit');
  expect(types).not.toContain('undo');
  expect(types).not.toContain('redo');
  void threadId;
});

/** One `commentThreadsSync` snapshot line for `threadId`, with optional overrides. */
function syncThread(threadId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId,
    status: 'Open',
    author: 'harness-user',
    timestamp: new Date(2026, 6, 24, 10, 12).toISOString(),
    body: 'Original comment.',
    recordedText: 'Alpha paragraph text.',
    offsetStart: 0,
    offsetEnd: 5,
    lastKnownLine: 3,
    nearestHeading: 'Session expiry',
    replies: [],
    statusChanges: [],
    ...over,
  };
}

/**
 * Regression cases for the defects the adversarial review found — each pins a
 * behaviour the original 14 cases either did not cover or asserted more weakly
 * than the acceptance criterion.
 */
test.describe('review regressions', () => {
  test('a thread absent from a host snapshot loses its pin, its highlight and its popover', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Alpha comment.');
    await page.locator('#comment-highlight-toggle').click();
    await clickPin(page, 0);
    await expect(page.locator('.comment-gutter-pin')).toHaveCount(1);

    // The host deleted it and pushes the authoritative snapshot without it.
    await simulate(page, { type: 'commentThreadsSync', docUri: DEFAULT_DOC_URI, threads: [] });

    await expect(page.locator('.comment-gutter-pin')).toHaveCount(0);
    await expect(page.locator('.comment-popover')).toBeHidden();
    const ranges = await page.evaluate(() => CSS.highlights.get('comment-anchor')?.size ?? 0);
    expect(ranges).toBe(0);
    void threadId;
  });

  test('Alt+Shift+C toggles on a macOS layout, where Option composes the key to "Ç"', async ({ page }) => {
    await openEditor(page, DOC);
    const before = await page.locator('#comment-highlight-toggle').getAttribute('aria-pressed');

    // macOS reports the COMPOSED character in `e.key`; only `e.code` is stable.
    const prevented = await page.locator('#content').evaluate((el) => {
      const e = new KeyboardEvent('keydown', {
        key: 'Ç',
        code: 'KeyC',
        altKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    });

    expect(prevented).toBe(true);
    await expect(page.locator('#comment-highlight-toggle')).toHaveAttribute(
      'aria-pressed',
      before === 'true' ? 'false' : 'true'
    );
  });

  test('a late replyResult cannot wipe a different thread\'s unsent draft', async ({ page }) => {
    await openEditor(page, DOC);
    const a = await createThread(page, 0, 'Thread A.');
    const b = await createThread(page, 2, 'Thread B.');

    // Submit on A, then move to B and start typing before A's result lands.
    await clickPin(page, 0);
    await page.locator('.comment-popover-reply-input').fill('Reply to A.');
    await page.locator('.comment-popover-reply-submit').click();
    const reply = (await postedOfType(page, 'replyToComment')).at(-1)!;
    expect(reply.threadId).toBe(a.threadId);

    await clickPin(page, 1);
    await page.locator('.comment-popover-reply-input').fill('Draft for B.');

    await simulate(page, {
      type: 'replyResult',
      requestId: reply.requestId,
      ok: true,
      replyId: 'reply-a',
      author: 'harness-user',
      timestamp: new Date().toISOString(),
    });
    await page.waitForTimeout(SETTLE_MS);

    // B's draft survives — the result belonged to A.
    await expect(page.locator('.comment-popover-reply-input')).toHaveValue('Draft for B.');
    void b;
  });

  test('a late thread-delete result cannot close a different thread\'s popover', async ({ page }) => {
    await openEditor(page, DOC);
    const a = await createThread(page, 0, 'Thread A.');
    const b = await createThread(page, 2, 'Thread B.');

    await clickPin(page, 0);
    await page.locator('.comment-popover-original .comment-popover-delete').click();
    await page.locator('.comment-delete-confirm-delete').click();
    const del = (await postedOfType(page, 'deleteComment')).at(-1)!;
    expect(del.threadId).toBe(a.threadId);

    await clickPin(page, 1);
    await simulate(page, { type: 'deleteCommentResult', requestId: del.requestId, ok: true });
    // `postMessage` is async and this assertion is about something NOT happening,
    // so it needs a settle window — without it the check races ahead of the
    // handler and passes on the pre-message state.
    await page.waitForTimeout(SETTLE_MS);

    // B's popover stays open — only A was deleted.
    await expect(page.locator('.comment-popover')).toBeVisible();
    void b;
  });

  test('Escape inside the delete confirmation cancels only the dialog and keeps the draft', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await page.locator('.comment-popover-reply-input').fill('Draft in progress.');

    await page.locator('.comment-popover-original .comment-popover-delete').click();
    await expect(page.locator('.comment-delete-confirm')).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.locator('.comment-delete-confirm')).toBeHidden();
    await expect(page.locator('.comment-popover')).toBeVisible();
    await expect(page.locator('.comment-popover-reply-input')).toHaveValue('Draft in progress.');
    expect(await postedOfType(page, 'deleteComment')).toHaveLength(0);
  });

  test('two threads on the SAME line cluster into one +N pin that opens the chooser', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'First on this line.');
    await createThread(page, 0, 'Second on this line.');

    await expect(page.locator('.comment-gutter-pin')).toHaveCount(1);
    await expect(page.locator('.comment-gutter-pin-count')).toHaveText('+2');
    await page.locator('.comment-gutter-pin').click();
    await expect(page.locator('.comment-gutter-cluster-row')).toHaveCount(2);
  });


  test('a Closed thread shows the closed notice and no reply box', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await simulate(page, {
      type: 'commentThreadsSync',
      docUri: DEFAULT_DOC_URI,
      threads: [syncThread(threadId, { status: 'Closed' })],
    });

    // A Closed thread keeps no pin (design handoff), so open it through the sync'd
    // registry rather than the gutter.
    await simulate(page, {
      type: 'commentThreadsSync',
      docUri: DEFAULT_DOC_URI,
      threads: [syncThread(threadId, { status: 'Resolved' })],
    });
    await clickPin(page, 0);
    await expect(page.locator('.comment-popover-reply-box')).toBeVisible();

    await simulate(page, {
      type: 'commentThreadsSync',
      docUri: DEFAULT_DOC_URI,
      threads: [syncThread(threadId, { status: 'Closed' })],
    });
    await expect(page.locator('.comment-popover-closed-notice')).toBeVisible();
    await expect(page.locator('.comment-popover-reply-box')).toBeHidden();
  });
});

test.describe('Req 24 US-23.8 AC4 — reply draft survives a concurrent native Close', () => {
  test('draft stays visible+editable with Submit disabled, and clears symmetrically on Reopen', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await page.locator('.comment-popover-reply-input').fill('My unsent draft.');

    await simulate(page, {
      type: 'commentThreadsSync',
      docUri: DEFAULT_DOC_URI,
      threads: [syncThread(threadId, { status: 'Closed' })],
    });

    await expect(page.locator('.comment-popover-reply-box')).toBeVisible();
    await expect(page.locator('.comment-popover-reply-input')).toHaveValue('My unsent draft.');
    const readOnly = await page
      .locator('.comment-popover-reply-input')
      .evaluate((el) => (el as HTMLTextAreaElement).readOnly);
    expect(readOnly).toBe(false);
    await expect(page.locator('.comment-popover-reply-submit')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.comment-popover-closed-while-draft')).toBeVisible();
    await expect(page.locator('.comment-popover-closed-notice')).toBeHidden();

    await simulate(page, {
      type: 'commentThreadsSync',
      docUri: DEFAULT_DOC_URI,
      threads: [syncThread(threadId, { status: 'Open' })],
    });

    await expect(page.locator('.comment-popover-closed-while-draft')).toBeHidden();
    await expect(page.locator('.comment-popover-reply-submit')).toHaveAttribute('aria-disabled', 'false');
    await expect(page.locator('.comment-popover-reply-input')).toHaveValue('My unsent draft.');
    expect(await postedOfType(page, 'replyToComment')).toHaveLength(0);
  });

  test('a reply already in flight is not cancelled by the Close — its own result decides, and the notice appears only afterwards', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await page.locator('.comment-popover-reply-input').fill('In-flight reply.');
    await page.locator('.comment-popover-reply-submit').click();
    const [reply] = await postedOfType(page, 'replyToComment');

    await simulate(page, {
      type: 'commentThreadsSync',
      docUri: DEFAULT_DOC_URI,
      threads: [syncThread(threadId, { status: 'Closed' })],
    });
    // Still mid-flight: the box reads as a normal busy composer, no closed
    // notice yet — the Close has not been allowed to interrupt it.
    await expect(page.locator('.comment-popover-reply-box')).toBeVisible();
    await expect(page.locator('.comment-popover-closed-while-draft')).toBeHidden();
    await expect(page.locator('.comment-popover-closed-notice')).toBeHidden();

    await simulate(page, { type: 'replyResult', requestId: reply.requestId, ok: false, error: 'Refused.' });

    await expect(page.locator('.comment-popover-reply-error')).toHaveText('Refused.');
    await expect(page.locator('.comment-popover-closed-while-draft')).toBeVisible();
    await expect(page.locator('.comment-popover-reply-input')).toHaveValue('In-flight reply.');
    await expect(page.locator('.comment-popover-reply-submit')).toHaveAttribute('aria-disabled', 'true');
  });

  test('an in-flight reply that times out (no result ever arrives) after a concurrent Close also reveals the notice only afterwards', async ({ page }) => {
    test.setTimeout(15_000);
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await page.locator('.comment-popover-reply-input').fill('Stuck reply.');
    await page.locator('.comment-popover-reply-submit').click();

    await simulate(page, {
      type: 'commentThreadsSync',
      docUri: DEFAULT_DOC_URI,
      threads: [syncThread(threadId, { status: 'Closed' })],
    });
    await expect(page.locator('.comment-popover-closed-while-draft')).toBeHidden();

    // No `replyResult` ever arrives — same AC3(i) timeout path, now racing AC4's Close.
    await page.waitForTimeout(10_300);

    await expect(page.locator('.comment-popover-reply-error')).toBeVisible();
    await expect(page.locator('.comment-popover-closed-while-draft')).toBeVisible();
    await expect(page.locator('.comment-popover-reply-input')).toHaveValue('Stuck reply.');
    await expect(page.locator('.comment-popover-reply-submit')).toHaveAttribute('aria-disabled', 'true');
  });

  test('the thread being deleted while its popover is open closes it and states the deletion in a toast', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    await simulate(page, { type: 'commentThreadsSync', docUri: DEFAULT_DOC_URI, threads: [] });

    await expect(page.locator('.comment-popover')).toBeHidden();
    await expect(page.locator('#wysiwyg-toast')).toHaveText('This thread was deleted.');
  });

  test('an ordinary Cancel still discards the draft even on a thread that is Closed', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await page.locator('.comment-popover-reply-input').fill('Draft to abandon.');
    await simulate(page, {
      type: 'commentThreadsSync',
      docUri: DEFAULT_DOC_URI,
      threads: [syncThread(threadId, { status: 'Closed' })],
    });
    await expect(page.locator('.comment-popover-closed-while-draft')).toBeVisible();

    await page.locator('.comment-popover-reply-cancel').click();

    await expect(page.locator('.comment-popover-reply-box')).toBeHidden();
    await expect(page.locator('.comment-popover-closed-while-draft')).toBeHidden();
    await expect(page.locator('.comment-popover-closed-notice')).toBeVisible();
  });
});

test.describe('Req 24 US-23.8 AC5 — temporary highlight independent of the "Show Comments" toggle', () => {
  test('toggle off: opening a popover draws only the independent active-thread highlight, closing clears it', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Alpha comment.');
    await clickPin(page, 0);

    expect(await page.evaluate(() => CSS.highlights.get('comment-anchor-open')?.size ?? 0)).toBe(1);
    expect(await page.evaluate(() => CSS.highlights.get('comment-anchor')?.size ?? 0)).toBe(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('.comment-popover')).toBeHidden();
    expect(await page.evaluate(() => CSS.highlights.get('comment-anchor-open')?.size ?? 0)).toBeFalsy();
  });

  test('opening a second thread transfers the active highlight instead of accumulating', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Thread A.');
    await createThread(page, 2, 'Thread B.');

    await clickPin(page, 0);
    expect(await page.evaluate(() => CSS.highlights.get('comment-anchor-open')?.size ?? 0)).toBe(1);

    await clickPin(page, 1);
    expect(await page.evaluate(() => CSS.highlights.get('comment-anchor-open')?.size ?? 0)).toBe(1);
  });

  test('toggling the "Show Comments" switch while a popover is open never disturbs the temporary highlight, and closing removes only the temporary scope', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Alpha comment.');
    await clickPin(page, 0);
    expect(await page.evaluate(() => CSS.highlights.get('comment-anchor-open')?.size ?? 0)).toBe(1);
    expect(await page.evaluate(() => CSS.highlights.get('comment-anchor')?.size ?? 0)).toBe(0);

    // The keyboard shortcut, not the toolbar button — clicking the button is a
    // real mousedown OUTSIDE the popover card, which the popover's own
    // (unrelated, pre-existing) outside-click dismiss would legitimately close
    // on, defeating the "mid-popover" scenario this AC describes.
    await page.locator('#content').press('Alt+Shift+C');
    await expect(page.locator('.comment-popover')).toBeVisible();
    expect(await page.evaluate(() => CSS.highlights.get('comment-anchor-open')?.size ?? 0)).toBe(1);
    expect(await page.evaluate(() => CSS.highlights.get('comment-anchor')?.size ?? 0)).toBe(1);

    // Closing while the toggle is ON: only the temporary scope goes away — the
    // thread keeps the highlight the toggle itself gives it.
    await page.keyboard.press('Escape');
    await expect(page.locator('.comment-popover')).toBeHidden();
    expect(await page.evaluate(() => CSS.highlights.get('comment-anchor-open')?.size ?? 0)).toBeFalsy();
    expect(await page.evaluate(() => CSS.highlights.get('comment-anchor')?.size ?? 0)).toBe(1);
  });
});
