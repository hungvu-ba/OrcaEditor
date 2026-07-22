/**
 * T0.1 (Trigger Popup Focused-Input Refactor) — the shell's query row is now a
 * real focused <input> that owns filtering natively (native caret + native IME),
 * replacing the old synthetic text span + fake caret. Driven directly via
 * window.TriggerPopupDebug with a fake dataSource (same pattern as
 * trigger-popup-shell.spec.ts) — no real @// trigger needed to exercise the shell.
 *
 * Covers: input is focused on open(); typing into it filters by the input value;
 * ArrowDown + Enter commits the highlighted item; Escape closes.
 */
import { test, expect } from '@playwright/test';
import { openEditor, popupQueryValue } from './_harness';

interface Group {
  label: string;
  items: Array<{ id: string; label: string }>;
}
interface Ctrl {
  open(a: {
    axis: string;
    anchorRange: Range;
    dataSource: { query(q: string): Group[] | Promise<Group[]> };
    onPick(item: unknown): void;
    onClose?(): void;
    restoreCaretOnCancel?: boolean;
  }): void;
  isOpen(): boolean;
  close(): void;
}
interface TriggerPopupDebugApi {
  initTriggerPopup(deps: { content: HTMLElement }): Ctrl;
}

/** Open the shell with a fake Headings dataSource that filters by substring. */
async function openHeadingsPopup(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const content = document.getElementById('content')!;
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(true);
    const all = ['Heading 1', 'Heading 2', 'Table', 'Image'];
    const debug = (window as unknown as { TriggerPopupDebug: TriggerPopupDebugApi }).TriggerPopupDebug;
    const ctrl = debug.initTriggerPopup({ content });
    (window as unknown as { __picked: string | null }).__picked = null;
    ctrl.open({
      axis: '/',
      anchorRange: range,
      // Simulate a typed-marker session so the Bug 5 empty-query Space-cancel
      // behavior (opt-in) is exercised at the shell level.
      restoreCaretOnCancel: true,
      dataSource: {
        query: (q: string) => [
          {
            label: 'Results',
            items: all
              .filter((label) => label.toLowerCase().includes(q.toLowerCase()))
              .map((label) => ({ id: label, label })),
          },
        ],
      },
      onPick: (item: unknown) => {
        (window as unknown as { __picked: string | null }).__picked = (item as { id: string }).id;
      },
    });
    (window as unknown as { __ctrl: Ctrl }).__ctrl = ctrl;
  });
}

test('open() focuses the query input', async ({ page }) => {
  await openEditor(page, 'hello world');
  await openHeadingsPopup(page);

  const isInputFocused = await page.evaluate(
    () => document.activeElement === document.querySelector('.trigger-popup-query-input')
  );
  expect(isInputFocused).toBe(true);
});

test('typing into the input filters results by its value', async ({ page }) => {
  await openEditor(page, 'hello world');
  await openHeadingsPopup(page);

  // The input is focused on open — type into it directly.
  await page.keyboard.type('head', { delay: 10 });

  expect(await popupQueryValue(page)).toBe('head');
  const labels = await page.locator('.trigger-popup-item-label').allTextContents();
  expect(labels).toEqual(['Heading 1', 'Heading 2']);
});

test('ArrowDown then Enter commits the highlighted item and closes the popup', async ({ page }) => {
  await openEditor(page, 'hello world');
  await openHeadingsPopup(page);

  // First enabled row is highlighted on render; ArrowDown moves to the 2nd item.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  const picked = await page.evaluate(() => (window as unknown as { __picked: string | null }).__picked);
  expect(picked).toBe('Heading 2');
  await expect(page.locator('.trigger-popup')).toBeHidden();
});

test('Escape closes the popup', async ({ page }) => {
  await openEditor(page, 'hello world');
  await openHeadingsPopup(page);
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  const stillOpen = await page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.isOpen());
  expect(stillOpen).toBe(false);
});

test('Bug 5 — Space on an empty query cancels the popup (shell-level)', async ({ page }) => {
  await openEditor(page, 'hello world');
  await openHeadingsPopup(page);
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.press('Space');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  const stillOpen = await page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.isOpen());
  expect(stillOpen).toBe(false);
});

test('Bug 5 — Space with a non-empty query keeps the popup open and stays as filter text', async ({ page }) => {
  await openEditor(page, 'hello world');
  await openHeadingsPopup(page);
  await page.keyboard.type('he', { delay: 10 });
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.press('Space');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  expect(await popupQueryValue(page)).toBe('he ');
});

// Bug 4/5 review fix — without the opt-in `restoreCaretOnCancel` flag (the toolbar
// Image-with-selection and re-opened declare sub-step sessions), cancel must
// keep its prior behavior: Escape must NOT collapse a non-collapsed content anchor,
// and empty-query Space must NOT cancel (stays filter text).
async function openNoRestorePopupOverSelection(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const content = document.getElementById('content')!;
    const p = content.querySelector('p')!;
    // Select the whole paragraph text → a NON-collapsed anchor (like toolbar mode).
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const debug = (window as unknown as { TriggerPopupDebug: TriggerPopupDebugApi }).TriggerPopupDebug;
    const ctrl = debug.initTriggerPopup({ content });
    ctrl.open({
      axis: '@',
      anchorRange: range.cloneRange(),
      // restoreCaretOnCancel intentionally OMITTED (non-marker session).
      dataSource: { query: () => [{ label: 'R', items: [{ id: 'a', label: 'Alpha' }] }] },
      onPick: () => {},
    });
    (window as unknown as { __ctrl: Ctrl }).__ctrl = ctrl;
  });
}

test('review fix — no opt-in flag: Escape does NOT run the shell caret-restore', async ({ page }) => {
  await openEditor(page, 'hello world');
  await openNoRestorePopupOverSelection(page);
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  // F1 regression guard: the shell must NOT force-focus #content / collapse the
  // anchor on a non-marker session. dom.restoreSelection would have focused
  // #content — so #content must NOT be the active element here. (The synthetic
  // harness can't model the browser's selection retention that the real toolbar
  // path relies on; not-refocusing is the observable proof the restore was gated.)
  const activeIsContent = await page.evaluate(() => document.activeElement === document.getElementById('content'));
  expect(activeIsContent).toBe(false);
});

test('review fix — no opt-in flag: empty-query Space does NOT cancel (stays filter text)', async ({ page }) => {
  await openEditor(page, 'hello world');
  await openNoRestorePopupOverSelection(page);
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.press('Space');
  // F2 regression guard: popup stays open; the space is ordinary filter text.
  await expect(page.locator('.trigger-popup')).toBeVisible();
  expect(await popupQueryValue(page)).toBe(' ');
});
