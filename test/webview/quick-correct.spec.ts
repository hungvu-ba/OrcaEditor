/**
 * Req 20 US-20.9 (Sprint C, Files scope): the "Search again →" quick-correct
 * popover (media/webview/quick-correct.ts), reached from broken-ref.ts's
 * hover tooltip action row. Covers: the tooltip's action only appears for a
 * broken FILE link (not a broken heading), the popover opens pre-seeded with
 * the reference's display text and immediately searches, picking a result
 * rewrites the anchor's href (keeping its display text) and the fix
 * round-trips through to a serialized 'edit', and Escape closes the popover
 * without touching the document.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

interface Posted {
  type: string;
  requestId?: number;
  targets?: string[];
}

async function waitForType(page: import('@playwright/test').Page, type: string): Promise<Posted> {
  const handle = await page.waitForFunction(
    (t) => (window as unknown as { __posted: Posted[] }).__posted.find((m) => m.type === t),
    type
  );
  return (await handle.jsonValue()) as Posted;
}

/** Mark the doc's one link broken via the real checkTargetsExist round trip. */
async function markBroken(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('#content a[href]');
  const req = await waitForType(page, 'checkTargetsExist');
  await page.evaluate(
    ({ requestId }) =>
      window.postMessage(
        { type: 'targetsExistResult', requestId, docVersion: 1, results: [{ target: './missing.md', exists: false }] },
        '*'
      ),
    { requestId: req.requestId }
  );
  await page.waitForSelector('#content a.broken-ref');
}

test('tooltip: "Search again" action shown for a broken file link, hidden for a broken heading link', async ({
  page,
}) => {
  await openEditor(page, '# Existing\n\n[Old Setup Guide](./missing.md) and [Bad](#nowhere).\n');
  await markBroken(page);

  const fileLink = page.locator('#content a[href="./missing.md"]');
  await fileLink.hover();
  const fileTooltipAction = page.locator('.broken-ref-tooltip-action');
  await expect(fileTooltipAction).toBeVisible();
  await expect(page.locator('.broken-ref-tooltip-title')).toContainText('File not found');

  const headingLink = page.locator('#content a[href="#nowhere"]');
  await headingLink.hover();
  await expect(page.locator('.broken-ref-tooltip-title')).toContainText('Heading not found');
  await expect(fileTooltipAction).toBeHidden();
});

test('"Search again" opens pre-seeded with the display text and searches immediately', async ({ page }) => {
  await openEditor(page, '[Old Setup Guide](./missing.md)\n');
  await markBroken(page);
  await clearPosted(page);

  await page.locator('#content a.broken-ref').hover();
  await page.locator('.broken-ref-tooltip-action').click();

  await expect(page.locator('.quick-correct-popover')).toBeVisible();
  await expect(page.locator('.quick-correct-input')).toHaveValue('Old Setup Guide');

  const search = await waitForType(page, 'searchFiles');
  expect((search as { query?: string }).query).toBe('Old Setup Guide');
});

test('picking a result rewrites the href (keeping display text) and the fix serializes back out', async ({
  page,
}) => {
  await openEditor(page, '[Old Setup Guide](./missing.md)\n');
  await markBroken(page);

  await page.locator('#content a.broken-ref').hover();
  await page.locator('.broken-ref-tooltip-action').click();
  const search = await waitForType(page, 'searchFiles');

  await page.evaluate(
    ({ requestId }) =>
      window.postMessage(
        {
          type: 'fileSearchResult',
          requestId,
          files: [{ path: './new-guide.md', name: 'new-guide.md', dir: '.' }],
        },
        '*'
      ),
    { requestId: search.requestId }
  );

  await page.locator('.quick-correct-item').first().click();
  await expect(page.locator('.quick-correct-popover')).toBeHidden();

  const href = await page.locator('#content a').first().getAttribute('href');
  expect(href).toBe('./new-guide.md');
  const text = await page.locator('#content a').first().textContent();
  expect(text).toBe('Old Setup Guide'); // display text is preserved, only the target changes

  const md = await waitForEdit(page);
  expect(md).toContain('[Old Setup Guide](./new-guide.md)');
});

test('Escape closes the popover without changing the document', async ({ page }) => {
  await openEditor(page, '[Old Setup Guide](./missing.md)\n');
  await markBroken(page);

  await page.locator('#content a.broken-ref').hover();
  await page.locator('.broken-ref-tooltip-action').click();
  await expect(page.locator('.quick-correct-popover')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.quick-correct-popover')).toBeHidden();

  const href = await page.locator('#content a').first().getAttribute('href');
  expect(href).toBe('./missing.md');
});
