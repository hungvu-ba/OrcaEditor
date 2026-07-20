/**
 * US-4.28: in-place code-block language switcher. Clicking a code block's header
 * language label opens the same 9-language dropdown as the toolbar's code-block
 * button; picking a language rewrites the block's `language-*` class in place,
 * re-highlights, updates the label, and re-serializes the fence. Needs a real
 * browser engine (real click + hljs + the Selection-safe contenteditable header)
 * — test/roundtrip/ (domino) covers only the serialize side (class → fence).
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

test('clicking the language label opens the 9-language dropdown, current language checked', async ({ page }) => {
  await openEditor(page, '```python\nx = 1\n```\n');
  await page.locator('#content pre > .md-code-header .md-code-lang').click();

  const popover = page.locator('.toolbar-popover.code-lang-popover');
  await expect(popover).toBeVisible();
  await expect(popover.locator('.toolbar-popover-item')).toHaveCount(9);
  // Current language (python) is the checked row.
  await expect(popover.locator('.toolbar-popover-item[data-dropdown-value="python"]')).toHaveClass(/selected/);
});

test('picking a language rewrites the block class + label and re-serializes the fence', async ({ page }) => {
  await openEditor(page, '```js\nconst a = 1;\n```\n');
  const code = page.locator('#content pre > code');
  await expect(code).toHaveClass(/language-js/);

  await page.locator('#content pre > .md-code-header .md-code-lang').click();
  await clearPosted(page);
  await page.locator('.toolbar-popover.code-lang-popover .toolbar-popover-item', { hasText: 'Python' }).click();

  // Label + <code> class updated in place; popover closed.
  await expect(page.locator('#content pre > .md-code-header .md-code-lang')).toHaveText('Python');
  await expect(code).toHaveClass(/language-python/);
  await expect(code).not.toHaveClass(/language-js\b/);
  await expect(page.locator('.toolbar-popover.code-lang-popover')).toBeHidden();

  // The re-serialized markdown fence follows the new language.
  const md = await waitForEdit(page);
  expect(md).toContain('```python');
  expect(md).not.toContain('```js\n');
});

test('picking the current language is a no-op — no edit posted', async ({ page }) => {
  await openEditor(page, '```python\nx = 1\n```\n');
  await page.locator('#content pre > .md-code-header .md-code-lang').click();
  await clearPosted(page);
  await page.locator('.toolbar-popover.code-lang-popover .toolbar-popover-item', { hasText: 'Python' }).click();

  // No 'edit' should be posted for an unchanged language.
  await page.waitForTimeout(600);
  const edits = await page.evaluate(
    () => (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'edit').length
  );
  expect(edits).toBe(0);
  await expect(page.locator('#content pre > .md-code-header .md-code-lang')).toHaveText('Python');
});

test('alias-token block (```js): current row checked, picking JavaScript is a no-op that keeps the token', async ({ page }) => {
  await openEditor(page, '```js\nconst a = 1;\n```\n');
  const code = page.locator('#content pre > code');
  await expect(code).toHaveClass(/language-js\b/);

  await page.locator('#content pre > .md-code-header .md-code-lang').click();
  // The canonical JavaScript row is check-marked even though the token is `js`.
  await expect(
    page.locator('.toolbar-popover.code-lang-popover .toolbar-popover-item[data-dropdown-value="javascript"]')
  ).toHaveClass(/selected/);

  await clearPosted(page);
  await page.locator('.toolbar-popover.code-lang-popover .toolbar-popover-item', { hasText: 'JavaScript' }).click();
  await page.waitForTimeout(600);
  const edits = await page.evaluate(
    () => (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'edit').length
  );
  expect(edits).toBe(0);
  // Token is untouched (not rewritten js → javascript).
  await expect(code).toHaveClass(/language-js\b/);
});

test('indented code block: switching language promotes it to a fenced block in the .md', async ({ page }) => {
  await openEditor(page, '    x = 1\n');
  const label = page.locator('#content pre > .md-code-header .md-code-lang');
  await expect(label).toHaveText('Code');

  await label.click();
  await page.locator('.toolbar-popover.code-lang-popover .toolbar-popover-item', { hasText: 'Python' }).click();

  await expect(label).toHaveText('Python');
  await expect(page.locator('#content pre > code')).toHaveClass(/language-python/);
  // The picked language actually reaches the document as a fence (not dropped).
  const md = await waitForEdit(page);
  expect(md).toContain('```python');
  expect(md).toContain('x = 1');
});
