/**
 * Document Blocks item 8: every fenced code block gets a persistent header bar
 * (language label + "Copy" button). Copy writes the block's raw code to the
 * clipboard and briefly flips the label to "Copied". Needs a real browser engine
 * (real click + navigator.clipboard) — test/roundtrip/ (domino) can't dispatch
 * events; it covers the serialize-safety side instead.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('labeled code block: header shows the language name and Copy writes raw code', async ({ page }) => {
  await openEditor(page, '```js\nconst a = 1;\n```\n');
  const header = page.locator('#content pre > .md-code-header');
  await expect(header).toHaveCount(1);
  await expect(header).toHaveAttribute('contenteditable', 'false');
  await expect(header.locator('.md-code-lang')).toHaveText('JavaScript');

  const copyBtn = header.locator('button.md-code-copy');
  await expect(copyBtn).toHaveText('Copy');

  // Capture what Copy writes without needing OS clipboard permissions.
  await page.evaluate(() => {
    (window as unknown as { __copied: string | null }).__copied = null;
    navigator.clipboard.writeText = (t: string) => {
      (window as unknown as { __copied: string | null }).__copied = t;
      return Promise.resolve();
    };
  });

  await copyBtn.click();

  const copied = await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied);
  expect(copied).toBe('const a = 1;');
  await expect(copyBtn).toHaveText('Copied');
});

test('unlabeled fence still gets a header labeled "Code"', async ({ page }) => {
  await openEditor(page, '```\nplain text\n```\n');
  const label = page.locator('#content pre > .md-code-header .md-code-lang');
  await expect(label).toHaveText('Code');
});
