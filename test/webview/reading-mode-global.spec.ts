/**
 * Bug 0716 #2 (reversal 2026-07-16): Reading Mode (enabled/mode)
 * must now behave like Zen — a change in one tab broadcasts to every other
 * open tab, not just the one the user clicked in. Simulates two tabs as two
 * Playwright pages in the same browser context: drives a real click on tab
 * A's toolbar, captures the `readingModeChanged` message it posts to the
 * (stubbed) host, then replays that same message into tab B via
 * `window.postMessage` — exactly what provider.ts's `broadcastReadingMode`
 * would do — and asserts tab B's DOM updates without re-posting its own
 * `readingModeChanged` (the loop-avoidance guard in `applyReadingModeFromHost`).
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

test('toggling Reading Mode in one tab broadcasts to another open tab', async ({ page, context }) => {
  const pageB = await context.newPage();
  await openEditor(page, '# hello');
  await openEditor(pageB, '# world');

  await clearPosted(page);
  // US-19.24: the main icon resets to Standard (disable); enabling a reading
  // mode goes through the dropdown (Sepia row → setMode).
  await page.locator('#reading-toggle ~ .split-caret').click();
  await page.locator('.toolbar-popover[data-for-id="reading-toggle"] [data-dropdown-value="sepia"]').click();
  await expect(page.locator('#reading-toggle')).toHaveClass(/active/);
  await expect(page.locator('body')).toHaveClass(/reading-mode/);

  const posted = await page.evaluate(
    () => (window as unknown as { __posted: Array<{ type: string; enabled: boolean; mode: string }> }).__posted
  );
  const readingModeMsg = posted.find((m) => m.type === 'readingModeChanged');
  expect(readingModeMsg).toMatchObject({ type: 'readingModeChanged', enabled: true });

  // Tab B should still be untouched before the (simulated) host broadcast arrives.
  await expect(pageB.locator('body')).not.toHaveClass(/reading-mode/);

  await clearPosted(pageB);
  await pageB.evaluate((msg) => window.postMessage(msg, '*'), readingModeMsg);

  await expect(pageB.locator('body')).toHaveClass(/reading-mode/);
  await expect(pageB.locator('#reading-toggle')).toHaveClass(/active/);

  // Loop guard: applying a broadcast must not re-post another readingModeChanged.
  const postedAfterBroadcast = await pageB.evaluate(
    () => (window as unknown as { __posted: Array<{ type: string }> }).__posted
  );
  expect(postedAfterBroadcast.filter((m) => m.type === 'readingModeChanged')).toEqual([]);

  await pageB.close();
});

test('a redundant broadcast matching current state does not re-render (no-op guard in applyReadingModeFromHost)', async ({ page }) => {
  await openEditor(page, '# hello', {
    readability: { enabled: true, mode: 'standard', fontFamily: '', zen: false },
  });
  // Let the init-handshake's own no-anim guard fully settle first (its double-rAF
  // removal of 'reading-no-anim' is itself a body class mutation, unrelated to what
  // this test checks) so the observer below only sees mutations from the broadcast.
  await page.waitForFunction(() => !document.body.classList.contains('reading-no-anim'));

  // Observe body's class attribute directly — a real (non-guarded) apply() call
  // always touches classList even when the resulting classes end up identical,
  // so this is a genuine behavioral check, not just an absence-of-message check.
  await page.evaluate(() => {
    (window as unknown as { __classMutations: number }).__classMutations = 0;
    new MutationObserver((records) => {
      (window as unknown as { __classMutations: number }).__classMutations += records.length;
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  });

  await page.evaluate(() =>
    window.postMessage({ type: 'readingModeChanged', enabled: true, mode: 'standard' }, '*')
  );
  // Give any (unwanted) mutation a frame to land before asserting its absence.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const mutations = await page.evaluate(() => (window as unknown as { __classMutations: number }).__classMutations);
  expect(mutations).toBe(0);
});

test('re-selecting the already-active Reading Mode option does not broadcast (sending-end no-op guard)', async ({ page }) => {
  // Default harness config: Reading Mode starts disabled — "Follow VS Code" is
  // already the active row. Re-picking it from the dropdown must be a true no-op:
  // before the bug 0716 #2 review fix, disable() unconditionally notified even
  // when nothing changed, because it's reachable directly from the dropdown
  // (not gated by toggle()'s own "already enabled?" check).
  await openEditor(page, '# hello');
  await clearPosted(page);

  await page.locator('#reading-toggle ~ .split-caret').click();
  await page.locator('.toolbar-popover[data-for-id="reading-toggle"] .toolbar-popover-item[data-dropdown-value="off"]').click();

  const posted = await page.evaluate(() => (window as unknown as { __posted: Array<{ type: string }> }).__posted);
  expect(posted.filter((m) => m.type === 'readingModeChanged')).toEqual([]);
});
