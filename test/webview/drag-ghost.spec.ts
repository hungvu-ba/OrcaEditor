/**
 * Coverage for the drag-ghost preview shown while dragging a block/li/row/
 * column: the source element already carries `.dd-hover-outline`(-cell) from
 * arming the drag (see armDrag/armLiDrag/armRowDrag/armColDrag), so cloning it
 * as-is into the `.dd-ghost` box drew a second blue rectangle on top of the
 * ghost's own border. The ghost's box was also never sized to the source
 * element's actual footprint, so it visibly didn't match the editor. Real
 * mousedown/mousemove drag behavior — not reducible to a hand-built DOM
 * snapshot (Plan/WEBVIEW_TEST.md).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { openEditor } from './_harness';

const DOC = `# Heading

Alpha paragraph with enough text to have a real width footprint in the editor.

| Col A | Col B |
| --- | --- |
| a1 | b1 |
`;

async function hoverCenter(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('locator has no bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test('dragging a block: the ghost never carries .dd-hover-outline and matches the source size', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const heading = page.locator('h1', { hasText: 'Heading' });
  await hoverCenter(page, heading);
  const headingRect = await heading.boundingBox();
  if (!headingRect) {
    throw new Error('heading has no bounding box');
  }

  const handle = page.locator('.dd-handle:not(.dd-li-handle):not(.dd-row-handle):not(.dd-col-handle):not(.dd-table-handle)');
  const handleBox = await handle.boundingBox();
  if (!handleBox) {
    throw new Error('block handle has no bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 10, { steps: 5 });

  const ghost = page.locator('.dd-ghost:visible');
  await expect(ghost).toBeVisible();
  await expect(ghost.locator('.dd-hover-outline')).toHaveCount(0);

  const ghostBox = await ghost.boundingBox();
  if (!ghostBox) {
    throw new Error('ghost has no bounding box');
  }
  expect(ghostBox.width).toBeCloseTo(headingRect.width, 0);
  // Height is intentionally left auto (not pinned to headingRect.height) — the
  // ghost's own padding needs extra room beyond the source's raw content
  // height, or the bottom line renders clipped (see the dedicated test below).
  expect(ghostBox.height).toBeGreaterThanOrEqual(headingRect.height);

  await page.keyboard.press('Escape');
  await expect(ghost).toBeHidden();
});

test('dragging a multi-line block: the ghost is tall enough that its bottom line is not clipped', async ({
  page,
}) => {
  const longText =
    'This paragraph has enough text in it to wrap across multiple lines inside the editor so the ghost preview must reserve room for every line, including the last one, without clipping it.';
  await openEditor(page, `# Heading\n\n${longText}\n`);
  const p = page.locator('p', { hasText: 'This paragraph' });
  await hoverCenter(page, p);

  const handle = page.locator('.dd-handle:not(.dd-li-handle):not(.dd-row-handle):not(.dd-col-handle):not(.dd-table-handle)');
  const handleBox = await handle.boundingBox();
  if (!handleBox) {
    throw new Error('block handle has no bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 10, { steps: 5 });

  const ghost = page.locator('.dd-ghost:visible');
  await expect(ghost).toBeVisible();
  const { ghostClientHeight, childScrollHeight } = await ghost.evaluate((el) => ({
    ghostClientHeight: el.clientHeight,
    childScrollHeight: (el.firstElementChild as HTMLElement | null)?.scrollHeight ?? 0,
  }));
  expect(childScrollHeight).toBeLessThanOrEqual(ghostClientHeight);

  await page.keyboard.press('Escape');
});

test('dragging a multi-line list item: the ghost is tall enough that its bottom line is not clipped', async ({
  page,
}) => {
  const longText =
    'This list item has enough text in it to wrap across multiple lines inside the editor so the ghost preview must reserve room for every line, including the last one, without clipping it.';
  await openEditor(page, `- ${longText}\n- Sibling item\n`);
  const li = page.locator('li', { hasText: 'This list item' });
  await hoverCenter(page, li);

  const liHandle = page.locator('.dd-li-handle');
  const handleBox = await liHandle.boundingBox();
  if (!handleBox) {
    throw new Error('li handle has no bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 10, { steps: 5 });

  const ghost = page.locator('.dd-ghost:visible');
  await expect(ghost).toBeVisible();
  const { ghostClientHeight, childScrollHeight } = await ghost.evaluate((el) => ({
    ghostClientHeight: el.clientHeight,
    childScrollHeight: (el.firstElementChild as HTMLElement | null)?.scrollHeight ?? 0,
  }));
  expect(childScrollHeight).toBeLessThanOrEqual(ghostClientHeight);

  await page.keyboard.press('Escape');
});

test('dragging a table row: the ghost never carries .dd-hover-outline and matches the row size', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const dataRow = page.locator('tbody tr', { hasText: 'a1' });
  await hoverCenter(page, page.locator('td', { hasText: 'a1' }));
  const rowRect = await dataRow.boundingBox();
  if (!rowRect) {
    throw new Error('row has no bounding box');
  }

  const rowHandle = page.locator('.dd-row-handle');
  const handleBox = await rowHandle.boundingBox();
  if (!handleBox) {
    throw new Error('row handle has no bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 10, { steps: 5 });

  const ghost = page.locator('.dd-ghost:visible');
  await expect(ghost).toBeVisible();
  await expect(ghost.locator('.dd-hover-outline')).toHaveCount(0);

  const ghostBox = await ghost.boundingBox();
  if (!ghostBox) {
    throw new Error('ghost has no bounding box');
  }
  expect(ghostBox.width).toBeCloseTo(rowRect.width, 0);
  expect(ghostBox.height).toBeCloseTo(rowRect.height, 0);

  await page.keyboard.press('Escape');
  await expect(ghost).toBeHidden();
});

test('dragging a table column: the ghost clones the real column content (header + every cell), never carries .dd-hover-outline-cell, and spans the full column', async ({
  page,
}) => {
  await openEditor(page, DOC);
  await hoverCenter(page, page.locator('td', { hasText: 'a1' }));
  const headerCellRect = await page.locator('th', { hasText: 'Col A' }).boundingBox();
  const tableRect = await page.locator('table').boundingBox();
  if (!headerCellRect || !tableRect) {
    throw new Error('missing bounding box');
  }

  const colHandle = page.locator('.dd-col-handle');
  const handleBox = await colHandle.boundingBox();
  if (!handleBox) {
    throw new Error('col handle has no bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 10, handleBox.y + handleBox.height / 2, { steps: 5 });

  const ghost = page.locator('.dd-ghost:visible');
  await expect(ghost).toBeVisible();
  // Real content — one cloned cell per real row (bug 0716 round 2 #4), not the old
  // empty placeholder box — and no .dd-hover-outline-cell leaking in from the source
  // cells the drag armed (same "no doubled outline" rule as the block/row ghosts above).
  const ghostText = await ghost.textContent();
  expect(ghostText).toContain('Col A');
  expect(ghostText).toContain('a1');
  expect(ghostText).not.toContain('Col B');
  expect(ghostText).not.toContain('b1');
  await expect(ghost.locator('.dd-hover-outline-cell')).toHaveCount(0);

  const ghostBox = await ghost.boundingBox();
  if (!ghostBox) {
    throw new Error('ghost has no bounding box');
  }
  expect(ghostBox.width).toBeCloseTo(headerCellRect.width, 0);
  expect(ghostBox.height).toBeCloseTo(Math.min(tableRect.height, 160), 0);

  await page.keyboard.press('Escape');
  await expect(ghost).toBeHidden();
});
