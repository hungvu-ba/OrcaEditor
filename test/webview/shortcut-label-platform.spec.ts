/**
 * T1.2 (CLAUDE.md cross-platform trap): a shortcut label must show ONE
 * platform's chord, never the hardcoded "⌘B / Ctrl+B" pair. Each
 * `test.describe` pins the browser context's `userAgent` (Windows / macOS)
 * so `shortcutLabel`'s `navigator.userAgent` check picks a fixed branch.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MACOS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function ariaLabel(page: import('@playwright/test').Page, selector: string): Promise<string | null> {
  return page.locator(selector).getAttribute('aria-label');
}

test.describe('Windows UA', () => {
  test.use({ userAgent: WINDOWS_UA });

  test('toolbar shortcut labels show Ctrl+, never ⌘', async ({ page }) => {
    await openEditor(page, 'hello world');
    expect(await ariaLabel(page, '#fmt-undo')).toBe('Undo (Ctrl+Z)');
    expect(await ariaLabel(page, '#fmt-redo')).toBe('Redo (Ctrl+Shift+Z)');
    expect(await ariaLabel(page, '#fmt-bold')).toBe('Bold (Ctrl+B)');
    expect(await ariaLabel(page, '#fmt-italic')).toBe('Italic (Ctrl+I)');
    expect(await ariaLabel(page, '#fmt-strike')).toBe('Strikethrough (Ctrl+Shift+X)');
    expect(await ariaLabel(page, '#fmt-inline-code')).toBe('Inline code (Ctrl+E)');
    expect(await page.locator('.cross-file-search-icon').getAttribute('title')).toBe(
      'Search across project files (Ctrl+Shift+F)'
    );
  });
});

test.describe('macOS UA', () => {
  test.use({ userAgent: MACOS_UA });

  test('toolbar shortcut labels show ⌘, never Ctrl+', async ({ page }) => {
    await openEditor(page, 'hello world');
    expect(await ariaLabel(page, '#fmt-undo')).toBe('Undo (⌘Z)');
    expect(await ariaLabel(page, '#fmt-redo')).toBe('Redo (⌘⇧Z)');
    expect(await ariaLabel(page, '#fmt-bold')).toBe('Bold (⌘B)');
    expect(await ariaLabel(page, '#fmt-italic')).toBe('Italic (⌘I)');
    expect(await ariaLabel(page, '#fmt-strike')).toBe('Strikethrough (⌘⇧X)');
    expect(await ariaLabel(page, '#fmt-inline-code')).toBe('Inline code (⌘E)');
    expect(await page.locator('.cross-file-search-icon').getAttribute('title')).toBe(
      'Search across project files (⌘⇧F)'
    );
  });
});
