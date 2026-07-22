/**
 * Req 21 US-21.1 — the "Declare entity" `/` trigger item (advanced-only) and
 * its 3-step flow: namespace picker (shares the `namespaceList` channel with
 * T5.2's future `@` Entities tab) -> id-input with a live duplicate check
 * against the workspace entity index (`entitySearch`) -> commit as a literal
 * `caption::NS_ID` raw-text insert that immediately becomes a `.md-caption`
 * solid-pill badge (postProcessCaptions).
 *
 * The harness has no real host, so each host round trip (`namespaceList` /
 * `entitySearch`) is answered by hand: wait for the posted request, then
 * `window.postMessage` the matching `*Result` reply back into the page —
 * same technique trigger-advanced-mode.spec.ts uses for `configUpdate`.
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

/**
 * `window.postMessage` only queues the 'message' event dispatch (a separate
 * task) — it does not run the page's handler synchronously. A single-match
 * locator assertion (`toHaveText` etc.) right after posting can therefore hit
 * the OLD render's stale row COUNT (a strict-mode violation), and Playwright
 * does not retry a strict-mode violation the way it retries a text mismatch.
 * Settle on the new row count FIRST (a count-based assertion retries fine),
 * THEN assert content — used after every host-reply post in this file.
 */
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

/** Open `/`, narrow to "Declare entity", click it — leaves the shared popup mid-flight into step 1 (namespace picker). */
async function openDeclareEntity(page: import('@playwright/test').Page): Promise<void> {
  await focusEmptyParagraph(page);
  await page.keyboard.type('/declare');
  await page.locator('.trigger-popup-item', { hasText: 'Declare entity' }).first().click();
}

test('"Declare entity" is hidden in simple mode (advanced-only gate)', async ({ page }) => {
  await openEditor(page, '', { trigger: { dateFormat: 'YYYY-MM-DD', executeCommands: [], mode: 'simple' } });
  await focusEmptyParagraph(page);
  await page.keyboard.type('/declare');
  await expect(page.locator('.trigger-popup-empty')).toHaveText('No matches');
});

test('happy path: existing namespace + accepting the suggested next id inserts a solid-pill badge', async ({
  page,
}) => {
  await openEditor(page, '');
  await openDeclareEntity(page);

  const nsReq = await waitForPosted(page, 'namespaceList');
  await page.evaluate(
    (req) =>
      window.postMessage(
        { type: 'namespaceListResult', requestId: req.requestId, ready: true, namespaces: [{ name: 'UC', count: 1 }] },
        '*'
      ),
    nsReq
  );

  await expect(page.locator('.trigger-popup-group-label')).toHaveCount(1);
  await expect(page.locator('.trigger-popup-group-label')).toHaveText('Namespace');
  await page.locator('.trigger-popup-item-label', { hasText: /^UC$/ }).first().click();

  const entReq = await waitForPosted(page, 'entitySearch');
  expect(entReq.namespace).toBe('UC');
  await page.evaluate(
    (req) =>
      window.postMessage(
        {
          type: 'entityResult',
          requestId: req.requestId,
          ready: true,
          entities: [{ namespace: 'UC', id: '01', file: 'file:///proj/Foo.md', line: 2, title: 'Alpha' }],
        },
        '*'
      ),
    entReq
  );

  await waitForItemCount(page, 1);
  // Label is capped at RESULT_TEXT_MAX_CHARS (30) by truncateDisplay, so the 41-char
  // suggestion row renders ellipsized; the pick value (id) is unaffected.
  await expect(page.locator('.trigger-popup-item-label')).toHaveText('Declare UC02 (suggested — type…');
  await page.keyboard.press('Enter');

  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('#content .md-caption')).toHaveText('caption::UC02');
});

test('duplicate id: Enter is refused with an inline error naming the conflicting file; a fresh id still commits', async ({
  page,
}) => {
  await openEditor(page, '');
  await openDeclareEntity(page);

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
          entities: [{ namespace: 'UC', id: '01', file: 'file:///proj/Foo.md', line: 2, title: 'Alpha' }],
        },
        '*'
      ),
    entReq
  );
  await expect(page.locator('.trigger-popup')).toBeVisible();

  // Type the already-declared id.
  await page.keyboard.type('01');
  await expect(page.locator('.trigger-popup-item-error')).toContainText('UC01');
  await expect(page.locator('.trigger-popup-item-error')).toContainText('Foo.md');

  // Enter is refused: popup stays open, nothing inserted.
  await page.keyboard.press('Enter');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await expect(page.locator('#content .md-caption')).toHaveCount(0);

  // Clear it and use a fresh id — commits normally.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('05');
  await expect(page.locator('.trigger-popup-item-label')).toHaveText('Declare UC05');
  await page.keyboard.press('Enter');

  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('#content .md-caption')).toHaveText('caption::UC05');
});

test('"+ Create new namespace" pinned row creates a brand-new namespace', async ({ page }) => {
  await openEditor(page, '');
  await openDeclareEntity(page);

  const nsReq = await waitForPosted(page, 'namespaceList');
  await page.evaluate(
    (req) => window.postMessage({ type: 'namespaceListResult', requestId: req.requestId, ready: true, namespaces: [] }, '*'),
    nsReq
  );

  await page.keyboard.type('ZZ');
  const createRow = page.locator('.trigger-popup-item-label', { hasText: 'Create new namespace' });
  await expect(createRow).toHaveText('+ Create new namespace "ZZ"');
  await createRow.click();

  const entReq = await waitForPosted(page, 'entitySearch');
  expect(entReq.namespace).toBe('ZZ');
  await page.evaluate(
    (req) => window.postMessage({ type: 'entityResult', requestId: req.requestId, ready: true, entities: [] }, '*'),
    entReq
  );

  // No existing entities in a brand-new namespace → no suggestion, placeholder shown.
  await waitForItemCount(page, 1);
  await expect(page.locator('.trigger-popup-item-label')).toHaveText('Type an id…');
  await page.keyboard.type('01');
  await expect(page.locator('.trigger-popup-item-label')).toHaveText('Declare ZZ01');
  await page.keyboard.press('Enter');

  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('#content .md-caption')).toHaveText('caption::ZZ01');
});
