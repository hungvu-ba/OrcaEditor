/**
 * Req 21 US-21.3: broken-ENTITY-reference detection + Entities-scope quick-
 * correct + Fix-all + toolbar-badge span (media/webview/broken-ref.ts +
 * quick-correct.ts, host replies mocked). Covers: a same-document entity ref
 * gets the marker (both .broken-ref + .md-entity-ref) via the real
 * checkEntitiesExist round trip; a healthy one is NOT marked (guards the latent
 * mis-mark where a same-doc `#UC01` fell into the heading branch); the verbatim
 * tooltip copy incl. the "+N other occurrences — Fix all" line; the Entities
 * quick-correct replace-in-place (href rewritten, display text kept); single-
 * file Fix-all; a stale entitiesExistResult discarded; and the toolbar badge
 * counting the entity broken ref.
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

/** Simulate the host's reply, exactly as provider.ts's 'checkEntitiesExist' case posts it back. */
async function replyEntitiesExist(
  page: import('@playwright/test').Page,
  requestId: number,
  docVersion: number,
  results: Array<{ id: string; exists: boolean; occurrences: number }>
): Promise<void> {
  await page.evaluate(
    ({ requestId, docVersion, results }) =>
      window.postMessage({ type: 'entitiesExistResult', requestId, docVersion, results }, '*'),
    { requestId, docVersion, results }
  );
}

/** Mark the doc's entity ref(s) broken via the real checkEntitiesExist round trip. */
async function markEntityBroken(
  page: import('@playwright/test').Page,
  results: Array<{ id: string; exists: boolean; occurrences: number }>
): Promise<void> {
  await page.waitForSelector('#content a.md-entity-ref');
  const req = await waitForCheckEntitiesExist(page);
  await replyEntitiesExist(page, req.requestId, req.docVersion, results);
  await page.waitForSelector('#content a.broken-ref');
}

function anchorClasses(page: import('@playwright/test').Page, href: string): Promise<string[]> {
  return page.evaluate((h) => {
    const a = document.querySelector(`#content a[href="${h}"]`);
    return a ? Array.from(a.classList) : [];
  }, href);
}

test('a broken entity ref gets the marker (broken-ref + md-entity-ref) via the real checkEntitiesExist round trip', async ({
  page,
}) => {
  await openEditor(page, 'See [UC01](#UC01) for details.\n');
  await page.waitForSelector('#content a.md-entity-ref');

  const req = await waitForCheckEntitiesExist(page);
  expect(req.ids).toEqual(['UC01']);

  await replyEntitiesExist(page, req.requestId, req.docVersion, [{ id: 'UC01', exists: false, occurrences: 1 }]);
  await page.waitForSelector('#content a.broken-ref');

  const classes = await anchorClasses(page, '#UC01');
  expect(classes).toContain('broken-ref');
  expect(classes).toContain('md-entity-ref');

  // The two-class marker font-weight delta + still gets the ::before warning icon.
  const fontWeight = await page.evaluate(
    () => getComputedStyle(document.querySelector('#content a.broken-ref.md-entity-ref') as HTMLElement).fontWeight
  );
  expect(fontWeight).toBe('600');
});

test('a healthy entity ref is NOT marked (guards the latent same-doc heading mis-mark)', async ({ page }) => {
  await openEditor(page, 'See [UC01](#UC01) for details.\n');
  await page.waitForSelector('#content a.md-entity-ref');

  const req = await waitForCheckEntitiesExist(page);
  await replyEntitiesExist(page, req.requestId, req.docVersion, [{ id: 'UC01', exists: true, occurrences: 1 }]);
  await page.waitForTimeout(150);

  const classes = await anchorClasses(page, '#UC01');
  expect(classes).not.toContain('broken-ref');
  expect(classes).toContain('md-entity-ref');
});

test('tooltip copy is verbatim; Fix-all line shows +N when other occurrences exist', async ({ page }) => {
  await openEditor(page, 'See [UC01](#UC01) here.\n');
  await markEntityBroken(page, [{ id: 'UC01', exists: false, occurrences: 3 }]);

  await page.locator('#content a.broken-ref').hover();
  await expect(page.locator('.broken-ref-tooltip-title')).toHaveText('UC01 not found');
  await expect(page.locator('.broken-ref-tooltip-desc')).toHaveText(
    'The declaration may have been deleted, renamed, or its namespace changed.'
  );
  await expect(page.locator('.broken-ref-tooltip-fixall')).toHaveText('+2 other occurrences found so far — Fix all');
});

test('Fix-all line is hidden when the ref is the only occurrence', async ({ page }) => {
  await openEditor(page, 'See [UC01](#UC01) here.\n');
  await markEntityBroken(page, [{ id: 'UC01', exists: false, occurrences: 1 }]);

  await page.locator('#content a.broken-ref').hover();
  await expect(page.locator('.broken-ref-tooltip-fixall')).toBeHidden();
});

test('Entities quick-correct: pre-seeded from display text, replace-in-place keeps the text and rewrites the href', async ({
  page,
}) => {
  await openEditor(page, 'See [UC01](#UC01) here.\n');
  await markEntityBroken(page, [{ id: 'UC01', exists: false, occurrences: 1 }]);
  await clearPosted(page);

  await page.locator('#content a.broken-ref').hover();
  await page.locator('.broken-ref-tooltip-action').click();

  await expect(page.locator('.quick-correct-popover')).toBeVisible();
  await expect(page.locator('.quick-correct-input')).toHaveValue('UC01');

  const searchHandle = await page.waitForFunction(() =>
    (window as unknown as { __posted: Array<{ type: string; query?: string; requestId?: number }> }).__posted.find(
      (m) => m.type === 'entitySearch'
    )
  );
  const search = (await searchHandle.jsonValue()) as { requestId: number; query: string };
  expect(search.query).toBe('UC01');

  await page.evaluate(
    ({ requestId }) =>
      window.postMessage(
        {
          type: 'entityResult',
          requestId,
          ready: true,
          entities: [{ namespace: 'BR', id: '02', file: 'file:///harness.md', line: 0, title: 'Some Rule' }],
        },
        '*'
      ),
    { requestId: search.requestId }
  );

  await page.locator('.quick-correct-item').first().click();
  await expect(page.locator('.quick-correct-popover')).toBeHidden();

  const href = await page.locator('#content a').first().getAttribute('href');
  expect(href).toBe('#BR02');
  const text = await page.locator('#content a').first().textContent();
  expect(text).toBe('UC01'); // display text preserved (replace-in-place)

  const md = await waitForEdit(page);
  expect(md).toContain('[UC01](#BR02)');
});

test('Fix-all applies one pick to every same-id occurrence in the current file', async ({ page }) => {
  await openEditor(page, 'First [UC01](#UC01) and second [UC01](#UC01).\n');
  await markEntityBroken(page, [{ id: 'UC01', exists: false, occurrences: 2 }]);
  await clearPosted(page);

  await page.locator('#content a.broken-ref').first().hover();
  await page.locator('.broken-ref-tooltip-fixall').click();

  await expect(page.locator('.quick-correct-popover')).toBeVisible();
  const searchHandle = await page.waitForFunction(() =>
    (window as unknown as { __posted: Array<{ type: string; requestId?: number }> }).__posted.find(
      (m) => m.type === 'entitySearch'
    )
  );
  const search = (await searchHandle.jsonValue()) as { requestId: number };

  await page.evaluate(
    ({ requestId }) =>
      window.postMessage(
        {
          type: 'entityResult',
          requestId,
          ready: true,
          entities: [{ namespace: 'BR', id: '02', file: 'file:///harness.md', line: 0, title: 'Rule' }],
        },
        '*'
      ),
    { requestId: search.requestId }
  );

  await page.locator('.quick-correct-item').first().click();

  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#content a')).map((a) => a.getAttribute('href'))
  );
  expect(hrefs).toEqual(['#BR02', '#BR02']);
  const texts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#content a')).map((a) => a.textContent)
  );
  expect(texts).toEqual(['UC01', 'UC01']); // each occurrence keeps its own display text
});

test('a stale entitiesExistResult from a superseded scan is discarded', async ({ page }) => {
  await openEditor(page, 'See [UC01](#UC01) here.\n');
  await page.waitForSelector('#content a.md-entity-ref');
  const first = await waitForCheckEntitiesExist(page);

  await clearPosted(page);
  await page.evaluate(() => window.postMessage({ type: 'update', text: 'See [UC01](#UC01) here.\n\nmore\n' }, '*'));
  const second = await waitForCheckEntitiesExist(page);
  expect(second.requestId).not.toBe(first.requestId);

  // Reply to the STALE first request — must be ignored.
  await replyEntitiesExist(page, first.requestId, first.docVersion, [{ id: 'UC01', exists: true, occurrences: 1 }]);
  await page.waitForTimeout(100);
  expect(await anchorClasses(page, '#UC01')).not.toContain('broken-ref');

  // Reply to the CURRENT request — this one applies.
  await replyEntitiesExist(page, second.requestId, second.docVersion, [{ id: 'UC01', exists: false, occurrences: 1 }]);
  await page.waitForSelector('#content a.broken-ref');
  expect(await anchorClasses(page, '#UC01')).toContain('broken-ref');
});

test('toolbar broken-ref badge counts the entity broken ref', async ({ page }) => {
  await openEditor(page, 'See [UC01](#UC01) here.\n');
  const badge = page.locator('#toolbar .broken-ref-badge');
  await expect(badge).toBeHidden();

  await markEntityBroken(page, [{ id: 'UC01', exists: false, occurrences: 1 }]);

  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('1');
});
