/**
 * Req 24 US-23.14 — edit an already-posted comment or reply: the popover's Edit
 * action, its pre-filled field, Save/Cancel, the Closed-thread gate, the
 * unchanged-text no-op, the empty-body refusal, the 4000/3800 body bound, the
 * per-target dedup guard, the "edited ⟨timestamp⟩" marker, and the
 * deleted-while-editing race.
 *
 * Playwright track (Plan/WEBVIEW_TEST.md): the Edit button only exists after a
 * real click on a real positioned gutter pin, the field is a real `<textarea>`
 * whose caret/selection and native undo need a real browser engine, and the
 * dedup guard is only observable by dispatching two real clicks faster than a
 * simulated host can reply — none of which a hand-built DOM snapshot
 * (test/roundtrip/) can produce.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted, DEFAULT_DOC_URI } from './_harness';

// Alpha (Ln 3) and Beta (Ln 7) are two DIFFERENT lines, so each keeps its own
// pin and `clickPin(0)`/`clickPin(1)` address them individually (only two
// threads on the SAME line collapse into one "+2" pin).
const DOC = [
  '# Session expiry', // line 1
  '', // 2
  'Alpha paragraph text.', // 3
  '', // 4
  '', // 5
  '', // 6
  'Beta paragraph text.', // 7
].join('\n');

const CREATED_AT = new Date(2026, 6, 24, 10, 12).toISOString();

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

/** Settle window for assertions about an effect NOT happening (postMessage is async). */
const SETTLE_MS = 250;

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

async function createThread(
  page: Page,
  pIndex: number,
  body: string,
  author = 'harness-user'
): Promise<{ threadId: string }> {
  await selectIn(page, pIndex, 0, 5);
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await page.locator('.comment-composer-input').fill(body);
  await page.locator('.comment-composer-submit').click();

  const create = (await postedOfType(page, 'createComment')).at(-1)!;
  await simulate(page, { type: 'createCommentResult', requestId: create.requestId, ok: true, author, timestamp: CREATED_AT });
  return { threadId: String(create.threadId) };
}

async function clickPin(page: Page, index = 0): Promise<void> {
  await page.locator('.comment-gutter-pin').nth(index).click();
  await expect(page.locator('.comment-popover')).toBeVisible();
}

/** One `commentThreadsSync` snapshot line, with optional overrides. */
function syncThread(threadId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId,
    status: 'Open',
    author: 'harness-user',
    timestamp: CREATED_AT,
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

async function pushSync(page: Page, threadId: string, over: Record<string, unknown> = {}): Promise<void> {
  await simulate(page, { type: 'commentThreadsSync', docUri: DEFAULT_DOC_URI, threads: [syncThread(threadId, over)] });
}

const editField = '.comment-popover-edit-input';
const originalRow = '.comment-popover-original';

test.describe('AC1 — the Edit action and its field', () => {
  test('Edit opens a field pre-filled with the displayed text; Cancel restores it and writes nothing', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    // No field until Edit is chosen.
    await expect(page.locator(editField)).toHaveCount(0);
    await page.locator(`${originalRow} .comment-popover-edit`).click();

    const field = page.locator(editField);
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('Original comment.');
    // The body text it replaced is no longer rendered as static text.
    await expect(page.locator(`${originalRow} .comment-popover-body-text`)).toHaveCount(0);

    await page.locator('.comment-popover-edit-cancel').click();
    await expect(page.locator(editField)).toHaveCount(0);
    await expect(page.locator(`${originalRow} .comment-popover-body-text`)).toHaveText('Original comment.');
    expect(await postedOfType(page, 'editComment')).toHaveLength(0);
  });

  test('Save posts editComment with the new body and no targetReplyId for the opening comment', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await clearPosted(page);

    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill('Corrected wording.');
    await page.locator('.comment-popover-edit-save').click();

    const [edit] = await postedOfType(page, 'editComment');
    expect(edit.threadId).toBe(threadId);
    expect(edit.body).toBe('Corrected wording.');
    expect(edit.targetReplyId).toBeUndefined();

    // The field closes on success; the follow-up sync carries the new body.
    await simulate(page, { type: 'editCommentResult', requestId: edit.requestId, ok: true });
    await expect(page.locator(editField)).toHaveCount(0);
    await pushSync(page, threadId, { body: 'Corrected wording.', editedAt: '2026-07-28T16:00:00.000Z' });
    await expect(page.locator(`${originalRow} .comment-popover-body-text`)).toHaveText('Corrected wording.');
  });

  test('a reply is edited through the same field, naming that reply as the target', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await pushSync(page, threadId, {
      replies: [{ id: 'reply-a', author: 'harness-user', timestamp: '2026-07-24T11:00:00.000Z', body: 'A typo heer.' }],
    });
    await clearPosted(page);

    await page.locator('.comment-popover-reply[data-reply-id="reply-a"] .comment-popover-edit').click();
    await expect(page.locator(editField)).toHaveValue('A typo heer.');
    await page.locator(editField).fill('A typo here.');
    await page.locator('.comment-popover-edit-save').click();

    const [edit] = await postedOfType(page, 'editComment');
    expect(edit.threadId).toBe(threadId);
    expect(edit.targetReplyId).toBe('reply-a');
    expect(edit.body).toBe('A typo here.');
  });

  test('the edit field pre-fills from the POST-FOLD displayed text, not an earlier original', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    // The host has already folded one edit into this thread's displayed body.
    await pushSync(page, threadId, { body: 'Already edited once.', editedAt: '2026-07-28T16:00:00.000Z' });

    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await expect(page.locator(editField)).toHaveValue('Already edited once.');
  });

  test('the edit <textarea> uses its own native undo, never the document\'s (US-23.6 AC2)', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await clearPosted(page);

    const field = page.locator(editField);
    await field.fill('abc');
    await field.press('ControlOrMeta+z');

    expect(await postedOfType(page, 'undo')).toHaveLength(0);
    expect(await postedOfType(page, 'edit')).toHaveLength(0);
  });
});

test.describe('AC1 — Edit is gated on thread status, never on authorship', () => {
  test('a Closed thread offers no Edit at all, and Reopening brings it back', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await pushSync(page, threadId, { status: 'Resolved' });
    await clickPin(page, 0);
    // Resolved is still editable — only Closed is locked out.
    await expect(page.locator(`${originalRow} .comment-popover-edit`)).toHaveCount(1);

    await pushSync(page, threadId, { status: 'Closed' });
    await expect(page.locator(`${originalRow} .comment-popover-edit`)).toHaveCount(0);

    await pushSync(page, threadId, { status: 'Open' });
    await expect(page.locator(`${originalRow} .comment-popover-edit`)).toHaveCount(1);
  });

  test('AC8: Edit is offered on content written by someone else — unlike Delete, it has no authority gate', async ({ page }) => {
    await openEditor(page, DOC, { commentAuthorName: 'me' });
    const { threadId } = await createThread(page, 0, "Reviewer's comment.", 'someone-else');
    await clickPin(page, 0);
    await pushSync(page, threadId, {
      author: 'someone-else',
      body: "Reviewer's comment.",
      replies: [{ id: 'reply-other', author: 'someone-else', timestamp: '2026-07-24T11:05:00.000Z', body: 'Their reply.' }],
    });

    // Delete stays author-gated (US-23.2 AC5) while Edit does not — the two
    // controls sit in the same row and must disagree here.
    await expect(page.locator(`${originalRow} .comment-popover-delete`)).toBeDisabled();
    await expect(page.locator(`${originalRow} .comment-popover-edit`)).toBeEnabled();
    const other = page.locator('.comment-popover-reply[data-reply-id="reply-other"]');
    await expect(other.locator('.comment-popover-delete')).toBeDisabled();
    await expect(other.locator('.comment-popover-edit')).toBeEnabled();

    // ...and it actually works, not merely enabled-looking.
    await clearPosted(page);
    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill("Reviewer's comment, reworded.");
    await page.locator('.comment-popover-edit-save').click();
    const [edit] = await postedOfType(page, 'editComment');
    expect(edit.threadId).toBe(threadId);
  });
});

test.describe('AC2 — Save refusals and the unchanged-text no-op', () => {
  test('an unchanged body (after trimming) is treated as Cancel — nothing posted, field closed', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await clearPosted(page);

    await page.locator(`${originalRow} .comment-popover-edit`).click();
    // Only surrounding whitespace differs — trimmed, this is the same text.
    await page.locator(editField).fill('   Original comment.   ');
    await page.locator('.comment-popover-edit-save').click();
    await page.waitForTimeout(SETTLE_MS);

    expect(await postedOfType(page, 'editComment')).toHaveLength(0);
    await expect(page.locator(editField)).toHaveCount(0);
    await expect(page.locator(`${originalRow} .comment-popover-body-text`)).toHaveText('Original comment.');
  });

  test('an empty/whitespace-only body is refused inline, the field stays open with the text intact', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await clearPosted(page);

    await page.locator(`${originalRow} .comment-popover-edit`).click();
    const save = page.locator('.comment-popover-edit-save');
    await page.locator(editField).fill('   ');
    // The control is inert AND a forced click posts nothing — Save being
    // aria-disabled is not on its own proof the handler refuses.
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await save.dispatchEvent('click');
    await page.waitForTimeout(SETTLE_MS);

    expect(await postedOfType(page, 'editComment')).toHaveLength(0);
    await expect(page.locator('.comment-popover-edit-error')).toBeVisible();
    await expect(page.locator(editField)).toHaveValue('   ');
  });

  test('a refused save keeps the field open with the typed edit intact for retry', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill('My correction.');
    await page.locator('.comment-popover-edit-save').click();
    const [edit] = await postedOfType(page, 'editComment');

    await simulate(page, { type: 'editCommentResult', requestId: edit.requestId, ok: false, error: 'Disk is full.' });

    await expect(page.locator('.comment-popover-edit-error')).toHaveText('Disk is full.');
    await expect(page.locator(editField)).toHaveValue('My correction.');
    // The displayed body was never optimistically updated.
    expect(await postedOfType(page, 'editComment')).toHaveLength(1);
  });
});

test.describe('AC6 — the per-target dedup guard', () => {
  test('a double-click on Save posts exactly one editComment', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await clearPosted(page);

    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill('Corrected once.');
    const save = page.locator('.comment-popover-edit-save');
    // Two real clicks with no host reply in between — the guard, not the host,
    // is what has to stop the second one.
    await save.click();
    await save.dispatchEvent('click');
    await page.waitForTimeout(SETTLE_MS);

    expect(await postedOfType(page, 'editComment')).toHaveLength(1);
  });

  test('the guard is released by a refusal, so an immediate retry is allowed', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await clearPosted(page);

    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill('First try.');
    await page.locator('.comment-popover-edit-save').click();
    const [first] = await postedOfType(page, 'editComment');
    await simulate(page, { type: 'editCommentResult', requestId: first.requestId, ok: false, error: 'Refused.' });
    await expect(page.locator('.comment-popover-edit-error')).toBeVisible();

    await page.locator(editField).fill('Second try.');
    await page.locator('.comment-popover-edit-save').click();
    expect(await postedOfType(page, 'editComment')).toHaveLength(2);
  });

  test('a stuck save releases its guard on the bounded timeout and says so, never staying dead for the session', async ({ page }) => {
    test.setTimeout(20_000);
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await clearPosted(page);

    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill('Stuck edit.');
    await page.locator('.comment-popover-edit-save').click();
    expect(await postedOfType(page, 'editComment')).toHaveLength(1);

    // No `editCommentResult` ever arrives — the same bounded release US-23.8
    // AC3(i) applies to reply (COMMENT_REPLY_RESULT_TIMEOUT_MS = 10s).
    await page.waitForTimeout(10_300);
    await expect(page.locator('.comment-popover-edit-error')).toBeVisible();
    await expect(page.locator(editField)).toHaveValue('Stuck edit.');

    // Released: a retry goes through rather than being swallowed.
    await page.locator('.comment-popover-edit-save').click();
    expect(await postedOfType(page, 'editComment')).toHaveLength(2);
  });

  test('a late editCommentResult for another thread cannot close the field open on this one', async ({ page }) => {
    await openEditor(page, DOC);
    const a = await createThread(page, 0, 'Thread A.');
    await createThread(page, 1, 'Thread B.');

    // Start a save on A, then move to B and open ITS field before A's result lands.
    await clickPin(page, 0);
    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill('Edit of A.');
    await page.locator('.comment-popover-edit-save').click();
    const edit = (await postedOfType(page, 'editComment')).at(-1)!;
    expect(edit.threadId).toBe(a.threadId);

    await clickPin(page, 1);
    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill('Draft on B.');

    await simulate(page, { type: 'editCommentResult', requestId: edit.requestId, ok: false, error: 'A failed.' });
    await page.waitForTimeout(SETTLE_MS);

    // B's field and its draft survive — the result belonged to A.
    await expect(page.locator(editField)).toHaveValue('Draft on B.');
    await expect(page.locator('.comment-popover-edit-error')).toBeHidden();
  });
});

test.describe('AC7 — the shared 4000/3800 body bound', () => {
  test('the counter appears only past 3800 code points and a paste over 4000 is clipped', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    await page.locator(`${originalRow} .comment-popover-edit`).click();
    const field = page.locator(editField);
    const counter = page.locator('.comment-popover-edit-counter');

    // Well under the threshold: no counter.
    await field.fill('short');
    await expect(counter).toBeHidden();

    // Past 3800 but under the cap: the counter shows.
    await field.fill('a'.repeat(3900));
    await expect(counter).toBeVisible();
    await expect(counter).toHaveText('3900/4000');

    // Over the cap: clipped to exactly 4000, code-point-safe.
    await field.fill('a'.repeat(4100));
    await expect(field).toHaveValue('a'.repeat(4000));
    await expect(counter).toHaveText('4000/4000');
  });

  test('clipping an astral (surrogate-pair) character never splits it mid-character', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await page.locator(`${originalRow} .comment-popover-edit`).click();

    const field = page.locator(editField);
    // 3999 ASCII + one emoji = exactly 4000 code points, then overflow after it.
    await field.fill(`${'a'.repeat(3999)}😀TRAILING`);
    const value = await field.inputValue();
    // Code-point length is the cap, and the emoji survived whole (its two UTF-16
    // units both present) rather than being cut into a lone surrogate.
    expect(Array.from(value)).toHaveLength(4000);
    expect(value.endsWith('😀')).toBe(true);
  });
});

test.describe('AC4 — the "edited" marker', () => {
  test('a body edited at least once is marked, and an unedited one is not', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    await expect(page.locator(`${originalRow} .comment-popover-edited`)).toHaveCount(0);

    await pushSync(page, threadId, {
      body: 'Edited body.',
      editedAt: '2026-07-28T16:00:00.000Z',
      replies: [{ id: 'reply-a', author: 'harness-user', timestamp: '2026-07-24T11:00:00.000Z', body: 'Untouched reply.' }],
    });

    const marker = page.locator(`${originalRow} .comment-popover-edited`);
    await expect(marker).toHaveCount(1);
    await expect(marker).toContainText('edited');
    // The reply carries no edit line, so it must NOT inherit the marker.
    await expect(page.locator('.comment-popover-reply .comment-popover-edited')).toHaveCount(0);
  });

  test('the marker renders the WINNING edit\'s timestamp, and the original author/time are untouched', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    const marker = page.locator(`${originalRow} .comment-popover-edited`);

    // First edit's stamp.
    await pushSync(page, threadId, { body: 'First edit.', editedAt: '2026-07-28T09:00:00.000Z' });
    const firstStamp = await marker.textContent();
    expect(firstStamp).toMatch(/^edited /);

    // A second, later edit wins the fold — the marker must move to ITS stamp,
    // never stay on the first edit ever made. Compared against the first
    // marker's own rendering rather than a hardcoded string, since the format is
    // locale/timezone-dependent and would otherwise pin the test to one machine.
    await pushSync(page, threadId, { body: 'Second edit.', editedAt: '2026-07-28T18:30:00.000Z' });
    const secondStamp = await marker.textContent();
    expect(secondStamp).toMatch(/^edited /);
    expect(secondStamp).not.toBe(firstStamp);

    // AC3: an edit never overwrites the original author/timestamp. The row's own
    // time field still shows the CREATION time (10:12), not either edit's.
    await expect(page.locator(`${originalRow} .comment-popover-time`)).toContainText('10:12');
    await expect(page.locator(`${originalRow} .comment-popover-author`)).toHaveText('harness-user');
    expect(secondStamp).not.toContain('10:12');
  });

  test('an edited reply gets its own marker independently of the opening comment', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await pushSync(page, threadId, {
      replies: [
        { id: 'reply-a', author: 'harness-user', timestamp: '2026-07-24T11:00:00.000Z', body: 'Edited reply.', editedAt: '2026-07-28T16:00:00.000Z' },
        { id: 'reply-b', author: 'harness-user', timestamp: '2026-07-24T11:05:00.000Z', body: 'Plain reply.' },
      ],
    });

    await expect(page.locator(`${originalRow} .comment-popover-edited`)).toHaveCount(0);
    await expect(page.locator('.comment-popover-reply[data-reply-id="reply-a"] .comment-popover-edited')).toHaveCount(1);
    await expect(page.locator('.comment-popover-reply[data-reply-id="reply-b"] .comment-popover-edited')).toHaveCount(0);
  });
});

test.describe('AC1 — races while the field is open', () => {
  test('the edited reply being deleted while the field is open closes it with a stated notice', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await pushSync(page, threadId, {
      replies: [{ id: 'reply-a', author: 'harness-user', timestamp: '2026-07-24T11:00:00.000Z', body: 'Doomed reply.' }],
    });

    await page.locator('.comment-popover-reply[data-reply-id="reply-a"] .comment-popover-edit').click();
    await page.locator(editField).fill('Editing a doomed reply.');
    await clearPosted(page);

    // Another session deleted that reply — the next authoritative snapshot omits it.
    await pushSync(page, threadId, { replies: [] });

    await expect(page.locator(editField)).toHaveCount(0);
    await expect(page.locator('#wysiwyg-toast')).toHaveText('This comment was deleted.');
    // No `edit` line is appended for the vanished target.
    expect(await postedOfType(page, 'editComment')).toHaveLength(0);
  });

  test('the whole thread being deleted while the field is open closes the popover, appending nothing', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill('Editing a doomed thread.');
    await clearPosted(page);

    await simulate(page, { type: 'commentThreadsSync', docUri: DEFAULT_DOC_URI, threads: [] });

    await expect(page.locator('.comment-popover')).toBeHidden();
    expect(await postedOfType(page, 'editComment')).toHaveLength(0);
  });

  test("a concurrent edit from another session does NOT force-refresh the open field's own draft", async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill('My in-progress wording.');

    // Another session's `edit` line lands, so the host pushes a new displayed
    // body for the same target. AC1's sub-criterion: the open field is neither
    // force-refreshed nor warned — last-write-wins is settled by the fold.
    await pushSync(page, threadId, { body: 'Their edit.', editedAt: '2026-07-28T17:00:00.000Z' });
    await page.waitForTimeout(SETTLE_MS);

    await expect(page.locator(editField)).toHaveValue('My in-progress wording.');

    // ...and Save still sends this field's own body.
    await clearPosted(page);
    await page.locator('.comment-popover-edit-save').click();
    const [edit] = await postedOfType(page, 'editComment');
    expect(edit.body).toBe('My in-progress wording.');
  });

  test('a settled re-resolution pass keeps the field open, its draft, and its caret position', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);

    await page.locator(`${originalRow} .comment-popover-edit`).click();
    const field = page.locator(editField);
    await field.fill('abcdef');
    // Put the caret mid-text, where a naive rebuild would snap it to the end.
    await field.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(3, 3));
    await field.dispatchEvent('keyup');

    // A host document update triggers the debounced re-resolution that re-renders
    // the popover (`resolve.onChange` -> `render`), rebuilding the list.
    await simulate(page, { type: 'update', text: `${DOC}\n\nGamma paragraph text.\n` });
    await page.waitForTimeout(450);
    await pushSync(page, threadId);
    await page.waitForTimeout(SETTLE_MS);

    await expect(page.locator(editField)).toHaveValue('abcdef');
    const caret = await page.locator(editField).evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      return { start: t.selectionStart, end: t.selectionEnd, focused: document.activeElement === t };
    });
    expect(caret).toEqual({ start: 3, end: 3, focused: true });
  });

  test('switching to another thread closes the field rather than carrying its draft across', async ({ page }) => {
    await openEditor(page, DOC);
    await createThread(page, 0, 'Thread A.');
    await createThread(page, 1, 'Thread B.');

    await clickPin(page, 0);
    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill('Draft belonging to A.');

    await clickPin(page, 1);
    await expect(page.locator(editField)).toHaveCount(0);
    await expect(page.locator(`${originalRow} .comment-popover-body-text`)).toHaveText('Thread B.');
  });
});

/**
 * Regressions for the defects the 3-reviewer adversarial pass found. Each pins a
 * behaviour the original 25 cases either did not cover or asserted too weakly.
 */
test.describe('review regressions', () => {
  test('AC6: a save in flight on one target never blocks a DIFFERENT target\'s save', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await pushSync(page, threadId, {
      replies: [{ id: 'reply-a', author: 'harness-user', timestamp: '2026-07-24T11:00:00.000Z', body: 'A reply.' }],
    });
    await clearPosted(page);

    // Save an edit of the REPLY, and leave it in flight (no result simulated).
    await page.locator('.comment-popover-reply[data-reply-id="reply-a"] .comment-popover-edit').click();
    await page.locator(editField).fill('Reply, corrected.');
    await page.locator('.comment-popover-edit-save').click();
    expect(await postedOfType(page, 'editComment')).toHaveLength(1);

    // Now edit the OPENING COMMENT of the same thread. The guard is per target,
    // so this must open, be typeable, and post — a single global scalar made
    // this silently dead until the first save timed out.
    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await expect(page.locator(editField)).toBeVisible();
    await page.locator(editField).fill('Comment, corrected.');
    await page.locator('.comment-popover-edit-save').click();

    const posts = await postedOfType(page, 'editComment');
    expect(posts).toHaveLength(2);
    expect(posts[0].targetReplyId).toBe('reply-a');
    expect(posts[1].targetReplyId).toBeUndefined();
  });

  test('AC6: a late result is matched to its own target, releasing only that guard', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await pushSync(page, threadId, {
      replies: [{ id: 'reply-a', author: 'harness-user', timestamp: '2026-07-24T11:00:00.000Z', body: 'A reply.' }],
    });
    await clearPosted(page);

    await page.locator('.comment-popover-reply[data-reply-id="reply-a"] .comment-popover-edit').click();
    await page.locator(editField).fill('Reply, corrected.');
    await page.locator('.comment-popover-edit-save').click();
    const replyEdit = (await postedOfType(page, 'editComment')).at(-1)!;

    // Open the COMMENT's field (allowed — different target) and cancel THAT one.
    // Cancelling it must not release the REPLY's in-flight guard; if it did, the
    // reply's own refusal below would match nothing and vanish silently.
    // (Cancelling the reply's own field would abandon its wait by design, which
    // is the established `closeReplyDraft` behaviour — not what this pins.)
    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill('Comment draft, abandoned.');
    await page.locator('.comment-popover-edit-cancel').click();
    await expect(page.locator(editField)).toHaveCount(0);

    await simulate(page, { type: 'editCommentResult', requestId: replyEdit.requestId, ok: false, error: 'Reply refused.' });
    await page.waitForTimeout(SETTLE_MS);

    // The refusal surfaced as a toast (its field is gone), and the comment's own
    // open draft was untouched.
    await expect(page.locator('#wysiwyg-toast')).toHaveText('Reply refused.');
    // Nothing was re-opened or re-armed by a result for a target whose field is gone.
    await expect(page.locator(editField)).toHaveCount(0);
  });

  test('AC1: a Close landing while the field is open closes it and refuses a further Save', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    await page.locator(`${originalRow} .comment-popover-edit`).click();
    await page.locator(editField).fill('Editing while it gets closed.');
    await clearPosted(page);

    await pushSync(page, threadId, { status: 'Closed' });

    // The field is gone — not left live over a thread the host is bound to
    // refuse — and the lockout is stated.
    await expect(page.locator(editField)).toHaveCount(0);
    await expect(page.locator('#wysiwyg-toast')).toContainText('closed');
    await expect(page.locator(`${originalRow} .comment-popover-edit`)).toHaveCount(0);
    expect(await postedOfType(page, 'editComment')).toHaveLength(0);
  });

  test('AC7: opening Edit on an already-over-cap body never truncates it on the first keystroke', async ({ page }) => {
    await openEditor(page, DOC);
    const { threadId } = await createThread(page, 0, 'Original comment.');
    await clickPin(page, 0);
    // US-23.10 AC10 (creation's own cap) is unbuilt, so a body longer than the
    // cap can legitimately exist. Editing it must not silently destroy the tail
    // — AC8 means this may not even be the editor's own comment.
    const overCap = 'x'.repeat(4200);
    await pushSync(page, threadId, { body: overCap });

    await page.locator(`${originalRow} .comment-popover-edit`).click();
    const field = page.locator(editField);
    await expect(field).toHaveValue(overCap);

    // Type one character: the tail must NOT be clipped away down to 4000 — the
    // ceiling is the body's own length, so it holds at 4200 rather than losing
    // 200 code points the editor never wrote.
    await field.press('End');
    await field.press('y');
    expect(Array.from(await field.inputValue())).toHaveLength(4200);

    // It also cannot be GROWN past that ceiling by a big paste.
    await field.fill('x'.repeat(4500));
    expect(Array.from(await field.inputValue())).toHaveLength(4200);

    // ...and editing it DOWN is always allowed.
    await field.fill('a short correction');
    await expect(field).toHaveValue('a short correction');
  });
});

test('US-23.6: no edit/undo/redo document message escapes the whole edit flow', async ({ page }) => {
  await openEditor(page, DOC);
  const { threadId } = await createThread(page, 0, 'Original comment.');
  await clickPin(page, 0);
  await clearPosted(page);

  await page.locator(`${originalRow} .comment-popover-edit`).click();
  await page.locator(editField).fill('A corrected body.');
  await page.locator('.comment-popover-edit-save').click();
  const [edit] = await postedOfType(page, 'editComment');
  await simulate(page, { type: 'editCommentResult', requestId: edit.requestId, ok: true });
  await pushSync(page, threadId, { body: 'A corrected body.', editedAt: '2026-07-28T16:00:00.000Z' });

  const types = (await posted(page)).map((m) => m.type);
  expect(types).not.toContain('edit');
  expect(types).not.toContain('undo');
  expect(types).not.toContain('redo');
});
