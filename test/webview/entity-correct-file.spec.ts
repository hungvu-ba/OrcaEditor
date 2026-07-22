/**
 * Req 21 bug fix: correcting a broken ENTITY reference via the "Search again →"
 * popover must repoint the href at the PICKED entity's declaring file, not keep
 * the broken reference's old file part. Regression: `applyEntityFix` only swapped
 * the `#fragment`, so picking an entity in a different file left the href on the
 * old file and a click opened the old file.
 *
 * docUri is the harness default `file:///harness.md` (see _harness.ts), so a pick
 * whose `file` differs from it produces a relative path, and a same-file pick
 * produces a bare `#id`.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

interface CheckEntitiesExistMsg {
  type: 'checkEntitiesExist';
  requestId: number;
  docVersion: number;
  ids: string[];
}

async function waitForCheckEntitiesExist(page: import('@playwright/test').Page): Promise<CheckEntitiesExistMsg> {
  const handle = await page.waitForFunction(() =>
    (window as unknown as { __posted: CheckEntitiesExistMsg[] }).__posted.find((m) => m.type === 'checkEntitiesExist')
  );
  return (await handle.jsonValue()) as CheckEntitiesExistMsg;
}

/** Mark the doc's entity ref broken via the real checkEntitiesExist round trip. */
async function markEntityBroken(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('#content a.md-entity-ref');
  const req = await waitForCheckEntitiesExist(page);
  await page.evaluate(
    ({ requestId, docVersion }) =>
      window.postMessage(
        { type: 'entitiesExistResult', requestId, docVersion, results: [{ id: 'UC01', exists: false, occurrences: 1 }] },
        '*'
      ),
    { requestId: req.requestId, docVersion: req.docVersion }
  );
  await page.waitForSelector('#content a.broken-ref');
}

/** Open the fix popover, run the search, and pick an entity declared in `file`. */
async function pickEntityInFile(page: import('@playwright/test').Page, file: string): Promise<void> {
  await page.locator('#content a.broken-ref').hover({ position: { x: 4, y: 6 } });
  await page.locator('.broken-ref-tooltip-action').click();
  await expect(page.locator('.quick-correct-popover')).toBeVisible();

  const searchHandle = await page.waitForFunction(() =>
    (window as unknown as { __posted: Array<{ type: string; requestId?: number }> }).__posted.find(
      (m) => m.type === 'entitySearch'
    )
  );
  const search = (await searchHandle.jsonValue()) as { requestId: number };
  await page.evaluate(
    ({ requestId, file }) =>
      window.postMessage(
        {
          type: 'entityResult',
          requestId,
          ready: true,
          entities: [{ namespace: 'BR', id: '02', file, line: 0, title: 'Some Rule' }],
        },
        '*'
      ),
    { requestId: search.requestId, file }
  );
  await page.locator('.quick-correct-item').first().click();
  await expect(page.locator('.quick-correct-popover')).toBeHidden();
}

test('correcting to an entity in a DIFFERENT file repoints the href at that file (not the old one)', async ({
  page,
}) => {
  await openEditor(page, 'See [UC01](old.md#UC01) here.\n');
  await markEntityBroken(page);
  await clearPosted(page);

  await pickEntityInFile(page, 'file:///sub/target.md');

  const href = await page.locator('#content a').first().getAttribute('href');
  expect(href).toBe('sub/target.md#BR02');
  expect(href).not.toContain('old.md'); // the bug: the old file part used to survive.
  expect(await page.locator('#content a').first().textContent()).toBe('UC01'); // display text kept.

  const md = await waitForEdit(page);
  expect(md).toContain('[UC01](sub/target.md#BR02)');
});

test('correcting to an entity in the SAME file produces a bare #id', async ({ page }) => {
  await openEditor(page, 'See [UC01](old.md#UC01) here.\n');
  await markEntityBroken(page);
  await clearPosted(page);

  await pickEntityInFile(page, 'file:///harness.md');

  const href = await page.locator('#content a').first().getAttribute('href');
  expect(href).toBe('#BR02');
});
