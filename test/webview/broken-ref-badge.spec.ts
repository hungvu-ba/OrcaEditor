/**
 * Req 21 US-21.3 (file-link portion): the right-pinned toolbar broken-count
 * badge (media/webview/toolbar.ts's `.broken-ref-badge`), recomputed live from
 * broken-ref.ts's scan. Covers: hidden at count 0, shows the live count once
 * links are marked broken, click jumps the caret to the nearest broken
 * reference AFTER the caret (wrapping to the first past the last), and the
 * badge follows the --rp-warning* tokens (not --vscode-badge-*).
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

interface CheckTargetsExistMsg {
  type: 'checkTargetsExist';
  requestId: number;
  docVersion: number;
  targets: string[];
}

async function waitForCheckTargetsExist(page: import('@playwright/test').Page): Promise<CheckTargetsExistMsg> {
  const handle = await page.waitForFunction(() =>
    (window as unknown as { __posted: CheckTargetsExistMsg[] }).__posted.find((m) => m.type === 'checkTargetsExist')
  );
  return (await handle.jsonValue()) as CheckTargetsExistMsg;
}

/** Mark every href in `targets` as broken via the real host round trip. */
async function markAllBroken(page: import('@playwright/test').Page, targets: string[]): Promise<void> {
  await page.waitForSelector('#content a[href]');
  const req = await waitForCheckTargetsExist(page);
  await page.evaluate(
    ({ requestId, docVersion, targets }) =>
      window.postMessage(
        {
          type: 'targetsExistResult',
          requestId,
          docVersion,
          results: targets.map((target) => ({ target, exists: false })),
        },
        '*'
      ),
    { requestId: req.requestId, docVersion: req.docVersion, targets }
  );
  await page.waitForSelector('#content a.broken-ref');
}

test('hidden at count 0; appears with the live count once links are marked broken', async ({ page }) => {
  await openEditor(page, '[Good link](./exists.md)\n');
  await page.waitForSelector('#content a[href]');
  const req = await waitForCheckTargetsExist(page);

  const badge = page.locator('#toolbar .broken-ref-badge');
  await expect(badge).toBeHidden();

  await page.evaluate(
    ({ requestId, docVersion }) =>
      window.postMessage(
        { type: 'targetsExistResult', requestId, docVersion, results: [{ target: './exists.md', exists: true }] },
        '*'
      ),
    { requestId: req.requestId, docVersion: req.docVersion }
  );
  await expect(badge).toBeHidden(); // still healthy → still hidden

  await openEditor(page, '[Broken One](./missing1.md) and [Broken Two](./missing2.md)\n');
  await markAllBroken(page, ['./missing1.md', './missing2.md']);

  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('2');
});

test('click jumps the caret to the nearest broken reference after the caret, wrapping past the last', async ({
  page,
}) => {
  await openEditor(page, '[First](./missing1.md) middle text [Second](./missing2.md)\n');
  await markAllBroken(page, ['./missing1.md', './missing2.md']);

  // Place the caret right at the very start of the document (before both links).
  await page.evaluate(() => {
    const content = document.getElementById('content')!;
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  await page.locator('#toolbar .broken-ref-badge').click();
  let inSecond = await page.evaluate(() => {
    const sel = window.getSelection()!;
    const second = document.querySelectorAll('#content a.broken-ref')[1];
    return second.contains(sel.anchorNode);
  });
  // Nearest AFTER the start-of-doc caret is the FIRST broken ref, not the second.
  expect(inSecond).toBe(false);

  // Click again from inside the (now-caret) first ref — nearest after it is the second.
  await page.locator('#toolbar .broken-ref-badge').click();
  inSecond = await page.evaluate(() => {
    const sel = window.getSelection()!;
    const second = document.querySelectorAll('#content a.broken-ref')[1];
    return second.contains(sel.anchorNode);
  });
  expect(inSecond).toBe(true);

  // From inside the second (last) ref, wrap back to the first.
  await page.locator('#toolbar .broken-ref-badge').click();
  const inFirst = await page.evaluate(() => {
    const sel = window.getSelection()!;
    const first = document.querySelectorAll('#content a.broken-ref')[0];
    return first.contains(sel.anchorNode);
  });
  expect(inFirst).toBe(true);
});

test('badge chrome follows --rp-warning tokens, not --vscode-badge-*', async ({ page }) => {
  await openEditor(page, '[Broken](./missing.md)\n');
  await markAllBroken(page, ['./missing.md']);

  const color = await page.evaluate(() => {
    document.documentElement.style.setProperty('--rp-warning', 'rgb(9, 8, 7)');
    const badge = document.querySelector('#toolbar .broken-ref-badge') as HTMLElement;
    return getComputedStyle(badge).color;
  });
  expect(color).toBe('rgb(9, 8, 7)');
});
