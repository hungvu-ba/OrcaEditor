/**
 * Right-click menu Cut / Copy / Paste. Inside VS Code's nested webview iframe
 * `execCommand('paste')` is always refused and `execCommand('cut'|'copy')` does
 * not reliably fire a clipboard event, so the menu routes through the async
 * Clipboard API — the same path as the Cmd/Ctrl+X/V fallbacks. The clipboard is
 * stubbed so the test observes exactly what the menu reads and writes.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

const DOC = '# Heading one\n\nAlpha paragraph text.\n\nBeta paragraph text.\n';

type ClipWindow = Window & { __clipText: string | null; __clipHtml: string | null };

/** Replace navigator.clipboard with an in-memory stub seeded with `readValue`. */
async function stubClipboard(page: Page, readValue: string): Promise<void> {
  await page.evaluate((readValue) => {
    const w = window as unknown as ClipWindow;
    w.__clipText = null;
    w.__clipHtml = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t: string) => {
          w.__clipText = t;
          return Promise.resolve();
        },
        write: async (items: ClipboardItem[]) => {
          const item = items[0];
          w.__clipText = await (await item.getType('text/plain')).text();
          if (item.types.includes('text/html')) {
            w.__clipHtml = await (await item.getType('text/html')).text();
          }
        },
        readText: () => Promise.resolve(readValue),
        read: () => Promise.resolve([]),
      },
    });
  }, readValue);
}

async function selectIn(page: Page, pIndex: number, from: number, to: number): Promise<void> {
  await page.locator('#content').evaluate(
    (el, { pIndex, from, to }) => {
      (el as HTMLElement).focus();
      const node = el.querySelectorAll('p')[pIndex].firstChild!;
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { pIndex, from, to }
  );
}

async function pick(page: Page, label: string): Promise<void> {
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await expect(page.locator('.comment-context-menu')).toBeVisible();
  await page.locator('.comment-menu-item', { hasText: label }).click();
}

function clip(page: Page): Promise<{ text: string | null; html: string | null }> {
  return page.evaluate(() => {
    const w = window as unknown as ClipWindow;
    return { text: w.__clipText, html: w.__clipHtml };
  });
}

test('Copy writes the selection as Markdown (plus HTML) and leaves the text', async ({ page }) => {
  await openEditor(page, DOC);
  await stubClipboard(page, '');
  await selectIn(page, 0, 0, 5);
  await pick(page, 'Copy');
  await expect.poll(async () => (await clip(page)).text?.trim()).toBe('Alpha');
  expect((await clip(page)).html).toContain('Alpha');
  await expect(page.locator('#content p').first()).toHaveText('Alpha paragraph text.');
});

test('Cut writes the selection to the clipboard and removes it', async ({ page }) => {
  await openEditor(page, DOC);
  await stubClipboard(page, '');
  await selectIn(page, 0, 0, 6);
  await pick(page, 'Cut');
  await expect.poll(async () => (await clip(page)).text?.trim()).toBe('Alpha');
  await expect(page.locator('#content p').first()).toHaveText('paragraph text.');
});

test('Paste inserts the clipboard text rendered as Markdown at the selection', async ({ page }) => {
  await openEditor(page, DOC);
  await stubClipboard(page, '**bold**');
  await selectIn(page, 1, 0, 4);
  await pick(page, 'Paste');
  await expect(page.locator('#content p').nth(1).locator('strong')).toHaveText('bold');
  await expect(page.locator('#content p').nth(1)).not.toContainText('Beta');
});
