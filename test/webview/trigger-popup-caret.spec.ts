/**
 * Req 20 (Mention Declare bugs 3 & 4) — the shared @// trigger popup must show
 * a blinking caret in its query row (row 1) and suppress the editor's own caret
 * while open, so the user can see that typing there filters. Drives the real
 * main.js bundle (real `/` typing in a real contentEditable).
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

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

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

test('bug 4: `/` popup shows a query-row caret and hides the editor caret', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');

  const card = page.locator('.trigger-popup');
  await expect(card).toBeVisible();

  // The axis marker + a visible blinking caret live in the query row (row 1).
  await expect(card.locator('.trigger-popup-query-axis')).toHaveText('/');
  await expect(card.locator('.trigger-popup-query-caret')).toBeVisible();

  // The editor's own caret is suppressed while the popup owns typing.
  await expect(page.locator('body')).toHaveClass(/trigger-popup-open/);
  const caretColor = await page.locator('#content').evaluate((el) => getComputedStyle(el).caretColor);
  expect(caretColor).toBe(TRANSPARENT);
});

test('bug 3: typing in the popup updates the query row and filters results', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await page.keyboard.type('heading', { delay: 20 });

  const card = page.locator('.trigger-popup');
  await expect(card.locator('.trigger-popup-query-text')).toHaveText('heading');

  const labels = await card.locator('.trigger-popup-item-label').allTextContents();
  expect(labels).toEqual(['Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']);
});

test('bug 3: typing letters via IME composition (isComposing) still filters', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  // Reproduce a Vietnamese IME (Telex/VNI/Unikey) composing "heading" after the
  // "/": mutate the DOM + caret like the browser does mid-composition, then fire
  // the `input` event the browser fires DURING composition (isComposing=true) —
  // the path that used to be dropped so letters never filtered (digits did).
  await page.locator('#content').evaluate((content) => {
    const sel = window.getSelection()!;
    const tn = sel.getRangeAt(0).startContainer as Text; // the text node holding "/"
    tn.textContent = '/heading';
    const nr = document.createRange();
    nr.setStart(tn, tn.textContent.length);
    nr.collapse(true);
    sel.removeAllRanges();
    sel.addRange(nr);
    content.dispatchEvent(
      new InputEvent('input', { isComposing: true, inputType: 'insertCompositionText', data: 'heading', bubbles: true })
    );
  });

  const card = page.locator('.trigger-popup');
  await expect(card.locator('.trigger-popup-query-text')).toHaveText('heading');
  const labels = await card.locator('.trigger-popup-item-label').allTextContents();
  expect(labels).toEqual(['Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']);
});

test('clicking a non-row part of the popup does not close it', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  const card = page.locator('.trigger-popup');
  await expect(card).toBeVisible();

  // The hint row is a non-interactive part of the card — a click there must not
  // blur #content (which would fire selectionchange → close the popup).
  await card.locator('.trigger-popup-hint').click();
  await expect(card).toBeVisible();
});

test('selecting text within the trigger token does NOT close the popup', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/heading');
  const card = page.locator('.trigger-popup');
  await expect(card).toBeVisible();

  // Select part of the "/heading" token (a non-collapsed selection that stays
  // inside the run) — the user is editing the query, so the popup must stay open.
  await page.locator('#content').evaluate((content) => {
    const tn = content.querySelector('p')!.firstChild as Text; // "/heading"
    const r = document.createRange();
    r.setStart(tn, 4);
    r.setEnd(tn, 8);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  });

  await page.waitForTimeout(100); // let selectionchange fire and be handled
  await expect(card).toBeVisible();
});

test('rebuilding #content (external update) while the popup is open closes it and restores the caret', async ({
  page,
}) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/trigger-popup-open/);

  // Host pushes a document rebuild (external edit) while the popup is still open —
  // renderDocument() must close the popup so the caret-suppression class can't linger.
  await page.evaluate(() => window.postMessage({ type: 'update', text: '# Changed\n\nbody\n' }, '*'));

  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/trigger-popup-open/);
  const caretColor = await page.locator('#content').evaluate((el) => getComputedStyle(el).caretColor);
  expect(caretColor).not.toBe(TRANSPARENT);
});

test('editor caret is restored when the popup closes (Escape)', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();

  await expect(page.locator('body')).not.toHaveClass(/trigger-popup-open/);
  const caretColor = await page.locator('#content').evaluate((el) => getComputedStyle(el).caretColor);
  expect(caretColor).not.toBe(TRANSPARENT);
});
