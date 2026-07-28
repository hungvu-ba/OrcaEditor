/**
 * Req 23 US-23.4 — the four anchor-resolution tiers, live.
 *
 * Playwright track (Plan/WEBVIEW_TEST.md): every case needs a real re-render of
 * `#content` (the host 'update' path), real Selection/`contextmenu` events to
 * create the comment in the first place, and a real `input` event to reproduce a
 * paste clone. None of that survives a hand-built DOM snapshot.
 *
 * The resolver's observable contract is the `commentAnchorUpdate` messages it
 * posts plus the `data-comment-anchor-state` it stamps — asserted here rather
 * than any internal registry.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

/** Paragraphs deliberately share no wording, so a tier-2 miss is a real miss. */
const DOC = [
  '# Session expiry',
  '',
  'The refund queue drains in enqueue order.',
  '',
  'Identifiers are recorded for later audit.',
  '',
].join('\n');

interface AnchorUpdate {
  type: string;
  threadId: string;
  anchorId: string;
  line: number;
  state: string;
  /** Req 24 US-23.13 AC1/AC2: set only on a transition the host should persist. */
  origin?: string;
}

function posted(page: Page, type: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    (wanted) =>
      (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === wanted),
    type
  ) as Promise<Array<Record<string, unknown>>>;
}

/** Create a comment on the nth paragraph and let the host confirm it, as US-23.1 does. */
async function addComment(page: Page, pIndex: number, body: string): Promise<{ anchorId: string; threadId: string }> {
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

  const create = (await posted(page, 'createComment')).at(-1)!;
  // Only a confirmed thread is tracked — mirrors the real createCommentResult.
  await page.evaluate(
    (requestId) => window.postMessage({ type: 'createCommentResult', requestId, ok: true }, '*'),
    create.requestId
  );
  // postMessage is delivered asynchronously; the thread is not registered (and
  // its node not stamped) until the webview handles it. Waiting for the stamp
  // keeps every case below deterministic instead of racing registration.
  await expect(page.locator(`[data-comment-anchor-id="${create.anchorId}"]`)).toHaveAttribute(
    'data-comment-anchor-state',
    'exact'
  );
  return { anchorId: String(create.anchorId), threadId: String(create.threadId) };
}

/** Re-render the document from the host, then wait for the debounced re-resolution to settle. */
async function hostUpdate(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => window.postMessage({ type: 'update', text: value }, '*'), text);
  await page.waitForTimeout(450);
}

async function lastUpdateFor(page: Page, threadId: string): Promise<AnchorUpdate | undefined> {
  const all = (await posted(page, 'commentAnchorUpdate')) as unknown as AnchorUpdate[];
  return all.filter((m) => m.threadId === threadId).at(-1);
}

test('tier 1: the anchored node keeps the thread while its structural id survives', async ({ page }) => {
  await openEditor(page, DOC);
  const { anchorId } = await addComment(page, 0, 'Does drains mean FIFO?');

  const anchored = page.locator(`[data-comment-anchor-id="${anchorId}"]`);
  await expect(anchored).toHaveText('The refund queue drains in enqueue order.');
  await expect(anchored).toHaveAttribute('data-comment-anchor-state', 'exact');
});

test('tier 2: a re-render with fresh ids relocates the thread by its recorded text', async ({ page }) => {
  await openEditor(page, DOC);
  const { anchorId, threadId } = await addComment(page, 0, 'Does drains mean FIFO?');
  await clearPosted(page);

  // A paragraph inserted ABOVE pushes the anchored one down and, because the
  // render rebuilds #content, throws away every structural id (AC1: a fresh
  // parse starts at tier 2).
  await hostUpdate(page, DOC.replace('# Session expiry\n', '# Session expiry\n\nA newly added lead-in line.\n'));

  const anchored = page.locator(`[data-comment-anchor-id="${anchorId}"]`);
  await expect(anchored).toHaveText('The refund queue drains in enqueue order.');
  await expect(anchored).toHaveAttribute('data-comment-anchor-state', 'exact');

  const update = await lastUpdateFor(page, threadId);
  expect(update?.state).toBe('exact');
  expect(update?.line).toBe(5); // was line 3, now two lines lower
  // Req 24 US-23.13 AC2: a relocation that never passed through floating is
  // never persisted — this thread went tier1(exact) -> tier2(exact), not
  // floating -> non-floating.
  expect(update?.origin).toBeUndefined();
});

test('tier 3: a rewritten anchor lands on the block that still covers it, marked approximate', async ({ page }) => {
  await openEditor(page, DOC);
  const { anchorId, threadId } = await addComment(page, 0, 'Does drains mean FIFO?');
  await clearPosted(page);

  await hostUpdate(page, DOC.replace('The refund queue drains in enqueue order.', 'Nothing like it.'));

  const anchored = page.locator(`[data-comment-anchor-id="${anchorId}"]`);
  await expect(anchored).toHaveText('Nothing like it.');
  // Never silently indistinguishable from an exact hit.
  await expect(anchored).toHaveAttribute('data-comment-anchor-state', 'approximate');
  expect((await lastUpdateFor(page, threadId))?.state).toBe('approximate');
});

test('tier 4: with the location gone the thread floats — no node, no silent drop', async ({ page }) => {
  await openEditor(page, DOC);
  const { anchorId, threadId } = await addComment(page, 0, 'Does drains mean FIFO?');
  await clearPosted(page);

  // Everything from the anchor down is deleted, so no block covers its line.
  await hostUpdate(page, '# Session expiry\n');

  expect(await page.locator(`[data-comment-anchor-id="${anchorId}"]`).count()).toBe(0);
  expect((await lastUpdateFor(page, threadId))?.state).toBe('floating');
});

test('every floated thread is listed — a big deletion floats them all, uncapped', async ({ page }) => {
  await openEditor(page, DOC);
  const first = await addComment(page, 0, 'One.');
  const second = await addComment(page, 1, 'Two.');
  await clearPosted(page);

  await hostUpdate(page, '# Session expiry\n');

  expect((await lastUpdateFor(page, first.threadId))?.state).toBe('floating');
  expect((await lastUpdateFor(page, second.threadId))?.state).toBe('floating');
});

test('AC5: undoing the deletion promotes a floating thread back to an exact anchor', async ({ page }) => {
  await openEditor(page, DOC);
  const { threadId, anchorId } = await addComment(page, 0, 'Does drains mean FIFO?');
  await hostUpdate(page, '# Session expiry\n');
  expect((await lastUpdateFor(page, threadId))?.state).toBe('floating');

  await clearPosted(page);
  // An undo arrives as an ordinary host update carrying the restored text.
  await hostUpdate(page, DOC);

  const update = await lastUpdateFor(page, threadId);
  expect(update?.state).toBe('exact');
  expect(update?.line).toBe(3);
  await expect(page.locator(`[data-comment-anchor-id="${anchorId}"]`)).toHaveText(
    'The refund queue drains in enqueue order.'
  );
  // Req 24 US-23.13 AC2: a genuine floating -> non-floating promotion IS
  // persisted, with the auto-resolve origin (never 'manual' — no Reviewer
  // action drove this one).
  expect(update?.origin).toBe('resolved');
});

/** Duplicate the anchored node the way an edit does: clone it, fire `input`, no re-render. */
async function cloneAnchored(page: Page, anchorId: string, where: 'before' | 'after'): Promise<void> {
  await page.locator('#content').evaluate(
    (el, { id, where }) => {
      const original = el.querySelector<HTMLElement>(`[data-comment-anchor-id="${id}"]`)!;
      const copy = original.cloneNode(true) as HTMLElement;
      if (where === 'before') {
        original.before(copy);
      } else {
        original.after(copy);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    },
    { id: anchorId, where }
  );
  await page.waitForTimeout(450); // the dedup runs behind the re-resolution debounce
}

function anchorIdsOfParagraphs(page: Page): Promise<Array<string | null>> {
  return page
    .locator('#content p')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-comment-anchor-id')));
}

test('AC6: a copy pasted BELOW the anchored node gets a fresh id, the original keeps its own', async ({ page }) => {
  await openEditor(page, DOC);
  const { anchorId } = await addComment(page, 0, 'Does drains mean FIFO?');
  await cloneAnchored(page, anchorId, 'after');

  const ids = await anchorIdsOfParagraphs(page);
  const carriers = ids.filter((id) => id !== null);
  expect(carriers).toHaveLength(2);
  expect(new Set(carriers).size).toBe(2); // never two locations on one anchor
  expect(ids[0]).toBe(anchorId); // the original, not the copy, keeps the thread
});

test('AC6: a copy pasted ABOVE the anchored node still leaves the thread on the original', async ({ page }) => {
  await openEditor(page, DOC);
  const { anchorId } = await addComment(page, 0, 'Does drains mean FIFO?');
  await cloneAnchored(page, anchorId, 'before');

  // Document order alone would hand the id to the copy, which now comes first.
  const ids = await anchorIdsOfParagraphs(page);
  expect(ids[0]).not.toBe(anchorId);
  expect(ids[1]).toBe(anchorId);
});

test('AC6: splitting the anchored paragraph with Enter leaves the id on one half only', async ({ page }) => {
  await openEditor(page, DOC);
  const { anchorId } = await addComment(page, 0, 'Does drains mean FIFO?');

  // contentEditable builds the second half by copying the first, attributes and
  // all — the one clone path that needs no clipboard and no re-render.
  await page.locator('#content').evaluate((el, id) => {
    const p = el.querySelector<HTMLElement>(`[data-comment-anchor-id="${id}"]`)!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 11);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, anchorId);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(450);

  const carriers = (await anchorIdsOfParagraphs(page)).filter((id) => id === anchorId);
  expect(carriers).toHaveLength(1);
});

test('AC6: a move (cut + paste) keeps the original id', async ({ page }) => {
  await openEditor(page, DOC);
  const { anchorId } = await addComment(page, 0, 'Does drains mean FIFO?');

  await page.locator('#content').evaluate((el, id) => {
    const original = el.querySelector<HTMLElement>(`[data-comment-anchor-id="${id}"]`)!;
    const moved = original.cloneNode(true);
    el.appendChild(moved);
    original.remove(); // cut half of the move — only one carrier survives
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  }, anchorId);
  await page.waitForTimeout(450);

  const carriers = await page
    .locator(`#content [data-comment-anchor-id="${anchorId}"]`)
    .evaluateAll((els) => els.map((el) => el.textContent));
  expect(carriers).toEqual(['The refund queue drains in enqueue order.']);
});

test('AC5: an edit typed in the editor (no re-render) still re-runs the tiers', async ({ page }) => {
  await openEditor(page, DOC);
  const { threadId, anchorId } = await addComment(page, 0, 'Does drains mean FIFO?');
  await clearPosted(page);

  // Delete the anchored paragraph by editing, not through a host update — the
  // host echo-suppresses the webview's own edit, so nothing re-renders.
  await page.locator('#content').evaluate((el, id) => {
    el.querySelector<HTMLElement>(`[data-comment-anchor-id="${id}"]`)!.remove();
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  }, anchorId);
  await page.waitForTimeout(450);

  const update = await lastUpdateFor(page, threadId);
  expect(update).toBeTruthy();
  expect(update?.state).not.toBe('exact');
});

test('AC7: an edit above other comments leaves their anchor ids untouched', async ({ page }) => {
  await openEditor(page, DOC);
  const first = await addComment(page, 0, 'One.');
  const second = await addComment(page, 1, 'Two.');
  await clearPosted(page);

  await hostUpdate(page, DOC.replace('# Session expiry\n', '# Session expiry\n\nA newly added lead-in line.\n'));

  // Both threads moved down two lines, and neither had to change its id.
  const firstUpdate = await lastUpdateFor(page, first.threadId);
  const secondUpdate = await lastUpdateFor(page, second.threadId);
  expect(firstUpdate?.anchorId).toBe(first.anchorId);
  expect(secondUpdate?.anchorId).toBe(second.anchorId);
  expect(firstUpdate?.line).toBe(5);
  expect(secondUpdate?.line).toBe(7);
});
