/**
 * Repro for a live user report (bug 0716 round 2): dragging a table row past a
 * neighboring row corrupted the table when cells carry rich inline content
 * (bold, inline code, multi-sentence text) — rows lost their <tr>/<td>
 * boundaries and cell text ran together. test/roundtrip/table.ts's row-drag
 * case can't catch this: it hand-builds the ALREADY-correct post-move DOM and
 * only checks serialization, it never exercises the real
 * `document.execCommand('insertHTML', ...)` + Selection Range call that
 * table.ts's `finishRowMove` actually performs (Plan/WEBVIEW_TEST.md: real
 * execCommand/Selection behavior needs a real browser engine).
 */
import { test, expect } from '@playwright/test';
import { openEditor, waitForEdit } from './_harness';

const TABLE_DOC = `| # | Quyết định | Chốt | Ghi chú |
| --- | --- | --- | --- |
| D1 | **Số affix v1** | **3 affix Tier-1** (Nhanh/Dai/Bọc Giáp), Tier 2/3 = **Phase 2** | Mâu thuẫn nguồn: §7.3/§9/§10 (canonical) = **3 affix**; Tech §5.4 ghi nhầm **"5 affix"** → **theo 3**. Budget \`floor(ZL/2)\` cap 3. |
| D2 | **Handoff mất-xe M2↔M3** | M2 sở hữu **primitive** \`RemoveVehicle\` + hệ quả; **M3 sở hữu TRIGGER** + \`VehicleState.hp\` | M3.4 chỉ **kéo cò** (hp→0 / tràn / kẹt-xăng / bỏ-bê) rồi gọi primitive. |
| D3 | **"Siege/Bao Vây" = 1 khái niệm, 2 bề mặt** | **KHÔNG tách 2 hệ** | (a) **Macro** — đồng hồ khi-DỪNG = \`DangerClockSystem\` **nâng cấp**. (b) **Micro** — Siege dâng mỗi round TRONG trận thủ/phục-kích. Dùng **chung ngưỡng 60/80/100**. |
| D4 | **Mất xe ④ (bỏ bê)** | **v1 nhẹ:** hp thấp không sửa → **−speed đoàn** (BV#6) | Không "hỏng hẳn" (Phase 2). |
`;

test('dragging row D3 above row D2 preserves every row and cell boundary', async ({ page }) => {
  await openEditor(page, TABLE_DOC);

  const d3Row = page.locator('tbody tr', { hasText: 'Siege/Bao Vây' });
  const d2Row = page.locator('tbody tr', { hasText: 'Handoff mất-xe' });
  const d3Cell = d3Row.locator('td').first();

  await d3Cell.hover();
  const rowHandle = page.locator('.dd-row-handle');
  await expect(rowHandle).toHaveCSS('display', 'flex');
  const handleBox = await rowHandle.boundingBox();
  const d2Box = await d2Row.boundingBox();
  if (!handleBox || !d2Box) {
    throw new Error('missing bounding box');
  }

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  // Land in D2's upper half so rowGapAt resolves the gap right before D2.
  await page.mouse.move(handleBox.x + handleBox.width / 2, d2Box.y + 2, { steps: 10 });
  await page.mouse.up();

  const md = await waitForEdit(page);

  const rows = md
    .trim()
    .split('\n')
    .filter((l) => l.trim().startsWith('|'));
  // Header + delimiter + 4 data rows = 6 lines; each data row keeps exactly 4 pipe-delimited cells.
  expect(rows.length).toBe(6);
  for (const row of rows.slice(2)) {
    expect((row.match(/\|/g) ?? []).length).toBe(5);
  }

  const d3Idx = md.indexOf('Siege/Bao Vây');
  const d2Idx = md.indexOf('Handoff mất-xe');
  const d1Idx = md.indexOf('Số affix v1');
  const d4Idx = md.indexOf('Mất xe ④');
  expect(d1Idx).toBeGreaterThanOrEqual(0);
  expect(d3Idx).toBeGreaterThan(d1Idx);
  expect(d2Idx).toBeGreaterThan(d3Idx);
  expect(d4Idx).toBeGreaterThan(d2Idx);

  // Content must not have merged across the old row boundary.
  expect(md).toContain('RemoveVehicle');
  expect(md).toContain('VehicleState.hp');
  expect(md).toContain('DangerClockSystem');
});

// Heading + paragraph before the table (not just the table alone) so the column handle,
// which sits ABOVE the header row, lands clear of the sticky toolbar's own band — a table
// as literally the first line puts the handle's y-position behind the toolbar (z-index 160
// vs. the handle's 20), making it unclickable; a pre-existing, separate positioning gap
// (no clamp against toolbar height, unlike image-zoom's equivalent fix) that this test
// deliberately avoids rather than exercises.
const COL_TABLE_DOC = `# Heading

Some paragraph to push the table down away from the toolbar.

| Alpha | Beta |
| --- | --- |
| RowOneAlpha | RowOneBeta |
| RowTwoAlpha | RowTwoBeta |
`;

test('dragging a column shows a ghost with the real column content, not an empty box (bug 0716 round 2 #4)', async ({
  page,
}) => {
  await openEditor(page, COL_TABLE_DOC);

  const headerCell = page.locator('th', { hasText: 'Alpha' });
  await headerCell.hover();
  const colHandle = page.locator('.dd-col-handle');
  await expect(colHandle).toHaveCSS('display', 'flex');
  const handleBox = await colHandle.boundingBox();
  if (!handleBox) {
    throw new Error('missing col handle bounding box');
  }

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  // Cross TD_DRAG_THRESHOLD_PX to enter the 'dragging' state and populate the ghost.
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 10, { steps: 5 });

  const ghost = page.locator('.dd-ghost-table');
  await expect(ghost).toBeVisible();
  const ghostText = await ghost.textContent();
  expect(ghostText).toContain('Alpha');
  expect(ghostText).toContain('RowOneAlpha');
  expect(ghostText).toContain('RowTwoAlpha');
  // The other column's content must not leak into this column's ghost.
  expect(ghostText).not.toContain('Beta');

  // Cancel instead of dropping — this test only asserts the ghost's content, not the move.
  await page.keyboard.press('Escape');
  await expect(ghost).toBeHidden();
});

// Tall enough (8 data rows) that the real table exceeds the base .dd-ghost text-preview
// ghost's 160px max-height — the col-ghost must not inherit that clip (bug 0716 round 2 #4
// follow-up: the ghost's own height must mirror the real table height, not be truncated).
const TALL_COL_TABLE_DOC = `# Heading

Some paragraph to push the table down away from the toolbar.

| Alpha | Beta |
| --- | --- |
| R1A | R1B |
| R2A | R2B |
| R3A | R3B |
| R4A | R4B |
| R5A | R5B |
| R6A | R6B |
| R7A | R7B |
| R8A | R8B |
`;

test('dragging a column: the ghost box matches the real column width and table height (bug 0716 round 2 #4 follow-up)', async ({
  page,
}) => {
  await openEditor(page, TALL_COL_TABLE_DOC);

  const headerCell = page.locator('th', { hasText: 'Alpha' });
  const headerBox = await headerCell.boundingBox();
  const table = page.locator('table');
  const tableBox = await table.boundingBox();
  if (!headerBox || !tableBox) {
    throw new Error('missing header/table bounding box');
  }

  await headerCell.hover();
  const colHandle = page.locator('.dd-col-handle');
  await expect(colHandle).toHaveCSS('display', 'flex');
  const handleBox = await colHandle.boundingBox();
  if (!handleBox) {
    throw new Error('missing col handle bounding box');
  }

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 10, { steps: 5 });

  const ghost = page.locator('.dd-ghost-table');
  await expect(ghost).toBeVisible();
  const ghostBox = await ghost.boundingBox();
  if (!ghostBox) {
    throw new Error('missing ghost bounding box');
  }
  // 2px tolerance for sub-pixel/DPI rounding between the two independent
  // getBoundingClientRect() reads (real header/table vs. the ghost), not a
  // deliberately loose bound — the ghost's inline style copies these values verbatim.
  expect(ghostBox.width).toBeGreaterThan(headerBox.width - 2);
  expect(ghostBox.width).toBeLessThan(headerBox.width + 2);
  expect(ghostBox.height).toBeGreaterThan(tableBox.height - 2);
  expect(ghostBox.height).toBeLessThan(tableBox.height + 2);

  await page.keyboard.press('Escape');
  await expect(ghost).toBeHidden();
});
