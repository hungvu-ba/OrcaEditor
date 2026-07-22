/**
 * bug_General.md Mention Declare #3 (resurfacing): a host `type:'update'` that
 * arrives WHILE a `/`/`@` trigger popup is open used to rebuild #content
 * (renderDocument → triggerPopup.close() + restoreCaretAtSource), detaching the
 * popup and stealing focus back to the editor. The filter text typed next then
 * leaked into #content and the committing Enter added a stray newline — while a
 * mouse click (no further typing) escaped it.
 *
 * The webview now DEFERS a host update while a popup owns the editor keyboard
 * (hasInputOwner) and flushes it when the popup releases input, dropping it if a
 * local edit (the popup's own commit) advanced the doc meanwhile.
 *
 * The Playwright harness has no real host, so the host update is injected by
 * hand (same technique as update-caret-preserve.spec.ts).
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, popupQueryValue } from './_harness';

async function focusEmptyParagraph(page: Page): Promise<void> {
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content) => {
    const p = content.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

/** Inject a host document re-render on the same channel provider.ts uses. */
async function pushUpdate(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => window.postMessage({ type: 'update', text: t }, '*'), text);
  await page.waitForTimeout(40);
}

test('mid-flow host update does not steal the popup: filter keeps filtering, no leak', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  // Host echoes an update mid-flow (text differs from the webview's currentText,
  // so pre-fix it would re-render and close the popup).
  await pushUpdate(page, '/');

  await page.keyboard.type('fo');

  // Popup still owns input: the filter lands in its query input, not #content.
  expect(await popupQueryValue(page)).toBe('fo');
  await expect(page.locator('#content')).toHaveText('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();
});

test('exec command via Enter survives a mid-flow update: command runs, run deleted, no newline', async ({ page }) => {
  await openEditor(page, '', {
    trigger: { dateFormat: 'YYYY-MM-DD', executeCommands: [{ id: 'orcaEditor.toggleZen', label: 'Focus mode' }], mode: 'advanced' },
  });
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await pushUpdate(page, '/'); // host update arrives right after the marker
  await page.keyboard.type('fo');

  await expect(page.locator('.trigger-popup-item', { hasText: 'Focus mode' })).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.locator('.trigger-popup')).toBeHidden();
  // No `fo` residue and no extra block/newline — the exact real-app symptom.
  await expect(page.locator('#content')).not.toContainText('fo');
  expect(await page.locator('#content').evaluate((el) => el.childElementCount)).toBe(1);
  await page.waitForFunction(() =>
    (window as unknown as { __posted: { type: string; commandId?: string }[] }).__posted.some(
      (m) => m.type === 'executeCommand' && m.commandId === 'orcaEditor.toggleZen'
    )
  );
});

test('a genuine deferred update is flushed after the popup cancels (Escape)', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  // A real external edit arrives while the popup is open; it must not be lost.
  await pushUpdate(page, 'Injected while open\n');
  await page.keyboard.press('Escape');

  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('#content')).toContainText('Injected while open');
});
