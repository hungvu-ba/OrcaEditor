/**
 * Performance Audit P-3/P-4/P-5: the block, list-item, table row/column and popup drags now do
 * their layout-reading work inside one requestAnimationFrame per frame instead of on every raw
 * mousemove. For the editor drags that same work resolves the drop target itself
 * (`currentGap`/`currentLiDepth`/`tdCurrentGap`), so a mouseup arriving in the SAME frame as the
 * last mousemove must still drop where the pointer is — mouseup flushes the pending frame first.
 *
 * Two shapes are covered, and they fail differently without the flush:
 *  - `dragInOneFrame`: press, move and release with no frame in between at all → no drop target
 *    was ever computed → nothing moves.
 *  - `dragAcrossFrames`: one move, a real frame boundary, then the final move + release in one
 *    frame → the drop lands at the PREVIOUS frame's gap, one target behind the cursor.
 * Only synchronous dispatch can produce either: `page.mouse.*` leaves real gaps between steps,
 * so a frame always runs before mouseup. Real event dispatch, not reducible to a hand-built DOM
 * snapshot (Plan/WEBVIEW_TEST.md).
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, waitForEdit, clearPosted } from './_harness';

const BLOCK_HANDLE_SELECTOR =
  '.dd-handle:not(.dd-li-handle):not(.dd-row-handle):not(.dd-col-handle):not(.dd-table-handle)';

const DOC = `Alpha paragraph.

Beta paragraph.

Gamma paragraph.

Delta paragraph.
`;

const LIST_DOC = `- Item one
- Item two
- Item three
- Item four
`;

const TABLE_DOC = `| Col |
| --- |
| r1 |
| r2 |
| r3 |
| r4 |
`;

const MATH_DOC = `Inline $x^2$ math.
`;

interface Point {
  x: number;
  y: number;
}

/** Dispatches mousedown/mousemove/mouseup at `to` with no yield to the event loop, so no
 * requestAnimationFrame callback can run between the move and the release. */
async function dragInOneFrame(page: Page, handleSelector: string, from: Point, to: Point): Promise<void> {
  await page.evaluate(
    ({ handleSelector: sel, from: start, to: end }) => {
      const handle = document.querySelector(sel);
      if (!handle) {
        throw new Error(`no handle for ${sel}`);
      }
      const opts = { bubbles: true, button: 0, buttons: 1 };
      handle.dispatchEvent(new MouseEvent('mousedown', { ...opts, clientX: start.x, clientY: start.y }));
      document.dispatchEvent(new MouseEvent('mousemove', { ...opts, clientX: end.x, clientY: end.y }));
      document.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0, clientX: end.x, clientY: end.y }));
    },
    { handleSelector, from, to }
  );
}

/** Presses at `from`, moves to `via`, lets a real frame run (so the drop target is resolved for
 * `via`), then moves to `to` and releases in one synchronous block. A correct implementation
 * drops at `to`; one that forgets to flush the pending frame drops at `via`. */
async function dragAcrossFrames(
  page: Page,
  handleSelector: string,
  from: Point,
  via: Point,
  to: Point
): Promise<void> {
  await page.evaluate(
    ({ handleSelector: sel, from: start, via: mid }) => {
      const handle = document.querySelector(sel);
      if (!handle) {
        throw new Error(`no handle for ${sel}`);
      }
      const opts = { bubbles: true, button: 0, buttons: 1 };
      handle.dispatchEvent(new MouseEvent('mousedown', { ...opts, clientX: start.x, clientY: start.y }));
      document.dispatchEvent(new MouseEvent('mousemove', { ...opts, clientX: mid.x, clientY: mid.y }));
    },
    { handleSelector, from, via }
  );
  // The drag frame armed by that move is already registered, and rAF callbacks run in
  // registration order — so when this one resolves, the drop target for `via` is committed.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.evaluate(
    ({ to: end }) => {
      const opts = { bubbles: true, button: 0, buttons: 1 };
      document.dispatchEvent(new MouseEvent('mousemove', { ...opts, clientX: end.x, clientY: end.y }));
      document.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0, clientX: end.x, clientY: end.y }));
    },
    { to }
  );
}

async function centerOf(page: Page, selector: string, hasText?: string): Promise<Point> {
  const locator = hasText ? page.locator(selector, { hasText }) : page.locator(selector);
  const box = await locator.first().boundingBox();
  if (!box) {
    throw new Error(`no bounding box for ${selector}`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Index of `needle` in `md`, asserted present first — a bare indexOf comparison would pass on
 * `-1`, i.e. it would greenlight a drag that DELETED the block instead of moving it. */
function orderOf(md: string, needle: string): number {
  const at = md.indexOf(needle);
  expect(at, `"${needle}" is missing from the serialized markdown`).toBeGreaterThanOrEqual(0);
  return at;
}

test('a block released in the same frame as its only move still drops at the cursor (P-3)', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const alpha = await centerOf(page, 'p', 'Alpha paragraph.');
  await page.mouse.move(alpha.x, alpha.y);
  await expect(page.locator(BLOCK_HANDLE_SELECTOR)).toBeVisible();
  const handle = await centerOf(page, BLOCK_HANDLE_SELECTOR);
  const gamma = await centerOf(page, 'p', 'Gamma paragraph.');

  await clearPosted(page);
  await dragInOneFrame(page, BLOCK_HANDLE_SELECTOR, handle, { x: handle.x, y: gamma.y });

  const md = await waitForEdit(page);
  // Every paragraph survived, and Alpha left its original first position.
  expect(orderOf(md, 'Alpha paragraph.')).toBeGreaterThan(orderOf(md, 'Beta paragraph.'));
  orderOf(md, 'Gamma paragraph.');
  orderOf(md, 'Delta paragraph.');
});

test('a block released one frame after an earlier move drops at the LAST cursor position, not the previous frame’s (P-3)', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const alpha = await centerOf(page, 'p', 'Alpha paragraph.');
  await page.mouse.move(alpha.x, alpha.y);
  await expect(page.locator(BLOCK_HANDLE_SELECTOR)).toBeVisible();
  const handle = await centerOf(page, BLOCK_HANDLE_SELECTOR);
  const beta = await centerOf(page, 'p', 'Beta paragraph.');
  const delta = await centerOf(page, 'p', 'Delta paragraph.');

  await clearPosted(page);
  await dragAcrossFrames(
    page,
    BLOCK_HANDLE_SELECTOR,
    handle,
    { x: handle.x, y: beta.y },
    { x: handle.x, y: delta.y }
  );

  const md = await waitForEdit(page);
  // Landed past Gamma — i.e. at the final cursor, not at the gap the earlier frame resolved
  // next to Beta. Also proves the flush reads the LATEST coordinates, not the frame's stale pair.
  expect(orderOf(md, 'Alpha paragraph.')).toBeGreaterThan(orderOf(md, 'Gamma paragraph.'));
  orderOf(md, 'Beta paragraph.');
  orderOf(md, 'Delta paragraph.');
});

test('a list item released in the same frame as its only move still drops at the cursor (P-3, li path)', async ({
  page,
}) => {
  await openEditor(page, LIST_DOC);
  const one = await centerOf(page, 'li', 'Item one');
  await page.mouse.move(one.x, one.y);
  await expect(page.locator('.dd-li-handle')).toBeVisible();
  const handle = await centerOf(page, '.dd-li-handle');
  const three = await centerOf(page, 'li', 'Item three');

  await clearPosted(page);
  // Same X as the handle keeps the horizontal offset at 0, so the depth stays root-level and
  // only the vertical gap — the value the coalesced frame resolves — decides the drop.
  await dragInOneFrame(page, '.dd-li-handle', handle, { x: handle.x, y: three.y });

  const md = await waitForEdit(page);
  expect(orderOf(md, 'Item one')).toBeGreaterThan(orderOf(md, 'Item two'));
  // Still a flat root-level list: no item acquired indentation from a stale depth.
  expect(md).not.toMatch(/^\s+- Item/m);
  orderOf(md, 'Item four');
});

test('a table row released in the same frame as its only move still drops at the cursor (P-4)', async ({
  page,
}) => {
  await openEditor(page, TABLE_DOC);
  const firstCell = await centerOf(page, 'tbody tr:first-child td');
  await page.mouse.move(firstCell.x, firstCell.y);
  await expect(page.locator('.dd-row-handle')).toBeVisible();
  const handle = await centerOf(page, '.dd-row-handle');
  const lastCell = await centerOf(page, 'tbody tr:last-child td');

  await clearPosted(page);
  await dragInOneFrame(page, '.dd-row-handle', handle, { x: handle.x, y: lastCell.y });

  const md = await waitForEdit(page);
  expect(orderOf(md, '| r1 |')).toBeGreaterThan(orderOf(md, '| r2 |'));
  orderOf(md, '| r3 |');
  orderOf(md, '| r4 |');
});

test('a table row released one frame after an earlier move drops at the LAST cursor position (P-4)', async ({
  page,
}) => {
  await openEditor(page, TABLE_DOC);
  const firstCell = await centerOf(page, 'tbody tr:first-child td');
  await page.mouse.move(firstCell.x, firstCell.y);
  await expect(page.locator('.dd-row-handle')).toBeVisible();
  const handle = await centerOf(page, '.dd-row-handle');
  const secondCell = await centerOf(page, 'tbody tr:nth-child(2) td');
  const lastCell = await centerOf(page, 'tbody tr:last-child td');

  await clearPosted(page);
  await dragAcrossFrames(
    page,
    '.dd-row-handle',
    handle,
    { x: handle.x, y: secondCell.y },
    { x: handle.x, y: lastCell.y }
  );

  const md = await waitForEdit(page);
  expect(orderOf(md, '| r1 |')).toBeGreaterThan(orderOf(md, '| r3 |'));
  orderOf(md, '| r2 |');
  orderOf(md, '| r4 |');
});

test('a dragged popup released in the same frame as its move lands at the pointer, not one frame behind (P-5)', async ({
  page,
}) => {
  await openEditor(page, MATH_DOC);
  await page.locator('.md-math-toggle').first().click();
  const popover = page.locator('.md-math-edit-popover');
  await expect(popover).toBeVisible();

  const before = await popover.boundingBox();
  if (!before) {
    throw new Error('popover has no bounding box');
  }
  // Grab the popover's own body (the title strip), never the textarea/buttons —
  // DRAG_IGNORE_SELECTOR refuses a drag started on those.
  const grab = { x: before.x + before.width / 2, y: before.y + 4 };
  const drop = { x: grab.x + 60, y: grab.y + 40 };

  // The style is read inside the SAME evaluate as the mouseup: any read done in a later
  // Playwright round-trip gives the pending frame time to fire, so it would pass even with no
  // flush at all — the position must be observably correct the moment the button is released.
  const after = await page.evaluate(
    ({ grab: start, drop: end }) => {
      const target = document.querySelector('.md-math-edit-popover') as HTMLElement | null;
      if (!target) {
        throw new Error('no popover');
      }
      const opts = { bubbles: true, button: 0, buttons: 1 };
      target.dispatchEvent(new MouseEvent('mousedown', { ...opts, clientX: start.x, clientY: start.y }));
      document.dispatchEvent(new MouseEvent('mousemove', { ...opts, clientX: end.x, clientY: end.y }));
      document.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0, clientX: end.x, clientY: end.y }));
      return { left: parseFloat(target.style.left), top: parseFloat(target.style.top) };
    },
    { grab, drop }
  );

  // The release position is honoured on mouseup even though its frame never fired — without the
  // flush the popup would still sit at `before`.
  expect(after.left).toBeCloseTo(before.x + 60, 0);
  expect(after.top).toBeCloseTo(before.y + 40, 0);
  // And it is still clamped inside the viewport, not parked off-screen by a 0×0 measurement.
  const viewport = page.viewportSize();
  expect(after.left).toBeGreaterThanOrEqual(0);
  expect(after.top).toBeGreaterThanOrEqual(0);
  expect(after.left + before.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
});
