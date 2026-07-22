/**
 * Bug #6 — the `@` commit must NOT eat the whitespace immediately before the
 * trigger. runAtInsertLink/runAtInsertImage insert the fresh `<a>`/`<img>` via
 * a live Range.insertNode (not execCommand('insertHTML'), which Chromium
 * normalizes so a now-trailing ASCII space on the preceding text node is
 * dropped). These tests type a real space before `@`/before the pick and assert
 * the space survives.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

interface Posted {
  type: string;
  query?: string;
  requestId?: number;
}
interface FileReply {
  path: string;
  name: string;
  dir: string;
}

/** Reply to the most recent `searchFiles` the webview posted, like the host's `fileSearchResult`. */
async function replyLastFileSearch(page: Page, files: FileReply[]): Promise<void> {
  await page.evaluate((files) => {
    const posted = (window as unknown as { __posted: Posted[] }).__posted;
    const req = [...posted].reverse().find((m) => m.type === 'searchFiles');
    if (!req) throw new Error('no searchFiles posted');
    window.postMessage({ type: 'fileSearchResult', requestId: req.requestId, files }, '*');
  }, files);
}

/** Place a collapsed caret at the END of the paragraph whose text is `paraText`. */
async function caretAtEndOfParagraph(page: Page, paraText: string): Promise<void> {
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content, paraText) => {
    const p = Array.from(content.querySelectorAll('p')).find((el) => el.textContent === paraText)!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, paraText);
}

/** Place a collapsed caret at the START of the paragraph whose text is `paraText`. */
async function caretAtStartOfParagraph(page: Page, paraText: string): Promise<void> {
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content, paraText) => {
    const p = Array.from(content.querySelectorAll('p')).find((el) => el.textContent === paraText)!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, paraText);
}

test('bug 6: `@` + pick a heading keeps the space before `@` (link commit)', async ({ page }) => {
  await openEditor(page, '# Target\n\nHello');
  await caretAtEndOfParagraph(page, 'Hello');
  // Space then `@`: the space lands in the editor -> "Hello "; `@` opens the popup.
  await page.keyboard.type(' @');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await page.keyboard.press('Enter'); // "Target" is the first (highlighted) heading

  await page.waitForFunction(() => !!document.querySelector('#content a[href="#target"]'));
  await expect(page.locator('#content a[href="#target"]')).toHaveText('Target');
  // The space between "Hello" and the link must survive - not "HelloTarget".
  const text = (await page.locator('#content p').first().textContent())!.replace(/\u00A0/g, " ");
  expect(text).toBe('Hello Target');
});

test('bug 6: `@` at line start adds no phantom leading space', async ({ page }) => {
  await openEditor(page, '# Target\n\ntext');
  await caretAtStartOfParagraph(page, 'text');
  await page.keyboard.type('@');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await page.keyboard.press('Enter');

  await page.waitForFunction(() => !!document.querySelector('#content a[href="#target"]'));
  // No leading char lost and no phantom space inserted before the link.
  const text = (await page.locator('#content p').first().textContent())!.replace(/\u00A0/g, " ");
  expect(text).toBe('Targettext');
});

test('bug 6: Image toolbar pick keeps the space before the caret (image commit)', async ({ page }) => {
  // A mid-line ASCII space (between "Hello " and "world") is the case insertHTML
  // collapsed; caret sits right after that space, before "world".
  await openEditor(page, 'Hello world');
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content) => {
    const p = content.querySelector('p')!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 6); // just after "Hello "
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.locator('#fmt-image').click();
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.type('pic');
  await replyLastFileSearch(page, [{ path: 'pic.png', name: 'pic.png', dir: '.' }]);
  await page.locator('.trigger-popup-item', { hasText: 'pic.png' }).first().click();

  await page.waitForFunction(() => !!document.querySelector('#content img[src="pic.png"]'));
  // Space before the <img> must survive - not "Helloworld" (bug #6).
  const text = (await page.locator('#content p').first().textContent())!.replace(/\u00A0/g, " ");
  expect(text).toBe('Hello world');
});
