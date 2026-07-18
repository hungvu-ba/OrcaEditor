/**
 * Coverage for bug 0716 round 2, #1: a new table-level drag handle so the
 * whole <table> can be reordered among its top-level siblings, alongside
 * table.ts's existing row/column handles (no mutual exclusion). Real
 * hover/click/drag behavior — not reducible to a hand-built DOM snapshot
 * (Plan/WEBVIEW_TEST.md).
 */
import { test, expect } from '@playwright/test';
import { openEditor, waitForEdit } from './_harness';

const DOC = `# Heading

Paragraph before.

| Col A | Col B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |

Paragraph after.
`;

test('hovering a table\'s corner zone shows a dedicated table-level handle', async ({ page }) => {
  await openEditor(page, DOC);
  const table = page.locator('table');
  const tableBox = await table.boundingBox();
  if (!tableBox) {
    throw new Error('table has no bounding box');
  }

  await page.mouse.move(tableBox.x + 2, tableBox.y + 2);
  await expect(page.locator('.dd-table-handle')).toHaveCSS('display', 'flex');
});

test('hovering an ordinary table cell does not show the table handle (row/column handles unaffected)', async ({
  page,
}) => {
  await openEditor(page, DOC);
  await page.locator('td', { hasText: 'a1' }).hover();

  await expect(page.locator('.dd-row-handle')).toHaveCSS('display', 'flex');
  await expect(page.locator('.dd-col-handle')).toHaveCSS('display', 'flex');
  await expect(page.locator('.dd-table-handle')).toHaveCSS('display', 'none');
});

test('the table handle can show simultaneously with the row and column handles — no mutual exclusion', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const table = page.locator('table');
  const tableBox = await table.boundingBox();
  if (!tableBox) {
    throw new Error('table has no bounding box');
  }

  // A couple px inside the table's own top-left corner — within the row-0/col-0 handles'
  // own hit zones AND the table handle's corner-overlap band (bug 0716 round 2, #1).
  await page.mouse.move(tableBox.x + 2, tableBox.y + 2);

  await expect(page.locator('.dd-table-handle')).toHaveCSS('display', 'flex');
  await expect(page.locator('.dd-row-handle')).toHaveCSS('display', 'flex');
  await expect(page.locator('.dd-col-handle')).toHaveCSS('display', 'flex');
});

test('a click (no movement) on the table handle opens the same Move up / Move down menu as any block', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const table = page.locator('table');
  const tableBox = await table.boundingBox();
  if (!tableBox) {
    throw new Error('table has no bounding box');
  }
  await page.mouse.move(tableBox.x + 2, tableBox.y + 2);

  const handle = page.locator('.dd-table-handle');
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error('table handle has no bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  const popup = page.locator('.dd-menu-popup:visible');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.dd-menu-item', { hasText: 'Move up' })).toHaveCount(1);
  await expect(popup.locator('.dd-menu-item', { hasText: 'Move down' })).toHaveCount(1);
});

test('dragging the table handle past the threshold moves the whole table among its siblings, without baking in a permanent outline', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const table = page.locator('table');
  const tableBox = await table.boundingBox();
  const afterBox = await page.locator('p', { hasText: 'Paragraph after.' }).boundingBox();
  if (!tableBox || !afterBox) {
    throw new Error('missing bounding box');
  }
  await page.mouse.move(tableBox.x + 2, tableBox.y + 2);

  const handleBox = await page.locator('.dd-table-handle').boundingBox();
  if (!handleBox) {
    throw new Error('table handle has no bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, afterBox.y + afterBox.height + 10, { steps: 10 });
  await page.mouse.up();

  const md = await waitForEdit(page);
  expect(md.indexOf('Paragraph after.')).toBeLessThan(md.indexOf('| a1'));
  // Table content survives the move intact.
  expect(md).toContain('| a1 | b1 |');
  expect(md).toContain('| a2 | b2 |');

  // The moved (newly-inserted) table must not carry a permanently-baked-in
  // .dd-hover-outline — hoveredTableBlock has to be cleared before the move snapshots
  // outerHTML, same as hoveredBlock/hoveredLi already are (bug 0715 #12 class of leak).
  expect(await page.locator('table').getAttribute('class')).not.toContain('dd-hover-outline');
});

test('after a table-handle move, dragging from the stale old handle position does not crash or stick the drag state', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  await openEditor(page, DOC);
  const table = page.locator('table');
  const tableBox = await table.boundingBox();
  const afterBox = await page.locator('p', { hasText: 'Paragraph after.' }).boundingBox();
  if (!tableBox || !afterBox) {
    throw new Error('missing bounding box');
  }
  await page.mouse.move(tableBox.x + 2, tableBox.y + 2);
  const handleBox = await page.locator('.dd-table-handle').boundingBox();
  if (!handleBox) {
    throw new Error('table handle has no bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, afterBox.y + afterBox.height + 10, { steps: 10 });
  await page.mouse.up();
  await waitForEdit(page);

  // Move to the OLD (now stale) table-handle screen position and perform an actual DRAG
  // (past the threshold, not just a click) from there. tableHandleEl lives outside
  // #content (appended to document.body), so hovering it never fires #content's own
  // mousemove/onContentHover — the only thing that can self-correct a stale
  // hoveredTableBlock is this feature's own cleanup on the prior move. Without it, this
  // arms armDrag on the now-detached original table node, and finishBlockMove ->
  // applyBlockMove throws when it can't find that node in draggableBlocks() (index -1) —
  // uncaught, leaving `state` stuck at 'dragging' and breaking all further drag-and-drop.
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 60, { steps: 10 });
  await page.mouse.up();

  expect(pageErrors, `uncaught page error(s): ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);

  // Drag-and-drop must still work normally afterward (state not stuck at 'dragging').
  const alpha = page.locator('p', { hasText: 'Paragraph before.' });
  await alpha.hover();
  const blockHandle = page.locator(
    '.dd-handle:not(.dd-li-handle):not(.dd-row-handle):not(.dd-col-handle):not(.dd-table-handle)'
  );
  await expect(blockHandle).toHaveCSS('display', 'flex');
  const blockHandleBox = await blockHandle.boundingBox();
  if (!blockHandleBox) {
    throw new Error('block handle broken after stale table-handle drag — state likely stuck');
  }
});

test('the menu opened via the table handle is positioned at the table handle, not the (hidden) block handle', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const table = page.locator('table');
  const tableBox = await table.boundingBox();
  if (!tableBox) {
    throw new Error('table has no bounding box');
  }
  await page.mouse.move(tableBox.x + 2, tableBox.y + 2);

  const handle = page.locator('.dd-table-handle');
  const handleBox = await handle.boundingBox();
  if (!handleBox) {
    throw new Error('table handle has no bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  const popupBox = await page.locator('.dd-menu-popup:visible').boundingBox();
  if (!popupBox) {
    throw new Error('menu popup has no bounding box');
  }
  // bug General #1: the popup now opens clear of the table's own content (just below it, or
  // above when there's no room below) instead of at the handle's own row — but still anchored
  // to the real table, never at the block handle's stale (display:none, zero-rect) position,
  // which would park it at the viewport's top-left corner (bug 0716 round 2, #1 follow-up).
  const overlaps =
    popupBox.x < tableBox.x + tableBox.width &&
    popupBox.x + popupBox.width > tableBox.x &&
    popupBox.y < tableBox.y + tableBox.height &&
    popupBox.y + popupBox.height > tableBox.y;
  expect(overlaps).toBe(false);
  const justBelow = Math.abs(popupBox.y - (tableBox.y + tableBox.height)) < 20;
  const justAbove = Math.abs(popupBox.y + popupBox.height - tableBox.y) < 20;
  expect(justBelow || justAbove).toBe(true);
});

test('the row handle menu opens clear of the row, like the block/table menu (bug General R2 #2)', async ({ page }) => {
  await openEditor(page, DOC);
  const row = page.locator('tbody tr', { hasText: 'a1' });
  await page.locator('td', { hasText: 'a1' }).hover();
  const rowHandleBox = await page.locator('.dd-row-handle').boundingBox();
  if (!rowHandleBox) {
    throw new Error('row handle has no bounding box');
  }
  await page.mouse.move(rowHandleBox.x + rowHandleBox.width / 2, rowHandleBox.y + rowHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  const popup = page.locator('.dd-menu-popup:visible');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.dd-menu-item', { hasText: 'Set as header row' })).toHaveCount(1);

  const popupBox = await popup.boundingBox();
  const rowBox = await row.boundingBox();
  if (!popupBox || !rowBox) {
    throw new Error('missing bounding box');
  }
  // The menu must not cover the row's own cells (bug General R2 #2) — placed above/below it.
  const overlaps =
    popupBox.x < rowBox.x + rowBox.width &&
    popupBox.x + popupBox.width > rowBox.x &&
    popupBox.y < rowBox.y + rowBox.height &&
    popupBox.y + popupBox.height > rowBox.y;
  expect(overlaps).toBe(false);
});

// A tall doc (table near the top, lots of filler below) so there is room to scroll.
const TALL_TABLE_DOC = `# Heading

| Col A | Col B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |

${Array.from({ length: 60 }, (_, i) => `Filler ${i}.`).join('\n\n')}
`;

async function openRowMenu(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('td', { hasText: 'a1' }).hover();
  const rowHandleBox = await page.locator('.dd-row-handle').boundingBox();
  if (!rowHandleBox) {
    throw new Error('row handle has no bounding box');
  }
  await page.mouse.move(rowHandleBox.x + rowHandleBox.width / 2, rowHandleBox.y + rowHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('.dd-menu-popup:visible')).toBeVisible();
}

test('an open row menu locks scroll; any key closes it and releases the lock (bug General R2 follow-up)', async ({ page }) => {
  await openEditor(page, TALL_TABLE_DOC);
  await openRowMenu(page);

  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.scrollY)).toBe(before); // scroll frozen while open

  await page.keyboard.press('a'); // a non-Escape key must also close the transient row menu
  await expect(page.locator('.dd-menu-popup:visible')).toBeHidden();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before); // lock released
});

test('a document re-render closes an open row menu and releases the scroll lock (bug General R2 follow-up)', async ({ page }) => {
  await openEditor(page, TALL_TABLE_DOC);
  await openRowMenu(page);
  const before = await page.evaluate(() => window.scrollY);

  // Simulate an external edit / undo pushing new content → renderDocument rebuilds #content,
  // destroying the row the menu was anchored to.
  const tall = `# Changed\n\n${Array.from({ length: 60 }, (_, i) => `New ${i}.`).join('\n\n')}\n`;
  await page.evaluate((t) => window.postMessage({ type: 'update', text: t }, '*'), tall);

  await expect(page.locator('.dd-menu-popup:visible')).toBeHidden();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before); // lock released
});
