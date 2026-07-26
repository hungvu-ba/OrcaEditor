/**
 * Req 23 US-23.6 — a comment action must never occupy a slot in the document's
 * undo/redo stack. Two things can break that, and neither is visible in a
 * hand-built DOM snapshot, so this belongs on the Playwright track
 * (Plan/WEBVIEW_TEST.md):
 *
 *  - AC2: a real undo/redo keystroke inside a comment text field must stay with
 *    that field's own native history instead of being delegated to the host.
 *  - AC3/AC4: the create flow must post ZERO `edit` messages — including the
 *    session-only marker class the composer writes onto the anchored node,
 *    which would otherwise reach `.md` through turndown's raw-HTML path.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

const DOC = '# Heading one\n\nAlpha paragraph text.\n\nBeta paragraph text.\n';

/**
 * An inline tag turndown has no markdown rule for, so it serializes through
 * `safeOuterHtml` — the one path where a class written into `#content` reaches
 * the `.md`. It sits inside a normal paragraph, which is what makes it
 * commentable: a whole raw-HTML block carries no `data-line` and US-23.1 refuses
 * to anchor there at all.
 */
const DOC_KEPT_TAG = '# Heading one\n\nAlpha <mark>marked</mark> text.\n\nBeta paragraph text.\n';

async function selectIn(page: Page, selector: string, from: number, to: number): Promise<void> {
  await page.locator('#content').evaluate(
    (el, { selector, from, to }) => {
      const node = el.querySelector(selector)!.firstChild!;
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { selector, from, to }
  );
}

async function openComposer(page: Page): Promise<void> {
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await expect(page.locator('.comment-context-menu')).toBeVisible();
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await expect(page.locator('.comment-composer')).toBeVisible();
}

/** Messages of the given types recorded by the harness's `acquireVsCodeApi` stub. */
async function postedOfType(page: Page, types: string[]): Promise<string[]> {
  return page.evaluate(
    (wanted) =>
      (window as unknown as { __posted: Array<{ type: string }> }).__posted
        .filter((m) => wanted.includes(m.type))
        .map((m) => m.type),
    types
  );
}

/**
 * Real key presses, both the macOS (`Meta`) and the Windows/Linux (`Control`)
 * form on one machine — CLAUDE.md's cross-platform trap: a shortcut handler
 * must honour both, and a test that only ever presses one cannot prove it.
 * Real presses, not synthetic `KeyboardEvent`s, because AC2's first half ("the
 * field's own native undo still works") only happens for genuine input.
 */
const UNDO_REDO_COMBOS = ['Control+z', 'Meta+z', 'Control+y', 'Meta+Shift+z'];

async function pressUndoRedo(page: Page, selector: string, combo: string): Promise<void> {
  const target = page.locator(selector);
  // Click + `page.keyboard`, never `locator.focus()`/`locator.press()`: a
  // contenteditable nested inside `#content` never becomes
  // `document.activeElement`, and both of those call `focus()` first, which
  // leaves the caret on <body> so the keystroke never reaches the editor
  // handler — the test would then pass without asserting anything (measured).
  await target.click();
  await page.keyboard.press(combo);
}

/** Mount a stand-in for US-23.2's future reply field INSIDE `#content`. */
async function mountFieldInContent(page: Page, kind: 'textarea' | 'text' | 'contenteditable'): Promise<string> {
  await page.locator('#content').evaluate((el, k) => {
    const field =
      k === 'textarea' ? document.createElement('textarea') : document.createElement(k === 'text' ? 'input' : 'div');
    if (k === 'text') {
      (field as HTMLInputElement).type = 'text';
    }
    if (k === 'contenteditable') {
      field.setAttribute('contenteditable', 'true');
      field.textContent = 'reply draft';
    }
    field.id = 'stand-in-reply';
    el.appendChild(field);
  }, kind);
  return '#stand-in-reply';
}

test('AC2: the composer stays mounted outside #content, so its keys never reach the editor handler', async ({
  page,
}) => {
  // A mount-location lock, not guard coverage: the composer card lives on
  // document.body, so the #content listener is never in its propagation path.
  await openEditor(page, DOC);
  await selectIn(page, 'p', 6, 15);
  await openComposer(page);
  await page.locator('.comment-composer-input').fill('draft text');
  await clearPosted(page);

  for (const combo of UNDO_REDO_COMBOS) {
    await pressUndoRedo(page, '.comment-composer-input', combo);
    expect(await postedOfType(page, ['undo', 'redo', 'edit']), `${combo} must not reach the host`).toEqual([]);
  }
});

for (const kind of ['textarea', 'text', 'contenteditable'] as const) {
  test(`AC2: undo/redo in a ${kind} field inside #content stays with the field`, async ({ page }) => {
    await openEditor(page, DOC);
    const field = await mountFieldInContent(page, kind);
    await clearPosted(page);

    for (const combo of UNDO_REDO_COMBOS) {
      await pressUndoRedo(page, field, combo);
      expect(await postedOfType(page, ['undo', 'redo']), `${combo} must not be delegated`).toEqual([]);
    }
  });
}

test('AC2: the field keeps its OWN native undo — the keystroke is not merely swallowed', async ({ page }) => {
  await openEditor(page, DOC);
  const field = await mountFieldInContent(page, 'textarea');
  // Real typing, so Chromium builds a native undo history for the field.
  await page.locator(field).click();
  await page.locator(field).pressSequentially('hello');
  // `ControlOrMeta` here on purpose: this is the one assertion about the
  // BROWSER's own undo command, which only the platform-correct chord triggers.
  // Both raw forms are covered by the delegation tests above.
  await page.locator(field).press('ControlOrMeta+z');

  // "Scoped to the input's own native undo" (AC2), not just "no-op": the field's
  // text really rolls back, which only happens if the guard left the keystroke
  // to the browser instead of calling preventDefault.
  expect(await page.locator(field).inputValue()).not.toBe('hello');
  expect(await postedOfType(page, ['undo', 'redo'])).toEqual([]);
});

test('AC2: undo/redo still delegates to the host from the editor body', async ({ page }) => {
  await openEditor(page, DOC);
  await clearPosted(page);

  await pressUndoRedo(page, '#content', 'Control+z');
  expect(await postedOfType(page, ['undo'])).toEqual(['undo']);

  await clearPosted(page);
  await pressUndoRedo(page, '#content', 'Control+y');
  expect(await postedOfType(page, ['redo'])).toEqual(['redo']);

  // A task-list checkbox is an <input> with no text history of its own — the
  // guard must not swallow its undo.
  await clearPosted(page);
  await page.locator('#content').evaluate((el) => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'stand-in-task';
    el.appendChild(box);
  });
  await pressUndoRedo(page, '#stand-in-task', 'Control+z');
  expect(await postedOfType(page, ['undo'])).toEqual(['undo']);
});

test('AC3/AC4: the whole create flow posts no edit message', async ({ page }) => {
  await openEditor(page, DOC);
  await selectIn(page, 'p', 6, 15);
  await clearPosted(page);

  await openComposer(page);
  await page.locator('.comment-composer-input').fill('No document edit, please.');
  await page.locator('.comment-composer-submit').click();
  // Longer than SYNC_DEBOUNCE_MS, so a debounced edit would have landed by now.
  // The composer stays open until the host answers (US-23.5 made create awaited),
  // and the harness has no host — irrelevant here: what matters is that neither
  // opening, typing, nor submitting produced a document edit.
  await page.waitForTimeout(450);

  expect(await postedOfType(page, ['edit'])).toEqual([]);
  expect(await postedOfType(page, ['createComment'])).toEqual(['createComment']);
});

test('AC3: the composer marker never leaks into the .md through the raw-HTML path', async ({ page }) => {
  await openEditor(page, DOC_KEPT_TAG);
  await selectIn(page, 'mark', 0, 6); // "marked" inside the kept tag
  await openComposer(page);
  // The marker really landed on the kept tag — otherwise this test would pass
  // for the wrong reason.
  await expect(page.locator('#content mark.comment-anchor-active')).toHaveCount(1);

  // An unrelated document edit forces a serialize WHILE the composer is open.
  await clearPosted(page);
  await page.locator('#content').evaluate((el) => {
    const p = el.querySelectorAll('p')[1];
    p.textContent = p.textContent + '!';
    p.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });

  const markdown = await waitForEdit(page);
  expect(markdown).toContain('<mark>marked</mark>');
  expect(markdown).not.toContain('comment-anchor-active');
  expect(markdown).not.toContain('class=""');
});
