/**
 * Req 20 US-20.9 / Req 21 US-21.3 — broken-ref.ts hover-tooltip hide
 * lifecycle. broken-ref-marker.spec.ts already covers show + the grace-timer
 * survive path (mouseout → tooltip mouseenter cancels the hide) and the
 * "Search again →" click; this spec covers the remaining hide branches:
 *  - grace timeout: mouseout with no rescue → tooltip hides after
 *    BROKEN_REF_TOOLTIP_HIDE_GRACE_MS.
 *  - re-hover rescue: mouseout then mouseover the SAME anchor cancels the
 *    scheduled hide (tooltip stays, no flicker re-show).
 *  - tooltip mouseleave → immediate hide (no grace).
 *  - document scroll → immediate hide (anchor rect is stale).
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

interface CheckTargetsExistMsg {
  type: 'checkTargetsExist';
  requestId: number;
  docVersion: number;
  targets: string[];
}

/** Open a doc with one broken file link and reply to the existence check so `.broken-ref` is stamped. */
async function openWithBrokenLink(page: import('@playwright/test').Page): Promise<void> {
  await openEditor(page, '[Old Setup Guide](./missing.md)\n');
  await page.waitForSelector('#content a[href]');
  const handle = await page.waitForFunction(() =>
    (window as unknown as { __posted: CheckTargetsExistMsg[] }).__posted.find((m) => m.type === 'checkTargetsExist')
  );
  const req = (await handle.jsonValue()) as CheckTargetsExistMsg;
  await page.evaluate(
    ({ requestId, docVersion }) =>
      window.postMessage(
        { type: 'targetsExistResult', requestId, docVersion, results: [{ target: './missing.md', exists: false }] },
        '*'
      ),
    { requestId: req.requestId, docVersion: req.docVersion }
  );
  await page.waitForSelector('#content a.broken-ref');
}

function tooltipVisible(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const t = document.querySelector('.broken-ref-tooltip') as HTMLElement | null;
    return !!t && !t.hidden;
  });
}

/** Wait two animation frames — the fix popup opens from the mousemove handler's rAF-coalesced callback. */
function rafTick(page: import('@playwright/test').Page): Promise<unknown> {
  return page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(null)))));
}

/** Hover the anchor's leading warning triangle → opens the fix popup (mousemove-driven, gated on the triangle hitzone). */
async function hoverAnchor(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const a = document.querySelector('#content a.broken-ref') as HTMLElement;
    const r = a.getClientRects()[0];
    a.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
  });
  await rafTick(page);
}

/** Leave the triangle (a mousemove off it, still inside #content) → schedules the grace hide. */
async function leaveAnchor(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const content = document.querySelector('#content') as HTMLElement;
    const r = content.getBoundingClientRect();
    content.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.right - 4, clientY: r.bottom - 4 }));
  });
  await rafTick(page);
}

test('mouseout with no rescue hides the tooltip after the grace period', async ({ page }) => {
  await openWithBrokenLink(page);
  await hoverAnchor(page);
  expect(await tooltipVisible(page)).toBe(true);

  await leaveAnchor(page);
  // Still visible immediately after mouseout (grace, not instant hide)...
  expect(await tooltipVisible(page)).toBe(true);
  // ...but gone once BROKEN_REF_TOOLTIP_HIDE_GRACE_MS (140ms) elapses.
  await page.waitForTimeout(300);
  expect(await tooltipVisible(page)).toBe(false);
});

test('re-hovering the same anchor during the grace period cancels the scheduled hide', async ({ page }) => {
  await openWithBrokenLink(page);
  await hoverAnchor(page);
  await leaveAnchor(page);

  // Back onto the SAME anchor before the grace timer fires → hide is cancelled.
  await hoverAnchor(page);
  await page.waitForTimeout(300);
  expect(await tooltipVisible(page)).toBe(true);
});

test('leaving the tooltip itself hides it immediately (no grace)', async ({ page }) => {
  await openWithBrokenLink(page);
  await hoverAnchor(page);
  await page.evaluate(() => {
    const t = document.querySelector('.broken-ref-tooltip') as HTMLElement;
    t.dispatchEvent(new MouseEvent('mouseenter'));
    t.dispatchEvent(new MouseEvent('mouseleave'));
  });
  expect(await tooltipVisible(page)).toBe(false);
});

test('scrolling hides the tooltip (anchor rect is stale)', async ({ page }) => {
  await openWithBrokenLink(page);
  await hoverAnchor(page);
  expect(await tooltipVisible(page)).toBe(true);

  await page.evaluate(() => document.dispatchEvent(new Event('scroll')));
  expect(await tooltipVisible(page)).toBe(false);
});
