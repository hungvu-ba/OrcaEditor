/**
 * X-6 (Cross-Environment Defects audit): on Windows/Linux, AltGr sets BOTH
 * ctrlKey=true and altKey=true. The Ctrl/Cmd+Shift+X (strikethrough) and
 * Ctrl/Cmd+Shift+Z (redo) handlers in main.ts checked only `mod && e.shiftKey`,
 * so on a Vietnamese/Polish/German/Brazilian layout typing an AltGr+Shift+X /
 * AltGr+Shift+Z character fired strikethrough or a destructive redo and
 * preventDefault swallowed the character. macOS has no AltGr, so it was
 * invisible on the dev machine.
 *
 * `content.press('Control+...')` can't model AltGr, so these dispatch a real
 * KeyboardEvent with the exact modifier flags AltGr produces. The handler only
 * reads e.ctrlKey/metaKey/altKey/shiftKey/key, so a synthetic keydown exercises
 * the guard faithfully.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

type Posted = { type: string };

/** Dispatch a keydown on #content with explicit modifier flags. */
async function pressKey(
  page: import('@playwright/test').Page,
  key: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }
): Promise<void> {
  await page.locator('#content').evaluate((el, { key, mods }) => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        ctrlKey: !!mods.ctrl,
        altKey: !!mods.alt,
        shiftKey: !!mods.shift,
        metaKey: !!mods.meta,
        bubbles: true,
        cancelable: true,
      })
    );
  }, { key, mods });
}

function selectFirstParagraph(page: import('@playwright/test').Page): Promise<void> {
  return page.locator('#content').evaluate((el) => {
    const textNode = el.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

function hasStrike(page: import('@playwright/test').Page): Promise<boolean> {
  return page
    .locator('#content')
    .evaluate((el) => /<(s|strike)\b|text-decoration[^;"]*line-through/i.test(el.innerHTML));
}

async function postedTypes(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __posted: Posted[] }).__posted.map((m) => m.type)
  );
}

test('Ctrl+Shift+X strikes text but AltGr+Shift+X (ctrl+alt) does not', async ({ page }) => {
  await openEditor(page, 'hello world');

  // Positive control: the real strikethrough shortcut still works.
  await selectFirstParagraph(page);
  await pressKey(page, 'x', { ctrl: true, shift: true });
  expect(await hasStrike(page)).toBe(true);

  // AltGr repro: same keys plus altKey must NOT strike anything new.
  await openEditor(page, 'hello world');
  await selectFirstParagraph(page);
  await pressKey(page, 'x', { ctrl: true, alt: true, shift: true });
  expect(await hasStrike(page)).toBe(false);
});

test('Ctrl+Shift+Z posts redo but AltGr+Shift+Z (ctrl+alt) does not', async ({ page }) => {
  // Positive control: the redo shortcut still delegates to the host.
  await openEditor(page, 'alpha');
  await page.locator('#content').click();
  await clearPosted(page);
  await pressKey(page, 'z', { ctrl: true, shift: true });
  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some((m) => m.type === 'redo')
  );

  // AltGr repro: adding altKey must NOT fire the destructive redo.
  await openEditor(page, 'alpha');
  await page.locator('#content').click();
  await clearPosted(page);
  await pressKey(page, 'z', { ctrl: true, alt: true, shift: true });
  await page.waitForTimeout(400);
  expect(await postedTypes(page)).not.toContain('redo');
});
