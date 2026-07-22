/**
 * bug_General Mention Declare #6: the declaration pill is a non-editable atom;
 * clicking it opens an anchored popover (caption-edit.ts) that edits the VALUE
 * (id) only — the namespace stays fixed — with a live duplicate check against
 * the namespace's already-declared entities. A duplicate/empty value is refused
 * (inline error + disabled Save); a fresh value rewrites the token in place.
 *
 * No real host: the `entitySearch` the popover posts on open is answered by
 * hand with a matching `entityResult` (same technique as entity-declare.spec.ts).
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

type Posted = { type: string; requestId?: number; namespace?: string };

async function waitForPosted(page: import('@playwright/test').Page, type: string): Promise<Posted> {
  const handle = await page.waitForFunction(
    (t) => (window as unknown as { __posted: Posted[] }).__posted.filter((m) => m.type === t).at(-1),
    type
  );
  return (await handle.jsonValue()) as Posted;
}

test('click pill → value-edit popover: duplicate refused, fresh value commits in place', async ({ page }) => {
  await openEditor(page, 'caption::UC1');

  const badge = page.locator('#content .md-caption');
  await expect(badge).toHaveCount(1);
  await badge.click();

  const popover = page.locator('.caption-edit-popover');
  const input = page.locator('.caption-edit-input');
  const error = page.locator('.caption-edit-error');
  const save = page.locator('.caption-edit-confirm');

  await expect(popover).toBeVisible();
  await expect(input).toHaveValue('1'); // value only — namespace is fixed.

  // The popover fetches the namespace's declared ids for the dup check.
  const req = await waitForPosted(page, 'entitySearch');
  expect(req.namespace).toBe('UC');
  await page.evaluate(
    (r) =>
      window.postMessage(
        {
          type: 'entityResult',
          requestId: r.requestId,
          ready: true,
          entities: [
            { namespace: 'UC', id: '1', file: 'file:///proj/A.md', line: 1, title: '' },
            { namespace: 'UC', id: '5', file: 'file:///proj/B.md', line: 1, title: '' },
          ],
        },
        '*'
      ),
    req
  );

  // Duplicate value → inline error + Save disabled.
  await input.fill('5');
  await expect(error).toContainText('UC5');
  await expect(save).toBeDisabled();

  // Fresh value → error cleared, Save enabled, commit rewrites the token.
  await input.fill('7');
  await expect(error).toBeHidden();
  await expect(save).toBeEnabled();
  await clearPosted(page);
  await save.click();

  await expect(popover).toBeHidden();
  await expect(badge).toHaveCount(1);
  expect(await badge.evaluate((el) => el.textContent)).toBe('caption::UC7');
  await expect(badge.locator('.md-caption-id')).toHaveText('7');

  // The rewrite persists to the document — the serialized .md carries the new token.
  const md = await waitForEdit(page);
  expect(md).toContain('caption::UC7');
  expect(md).not.toContain('caption::UC1');
});

test('empty value is refused', async ({ page }) => {
  await openEditor(page, 'caption::UC1');
  const badge = page.locator('#content .md-caption');
  await badge.click();

  const req = await waitForPosted(page, 'entitySearch');
  await page.evaluate(
    (r) => window.postMessage({ type: 'entityResult', requestId: r.requestId, ready: true, entities: [] }, '*'),
    req
  );

  await page.locator('.caption-edit-input').fill('');
  await expect(page.locator('.caption-edit-error')).toBeVisible();
  await expect(page.locator('.caption-edit-confirm')).toBeDisabled();
});
