/**
 * T2.4 (Performance Low-End C-6): the TOC reading-stats word count walks
 * `#content` instead of cloning it, and a debounced TOC build that finds the
 * same headings keeps the existing `.toc-item` nodes. Needs a real browser:
 * the build rides the real debounce + DOM mutation path.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

async function openToc(page: Page, markdown: string): Promise<void> {
  await openEditor(page, markdown);
  // force: true — see toc-filter.spec.ts: #toc-toggle's toolbar overflow logic
  // can transiently report it "outside the viewport" under parallel workers.
  await page.locator('#toc-toggle').click({ force: true });
}

test('typing in body text keeps every .toc-item node', async ({ page }) => {
  await openToc(page, '# Alpha\n\nBody text here.\n\n## Beta\n\nMore body.\n');
  const items = page.locator('.toc-item');
  await expect(items).toHaveCount(2);
  await items.evaluateAll((els) => els.forEach((el) => el.setAttribute('data-mark', '1')));
  const meta = page.locator('#toc-meta-text');
  const before = await meta.textContent();

  await page.locator('#content p', { hasText: 'Body text here.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' plus several extra words typed');
  // Premise: the word count changed, so the debounced build ran.
  await expect(meta).not.toHaveText(before ?? '');

  await expect(items).toHaveCount(2);
  expect(await items.evaluateAll((els) => els.map((el) => el.getAttribute('data-mark')))).toEqual(['1', '1']);
});

test('a heading replaced by a new node rebuilds its entry and the click reaches the live heading', async ({ page }) => {
  await openToc(page, '# Title\n\nBody.\n');
  await expect(page.locator('.toc-item')).toHaveCount(1);
  await page.locator('#content h1').evaluate((el) => el.setAttribute('data-old', '1'));
  await page.locator('.toc-item').evaluate((el) => el.setAttribute('data-mark', '1'));

  await page.evaluate(() => window.postMessage({ type: 'update', text: 'Title\n=====\n\nBody.\n' }, '*'));
  // Premise: the h1 is a new node.
  await expect(page.locator('#content h1[data-old]')).toHaveCount(0);
  await expect(page.locator('#content h1')).toHaveText('Title');
  await expect(page.locator('.toc-item[data-mark]')).toHaveCount(0);

  await page.locator('.toc-item').click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const node = window.getSelection()?.anchorNode ?? null;
        const h1 = document.querySelector('#content h1');
        return !!h1 && !!node && h1.contains(node);
      }),
    )
    .toBe(true);
});

test('word count skips fenced + inline code, display math and mermaid', async ({ page }) => {
  const doc = [
    'Intro words here.',
    '',
    '```js',
    'const fenced = code here;',
    '```',
    '',
    'Inline `code span` stays out.',
    '',
    '$$',
    'x^2 + y^2',
    '$$',
    '',
    '```mermaid',
    'graph TD; A-->B',
    '```',
    '',
    'Tail words.',
    '',
  ].join('\n');
  await openToc(page, doc);
  // 8 = the count the cloning implementation gave for this same document.
  await expect(page.locator('#toc-meta-text')).toHaveText('1 min read · 8 words');
});
