/**
 * Req 20 US-20.9 (Sprint C, file/heading links only): broken-reference
 * inline marker (media/webview/broken-ref.ts), hooked into main.ts's
 * renderDocument() chain. Covers: the always-visible `.broken-ref` marker for
 * a broken file link (via the real `checkTargetsExist`/`targetsExistResult`
 * host round trip) vs. a healthy one staying unmarked; same-document
 * `#heading` links resolved locally (no host round trip); `http(s)` links
 * never sent to the host; the caret-inside-reference skip; and a stale
 * `targetsExistResult` (superseded by a newer scan) being discarded.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

interface CheckTargetsExistMsg {
  type: 'checkTargetsExist';
  requestId: number;
  docVersion: number;
  targets: string[];
}

/** Wait for the next 'checkTargetsExist' message posted to the host. */
async function waitForCheckTargetsExist(page: import('@playwright/test').Page): Promise<CheckTargetsExistMsg> {
  const handle = await page.waitForFunction(() =>
    (window as unknown as { __posted: CheckTargetsExistMsg[] }).__posted.find((m) => m.type === 'checkTargetsExist')
  );
  return (await handle.jsonValue()) as CheckTargetsExistMsg;
}

/** Simulate the host's reply, exactly as provider.ts's 'checkTargetsExist' case would post it back. */
async function replyTargetsExist(
  page: import('@playwright/test').Page,
  requestId: number,
  docVersion: number,
  results: Array<{ target: string; exists: boolean }>
): Promise<void> {
  await page.evaluate(
    ({ requestId, docVersion, results }) =>
      window.postMessage({ type: 'targetsExistResult', requestId, docVersion, results }, '*'),
    { requestId, docVersion, results }
  );
}

function brokenClasses(page: import('@playwright/test').Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => {
    const out: Record<string, boolean> = {};
    for (const a of Array.from(document.querySelectorAll('#content a[href]'))) {
      out[a.getAttribute('href') ?? ''] = a.classList.contains('broken-ref');
    }
    return out;
  });
}

test('broken file link gets the marker, healthy one does not — via the real fs.stat round trip', async ({ page }) => {
  await openEditor(
    page,
    '[Old Setup Guide](./missing.md) and [Existing](./exists.md).\n'
  );
  await page.waitForSelector('#content a[href]');

  const req = await waitForCheckTargetsExist(page);
  expect(req.targets.sort()).toEqual(['./exists.md', './missing.md']);

  await replyTargetsExist(page, req.requestId, req.docVersion, [
    { target: './missing.md', exists: false },
    { target: './exists.md', exists: true },
  ]);

  const classes = await brokenClasses(page);
  expect(classes['./missing.md']).toBe(true);
  expect(classes['./exists.md']).toBeFalsy();
});

test('http(s)/mailto links are never sent to the host for existence checking', async ({ page }) => {
  await openEditor(
    page,
    '[Broken](./missing.md) and [External](https://example.com) and [Mail](mailto:a@b.com).\n'
  );
  await page.waitForSelector('#content a[href]');

  const req = await waitForCheckTargetsExist(page);
  expect(req.targets).toEqual(['./missing.md']);
});

test('same-document #heading links resolve locally against the TOC heading index — no host round trip', async ({
  page,
}) => {
  await openEditor(page, '# Existing Heading\n\n[Good](#existing-heading) and [Bad](#nonexistent-heading).\n');
  await page.waitForSelector('#content a[href]');

  // No file-link candidates in this doc → recompute() never posts checkTargetsExist.
  await page.waitForTimeout(500);
  const posted = await page.evaluate(() => (window as unknown as { __posted: Array<{ type: string }> }).__posted);
  expect(posted.some((m) => m.type === 'checkTargetsExist')).toBe(false);

  const classes = await brokenClasses(page);
  expect(classes['#existing-heading']).toBeFalsy();
  expect(classes['#nonexistent-heading']).toBe(true);
});

test('the reference the caret is currently inside is skipped for that recompute pass', async ({ page }) => {
  await openEditor(page, '[Old Setup Guide](./missing.md)\n');
  await page.waitForSelector('#content a[href]');

  // Place the caret inside the link's text before the debounced recompute fires.
  await page.evaluate(() => {
    const a = document.querySelector('#content a[href]') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(a);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  await page.waitForTimeout(500);
  const posted = await page.evaluate(() => (window as unknown as { __posted: Array<{ type: string }> }).__posted);
  expect(posted.some((m) => m.type === 'checkTargetsExist')).toBe(false);
});

test('hover tooltip survives the pointer crossing the anchor→tooltip gap (no instant hide)', async ({ page }) => {
  await openEditor(page, '[Old Setup Guide](./missing.md)\n');
  await page.waitForSelector('#content a[href]');
  const req = await waitForCheckTargetsExist(page);
  await replyTargetsExist(page, req.requestId, req.docVersion, [{ target: './missing.md', exists: false }]);
  await page.waitForSelector('#content a.broken-ref');

  const tooltipVisible = () =>
    page.evaluate(() => {
      const t = document.querySelector('.broken-ref-tooltip') as HTMLElement | null;
      return !!t && !t.hidden;
    });

  const rafTick = () =>
    page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(null)))));

  // Hover the anchor's warning triangle → fix popup shows (mousemove-driven).
  await page.evaluate(() => {
    const a = document.querySelector('#content a.broken-ref') as HTMLElement;
    const r = a.getClientRects()[0];
    a.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
  });
  await rafTick();
  expect(await tooltipVisible()).toBe(true);

  // Leave the triangle toward the gap (a mousemove off it schedules the hide),
  // then enter the tooltip before the grace elapses — hide must be cancelled.
  await page.evaluate(() => {
    const content = document.querySelector('#content') as HTMLElement;
    const r = content.getBoundingClientRect();
    content.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.right - 4, clientY: r.bottom - 4 }));
  });
  await rafTick();
  await page.evaluate(() => {
    const t = document.querySelector('.broken-ref-tooltip') as HTMLElement;
    t.dispatchEvent(new MouseEvent('mouseenter'));
  });
  await page.waitForTimeout(300); // > BROKEN_REF_TOOLTIP_HIDE_GRACE_MS
  expect(await tooltipVisible()).toBe(true);

  // Clicking "Search again →" is now reachable and drives onSearchAgain (quick-correct).
  await page.evaluate(() => {
    const action = document.querySelector('.broken-ref-tooltip-action') as HTMLElement;
    action.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  expect(await tooltipVisible()).toBe(false);
});

test('a stale targetsExistResult from a superseded scan is discarded', async ({ page }) => {
  await openEditor(page, '[Old Setup Guide](./missing.md)\n');
  await page.waitForSelector('#content a[href]');
  const first = await waitForCheckTargetsExist(page);

  // Force a second scan before replying to the first (e.g. a fresh edit debounced through).
  await clearPosted(page);
  await page.evaluate(() =>
    window.postMessage({ type: 'update', text: '[Old Setup Guide](./missing.md)\n\nmore text\n' }, '*')
  );
  const second = await waitForCheckTargetsExist(page);
  expect(second.requestId).not.toBe(first.requestId);

  // Reply to the STALE first request only — must be discarded, not applied.
  await replyTargetsExist(page, first.requestId, first.docVersion, [{ target: './missing.md', exists: true }]);
  await page.waitForTimeout(100);
  let classes = await brokenClasses(page);
  expect(classes['./missing.md']).toBeFalsy(); // stale reply had no effect either way yet

  // Now reply to the CURRENT request — this one must apply.
  await replyTargetsExist(page, second.requestId, second.docVersion, [{ target: './missing.md', exists: false }]);
  classes = await brokenClasses(page);
  expect(classes['./missing.md']).toBe(true);
});
