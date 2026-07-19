/**
 * Two code-block header behaviors that need a real browser engine (real toolbar
 * click + execCommand insert + Selection API), so test/roundtrip/ (domino) can't
 * cover them:
 *   1. Bug fix — inserting a code block from the toolbar must show its header bar
 *      (language label = in-place switch menu, Copy, Wrap) IMMEDIATELY, not only
 *      after a host re-render (previously the header appeared just after an undo).
 *   2. Feature — every fenced code block is word-wrapped by default; the header's
 *      "Wrap" button toggles that per block (UI-only state, never serialized).
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('inserting a code block from the toolbar shows its header immediately (no undo)', async ({ page }) => {
  await openEditor(page, 'Hello world\n');
  // Select the paragraph text in #content, then trigger the code-block button's
  // main face (default: JavaScript). The button preserves the selection via
  // mousedown-preventDefault, so the insert runs against it.
  await page.evaluate(() => {
    const p = document.querySelector('#content p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.locator('#fmt-codeblock').click();

  const header = page.locator('#content pre > .md-code-header');
  await expect(header).toHaveCount(1);
  await expect(header.locator('.md-code-lang')).toHaveText('JavaScript');
  await expect(header.locator('button.md-code-wrap')).toHaveCount(1);
  await expect(header.locator('button.md-code-copy')).toHaveCount(1);
});

test('code block wraps by default and the Wrap button toggles it per block', async ({ page }) => {
  await openEditor(page, '```js\nconst a = 1;\n```\n');
  const pre = page.locator('#content pre');
  const wrapBtn = page.locator('#content pre > .md-code-header button.md-code-wrap');

  // Default state: wrapped, button pressed.
  await expect(pre).toHaveClass(/md-code-wrapped/);
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'true');

  // Toggle off → no-wrap (horizontal scroll), button released.
  await wrapBtn.click();
  await expect(pre).not.toHaveClass(/md-code-wrapped/);
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'false');

  // Toggle on again → back to wrapped.
  await wrapBtn.click();
  await expect(pre).toHaveClass(/md-code-wrapped/);
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'true');
});
