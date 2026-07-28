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

/**
 * Req 24 US-23.18 — the routes `ownsNativeUndo` structurally cannot see.
 *
 * Everything above tests the shipped US-23.6 guard, which only ever runs from
 * `#content`'s own keydown listener. Every comment field is mounted on
 * `document.body`, so that listener is never in their propagation path and the
 * cases above prove only WHERE the composer is mounted, not that a chord
 * pressed in it is consumed. These four cover the guard that does consume it.
 */
/**
 * Dispatch each undo/redo chord at every focusable element of `surfaceSelector`
 * and report the ones that were NOT consumed.
 *
 * `defaultPrevented` is the assertion, because it is the guard's own observable
 * effect. Asserting "nothing was posted to the host" instead — the obvious
 * choice — proves nothing here: these surfaces are mounted on `document.body`,
 * so `#content`'s handler (the only thing that ever posts `undo`) is not in
 * their propagation path and nothing is posted whether the guard exists or not.
 * That assertion passes with `initCommentUndoGuard()` deleted; this one does not.
 *
 * It walks the LIVE DOM rather than a hardcoded field list (AC2): every
 * focusable descendant is tested, so a surface that grows a new control is
 * covered without touching this test. That is what catches the case where the
 * registry lists only leaf text fields — the composer's own Submit button stays
 * focusable by design (AC7 keeps it `aria-disabled`, never `disabled`), so
 * Tab-then-undo is a real route out of the guard.
 */
async function chordLeaksIn(page: Page, surfaceSelector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const surface = document.querySelector(sel);
    if (surface === null) {
      throw new Error(`surface ${sel} is not mounted`);
    }
    const focusable = [surface, ...surface.querySelectorAll('textarea, input, button, [tabindex]')];
    const chords = [
      { code: 'KeyZ', key: 'z', ctrlKey: true, shiftKey: false, metaKey: false },
      { code: 'KeyZ', key: 'z', ctrlKey: false, shiftKey: false, metaKey: true },
      { code: 'KeyY', key: 'y', ctrlKey: true, shiftKey: false, metaKey: false },
      { code: 'KeyZ', key: 'z', ctrlKey: false, shiftKey: true, metaKey: true },
    ];
    const leaks: string[] = [];
    for (const target of focusable) {
      (target as HTMLElement).focus?.();
      for (const chord of chords) {
        const event = new KeyboardEvent('keydown', { ...chord, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        if (!event.defaultPrevented) {
          const name = `${target.tagName.toLowerCase()}.${String(target.className).split(' ')[0]}`;
          leaks.push(`${name} <- ${chord.metaKey ? 'Meta' : 'Control'}${chord.shiftKey ? '+Shift' : ''}+${chord.key}`);
        }
      }
    }
    return leaks;
  }, surfaceSelector);
}

test.describe('US-23.18 — the comment-field undo guard', () => {
  test('AC1/AC2: every focusable element of the composer consumes the chord', async ({ page }) => {
    await openEditor(page, DOC);
    await selectIn(page, 'p', 6, 15);
    await openComposer(page);

    expect(await chordLeaksIn(page, '.comment-composer')).toEqual([]);
  });

  // Complement to the case above, not a duplicate of it: that one proves the
  // guard RUNS, this one proves it does not STEAL. `preventDefault()` cancels
  // the browser's own field undo, so the guard reissues it via `execCommand`;
  // if that reissue were dropped, the Reviewer would lose the ability to correct
  // a typo in their own comment — the exact thing US-23.6 AC2 protects.
  test('AC1: the composer field keeps its OWN undo after the guard cancels the key', async ({ page }) => {
    await openEditor(page, DOC);
    await selectIn(page, 'p', 6, 15);
    await openComposer(page);
    // Real typing, not `.fill()`: only genuine input builds the native history
    // that `preventDefault()` cancels and the guard has to reissue. `.fill()`
    // sets `value` directly and leaves nothing to roll back.
    await page.locator('.comment-composer-input').click();
    await page.locator('.comment-composer-input').pressSequentially('draft');
    await clearPosted(page);

    await page.locator('.comment-composer-input').press('ControlOrMeta+z');

    // A real rollback of the typing, asserted as "a strictly shorter prefix of
    // what was typed" rather than a fixed value: `execCommand('undo')` undoes one
    // typing unit, and Chromium's unit size for `pressSequentially` is its own
    // business — pinning the exact result would make this fail on a browser
    // version that coalesces differently. The shape is what matters, and it
    // still rejects the two real failure modes: nothing happened (the reissue
    // was dropped), or the field was wiped/mangled rather than rolled back.
    const rolledBack = await page.locator('.comment-composer-input').inputValue();
    expect(rolledBack).not.toBe('draft');
    expect('draft'.startsWith(rolledBack), `"${rolledBack}" must be a prefix of the typed text`).toBe(true);
    expect(await postedOfType(page, ['undo', 'redo', 'edit'])).toEqual([]);
  });

  test('AC8: the anchor-lost dialog swallows undo/redo instead of leaking it to the document', async ({ page }) => {
    await openEditor(page, DOC);
    // A thread anchored for real, then robbed of its text. Both halves matter:
    // the dialog arms on the TRANSITION into floating (`previousState !==
    // 'floating'` in comment-resolve.ts), so a thread seeded already-unplaceable
    // never opens it; and the replacement has to drop the whole document, since
    // a merely edited paragraph still places at tier 3 (approximate).
    await selectIn(page, 'p', 0, 5);
    await openComposer(page);
    await page.locator('.comment-composer-input').fill('Anchor me.');
    await page.locator('.comment-composer-submit').click();
    const create = await page.evaluate(
      () =>
        (window as unknown as { __posted: Array<{ type: string; requestId?: number }> }).__posted
          .filter((m) => m.type === 'createComment')
          .at(-1)!
    );
    await page.evaluate(
      (requestId) =>
        window.postMessage(
          { type: 'createCommentResult', requestId, ok: true, author: 'reviewer', timestamp: '2026-07-20T09:00:00.000Z' },
          '*'
        ),
      create.requestId
    );
    await page.evaluate(() => window.postMessage({ type: 'update', text: '# Session expiry\n' }, '*'));
    await expect(page.locator('.comment-anchor-lost')).toBeVisible();
    await clearPosted(page);

    // A modal with no text field of its own: focus lives on its card, so the
    // chord must die here rather than reach the document underneath the scrim.
    expect(await chordLeaksIn(page, '.comment-anchor-lost')).toEqual([]);
    expect(await postedOfType(page, ['undo', 'redo', 'edit'])).toEqual([]);
  });

  test('AC2: every focusable element of the thread popover consumes the chord', async ({ page }) => {
    await openEditor(page, DOC);
    await selectIn(page, 'p', 0, 5);
    await openComposer(page);
    await page.locator('.comment-composer-input').fill('Anchor me.');
    await page.locator('.comment-composer-submit').click();
    const create = await page.evaluate(
      () =>
        (window as unknown as { __posted: Array<{ type: string; requestId?: number }> }).__posted
          .filter((m) => m.type === 'createComment')
          .at(-1)!
    );
    await page.evaluate(
      (requestId) =>
        window.postMessage(
          { type: 'createCommentResult', requestId, ok: true, author: 'reviewer', timestamp: '2026-07-20T09:00:00.000Z' },
          '*'
        ),
      create.requestId
    );
    await page.locator('.comment-gutter-pin').first().click();
    await expect(page.locator('.comment-popover')).toBeVisible();

    // A second surface, and the one with the richest mix of controls: the reply
    // `<textarea>` alongside the Resolve/Close/Delete action bar. The buttons are
    // the half a leaf-field-only registry would miss.
    expect(await chordLeaksIn(page, '.comment-popover')).toEqual([]);
    expect(await postedOfType(page, ['undo', 'redo', 'edit'])).toEqual([]);
  });

  test('AC3: the guard is scoped — undo from #content still delegates while a composer is open', async ({ page }) => {
    await openEditor(page, DOC);
    await selectIn(page, 'p', 6, 15);
    await openComposer(page);
    await clearPosted(page);

    // The positive control that a document-level capture listener could break:
    // with the guard installed AND armed (a comment field is on screen), a chord
    // pressed anywhere else must still reach the document's undo stack.
    await pressUndoRedo(page, '#content', 'Control+z');
    expect(await postedOfType(page, ['undo'])).toEqual(['undo']);
  });

  test('AC7: a re-render under an open composer keeps the draft and refuses Submit', async ({ page }) => {
    await openEditor(page, DOC);
    await selectIn(page, 'p', 6, 15);
    await openComposer(page);
    await page.locator('.comment-composer-input').fill('Half-typed thought.');
    await clearPosted(page);

    // What an undo/redo delivers to the webview: a full 'update' re-render. It
    // drops every session-only anchor id, so the composer's target stops
    // resolving — the condition `submit()` already refused on, surfaced up front.
    await page.evaluate((text) => window.postMessage({ type: 'update', text }, '*'), DOC.replace('Alpha', 'Gamma'));
    await page.waitForTimeout(450);

    await expect(page.locator('.comment-composer')).toBeVisible();
    await expect(page.locator('.comment-composer-input')).toHaveValue('Half-typed thought.');
    await expect(page.locator('.comment-composer-submit')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.comment-composer-error')).toContainText('Target lost');

    // Refused, not merely discouraged: fire the handler directly. `.click()`
    // cannot be used — Playwright treats `aria-disabled="true"` as not enabled
    // and would time out on actionability, never reaching `submit()` to prove
    // the refusal is in the handler rather than only in the button's styling.
    await page.locator('.comment-composer-submit').dispatchEvent('click');
    expect(await postedOfType(page, ['createComment'])).toEqual([]);
    await expect(page.locator('.comment-composer-input')).toHaveValue('Half-typed thought.');
  });
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
