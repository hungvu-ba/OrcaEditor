/**
 * T0.1 (Trigger Popup Focused-Input Refactor) — the shell's query row is now a
 * real focused <input>, not a synthetic text span + fake caret. This spec was
 * the old fake-caret model; its caret-visibility / editor-caret-suppression
 * assertions are retired and repointed at the input model (focus + input value).
 *
 * These tests drive the REAL `/` trigger (trigger-slash.ts) end-to-end. The
 * real-trigger auto-close policy (selectionchange-based) is rewritten in T1.2 to
 * account for focus now living in the popup input; until T1.2 lands, the
 * real-trigger flows here are only fully coherent as part of the joint set.
 */
import { test, expect } from '@playwright/test';
import { openEditor, popupQueryValue } from './_harness';

/** Caret at the very start of #content's (only) empty paragraph. */
async function focusEmptyParagraph(page: import('@playwright/test').Page): Promise<void> {
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

test('`/` popup focuses the query input (axis marker shows /)', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');

  const card = page.locator('.trigger-popup');
  await expect(card).toBeVisible();

  // The axis marker sits at the head of the query row; the focused <input> owns typing.
  await expect(card.locator('.trigger-popup-query-axis')).toHaveText('/');
  const isInputFocused = await page.evaluate(
    () => document.activeElement === document.querySelector('.trigger-popup-query-input')
  );
  expect(isInputFocused).toBe(true);
});

test('typing in the popup input updates its value and filters results', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  // Focus is now in the popup input; typing lands there and filters via its value.
  await page.keyboard.type('heading', { delay: 20 });

  const card = page.locator('.trigger-popup');
  expect(await popupQueryValue(page)).toBe('heading');

  const labels = await card.locator('.trigger-popup-item-label').allTextContents();
  // Heading 4–6 are hidden from the `/` menu (kept in BLOCK_ITEMS data only).
  expect(labels).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
});

test('clicking a non-row part of the popup does not close it', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  const card = page.locator('.trigger-popup');
  await expect(card).toBeVisible();

  // The hint row is a non-interactive part of the card — a click there must not
  // blur the query input (card mousedown preventDefault keeps focus in the input).
  await card.locator('.trigger-popup-hint').click();
  await expect(card).toBeVisible();
});

test('a host update while the popup is open is deferred (popup stays), then flushed on close', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/trigger-popup-open/);

  // Bug #3: a host document rebuild while the popup owns input is DEFERRED, not
  // applied now — rebuilding #content here would detach the popup and steal focus
  // (leaking the filter). The popup stays open and #content is untouched.
  await page.evaluate(() => window.postMessage({ type: 'update', text: '# Changed\n\nbody\n' }, '*'));
  await page.waitForTimeout(40);
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await expect(page.locator('#content h1')).toHaveCount(0);

  // Closing the popup releases input ownership → the deferred update is flushed
  // and no is-open state lingers.
  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/trigger-popup-open/);
  await expect(page.locator('#content h1')).toHaveText('Changed');
});

/**
 * Bug 4/5 — after a cancel, focus must be back on #content and the caret must sit
 * collapsed right after the trigger marker. Returns the editor's post-cancel state.
 */
async function contentCaretState(
  page: import('@playwright/test').Page
): Promise<{ active: boolean; collapsed: boolean; text: string; charBeforeCaret: string }> {
  return page.evaluate(() => {
    const content = document.getElementById('content')!;
    const sel = window.getSelection()!;
    const before =
      sel.rangeCount > 0 && sel.anchorNode && sel.anchorNode.nodeType === Node.TEXT_NODE
        ? (sel.anchorNode.textContent ?? '').slice(Math.max(0, sel.anchorOffset - 1), sel.anchorOffset)
        : '';
    return {
      active: document.activeElement === content,
      collapsed: sel.isCollapsed,
      text: content.textContent ?? '',
      charBeforeCaret: before,
    };
  });
}

test('Escape closes the `/` popup and restores the caret right after `/`', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/trigger-popup-open/);

  // Bug 4: #content regains focus and a collapsed caret sits right after the `/`.
  const state = await contentCaretState(page);
  expect(state.active).toBe(true);
  expect(state.collapsed).toBe(true);
  expect(state.text).toBe('/');
  expect(state.charBeforeCaret).toBe('/');
});

test('Escape closes the `@` popup and restores the caret right after `@`', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('@');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();

  const state = await contentCaretState(page);
  expect(state.active).toBe(true);
  expect(state.collapsed).toBe(true);
  expect(state.charBeforeCaret).toBe('@');
});

test('Tab with a typed filter (no ghost) keeps the query input focused; Escape still closes', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/head');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  const queryFocused = () =>
    page.evaluate(() => document.activeElement?.classList.contains('trigger-popup-query-input') ?? false);
  expect(await queryFocused()).toBe(true);

  // Bug: plain Tab used to blur the input (focus tabbed away), orphaning the
  // popup so it no longer received Escape. It must now be swallowed.
  await page.keyboard.press('Tab');
  expect(await queryFocused()).toBe(true);
  expect(await popupQueryValue(page)).toBe('head');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  // Focus never left the input → Escape (which rides on its keydown) still closes.
  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
});

test('Space on an empty query cancels the `/` popup and restores the caret (no space inserted)', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.press('Space');
  await expect(page.locator('.trigger-popup')).toBeHidden();

  // Bug 5: the `/` stays, the space is consumed (NOT inserted), caret sits after `/`.
  const state = await contentCaretState(page);
  expect(state.active).toBe(true);
  expect(state.collapsed).toBe(true);
  expect(state.text).toBe('/');
  expect(state.charBeforeCaret).toBe('/');
});

test('Space with a non-empty query keeps the popup open and filters (multi-word label guard)', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await page.keyboard.type('ad', { delay: 20 });
  await expect(page.locator('.trigger-popup')).toBeVisible();

  // Query is non-empty ("ad") → space is filter text, not a cancel gesture.
  await page.keyboard.press('Space');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  expect(await popupQueryValue(page)).toBe('ad ');
});
