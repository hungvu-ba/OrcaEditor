/**
 * Bug General #1 / R3 #1: clicking a block/table handle opens the move menu anchored at the
 * click point (context-menu-at-cursor), not far below the whole block; it marks the whole block
 * as selected, and Delete/Backspace then removes the entire block. Needs real click + keyboard +
 * Selection API behavior — not reducible to a hand-built DOM snapshot (Plan/Archived/WEBVIEW_TEST.md).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

const DOC = `# Heading

Alpha paragraph.

Beta paragraph.

Gamma paragraph.
`;

// A single very tall (many-line-wrapping) paragraph: its handle spans the whole block, so a click
// at the handle's center is far above the block's bottom — the old block-rect anchoring opened the
// menu way down there, the R3 #1 fix opens it at the click.
const TALL_DOC = `# Heading

${'Long wrapping paragraph sentence. '.repeat(60)}

Tail paragraph.
`;

const TABLE_DOC = `# Heading

Paragraph before.

| Col A | Col B |
| --- | --- |
| a1 | b1 |

Paragraph after.
`;

const BLOCK_HANDLE_SELECTOR =
  '.dd-handle:not(.dd-li-handle):not(.dd-row-handle):not(.dd-col-handle):not(.dd-table-handle)';

/** Click (mousedown+up, no movement) a handle at its own center to open the menu. */
async function clickHandle(page: Page, handle: Locator): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error('handle has no bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

test('clicking the block handle opens the menu at the click point (not far below a tall block) and marks it selected without selecting text', async ({
  page,
}) => {
  await openEditor(page, TALL_DOC);
  const para = page.locator('p', { hasText: 'Long wrapping paragraph sentence.' });
  await para.hover();
  const handle = page.locator(BLOCK_HANDLE_SELECTOR);
  await expect(handle).toHaveCSS('display', 'flex');

  const handleBox = await handle.boundingBox();
  const blockBox = await para.boundingBox();
  if (!handleBox || !blockBox) {
    throw new Error('missing bounding box');
  }
  // Sanity: the block is tall enough that its center (where we click) is well above its bottom,
  // so anchoring at the click vs. at the block rect is measurably different (needs > ~88px for the
  // popup-top-vs-block-bottom assertion below to have margin).
  expect(blockBox.height).toBeGreaterThan(120);
  const clickY = handleBox.y + handleBox.height / 2;
  await clickHandle(page, handle);

  const popup = page.locator('.dd-menu-popup:visible');
  await expect(popup).toBeVisible();

  const popupBox = await popup.boundingBox();
  if (!popupBox) {
    throw new Error('missing bounding box');
  }
  // R3 #1: the popup opens at the click point — its top just below the cursor, or (if it had to
  // flip for lack of room below) its bottom just above the cursor — NEVER anchored down at the
  // whole block's bottom the way the old block-rect placement did.
  const openedBelow = Math.abs(popupBox.y - clickY) < 40;
  const openedAbove = Math.abs(popupBox.y + popupBox.height - clickY) < 40;
  expect(openedBelow || openedAbove).toBe(true);
  expect(popupBox.y).toBeLessThan(blockBox.y + blockBox.height - 40);

  // Selected state is the outline only — no native text selection over the block (bug General R2 #1).
  expect((await para.getAttribute('class')) ?? '').toContain('dd-hover-outline');
  const sel = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(sel).not.toContain('Long wrapping paragraph sentence.');
});

test('the block-handle menu near the top of the document never overlaps the sticky toolbar', async ({ page }) => {
  await openEditor(page, DOC);
  // Heading is the very first block, right under the sticky #toolbar — its menu flips above and
  // must be clamped below the toolbar (bug General R2 #4).
  const heading = page.locator('h1', { hasText: 'Heading' });
  await heading.hover();
  await clickHandle(page, page.locator(BLOCK_HANDLE_SELECTOR));
  await expect(page.locator('.dd-menu-popup:visible')).toBeVisible();

  const popupBox = await page.locator('.dd-menu-popup:visible').boundingBox();
  const toolbarBox = await page.locator('#toolbar').boundingBox();
  if (!popupBox || !toolbarBox) {
    throw new Error('missing bounding box');
  }
  expect(popupBox.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height - 1);
});

test('page scroll is frozen while a handle menu is open and works again once it closes', async ({ page }) => {
  // A tall doc so there is somewhere to scroll to.
  await openEditor(page, `# Heading\n\n${Array.from({ length: 60 }, (_, i) => `Para ${i}.`).join('\n\n')}\n`);
  const beta = page.locator('p', { hasText: 'Para 3.' });
  await beta.hover();
  await clickHandle(page, page.locator(BLOCK_HANDLE_SELECTOR));
  await expect(page.locator('.dd-menu-popup:visible')).toBeVisible();

  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(50);
  const during = await page.evaluate(() => window.scrollY);
  expect(during).toBe(before); // scroll blocked while the menu is open

  await page.keyboard.press('Escape');
  await expect(page.locator('.dd-menu-popup:visible')).toBeHidden();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(50);
  const after = await page.evaluate(() => window.scrollY);
  expect(after).toBeGreaterThan(before); // scroll works again after close
});

test('Delete while a block is selected removes the whole block from the document', async ({ page }) => {
  await openEditor(page, DOC);
  const beta = page.locator('p', { hasText: 'Beta paragraph.' });
  await beta.hover();
  await clickHandle(page, page.locator(BLOCK_HANDLE_SELECTOR));
  await expect(page.locator('.dd-menu-popup:visible')).toBeVisible();

  await clearPosted(page);
  await page.keyboard.press('Delete');

  const md = await waitForEdit(page);
  expect(md).not.toContain('Beta paragraph.');
  expect(md).toContain('Alpha paragraph.');
  expect(md).toContain('Gamma paragraph.');
  await expect(page.locator('.dd-menu-popup:visible')).toBeHidden();
});

test('Backspace via the table handle removes the whole table', async ({ page }) => {
  await openEditor(page, TABLE_DOC);
  const tableBox = await page.locator('table').boundingBox();
  if (!tableBox) {
    throw new Error('table has no bounding box');
  }
  // A couple px inside the table's own top-left corner surfaces the table-level handle.
  await page.mouse.move(tableBox.x + 2, tableBox.y + 2);
  await clickHandle(page, page.locator('.dd-table-handle'));
  await expect(page.locator('.dd-menu-popup:visible')).toBeVisible();

  await clearPosted(page);
  await page.keyboard.press('Backspace');

  const md = await waitForEdit(page);
  expect(md).not.toContain('| a1 | b1 |');
  expect(md).not.toContain('Col A');
  expect(md).toContain('Paragraph before.');
  expect(md).toContain('Paragraph after.');
});

test('with no handle menu open, Delete stays normal editing and does not remove a whole block', async ({
  page,
}) => {
  // Guards the isMenuOpen() gate on the new key handler: a plain caret Delete must behave as
  // usual (remove one character), never wipe the whole block.
  await openEditor(page, DOC);
  await page.locator('p', { hasText: 'Beta paragraph.' }).click();
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find((el) => el.textContent?.includes('Beta paragraph.'));
    const r = document.createRange();
    r.selectNodeContents(p!);
    r.collapse(true);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });

  await clearPosted(page);
  await page.keyboard.press('Delete');

  const md = await waitForEdit(page);
  // Block survives — only its first character is gone ("Beta" → "eta").
  expect(md).toContain('eta paragraph.');
  expect(md).toContain('Alpha paragraph.');
});

test('an arrow key closes the menu, so a later Delete does not wipe the tracked block', async ({ page }) => {
  // Review finding: the menu-open state must not keep hijacking Delete/Backspace after the user
  // has moved on, or a later keystroke silently deletes the whole tracked block.
  await openEditor(page, DOC);
  const beta = page.locator('p', { hasText: 'Beta paragraph.' });
  await beta.hover();
  await clickHandle(page, page.locator(BLOCK_HANDLE_SELECTOR));
  await expect(page.locator('.dd-menu-popup:visible')).toBeVisible();

  await page.keyboard.press('ArrowLeft'); // any non-Delete/Backspace/modifier key ends the mode
  await expect(page.locator('.dd-menu-popup:visible')).toBeHidden();

  await page.keyboard.press('Delete');
  // Menu already closed → the handle-delete path can't fire, so the block is NOT wiped.
  await expect(page.locator('p', { hasText: 'Beta paragraph.' })).toHaveCount(1);
  await expect(page.locator('p', { hasText: 'Alpha paragraph.' })).toHaveCount(1);
});

test('deleting the only block leaves an editable paragraph (caret host preserved)', async ({ page }) => {
  // Review finding: a plain single-paragraph doc has no trailing caret-trap <p>, so deleting its
  // only block must re-seed a typable paragraph, or typing lands as a bare text node under #content.
  await openEditor(page, 'Only paragraph.\n');
  const only = page.locator('p', { hasText: 'Only paragraph.' });
  await only.hover();
  await clickHandle(page, page.locator(BLOCK_HANDLE_SELECTOR));
  await expect(page.locator('.dd-menu-popup:visible')).toBeVisible();
  await page.keyboard.press('Delete');
  await page.keyboard.type('fresh text');

  // Caret host preserved: the typed text lands inside a <p> block, never as a bare text node
  // directly under #content, and the deleted block is gone.
  const dom = await page.evaluate(() => {
    const c = document.getElementById('content')!;
    return {
      inParagraph: [...c.children].some((el) => el.tagName === 'P' && (el.textContent ?? '').includes('fresh text')),
      bareText: [...c.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== ''),
      hasOnly: (c.textContent ?? '').includes('Only paragraph.'),
    };
  });
  expect(dom.hasOnly).toBe(false);
  expect(dom.bareText).toBe(false);
  expect(dom.inParagraph).toBe(true);

  // And it round-trips to markdown: wait for the edit that reflects the typed text.
  const md = await page.waitForFunction(() => {
    const last = (window as unknown as { __posted: Array<{ type: string; text: string }> }).__posted
      .filter((m) => m.type === 'edit')
      .at(-1);
    return last && last.text.includes('fresh text') ? last.text : null;
  });
  expect(await md.jsonValue()).not.toContain('Only paragraph.');
});
