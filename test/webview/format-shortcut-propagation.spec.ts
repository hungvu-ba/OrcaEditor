/**
 * The VS Code webview preload listens for `keydown` on the webview's `window`
 * (bubble phase), ignores `defaultPrevented`, and forwards every key to the
 * workbench. So a Ctrl/Cmd+B in `#content` bolded the text AND toggled the
 * Primary Side Bar (+I Extensions view, +E Quick Open on Windows). The inline-
 * format chords must stop at `#content`; Ctrl/Cmd+S must still reach the
 * window so VS Code saves.
 *
 * The harness has no preload, so a `window` keydown spy stands in for it.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

type Page = import('@playwright/test').Page;

/** Dispatch a keydown on #content with explicit modifier flags. */
async function pressKey(page: Page, key: string, mods: { ctrl?: boolean; shift?: boolean }): Promise<void> {
  await page.locator('#content').evaluate((el, { key, mods }) => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        bubbles: true,
        cancelable: true,
      })
    );
  }, { key, mods });
}

function selectFirstParagraph(page: Page): Promise<void> {
  return page.locator('#content').evaluate((el) => {
    const textNode = el.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

/** Stand-in for the preload's bubble-phase `window` keydown listener. */
function installWindowSpy(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __windowKeys: string[] };
    w.__windowKeys = [];
    window.addEventListener('keydown', (e) => w.__windowKeys.push(e.key));
  });
}

function windowKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __windowKeys: string[] }).__windowKeys);
}

const FORMAT_CHORDS = [
  { name: 'Control+B', key: 'b', shift: false, formatted: /<(b|strong)\b/i },
  { name: 'Control+I', key: 'i', shift: false, formatted: /<(i|em)\b/i },
  { name: 'Control+E', key: 'e', shift: false, formatted: /<code\b/i },
  { name: 'Control+Shift+X', key: 'X', shift: true, formatted: /<(s|strike)\b|text-decoration[^;"]*line-through/i },
];

for (const chord of FORMAT_CHORDS) {
  test(`${chord.name} formats the selection and does not reach window`, async ({ page }) => {
    await openEditor(page, 'hello world');
    await installWindowSpy(page);
    await selectFirstParagraph(page);

    await pressKey(page, chord.key, { ctrl: true, shift: chord.shift });

    const html = await page.locator('#content').evaluate((el) => el.innerHTML);
    expect(html).toMatch(chord.formatted);
    expect(await windowKeys(page)).toEqual([]);
  });
}

test('Control+S still reaches window so VS Code can save', async ({ page }) => {
  await openEditor(page, 'hello world');
  await installWindowSpy(page);
  await page.locator('#content').click();

  await pressKey(page, 's', { ctrl: true });

  expect(await windowKeys(page)).toEqual(['s']);
});
