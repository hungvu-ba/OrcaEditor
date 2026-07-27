/**
 * Req 23 US-23.1 — "Add Comment": the right-click menu, the anchor it mints,
 * and the composer that posts it. Real Selection API + real `contextmenu`/click
 * events, so this belongs on the Playwright track (Plan/WEBVIEW_TEST.md), not a
 * hand-built DOM snapshot: the anchor is computed from a live Range and the
 * menu/composer only exist after real event dispatch.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted, seedCommentThreads } from './_harness';

const DOC = '# Heading one\n\nAlpha paragraph text.\n\nBeta paragraph text.\n';

/** Select `text` inside the nth `<p>` (or place a bare caret at `caretAt` when given). */
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

/** Select across two different paragraphs — the multi-node case. */
async function selectAcrossParagraphs(page: Page): Promise<void> {
  await page.locator('#content').evaluate((el) => {
    const ps = el.querySelectorAll('p');
    const range = document.createRange();
    range.setStart(ps[0].firstChild!, 2);
    range.setEnd(ps[1].firstChild!, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

async function openContextMenu(page: Page): Promise<void> {
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await expect(page.locator('.comment-context-menu')).toBeVisible();
}

/** Open the menu on the current selection and pick "Add Comment". */
async function openComposer(page: Page): Promise<void> {
  await openContextMenu(page);
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await expect(page.locator('.comment-composer')).toBeVisible();
}

function postedCreates(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() =>
    (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'createComment')
  ) as Promise<Array<Record<string, unknown>>>;
}

function postedOfType(page: Page, type: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    (t) => (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === t),
    type
  ) as Promise<Array<Record<string, unknown>>>;
}

async function simulate(page: Page, msg: Record<string, unknown>): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, '*'), msg);
}

/** How many toasts are CURRENTLY shown (`showToast`'s `.show` class) — AC5 asserts a refusal never shows one. */
function shownToastCount(page: Page): Promise<number> {
  return page.locator('#wysiwyg-toast.show').count();
}

/**
 * Dispatch a real `contextmenu` MouseEvent with a specific `button`, needed
 * for AC1's pointer-vs-keyboard distinction. `locator.dispatchEvent` does not
 * propagate `button` through for `contextmenu` (verified: it reads back as
 * `undefined` regardless of what is passed), so this constructs the event
 * directly in the page instead of going through that helper.
 */
async function dispatchContextMenu(page: Page, x: number, y: number, button: number): Promise<void> {
  await page.locator('#content').evaluate(
    (el, { x, y, button }) => {
      el.dispatchEvent(new MouseEvent('contextmenu', { clientX: x, clientY: y, button, bubbles: true, cancelable: true }));
    },
    { x, y, button }
  );
}

test('right-click over a selection anchors the comment to that node with within-node offsets', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 0, 6, 15); // "paragraph" inside "Alpha paragraph text."
  await clearPosted(page);
  await openComposer(page);

  // The quote shows exactly what the anchor covers.
  await expect(page.locator('.comment-composer-quote-text')).toHaveText('“paragraph”');

  await page.locator('.comment-composer-input').fill('Why this wording?');
  await page.locator('.comment-composer-submit').click();

  const [msg] = await postedCreates(page);
  expect(msg).toBeTruthy();
  expect(msg.body).toBe('Why this wording?');
  expect(msg.offsetStart).toBe(6);
  expect(msg.offsetEnd).toBe(15);
  expect(String(msg.anchorId)).toMatch(/^comment-anchor-\d+$/);
  // 1-based source line of the anchored paragraph, not a document-wide offset.
  expect(msg.line).toBe(3);

  // The anchor id is stamped on the paragraph itself, not on #content.
  const stamped = await page
    .locator('#content p')
    .first()
    .getAttribute('data-comment-anchor-id');
  expect(stamped).toBe(msg.anchorId);
});

test('the create carries the anchor snapshot the sidecar persists (US-23.5)', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 0, 6, 15); // "paragraph" inside "Alpha paragraph text."
  await clearPosted(page);
  await openComposer(page);
  await page.locator('.comment-composer-input').fill('Snapshot me.');
  await page.locator('.comment-composer-submit').click();

  const [msg] = await postedCreates(page);
  // recordedText/nearestHeading are written straight into the sidecar's
  // `anchor` block, and tier 2 (US-23.4) is the ONLY way a reopened file finds
  // this comment again — the session-scoped anchorId is never persisted. A
  // create that posted them empty would be unrecoverable after a reopen, so the
  // capture is asserted at the point it leaves the webview.
  expect(msg.recordedText).toBe('Alpha paragraph text.');
  expect(msg.nearestHeading).toBe('Heading one');
});

test('a bare caret is a valid anchor — collapsed offsets, same path as a range', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 1, 5, 5); // collapsed caret inside "Beta paragraph text."
  await clearPosted(page);
  await openComposer(page);

  // No selected text — the composer shows no quote block.
  await expect(page.locator('.comment-composer-quote')).toBeHidden();

  await page.locator('.comment-composer-input').fill('Caret anchored.');
  await page.locator('.comment-composer-submit').click();

  const [msg] = await postedCreates(page);
  expect(msg.offsetStart).toBe(5);
  expect(msg.offsetEnd).toBe(5);
  expect(msg.line).toBe(5);
});

test('a selection crossing two paragraphs anchors to their common ancestor, not a split', async ({ page }) => {
  await openEditor(page, DOC);
  await selectAcrossParagraphs(page);
  await clearPosted(page);
  await openComposer(page);

  await page.locator('.comment-composer-input').fill('Spans both.');
  await page.locator('.comment-composer-submit').click();

  const msgs = await postedCreates(page);
  // One thread for the whole selection — never one per crossed node.
  expect(msgs).toHaveLength(1);
  const anchorId = String(msgs[0].anchorId);
  const stampedOnContent = await page.locator('#content').getAttribute('data-comment-anchor-id');
  expect(stampedOnContent).toBe(anchorId);
});

test('empty and whitespace-only bodies are a no-op — nothing posted, the composer stays open', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 0, 0, 5);
  await clearPosted(page);
  await openComposer(page);

  // dispatchEvent, not click(): Playwright refuses to click an aria-disabled
  // control, and the point here is exactly that a click on it does nothing.
  const submit = page.locator('.comment-composer-submit');
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await submit.dispatchEvent('click');
  expect(await postedCreates(page)).toHaveLength(0);
  await expect(page.locator('.comment-composer')).toBeVisible();

  await page.locator('.comment-composer-input').fill('   ');
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await submit.dispatchEvent('click');
  expect(await postedCreates(page)).toHaveLength(0);
  await expect(page.locator('.comment-composer')).toBeVisible();

  // Real text flips it live.
  await page.locator('.comment-composer-input').fill('real');
  await expect(submit).toHaveAttribute('aria-disabled', 'false');
});

test('"Add Comment" is disabled when there is no addressable node under the cursor', async ({ page }) => {
  await openEditor(page, DOC);
  // Selection collapsed outside #content — nothing addressable to anchor to.
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await openContextMenu(page);

  const item = page.locator('.comment-menu-item', { hasText: 'Add Comment' });
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await expect(item).toHaveAttribute('title', 'No commentable block under the cursor');

  // Clicking it does nothing — no composer, no message.
  await clearPosted(page);
  await item.dispatchEvent('click');
  await expect(page.locator('.comment-composer')).toBeHidden();
  expect(await postedCreates(page)).toHaveLength(0);
});

test('submitting twice before the host replies creates only one thread', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 0, 0, 5);
  await clearPosted(page);
  await openComposer(page);
  await page.locator('.comment-composer-input').fill('Only once.');
  await page.locator('.comment-composer-submit').click();

  // Re-trigger while the first create is still in flight (no host reply yet).
  await selectIn(page, 1, 0, 4);
  await openContextMenu(page);
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await expect(page.locator('.comment-composer')).toBeHidden();

  expect(await postedCreates(page)).toHaveLength(1);
});

test('a host refusal is surfaced INLINE (US-23.10 AC5) and releases the guard so the Reviewer can retry', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 0, 0, 5);
  await clearPosted(page);
  await openComposer(page);
  await page.locator('.comment-composer-input').fill('First try.');
  await page.locator('.comment-composer-submit').click();

  const first = (await postedCreates(page))[0];
  await simulate(page, { type: 'createCommentResult', requestId: first.requestId, ok: false, error: 'That location changed.' });

  // AC5: stays open, body intact, reason shown INLINE — never a toast.
  await expect(page.locator('.comment-composer')).toBeVisible();
  await expect(page.locator('.comment-composer-input')).toHaveValue('First try.');
  await expect(page.locator('.comment-composer-error-text')).toHaveText('That location changed.');
  expect(await shownToastCount(page)).toBe(0);

  // Guard released — starting a fresh comment elsewhere goes through.
  await page.locator('.comment-composer-cancel').click();
  await selectIn(page, 1, 0, 4);
  await openComposer(page);
  await page.locator('.comment-composer-input').fill('Second try.');
  await page.locator('.comment-composer-submit').click();
  expect(await postedCreates(page)).toHaveLength(2);
});

test('the anchor attribute never reaches the serialized .md', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 0, 6, 15);
  await openComposer(page);
  await page.locator('.comment-composer-input').fill('Anchored.');
  await page.locator('.comment-composer-submit').click();

  // Serialize through the same path the host sync uses.
  const stamped = await page.locator('#content p').first().getAttribute('data-comment-anchor-id');
  expect(stamped).toBeTruthy();
  await clearPosted(page);
  await page.locator('#content').evaluate((el) => {
    const p = el.querySelectorAll('p')[1];
    p.textContent = p.textContent + '!';
    p.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  const md = await page.waitForFunction(
    () =>
      (window as unknown as { __posted: Array<{ type: string; text: string }> }).__posted
        .filter((m) => m.type === 'edit')
        .at(-1)?.text,
    undefined,
    { timeout: 2000 }
  );
  expect(await md.jsonValue()).not.toContain('data-comment-anchor-id');
});

/**
 * US-23.10 AC1 — click-point anchoring: a keyboard-invoked menu never
 * collapses the selection; a pointer right-click outside it collapses only
 * when "Add Comment" is actually invoked; a click with no anchorable position
 * leaves the selection untouched and the menu item reflects that.
 */
test.describe('US-23.10 AC1 — click-point anchoring', () => {
  test('a keyboard-invoked context menu (button 0) never collapses the selection, even at a stray click point', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await selectIn(page, 0, 6, 15); // "paragraph" inside Alpha (Ln 3)
    await clearPosted(page);
    // Chromium reports button 0 (not 2) for a keyboard-invoked context menu
    // (Shift+F10 / the Menu key) — dispatched here over the SECOND paragraph
    // to prove those coordinates are genuinely ignored, not coincidentally unused.
    await dispatchContextMenu(page, 10, 400, 0);
    await expect(page.locator('.comment-context-menu')).toBeVisible();
    await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();

    await expect(page.locator('.comment-composer-quote-text')).toHaveText('“paragraph”');
    await page.locator('.comment-composer-input').fill('Kept the selection.');
    await page.locator('.comment-composer-submit').click();
    const [msg] = await postedCreates(page);
    expect(msg.offsetStart).toBe(6);
    expect(msg.offsetEnd).toBe(15);
    expect(msg.line).toBe(3);
  });

  test('a pointer right-click outside the selection collapses to the click point ONLY when "Add Comment" is invoked, not at menu-open', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await selectIn(page, 0, 6, 15); // "paragraph" inside Alpha
    await clearPosted(page);
    const betaBox = (await page.locator('#content p').nth(1).boundingBox())!;
    const x = betaBox.x + 5;
    const y = betaBox.y + betaBox.height / 2;
    await dispatchContextMenu(page, x, y, 2);
    await expect(page.locator('.comment-context-menu')).toBeVisible();

    // Opening the menu alone must not have touched the selection yet.
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('paragraph');

    await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
    // No quote: the click collapsed to a bare caret in Beta, not Alpha's selection.
    await expect(page.locator('.comment-composer-quote')).toBeHidden();
    await page.locator('.comment-composer-input').fill('Collapsed to the click.');
    await page.locator('.comment-composer-submit').click();
    const [msg] = await postedCreates(page);
    expect(msg.offsetStart).toBe(msg.offsetEnd); // bare caret
    expect(msg.line).toBe(5); // Beta's line, not Alpha's (3)
  });

  test('a click resolving to no anchorable position leaves the existing selection untouched, and the menu item reflects that', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await selectIn(page, 0, 6, 15); // a perfectly valid selection exists
    await clearPosted(page);
    // Force the click-point resolution to find nothing addressable there —
    // stands in for a click landing on an image/mermaid/table-chrome node.
    await page.evaluate(() => {
      (document as unknown as { caretRangeFromPoint: () => null }).caretRangeFromPoint = () => null;
    });
    await dispatchContextMenu(page, 10, 10, 2);

    const item = page.locator('.comment-menu-item', { hasText: 'Add Comment' });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toHaveAttribute('title', 'No commentable block under the cursor');

    // The pre-existing selection is untouched.
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('paragraph');

    // Clicking the disabled item is a no-op — no composer, no message.
    await item.dispatchEvent('click');
    await expect(page.locator('.comment-composer')).toBeHidden();
    expect(await postedCreates(page)).toHaveLength(0);
  });
});

/** US-23.10 AC5 — a refusal keeps the composer/reply open, body intact, reason inline. */
test.describe('US-23.10 AC5 — refusal keeps the composer/reply open', () => {
  test('while a create is in flight the input is read-only and Submit is inert; a stale-anchor refusal re-arms both, keeps the body, and offers re-targeting', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await selectIn(page, 0, 0, 5);
    await clearPosted(page);
    await openComposer(page);
    await page.locator('.comment-composer-input').fill('Keep me.');
    await page.locator('.comment-composer-submit').click();

    const isReadOnly = () =>
      page.locator('.comment-composer-input').evaluate((el) => (el as HTMLTextAreaElement).readOnly);
    // In flight: read-only input, inert Submit — never after a refusal.
    expect(await isReadOnly()).toBe(true);
    await expect(page.locator('.comment-composer-submit')).toHaveAttribute('aria-disabled', 'true');

    const [msg] = await postedCreates(page);
    await simulate(page, {
      type: 'createCommentResult',
      requestId: msg.requestId,
      ok: false,
      error: 'This comment lost its anchor before it could be created.',
    });

    // AC5: stays open, body intact, reason inline (never a toast); re-armed.
    await expect(page.locator('.comment-composer')).toBeVisible();
    await expect(page.locator('.comment-composer-input')).toHaveValue('Keep me.');
    await expect(page.locator('.comment-composer-error-text')).toHaveText(
      'This comment lost its anchor before it could be created.'
    );
    expect(await shownToastCount(page)).toBe(0);
    expect(await isReadOnly()).toBe(false);
    await expect(page.locator('.comment-composer-submit')).toHaveAttribute('aria-disabled', 'false');
    // Stale-anchor refusal specifically offers re-targeting.
    await expect(page.locator('.comment-composer-retarget')).toBeVisible();

    // Re-target to the current selection and retry — the typed body survives.
    await selectIn(page, 1, 0, 4);
    await page.locator('.comment-composer-retarget').click();
    await expect(page.locator('.comment-composer-error')).toBeHidden();
    await expect(page.locator('.comment-composer-input')).toHaveValue('Keep me.');
    await page.locator('.comment-composer-submit').click();
    const creates = await postedCreates(page);
    expect(creates).toHaveLength(2);
    expect(creates[1].offsetStart).toBe(0);
    expect(creates[1].offsetEnd).toBe(4);
  });

  test('a non-anchor refusal keeps the composer open with the reason inline and offers no re-target', async ({ page }) => {
    await openEditor(page, DOC);
    await selectIn(page, 0, 0, 5);
    await clearPosted(page);
    await openComposer(page);
    await page.locator('.comment-composer-input').fill('Keep me too.');
    await page.locator('.comment-composer-submit').click();

    const [msg] = await postedCreates(page);
    await simulate(page, { type: 'createCommentResult', requestId: msg.requestId, ok: false, error: 'Failed to save the comment.' });

    await expect(page.locator('.comment-composer')).toBeVisible();
    await expect(page.locator('.comment-composer-input')).toHaveValue('Keep me too.');
    await expect(page.locator('.comment-composer-error-text')).toHaveText('Failed to save the comment.');
    await expect(page.locator('.comment-composer-retarget')).toBeHidden();
    expect(await shownToastCount(page)).toBe(0);
  });

  test('a reply refusal (comment-popover.ts mirror) keeps the reply box open with text intact and the reason inline, not a toast', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await selectIn(page, 0, 0, 5);
    await openComposer(page);
    await page.locator('.comment-composer-input').fill('Original.');
    await page.locator('.comment-composer-submit').click();
    const [create] = await postedCreates(page);
    await simulate(page, {
      type: 'createCommentResult',
      requestId: create.requestId,
      ok: true,
      author: 'harness-user',
      timestamp: new Date(2026, 6, 24, 10, 0).toISOString(),
    });

    await page.locator('.comment-gutter-pin').first().click();
    await expect(page.locator('.comment-popover')).toBeVisible();

    await page.locator('.comment-popover-reply-input').fill('My reply.');
    await page.locator('.comment-popover-reply-submit').click();
    const [reply] = await postedOfType(page, 'replyToComment');
    await simulate(page, { type: 'replyResult', requestId: reply.requestId, ok: false, error: 'This comment thread no longer exists.' });

    await expect(page.locator('.comment-popover-reply-box')).toBeVisible();
    await expect(page.locator('.comment-popover-reply-input')).toHaveValue('My reply.');
    await expect(page.locator('.comment-popover-reply-error')).toHaveText('This comment thread no longer exists.');
    expect(await shownToastCount(page)).toBe(0);
  });
});

/** US-23.10 AC7 — the up-front document guard, pushed via `commentThreadsSync.sidecar.problem`. */
test.describe('US-23.10 AC7 — up-front document guard', () => {
  test('"Add Comment" is disabled up front with the specific document-guard reason, and re-enables once the guard clears without reopening the editor', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    await seedCommentThreads(page, [], { problem: 'Save the file first to comment on it.' });
    await selectIn(page, 0, 0, 5);

    await openContextMenu(page);
    const item = page.locator('.comment-menu-item', { hasText: 'Add Comment' });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toHaveAttribute('title', 'Save the file first to comment on it.');
    await clearPosted(page);
    await item.dispatchEvent('click');
    await expect(page.locator('.comment-composer')).toBeHidden();
    expect(await postedCreates(page)).toHaveLength(0);

    // The guard clears (e.g. the document was saved) — re-evaluated from the
    // SAME channel, with no reopen of the editor.
    await seedCommentThreads(page, [], {});
    await openContextMenu(page);
    await expect(item).toHaveAttribute('aria-disabled', 'false');
  });
});

/** US-23.10 AC9 — plain-text rendering everywhere, bidi/control-char neutralization on submit. */
test.describe('US-23.10 AC9 — plain-text rendering', () => {
  test('a body with <script>/Markdown syntax renders as literal text in the popover, multi-line preserved via computed white-space', async ({
    page,
  }) => {
    await openEditor(page, DOC);
    const bodyText = '<script>alert(1)</script>\n**bold** not-actually-bold\nthird line';
    await seedCommentThreads(page, [{ threadId: 't1', body: bodyText }]);

    await page.locator('.comment-gutter-pin').first().click();
    const bodyEl = page.locator('.comment-popover-original .comment-popover-body-text');
    await expect(bodyEl).toBeVisible();
    // Literal text — the raw body, never interpreted as HTML or Markdown.
    expect(await bodyEl.textContent()).toBe(bodyText);
    expect(await page.locator('.comment-popover-original script').count()).toBe(0);
    // Multi-line preserved via the ACTUAL computed style, not just the source CSS.
    expect(await bodyEl.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
  });

  test('a submitted body has its bidi-override characters stripped before it ever leaves the webview', async ({ page }) => {
    await openEditor(page, DOC);
    await selectIn(page, 0, 0, 5);
    await clearPosted(page);
    await openComposer(page);
    const rlo = String.fromCharCode(0x202e); // U+202E RIGHT-TO-LEFT OVERRIDE
    await page.locator('.comment-composer-input').fill(`safe text${rlo}evil suffix`);
    await page.locator('.comment-composer-submit').click();
    const [msg] = await postedCreates(page);
    expect(msg.body).toBe('safe textevil suffix');
  });
});
