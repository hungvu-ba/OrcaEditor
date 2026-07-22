/**
 * Req 21 US-21.4 — the "Relate to entity" `/` trigger item (advanced-only)
 * and its target-picker: browse-by-namespace or flat id/title search (shares
 * the `namespaceList`/`entitySearch` channels with T5.1/T5.2), commits as a
 * ONE-WAY real markdown link — "Refers to: [id](path#id)" — into the CURRENT
 * file only. Never touches the target file, never writes a References-section
 * entry, no reverse line.
 *
 * The harness has no real host, so each host round trip (`namespaceList` /
 * `entitySearch`) is answered by hand — same technique entity-declare.spec.ts
 * uses.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

type Posted = { type: string; requestId?: number; namespace?: string; query?: string };

/** Wait for the most recent posted message of `type` and return it (with its requestId). */
async function waitForPosted(page: import('@playwright/test').Page, type: string): Promise<Posted> {
  const handle = await page.waitForFunction(
    (t) => (window as unknown as { __posted: Posted[] }).__posted.filter((m) => m.type === t).at(-1),
    type
  );
  return (await handle.jsonValue()) as Posted;
}

async function waitForItemCount(page: import('@playwright/test').Page, n: number): Promise<void> {
  await expect(page.locator('.trigger-popup-item')).toHaveCount(n);
}

async function focusEmptyParagraph(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content) => {
    const p = content.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

/** Open `/`, narrow to "Relate to entity", click it — leaves the shared popup mid-flight into the target-picker. */
async function openRelate(page: import('@playwright/test').Page): Promise<void> {
  await focusEmptyParagraph(page);
  await page.keyboard.type('/relate');
  await page.locator('.trigger-popup-item', { hasText: 'Relate to entity' }).first().click();
}

test('"Relate to entity" is hidden in simple mode (advanced-only gate)', async ({ page }) => {
  await openEditor(page, '', { trigger: { dateFormat: 'YYYY-MM-DD', executeCommands: [], mode: 'simple' } });
  await focusEmptyParagraph(page);
  await page.keyboard.type('/relate');
  await expect(page.locator('.trigger-popup-empty')).toHaveText('No matches');
});

test('happy path: browse a namespace, pick an entity — inserts a one-way "Refers to:" link', async ({ page }) => {
  await openEditor(page, '');
  await openRelate(page);

  const nsReq = await waitForPosted(page, 'namespaceList');
  await page.evaluate(
    (req) =>
      window.postMessage(
        { type: 'namespaceListResult', requestId: req.requestId, ready: true, namespaces: [{ name: 'BR', count: 1 }] },
        '*'
      ),
    nsReq
  );

  await expect(page.locator('.trigger-popup-group-label')).toHaveText('Namespaces');
  await page.locator('.trigger-popup-item-label', { hasText: /^BR$/ }).first().click();

  const entReq = await waitForPosted(page, 'entitySearch');
  expect(entReq.namespace).toBe('BR');
  await page.evaluate(
    (req) =>
      window.postMessage(
        {
          type: 'entityResult',
          requestId: req.requestId,
          ready: true,
          entities: [{ namespace: 'BR', id: '01', file: 'file:///proj/Foo.md', line: 2, title: 'A rule' }],
        },
        '*'
      ),
    entReq
  );

  await waitForItemCount(page, 2); // '‹ All namespaces' back row + BR01
  await page.locator('.trigger-popup-item-label', { hasText: /^BR01$/ }).first().click();

  await expect(page.locator('.trigger-popup')).toBeHidden();
  const link = page.locator('#content a', { hasText: 'BR01' });
  await expect(link).toHaveAttribute('href', 'proj/Foo.md#BR01');
  await expect(page.locator('#content p')).toHaveText('Refers to: BR01');
});

test('back row returns to the namespace list (fresh namespaceList round trip)', async ({ page }) => {
  await openEditor(page, '');
  await openRelate(page);

  const nsReq1 = await waitForPosted(page, 'namespaceList');
  await page.evaluate(
    (req) =>
      window.postMessage(
        { type: 'namespaceListResult', requestId: req.requestId, ready: true, namespaces: [{ name: 'BR', count: 1 }] },
        '*'
      ),
    nsReq1
  );
  await page.locator('.trigger-popup-item-label', { hasText: /^BR$/ }).first().click();

  const entReq = await waitForPosted(page, 'entitySearch');
  await page.evaluate(
    (req) =>
      window.postMessage(
        {
          type: 'entityResult',
          requestId: req.requestId,
          ready: true,
          entities: [{ namespace: 'BR', id: '01', file: 'file:///proj/Foo.md', line: 2, title: 'A rule' }],
        },
        '*'
      ),
    entReq
  );
  await waitForItemCount(page, 2);

  await page.locator('.trigger-popup-item-label', { hasText: '‹ All namespaces' }).first().click();

  const nsReq2 = await waitForPosted(page, 'namespaceList');
  expect(nsReq2.requestId).not.toBe(nsReq1.requestId);
  await page.evaluate(
    (req) =>
      window.postMessage(
        {
          type: 'namespaceListResult',
          requestId: req.requestId,
          ready: true,
          namespaces: [
            { name: 'BR', count: 1 },
            { name: 'UC', count: 2 },
          ],
        },
        '*'
      ),
    nsReq2
  );
  await waitForItemCount(page, 2);
  await expect(page.locator('.trigger-popup-item-label')).toHaveText(['BR', 'UC']);
});

test('typed query flat-searches across all namespaces (no create-new-namespace row)', async ({ page }) => {
  await openEditor(page, '');
  await openRelate(page);

  await waitForPosted(page, 'namespaceList'); // bare-query browse fires first — not answered, typing supersedes it.
  await page.keyboard.type('rule');

  const entReq = await waitForPosted(page, 'entitySearch');
  expect(entReq.query).toBe('rule');
  expect(entReq.namespace).toBeUndefined();
  await page.evaluate(
    (req) =>
      window.postMessage(
        {
          type: 'entityResult',
          requestId: req.requestId,
          ready: true,
          entities: [{ namespace: 'BR', id: '01', file: 'file:///proj/Foo.md', line: 2, title: 'A rule' }],
        },
        '*'
      ),
    entReq
  );

  await waitForItemCount(page, 1);
  await expect(page.locator('.trigger-popup-item-label')).toHaveText('BR01');
  await expect(page.locator('.trigger-popup-item-label', { hasText: 'Create new namespace' })).toHaveCount(0);
  await page.locator('.trigger-popup-item-label', { hasText: /^BR01$/ }).first().click();

  await expect(page.locator('#content p')).toHaveText('Refers to: BR01');
});

test('same-file target: no target-file write, no References-section entry, single one-way link', async ({ page }) => {
  await openEditor(page, 'Intro text.\n\nMore text.');
  await page.locator('#content').click();
  await page.locator('#content').evaluate(() => {
    const p = Array.from(document.querySelectorAll('#content p')).find((el) => el.textContent === 'More text.')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.type(' /relate');
  await page.locator('.trigger-popup-item', { hasText: 'Relate to entity' }).first().click();

  const nsReq = await waitForPosted(page, 'namespaceList');
  await page.evaluate(
    (req) =>
      window.postMessage(
        { type: 'namespaceListResult', requestId: req.requestId, ready: true, namespaces: [{ name: 'UC', count: 1 }] },
        '*'
      ),
    nsReq
  );
  await page.locator('.trigger-popup-item-label', { hasText: /^UC$/ }).first().click();

  const entReq = await waitForPosted(page, 'entitySearch');
  await page.evaluate(
    (req) =>
      window.postMessage(
        {
          type: 'entityResult',
          requestId: req.requestId,
          ready: true,
          entities: [{ namespace: 'UC', id: '01', file: 'file:///harness.md', line: 1, title: '' }],
        },
        '*'
      ),
    entReq
  );
  await waitForItemCount(page, 2);
  await page.locator('.trigger-popup-item-label', { hasText: /^UC01$/ }).first().click();

  await expect(page.locator('#content p', { hasText: 'More text.' })).toHaveText('More text. Refers to: UC01');
  // One-way, single-file: exactly one link in the whole document, no second
  // (reverse) occurrence and nothing appended as a References section.
  await expect(page.locator('#content a')).toHaveCount(1);
  await expect(page.locator('#content h1, #content h2', { hasText: 'References' })).toHaveCount(0);
});
