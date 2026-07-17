/**
 * Undo chronology (bug 0717): undo must revert edits strictly newest-first.
 * Undo/redo is fully TextDocument-based, so its unit order equals the order of
 * 'edit' messages the webview posts. Two defects broke that chronology:
 *
 * 1. `invokeAction` (toolbar.ts) only called the debounced `scheduleSync()`,
 *    so text typed within the 250ms debounce window and a toolbar format
 *    change serialized into ONE 'edit' → one undo unit reverting both at once
 *    ("parallel" undo instead of chronological).
 * 2. The toolbar Undo/Redo buttons still ran `document.execCommand('undo'/'redo')`
 *    — the browser's NATIVE stack, blind to raw-DOM list ops
 *    (commitListOpDirect) — while Ctrl+Z/Y delegate to the host TextDocument.
 *
 * The host-side undo itself needs the real VS Code host and is verified
 * manually; these tests assert the message contract that drives it.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

type Posted = { type: string; text?: string; pendingText?: string };

async function postedOfType(page: import('@playwright/test').Page, type: string): Promise<Posted[]> {
  return page.evaluate(
    (t) => (window as unknown as { __posted: Posted[] }).__posted.filter((m) => m.type === t),
    type
  );
}

test('typing then clicking Bullet inside the debounce window commits two chronological edits', async ({ page }) => {
  await openEditor(page, '');
  const content = page.locator('#content');
  await content.click();
  await clearPosted(page);

  // No word boundary → the 250ms sync debounce is still pending when the
  // toolbar click lands, which used to merge typing + format into one edit.
  await page.keyboard.type('alpha');
  await page.locator('#fmt-bullet').click();

  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some(
      (m) => m.type === 'edit' && /^\*\s+alpha$/m.test(m.text ?? '')
    )
  );

  const editTexts = (await postedOfType(page, 'edit')).map((m) => (m.text ?? '').trim());
  // The pending typing must be flushed as its OWN undo unit BEFORE the bullet
  // edit — never coalesced with it.
  expect(editTexts[0]).toBe('alpha');
  expect(editTexts.some((t) => /^\*\s+alpha$/.test(t))).toBe(true);
  expect(editTexts.length).toBeGreaterThanOrEqual(2);
});

test('clicking Bullet then typing posts the bullet edit immediately, before the typing edit', async ({ page }) => {
  await openEditor(page, 'alpha');
  const content = page.locator('#content');
  await content.click();
  await clearPosted(page);

  await page.locator('#fmt-bullet').click();
  // The format edit must be posted synchronously on click (no debounce), so
  // typing that follows can never merge into the same undo unit.
  const editsRightAfterClick = (await postedOfType(page, 'edit')).map((m) => (m.text ?? '').trim());
  expect(editsRightAfterClick.length).toBe(1);
  expect(editsRightAfterClick[0]).toMatch(/^\*\s+alpha$/);

  await page.keyboard.type(' beta');
  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some(
      (m) => m.type === 'edit' && /alpha beta/.test(m.text ?? '')
    )
  );
  const editTexts = (await postedOfType(page, 'edit')).map((m) => (m.text ?? '').trim());
  expect(editTexts[0]).toMatch(/^\*\s+alpha$/);
});

test('toolbar Undo button delegates to the host TextDocument, never the native stack', async ({ page }) => {
  await openEditor(page, '');
  const content = page.locator('#content');
  await content.click();
  await page.keyboard.type('alpha beta');
  // Let the pending sync settle so the click carries no pendingText noise.
  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some(
      (m) => m.type === 'edit' && (m.text ?? '').trim() === 'alpha beta'
    )
  );
  await clearPosted(page);

  await page.locator('#fmt-undo').click();

  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some((m) => m.type === 'undo')
  );
  // Native execCommand('undo') would have reverted the typing in the DOM; the
  // host-delegated path leaves the DOM alone (the host replies with 'update').
  await expect(content).toHaveText('alpha beta');
  // Past the debounce window: no sync of any kind may trail the undo.
  await page.waitForTimeout(400);
  expect(await postedOfType(page, 'edit')).toEqual([]);
});

test('Undo on a drifted document (no trailing newline) never posts an edit behind the undo', async ({ page }) => {
  // Init text lacks the trailing \n serialize() normalizes to, so
  // serialize() !== currentText: any flush/sync run by the Undo click would
  // post a stale "normalization" edit right after the undo message, which the
  // host would apply on top of the undone state — visibly cancelling the undo.
  await openEditor(page, 'alpha');
  await page.locator('#content').click();
  await clearPosted(page);

  await page.locator('#fmt-undo').click();

  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some((m) => m.type === 'undo')
  );
  await page.waitForTimeout(400);
  expect(await postedOfType(page, 'edit')).toEqual([]);
});

test('toolbar Redo button posts a redo message, same contract as Ctrl+Y', async ({ page }) => {
  // Deliberately drifted init text (no trailing \n) — the Redo click must not
  // run any serialize/sync at all, or the resulting normalization edit would
  // land as a fresh TextDocument edit and permanently clear the redo stack.
  await openEditor(page, 'alpha');
  await page.locator('#content').click();
  await clearPosted(page);

  await page.locator('#fmt-redo').click();

  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some((m) => m.type === 'redo')
  );
  await page.waitForTimeout(400);
  expect(await postedOfType(page, 'edit')).toEqual([]);
  // Nothing pending → the message must not carry any pendingText noise.
  const redoMsg = (await postedOfType(page, 'redo'))[0];
  expect(redoMsg.pendingText).toBeUndefined();
});

test('typing pending when Redo is clicked rides the redo message as pendingText', async ({ page }) => {
  await openEditor(page, '');
  await page.locator('#content').click();
  await clearPosted(page);

  await page.keyboard.type('alpha'); // no word boundary → sync still pending
  await page.locator('#fmt-redo').click();

  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some((m) => m.type === 'redo')
  );
  await page.waitForTimeout(400);
  const redoMsg = (await postedOfType(page, 'redo'))[0];
  expect((redoMsg.pendingText ?? '').trim()).toBe('alpha');
  expect(await postedOfType(page, 'edit')).toEqual([]);
});

test('typing pending when Undo is clicked commits the typing as its own edit before the undo', async ({ page }) => {
  await openEditor(page, '');
  const content = page.locator('#content');
  await content.click();
  await clearPosted(page);

  await page.keyboard.type('alpha'); // no word boundary → sync still pending
  await page.locator('#fmt-undo').click();

  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some((m) => m.type === 'undo')
  );
  await page.waitForTimeout(400);
  const posted = await page.evaluate(() => (window as unknown as { __posted: Posted[] }).__posted);
  const undoMsg = posted.find((m) => m.type === 'undo')!;
  // The pending typing must ride the undo message itself — ONE message, so the
  // host commits it and undoes atomically in a single handler. A separate
  // 'edit' (before or after) would race the async undo handler host-side and
  // can drop the typed text entirely.
  expect((undoMsg.pendingText ?? '').trim()).toBe('alpha');
  expect(posted.filter((m) => m.type === 'edit')).toEqual([]);
});
