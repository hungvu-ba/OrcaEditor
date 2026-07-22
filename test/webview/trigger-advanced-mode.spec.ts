/**
 * Req 21 US-21.5 — `orcaEditor.triggerActions.mode` (`simple` | `advanced`,
 * default `advanced`). This story only ships the setting + the visibility
 * gate's plumbing (provider.ts seed + live `configUpdate`, main.ts's
 * `applyTriggerMode`, and the generic `advancedOnly`-filtering guards in
 * trigger-at.ts/trigger-slash.ts) — no entity-related trigger action exists
 * yet to gate (the `@` Entities scope and `/declare`/`/relate` items are
 * later stories, T5.1/T5.2/T9.1). These tests therefore cover:
 *  - round-trip: `InitConfig.trigger.mode` reaches the webview correctly.
 *  - live toggle: a `configUpdate` from the host re-applies the gate without
 *    reopening the document (mirrors autoOpenToc/showLineNumbers's own
 *    live-update path in main.ts).
 *  - the guard is a no-op today: every currently-shipped `@`/`/` action stays
 *    visible in `simple` mode, since none is flagged `advancedOnly` yet —
 *    proving the gate filters generically (by attribute) rather than by a
 *    hardcoded item list, and never hides already-shipped content.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

/** Place a collapsed caret at the start of the paragraph whose text is `paraText`. */
async function caretAtStartOfParagraph(page: import('@playwright/test').Page, paraText: string): Promise<void> {
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content, paraText) => {
    const p = Array.from(content.querySelectorAll('p')).find((el) => el.textContent === paraText);
    const target = p ?? content.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, paraText);
}

test('default config (no override) round-trips as advanced mode', async ({ page }) => {
  await openEditor(page, 'text');
  await expect(page.locator('body')).toHaveAttribute('data-trigger-mode', 'advanced');
});

test('InitConfig.trigger.mode "simple" round-trips into the webview at open', async ({ page }) => {
  await openEditor(page, 'text', { trigger: { dateFormat: 'YYYY-MM-DD', executeCommands: [], mode: 'simple' } });
  await expect(page.locator('body')).toHaveAttribute('data-trigger-mode', 'simple');
});

test('a live configUpdate toggles the mode without reopening the document', async ({ page }) => {
  await openEditor(page, 'text');
  await expect(page.locator('body')).toHaveAttribute('data-trigger-mode', 'advanced');

  await page.evaluate(() =>
    window.postMessage(
      { type: 'configUpdate', autoOpenToc: false, showLineNumbers: false, triggerMode: 'simple' },
      '*'
    )
  );
  await expect(page.locator('body')).toHaveAttribute('data-trigger-mode', 'simple');

  await page.evaluate(() =>
    window.postMessage(
      { type: 'configUpdate', autoOpenToc: false, showLineNumbers: false, triggerMode: 'advanced' },
      '*'
    )
  );
  await expect(page.locator('body')).toHaveAttribute('data-trigger-mode', 'advanced');
});

test('simple mode does not hide any currently-shipped `@` scope (no Req 21 item flagged advancedOnly yet)', async ({
  page,
}) => {
  await openEditor(page, '# Alpha\n\ntext', {
    trigger: { dateFormat: 'YYYY-MM-DD', executeCommands: [], mode: 'simple' },
  });
  await caretAtStartOfParagraph(page, 'text');
  await page.keyboard.type('@');
  const pills = await page.locator('.trigger-popup-pill').allTextContents();
  expect(pills).toEqual(['All', 'Files', 'Headings']);
});

test('simple mode does not hide any currently-shipped `/` group (no Req 21 item flagged advancedOnly yet)', async ({
  page,
}) => {
  await openEditor(page, '', { trigger: { dateFormat: 'YYYY-MM-DD', executeCommands: [], mode: 'simple' } });
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
  await page.keyboard.type('/');
  const groupLabels = await page.locator('.trigger-popup-group-label').allTextContents();
  expect(groupLabels).toEqual(['Blocks', 'Insert']);
});
