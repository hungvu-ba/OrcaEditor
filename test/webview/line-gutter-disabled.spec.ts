/**
 * `orcaEditor.showLineNumbers: false` must hide the line-number gutter.
 *
 * The gutter's ResizeObserver and the drag-drop engine repaint #line-gutter
 * without checking the setting, so numbers were drawn with no padding reserved
 * for them and overlapped the text.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

const DOC = ['# Title', '', 'First paragraph.', '', '- one', '- two', '', 'Last paragraph.'].join('\n');

async function simulate(page: Page, msg: unknown): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, '*'), msg);
}

test('disabled gutter shows no line numbers, even after a relayout', async ({ page }) => {
  await openEditor(page, DOC, { showLineNumbers: false });
  await page.setViewportSize({ width: 500, height: 700 });
  await page.waitForTimeout(100);
  await expect(page.locator('body')).not.toHaveClass(/md-line-numbers/);
  await expect(page.locator('#line-gutter .md-line-number').first()).toBeHidden();
});

test('turning the gutter off via configUpdate hides numbers already drawn', async ({ page }) => {
  await openEditor(page, DOC, { showLineNumbers: true });
  await expect(page.locator('#line-gutter .md-line-number').first()).toBeVisible();
  await simulate(page, { type: 'configUpdate', autoOpenToc: false, showLineNumbers: false, triggerMode: 'advanced' });
  await expect(page.locator('#line-gutter .md-line-number').first()).toBeHidden();
});
