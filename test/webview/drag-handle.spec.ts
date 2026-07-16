/**
 * Playwright coverage for bug 0716 (drag-handle group): mutual exclusion
 * between the block handle and the li handle (#3), click-vs-drag on the block
 * handle — a click opens the menu, a drag past the threshold still reorders
 * (#5), hover-vs-mousedown timing for `.dd-hover-outline`/`.dd-hover-outline-
 * cell` (#6), and the table's row+column dual-handle display staying
 * unchanged. None of these are reducible to a hand-built DOM snapshot
 * (test/roundtrip/) — they all depend on real mousemove/mousedown event
 * dispatch (Plan/WEBVIEW_TEST.md).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { openEditor, waitForEdit } from './_harness';

const DOC = `# Heading

Alpha paragraph.

Beta paragraph.

- Parent item
  - Nested item
- Sibling item

| Col A | Col B |
| --- | --- |
| a1 | b1 |
`;

/** A flat ordered list — its wide numeric markers ("1." … "3.") make the old handle-over-the-
 * marker overlap most visible, and it has no nesting, so the "outermost item" is depth-0. */
const ORDERED_DOC = `# Heading

1. First item
2. Second item
3. Third item

Tail paragraph.
`;

/** The plain block handle only ever carries the base class — the li/row/col handles each
 * add a second class on top of it (see drag-drop.ts/table.ts handle setup). */
const BLOCK_HANDLE_SELECTOR = '.dd-handle:not(.dd-li-handle):not(.dd-row-handle):not(.dd-col-handle):not(.dd-table-handle)';

async function hoverCenter(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('locator has no bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

async function classListOf(locator: Locator): Promise<string> {
  return (await locator.getAttribute('class')) ?? '';
}

test('hovering a nested <li> shows only the li handle, never the block handle', async ({ page }) => {
  await openEditor(page, DOC);
  await hoverCenter(page, page.locator('li', { hasText: 'Nested item' }).last());

  const liHandle = page.locator('.dd-li-handle');
  await expect(liHandle).toHaveCSS('display', 'flex');
  await expect(page.locator(BLOCK_HANDLE_SELECTOR)).toHaveCSS('display', 'none');

  // Marker clearance for a NESTED item: the handle sits snug just left of the child's OWN
  // marker (right edge ~LI_HANDLE_MARKER_GAP_PX left of the child's content edge), and is still
  // inside the inner list's gutter (right of the inner <ul>'s left edge) — NOT pushed out to
  // the inner list's left edge (which put it in the parent's marker column, far from the
  // child's own bullet). 26 = LI_HANDLE_MARKER_GAP_PX (drag-drop.ts).
  const handleBox = await liHandle.boundingBox();
  const nestedBox = await page.locator('li', { hasText: 'Nested item' }).last().boundingBox();
  const innerListBox = await page.locator('ul ul').boundingBox();
  if (!handleBox || !nestedBox || !innerListBox) {
    throw new Error('missing bounding box');
  }
  expect(Math.round(handleBox.x + handleBox.width)).toBe(Math.round(nestedBox.x - 26));
  expect(handleBox.x + handleBox.width).toBeGreaterThan(innerListBox.x);
});

test('hovering a depth-0 <li> also shows only the li handle (narrows the old both-show behavior)', async ({
  page,
}) => {
  await openEditor(page, DOC);
  await hoverCenter(page, page.locator('li', { hasText: 'Sibling item' }));

  await expect(page.locator('.dd-li-handle')).toHaveCSS('display', 'flex');
  await expect(page.locator(BLOCK_HANDLE_SELECTOR)).toHaveCSS('display', 'none');
});

test('the li handle sits snug just left of the marker, not out at the list edge', async ({ page }) => {
  await openEditor(page, ORDERED_DOC);
  const item = page.locator('li', { hasText: 'Second item' });
  await hoverCenter(page, item);

  const handle = page.locator('.dd-li-handle');
  await expect(handle).toHaveCSS('display', 'flex');
  const handleBox = await handle.boundingBox();
  const itemBox = await item.boundingBox();
  const listBox = await page.locator('ol').boundingBox();
  if (!handleBox || !itemBox || !listBox) {
    throw new Error('missing bounding box');
  }
  // Snug: right edge ~LI_HANDLE_MARKER_GAP_PX (26) left of the item's OWN content edge — just
  // left of the right-aligned number, never on top of it (anchoring at `li.left` did that).
  // And strictly inside the marker gutter (right of the <ol>'s own left edge) — NOT pushed out
  // to the list edge (which put a nested item's handle in the parent's column). 26 =
  // LI_HANDLE_MARKER_GAP_PX (drag-drop.ts).
  expect(Math.round(handleBox.x + handleBox.width)).toBe(Math.round(itemBox.x - 26));
  expect(handleBox.x + handleBox.width).toBeGreaterThan(listBox.x);
});

test('on a narrow-gutter task list the handle is clamped to the list edge, not flung off-screen', async ({
  page,
}) => {
  // A task list uses a much smaller left padding (~1.2em) than an ordinary list's 40px, so
  // `li.left - LI_HANDLE_MARKER_GAP_PX` would fall LEFT of the list's own edge — and, at a
  // small left reserve, off the left of the viewport. `liHandleAnchorLeft` clamps to the
  // enclosing list's left edge so the handle stays grabbable.
  await openEditor(page, `# Heading\n\n- [ ] First task\n- [ ] Second task\n`);
  const item = page.locator('li', { hasText: 'Second task' });
  await hoverCenter(page, item);

  const handle = page.locator('.dd-li-handle');
  await expect(handle).toHaveCSS('display', 'flex');
  const handleBox = await handle.boundingBox();
  const listBox = await page.locator('ul').first().boundingBox();
  if (!handleBox || !listBox) {
    throw new Error('missing bounding box');
  }
  // Clamped: right edge at (not left of) the list's own left edge — without the clamp it would
  // sit ~7px further left (li.left − 26 < list.left for a task list). And on-screen.
  expect(handleBox.x + handleBox.width).toBeGreaterThanOrEqual(listBox.x - 1);
  expect(handleBox.x).toBeGreaterThanOrEqual(0);
});

test('parent and child handles use the identical snug-to-own-marker offset (consistent per-level rhythm)', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const handle = page.locator('.dd-li-handle');
  const parentLi = page.locator('li', { hasText: 'Parent item' }).first();
  const nestedLi = page.locator('li', { hasText: 'Nested item' }).last();
  const parentBox = await parentLi.boundingBox();
  const nestedBox = await nestedLi.boundingBox();
  if (!parentBox || !nestedBox) {
    throw new Error('missing bounding box');
  }

  // Hover the parent's OWN first line (its bounding box spans the whole subtree).
  await page.mouse.move(parentBox.x + parentBox.width / 2, parentBox.y + 5);
  const parentHandle = await handle.boundingBox();
  await hoverCenter(page, nestedLi);
  const childHandle = await handle.boundingBox();
  if (!parentHandle || !childHandle) {
    throw new Error('missing handle box');
  }

  // Each handle sits the SAME gap left of its own item's content edge — so the parent handle is
  // balanced against its child group exactly as the child handle is against its own marker, one
  // indent step apart (child handle further right, nearer its own deeper number).
  const parentOffset = parentBox.x - (parentHandle.x + parentHandle.width);
  const childOffset = nestedBox.x - (childHandle.x + childHandle.width);
  expect(Math.round(childOffset)).toBe(Math.round(parentOffset));
  expect(childHandle.x).toBeGreaterThan(parentHandle.x);
});

test('parent and child handles are a uniform height, each aligned to its own item top (not subtree-tall)', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const handle = page.locator('.dd-li-handle');
  const parentLi = page.locator('li', { hasText: 'Parent item' }).first();
  const nestedLi = page.locator('li', { hasText: 'Nested item' }).last();
  const parentBox = await parentLi.boundingBox();
  const nestedBox = await nestedLi.boundingBox();
  if (!parentBox || !nestedBox) {
    throw new Error('missing bounding box');
  }

  // Parent handle (hover the parent's OWN first line).
  await page.mouse.move(parentBox.x + parentBox.width / 2, parentBox.y + 5);
  const parentHandle = await handle.boundingBox();
  await hoverCenter(page, nestedLi);
  const childHandle = await handle.boundingBox();
  if (!parentHandle || !childHandle) {
    throw new Error('missing handle box');
  }

  // Uniform height, and each handle top-aligned to its OWN item's row — the parent handle no
  // longer spans its whole subtree (which made its centered glyph float over the children).
  expect(Math.round(parentHandle.height)).toBe(Math.round(childHandle.height));
  expect(Math.round(parentHandle.y)).toBe(Math.round(parentBox.y));
  expect(Math.round(childHandle.y)).toBe(Math.round(nestedBox.y));
  // The parent has a nested child, so its full <li> box is taller than its own-content handle.
  expect(parentHandle.height).toBeLessThan(parentBox.height);
});

test('a parent item with no own text (only a nested list) still shows a clamped, grabbable handle', async ({
  page,
}) => {
  // The first `-` has no own text, only a nested list — its own-content height is ~0, so the
  // handle must clamp to LI_HANDLE_MIN_HEIGHT_PX (20) rather than collapse to a zero sliver.
  await openEditor(page, `# Heading\n\n-\n  - Only child\n- Sibling\n`);
  const child = page.locator('li', { hasText: 'Only child' }).last();
  const handle = page.locator('.dd-li-handle');
  await hoverCenter(page, child);
  const hb = await handle.boundingBox();
  const childBox = await child.boundingBox();
  if (!hb || !childBox) {
    throw new Error('missing bounding box');
  }
  // Step onto the child handle, then slide left to climb to the empty parent.
  const y = childBox.y + childBox.height / 2;
  await page.mouse.move(hb.x + hb.width / 2, y);
  await page.mouse.move(Math.max(0, hb.x - 6), y);

  const after = await handle.boundingBox();
  if (!after) {
    throw new Error('handle disappeared');
  }
  // Grabbable: at least the clamp minimum (not ~0).
  expect(after.height).toBeGreaterThanOrEqual(20 - 1);
});

test('dragging a list item by its own handle reorders it', async ({ page }) => {
  // Exercises AC #4 (a drag via the li handle still moves the item) AND that the now-shorter
  // handle is genuinely grabbable.
  await openEditor(page, `# Heading\n\n- Apple\n- Banana\n- Cherry\n`);
  const apple = page.locator('li', { hasText: 'Apple' });
  await hoverCenter(page, apple);
  const hb = await page.locator('.dd-li-handle').boundingBox();
  const cherryBox = await page.locator('li', { hasText: 'Cherry' }).boundingBox();
  if (!hb || !cherryBox) {
    throw new Error('missing bounding box');
  }
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, cherryBox.y + cherryBox.height + 6, { steps: 8 });
  await page.mouse.up();

  const md = await waitForEdit(page);
  expect(md.indexOf('Apple')).toBeGreaterThan(md.indexOf('Banana'));
});

test('dragging a list item both vertically and horizontally moves it to a different depth in the same list (cross-level drag, US-17.7 M6)', async ({
  page,
}) => {
  // The point of the cross-level move: a vertical reorder AND a horizontal depth change land in
  // ONE drop gesture, not two separate ones (M3's old either/or). Dragging "Apple" below "Cherry"
  // while also moving right past LIST_INDENT_THRESHOLD_PX (32px) nests it as Cherry's own child.
  await openEditor(page, `# Heading\n\n- Apple\n- Banana\n  - Banana child\n- Cherry\n`);
  const apple = page.locator('li', { hasText: 'Apple' });
  await hoverCenter(page, apple);
  const hb = await page.locator('.dd-li-handle').boundingBox();
  const cherryBox = await page.locator('li', { hasText: 'Cherry' }).boundingBox();
  if (!hb || !cherryBox) {
    throw new Error('missing bounding box');
  }
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 40, cherryBox.y + cherryBox.height + 6, { steps: 8 });
  await page.mouse.up();

  const md = await waitForEdit(page);
  // Apple landed as Cherry's own child — after Cherry in document order, indented one level.
  expect(md.indexOf('Cherry')).toBeLessThan(md.indexOf('Apple'));
  const appleLine = md.split('\n').find((l) => l.includes('Apple'));
  expect(appleLine).toMatch(/^\s+-\s+Apple/);
  // Banana's own pre-existing subtree is untouched by Apple's move.
  expect(md).toContain('Banana child');
});

test('dragging a list item back to its own original position is a safe no-op (does not crash the drag state machine)', async ({
  page,
}) => {
  // Regression for US-17.7 M6: releasing a cross-level drag at (or near) the dragged item's own
  // current position used to resolve `beforeEl` to the dragged item itself, which
  // `applyLiReparentMove`'s `deleteContents()` then detached before `setStartBefore` tried to use
  // it as a reference — an uncaught DOMException that deleted the item and left the drag state
  // machine stuck at 'dragging'. "Apple" is the root list's first item, so releasing just past
  // the 4px drag threshold without crossing into another row reproduces gap 0 exactly.
  await openEditor(page, `# Heading\n\n- Apple\n- Banana\n- Cherry\n`);
  const apple = page.locator('li', { hasText: 'Apple' });
  const liHandle = page.locator('.dd-li-handle');
  await hoverCenter(page, apple);
  await liHandle.waitFor({ state: 'visible' });
  const hb = await liHandle.boundingBox();
  if (!hb) {
    throw new Error('missing bounding box');
  }
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 6, { steps: 4 });
  await page.mouse.up();

  // No data loss — all three items survive, original order.
  const items = await page.locator('li').allTextContents();
  expect(items).toEqual(['Apple', 'Banana', 'Cherry']);

  // The drag state machine isn't stuck — a real drag right after this still works.
  await hoverCenter(page, apple);
  await liHandle.waitFor({ state: 'visible' });
  const hb2 = await liHandle.boundingBox();
  const cherryBox = await page.locator('li', { hasText: 'Cherry' }).boundingBox();
  if (!hb2 || !cherryBox) {
    throw new Error('missing bounding box');
  }
  await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb2.x + hb2.width / 2, cherryBox.y + cherryBox.height + 6, { steps: 8 });
  await page.mouse.up();
  const md = await waitForEdit(page);
  expect(md.indexOf('Apple')).toBeGreaterThan(md.indexOf('Banana'));
});

test('pressing Escape mid cross-level drag cancels with no DOM change', async ({ page }) => {
  await openEditor(page, `# Heading\n\n- Apple\n- Banana\n  - Banana child\n- Cherry\n`);
  const apple = page.locator('li', { hasText: 'Apple' });
  await hoverCenter(page, apple);
  await page.locator('.dd-li-handle').waitFor({ state: 'visible' });
  const hb = await page.locator('.dd-li-handle').boundingBox();
  const cherryBox = await page.locator('li', { hasText: 'Cherry' }).boundingBox();
  if (!hb || !cherryBox) {
    throw new Error('missing bounding box');
  }
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 40, cherryBox.y + cherryBox.height + 6, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();

  // `<li>.textContent` includes nested descendants, so strip each item's own nested list before
  // reading its text — otherwise "Banana" would read as "BananaBanana child".
  const ownTexts = await page.locator('#content').evaluate((root) =>
    Array.from(root.querySelectorAll('li')).map((li) => {
      const clone = li.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('ul, ol').forEach((n) => n.remove());
      return clone.textContent?.trim();
    })
  );
  expect(ownTexts).toEqual(['Apple', 'Banana', 'Banana child', 'Cherry']);
});

test('a pure horizontal drag (no vertical move) still indents the item one level under the previous item, matching the old in-place M3 behavior', async ({
  page,
}) => {
  await openEditor(page, `# Heading\n\n- Apple\n- Banana\n- Cherry\n`);
  const banana = page.locator('li', { hasText: 'Banana' });
  await hoverCenter(page, banana);
  const liHandle = page.locator('.dd-li-handle');
  await liHandle.waitFor({ state: 'visible' });
  const hb = await liHandle.boundingBox();
  if (!hb) {
    throw new Error('missing bounding box');
  }
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 40, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();

  const md = await waitForEdit(page);
  const bananaLine = md.split('\n').find((l) => l.includes('Banana'));
  expect(bananaLine).toMatch(/^\s+-\s+Banana/);
  expect(md.indexOf('Apple')).toBeLessThan(md.indexOf('Banana'));
});

test('a mousedown in a parent handle gutter at a CHILD row still arms the parent drag (tall invisible hit zone)', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const parentLi = page.locator('li', { hasText: 'Parent item' }).first();
  const nestedLi = page.locator('li', { hasText: 'Nested item' }).last();
  const siblingLi = page.locator('li', { hasText: 'Sibling item' });
  const parentBox = await parentLi.boundingBox();
  const nestedBox = await nestedLi.boundingBox();
  const siblingBox = await siblingLi.boundingBox();
  if (!parentBox || !nestedBox || !siblingBox) {
    throw new Error('missing bounding box');
  }

  // The parent handle is drawn only at the parent's OWN row; get its x by hovering that row.
  await page.mouse.move(parentBox.x + parentBox.width / 2, parentBox.y + 5);
  const ph = await page.locator('.dd-li-handle').boundingBox();
  if (!ph) {
    throw new Error('parent handle missing');
  }

  // Press in the parent's handle COLUMN but down at the NESTED child's row — the spot where the
  // drawn glyph is NOT (it's up at the parent's row). The tall hit zone must still arm the
  // parent's drag; dragging below the sibling moves the parent AND its nested child.
  const gx = ph.x + ph.width / 2;
  await page.mouse.move(gx, nestedBox.y + nestedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gx, siblingBox.y + siblingBox.height + 10, { steps: 8 });
  await page.mouse.up();

  const md = await waitForEdit(page);
  expect(md.indexOf('Parent item')).toBeGreaterThan(md.indexOf('Sibling item'));
  expect(md).toContain('Nested item');
});

test('a cold jump into any point of a nested <li>\'s own handle band resolves to that item, not its parent (bug 0716 round 2, #2)', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const nestedLi = page.locator('li', { hasText: 'Nested item' }).last();
  const siblingLi = page.locator('li', { hasText: 'Sibling item' });
  const handle = page.locator('.dd-li-handle');

  // Capture the CORRECT handle box for the nested item via a genuine hover, and compare
  // every cold-jump result against it directly (x, y, AND height) — a height-only check is a
  // weak proxy that could coincidentally match the wrong <li> in a different document shape.
  await hoverCenter(page, nestedLi);
  const expectedBox = await handle.boundingBox();
  const nestedBox = await nestedLi.boundingBox();
  if (!expectedBox || !nestedBox) {
    throw new Error('missing bounding box');
  }

  // A point left of a nested <li>'s own content — including its reserved handle band — can
  // land on the enclosing <ul>'s own padding box, or (a narrow sliver) the <li>'s own marker
  // glyph, depending on exactly where in that band the cursor is. A single COLD jump there
  // (no prior hover on this item — the handle isn't pre-rendered/intercepting yet, unlike a
  // slow drag in from the item's own content) used to resolve most of that band to the
  // PARENT <li> instead, because a plain `.closest('li')` on the <ul>/marker hit skips
  // straight past the nested item to whichever ancestor <li> wraps the whole list.
  const y = nestedBox.y + nestedBox.height / 2;
  for (let offset = 2; offset <= 20; offset += 2) {
    const x = Math.round(nestedBox.x - offset);
    await hoverCenter(page, siblingLi); // reset hover state before each cold jump
    await page.mouse.move(x, y);
    const handleBox = await handle.boundingBox();
    if (!handleBox) {
      throw new Error(`li handle missing at x=${x} (offset ${offset})`);
    }
    expect(Math.round(handleBox.x), `handle x at offset=${offset}`).toBe(Math.round(expectedBox.x));
    expect(Math.round(handleBox.y), `handle y at offset=${offset}`).toBe(Math.round(expectedBox.y));
    expect(Math.round(handleBox.height), `handle height at offset=${offset}`).toBe(Math.round(expectedBox.height));
  }
});

test('a cold jump just left of a nested <li>\'s own handle band reaches the parent (bug 0715 #8 no regression)', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const parentLi = page.locator('li', { hasText: 'Parent item' }).first();
  const nestedLi = page.locator('li', { hasText: 'Nested item' }).last();
  const siblingLi = page.locator('li', { hasText: 'Sibling item' });
  const handle = page.locator('.dd-li-handle');

  const nestedBox = await nestedLi.boundingBox();
  const parentBox = await parentLi.boundingBox();
  if (!nestedBox || !parentBox) {
    throw new Error('missing bounding box');
  }

  // Capture the nested item's OWN handle box — its left edge is the start of the child's band
  // (anchored to the nested list's own left edge). A point left of THAT is genuinely past the
  // child's band, derived from measured geometry rather than a hardcoded indent width.
  await hoverCenter(page, nestedLi);
  const nestedHandleBox = await handle.boundingBox();
  if (!nestedHandleBox) {
    throw new Error('nested li handle missing');
  }
  // Capture the CORRECT handle box for the parent via a genuine hover on its own (first) line
  // — the parent's own bounding box spans its whole subtree, so hover a point inside its text.
  await page.mouse.move(parentBox.x + parentBox.width / 2, parentBox.y + 5);
  const expectedBox = await handle.boundingBox();
  if (!expectedBox) {
    throw new Error('parent li handle missing');
  }

  // A few px LEFT of the nested item's own handle, at the nested row's y — a cold jump there
  // must resolve to the PARENT, not the child (still inside #content, so `mousemove` fires).
  await hoverCenter(page, siblingLi);
  const x = Math.max(0, Math.round(nestedHandleBox.x - 5));
  await page.mouse.move(x, nestedBox.y + nestedBox.height / 2);

  const handleBox = await handle.boundingBox();
  if (!handleBox) {
    throw new Error('li handle disappeared');
  }
  expect(Math.round(handleBox.x)).toBe(Math.round(expectedBox.x));
  expect(Math.round(handleBox.height)).toBe(Math.round(expectedBox.height));
});

test('a cursor in the gap between two loose (blank-line-separated) nested list items resolves to one of them, not the ancestor', async ({
  page,
}) => {
  // A "loose" list (blank line between items) wraps each item's content in its own <p>,
  // whose own margin (markdown.css) opens real vertical space between sibling <li> rows —
  // unlike the tight list used elsewhere in this file, where rows sit flush with no gap.
  const LOOSE_DOC = `# Heading

- Parent item

  - Nested item 1

  - Nested item 2

- Sibling item
`;
  await openEditor(page, LOOSE_DOC);
  const parentLi = page.locator('li', { hasText: 'Parent item' }).first();
  // .last() picks the actual nested <li>, not the outer "Parent item" <li> (whose own text
  // content also contains "Nested item N" via its descendant) — same pattern as elsewhere in
  // this file.
  const nested1 = page.locator('li', { hasText: 'Nested item 1' }).last();
  const nested2 = page.locator('li', { hasText: 'Nested item 2' }).last();
  const siblingLi = page.locator('li', { hasText: 'Sibling item' });
  const parentBox = await parentLi.boundingBox();
  const box1 = await nested1.boundingBox();
  const box2 = await nested2.boundingBox();
  if (!parentBox || !box1 || !box2) {
    throw new Error('missing bounding box');
  }

  const gapY = (box1.y + box1.height + box2.y) / 2;
  const x = Math.round(box1.x - 10);
  await hoverCenter(page, siblingLi);
  await page.mouse.move(x, gapY);

  const handleBox = await page.locator('.dd-li-handle').boundingBox();
  if (!handleBox) {
    throw new Error('li handle missing in the inter-item gap');
  }
  // Must resolve to one of the two nested items (whichever row is vertically nearer), never
  // silently fall back to the ancestor "Parent item" <li> (bug 0716 round 2, #2 resurfacing in
  // the gap band). Handles are now a uniform own-content height at each item's OWN top, so
  // assert by ROW: the handle sits at a nested item's row (>= the first nested row's top), not
  // up at the parent's own row above it — a height check no longer discriminates.
  expect(handleBox.y).toBeGreaterThanOrEqual(Math.round(box1.y) - 1);
  expect(handleBox.y).toBeLessThan(Math.round(parentBox.y + parentBox.height));
});

test('leaving #content leftward past the outermost item surfaces the whole-list block handle', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const nestedLi = page.locator('li', { hasText: 'Nested item' }).last();
  const handle = page.locator('.dd-li-handle');
  const nestedBox = await nestedLi.boundingBox();
  const listBox = await page.locator('ul').first().boundingBox();
  if (!nestedBox || !listBox) {
    throw new Error('missing bounding box');
  }

  await hoverCenter(page, nestedLi);
  const initialHandleBox = await handle.boundingBox();
  if (!initialHandleBox) {
    throw new Error('li handle missing after hover');
  }
  expect(Math.round(initialHandleBox.height)).toBe(Math.round(nestedBox.height));

  // `mousemove` (and findLiAt's own ancestor climb) never fires once the cursor has left
  // #content's own rendered box -- only #content's `mouseleave` does. A point this far left is
  // outside #content and past EVERY ancestor's band, so the climb runs out of <li> ancestors
  // and returns null: the li handle hides and the whole top-level <ul> block handle takes over.
  await page.mouse.move(-50, nestedBox.y + nestedBox.height / 2);

  await expect(handle).toHaveCSS('display', 'none');
  const blockHandle = page.locator(BLOCK_HANDLE_SELECTOR);
  await expect(blockHandle).toHaveCSS('display', 'flex');
  const blockBox = await blockHandle.boundingBox();
  if (!blockBox) {
    throw new Error('block handle missing');
  }
  expect(Math.round(blockBox.height)).toBe(Math.round(listBox.height));
});

test('moving gradually left OFF the li handle (not a single jump) still surfaces the whole-list block handle', async ({
  page,
}) => {
  // Real interaction, unlike the single-jump tests above: hover the item, step ONTO its own
  // handle, THEN move left off it. Stepping onto the handle is what makes #content fire its
  // mouseleave with relatedTarget = the handle (early-return, state kept); moving further left
  // off the handle does NOT fire #content's mouseleave again (the cursor already left #content
  // when it moved onto the handle). The li handle must still hand off to the whole-list block
  // handle here — otherwise "move left off the handle → nothing shows" (user report).
  await openEditor(page, ORDERED_DOC);
  const item = page.locator('li', { hasText: 'Second item' });
  await hoverCenter(page, item);
  const liHandle = page.locator('.dd-li-handle');
  await expect(liHandle).toHaveCSS('display', 'flex');
  const hb = await liHandle.boundingBox();
  const itemBox = await item.boundingBox();
  if (!hb || !itemBox) {
    throw new Error('missing bounding box');
  }

  const y = itemBox.y + itemBox.height / 2;
  await page.mouse.move(hb.x + hb.width / 2, y); // step onto the handle
  await page.mouse.move(Math.max(0, hb.x - 6), y); // then left off it

  await expect(liHandle).toHaveCSS('display', 'none');
  await expect(page.locator(BLOCK_HANDLE_SELECTOR)).toHaveCSS('display', 'flex');
});

test('moving gradually left OFF a nested child handle reveals the parent handle', async ({ page }) => {
  await openEditor(page, DOC);
  const nestedLi = page.locator('li', { hasText: 'Nested item' }).last();
  const parentLi = page.locator('li', { hasText: 'Parent item' }).first();
  const handle = page.locator('.dd-li-handle');
  const nestedBox = await nestedLi.boundingBox();
  const parentBox = await parentLi.boundingBox();
  if (!nestedBox || !parentBox) {
    throw new Error('missing bounding box');
  }

  // Capture the expected parent handle (hover the parent's own first line).
  await page.mouse.move(parentBox.x + parentBox.width / 2, parentBox.y + 5);
  const expectedParent = await handle.boundingBox();

  await hoverCenter(page, nestedLi);
  const hb = await handle.boundingBox();
  if (!hb || !expectedParent) {
    throw new Error('missing handle box');
  }

  // Step onto the child handle, then slide left off it — must hand off to the PARENT handle
  // (this exit re-enters #content, so onContentHover resolves it; the handle's own mouseleave
  // must NOT clobber that).
  const y = nestedBox.y + nestedBox.height / 2;
  await page.mouse.move(hb.x + hb.width / 2, y);
  await page.mouse.move(Math.max(0, hb.x - 6), y);

  const after = await handle.boundingBox();
  if (!after) {
    throw new Error('li handle disappeared');
  }
  expect(Math.round(after.x)).toBe(Math.round(expectedParent.x));
  expect(Math.round(after.height)).toBe(Math.round(expectedParent.height));
});

test('leaving #content leftward from a depth-0 item also surfaces the whole-list block handle', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const siblingLi = page.locator('li', { hasText: 'Sibling item' });
  const handle = page.locator('.dd-li-handle');
  const siblingBox = await siblingLi.boundingBox();
  const listBox = await page.locator('ul').first().boundingBox();
  if (!siblingBox || !listBox) {
    throw new Error('missing bounding box');
  }

  await hoverCenter(page, siblingLi);
  await expect(handle).toHaveCSS('display', 'flex');

  // A depth-0 item has no ancestor <li>; moving far left (outside #content) past its band still
  // climbs "out" — climbLiFrom returns null and the whole-list block handle takes over, rather
  // than freezing on the item. Coordinates aren't clamped under Playwright/CDP, so a negative x
  // reliably lands outside the viewport.
  await page.mouse.move(-50, siblingBox.y + siblingBox.height / 2);

  await expect(handle).toHaveCSS('display', 'none');
  const blockHandle = page.locator(BLOCK_HANDLE_SELECTOR);
  await expect(blockHandle).toHaveCSS('display', 'flex');
  const blockBox = await blockHandle.boundingBox();
  if (!blockBox) {
    throw new Error('block handle missing');
  }
  expect(Math.round(blockBox.height)).toBe(Math.round(listBox.height));
});

test('the surfaced whole-list block handle drags the entire flat list as one block', async ({ page }) => {
  await openEditor(page, ORDERED_DOC);
  const item = page.locator('li', { hasText: 'Second item' });
  await hoverCenter(page, item);
  const itemBox = await item.boundingBox();
  if (!itemBox) {
    throw new Error('missing bounding box');
  }

  // Surface the whole-list block handle by moving left out of #content.
  await page.mouse.move(-50, itemBox.y + itemBox.height / 2);
  const blockHandle = page.locator(BLOCK_HANDLE_SELECTOR);
  await expect(blockHandle).toHaveCSS('display', 'flex');
  const handleBox = await blockHandle.boundingBox();
  const tailBox = await page.locator('p', { hasText: 'Tail paragraph.' }).boundingBox();
  if (!handleBox || !tailBox) {
    throw new Error('missing bounding box');
  }

  // Drag it below the tail paragraph — the whole <ol> moves as one top-level block.
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, tailBox.y + tailBox.height + 10, { steps: 10 });
  await page.mouse.up();

  const md = await waitForEdit(page);
  expect(md.indexOf('Tail paragraph.')).toBeLessThan(md.indexOf('First item'));
});

test('the block handle survives a mouse move that jumps clean past it in one sampled step', async ({ page }) => {
  await openEditor(page, DOC);
  const heading = page.locator('h1', { hasText: 'Heading' });
  await hoverCenter(page, heading);

  const handle = page.locator(BLOCK_HANDLE_SELECTOR);
  await expect(handle).toHaveCSS('display', 'flex');
  const handleBox = await handle.boundingBox();
  const headingBox = await heading.boundingBox();
  if (!handleBox || !headingBox) {
    throw new Error('missing bounding box');
  }

  // A single-step jump (Playwright's default — no interpolation) from inside the heading
  // text straight to a point well past the handle's own left edge, at the same vertical
  // position. This models a real OS mouse-move sample that never actually crossed the
  // handle's rect mid-flight — the handle must not disappear just because no intermediate
  // event landed on it (bug 0716 #4 follow-up: "hover area must count the handle's own
  // area, and the space en route to it").
  await page.mouse.move(Math.max(0, handleBox.x - 15), headingBox.y + headingBox.height / 2);
  await expect(handle).toHaveCSS('display', 'flex');
});

test('a click (no movement) on the block handle opens the menu with Move up / Move down', async ({ page }) => {
  await openEditor(page, DOC);
  await hoverCenter(page, page.locator('p', { hasText: 'Alpha paragraph.' }));

  const handle = page.locator(BLOCK_HANDLE_SELECTOR);
  await expect(handle).toHaveCSS('display', 'flex');
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error('block handle has no bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  const popup = page.locator('.dd-menu-popup:visible');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.dd-menu-item', { hasText: 'Move up' })).toHaveCount(1);
  await expect(popup.locator('.dd-menu-item', { hasText: 'Move down' })).toHaveCount(1);
});

test('dragging the block handle past the threshold still reorders the block', async ({ page }) => {
  await openEditor(page, DOC);
  await hoverCenter(page, page.locator('p', { hasText: 'Alpha paragraph.' }));

  const handleBox = await page.locator(BLOCK_HANDLE_SELECTOR).boundingBox();
  const betaBox = await page.locator('p', { hasText: 'Beta paragraph.' }).boundingBox();
  if (!handleBox || !betaBox) {
    throw new Error('missing bounding box');
  }

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, betaBox.y + betaBox.height + 10, { steps: 10 });
  await page.mouse.up();

  const md = await waitForEdit(page);
  expect(md.indexOf('Beta paragraph.')).toBeLessThan(md.indexOf('Alpha paragraph.'));
});

test('plain hover never adds .dd-hover-outline anywhere, mousedown on a handle does', async ({ page }) => {
  await openEditor(page, DOC);

  const alpha = page.locator('p', { hasText: 'Alpha paragraph.' });
  await hoverCenter(page, alpha);
  await expect(page.locator(BLOCK_HANDLE_SELECTOR)).toHaveCSS('display', 'flex');
  expect(await classListOf(alpha)).not.toContain('dd-hover-outline');

  const nestedLi = page.locator('li', { hasText: 'Nested item' }).last();
  await hoverCenter(page, nestedLi);
  expect(await classListOf(nestedLi)).not.toContain('dd-hover-outline');

  const cell = page.locator('td', { hasText: 'a1' });
  await hoverCenter(page, cell);
  const row = page.locator('tbody tr', { hasText: 'a1' });
  expect(await classListOf(row)).not.toContain('dd-hover-outline');
  expect(await classListOf(cell)).not.toContain('dd-hover-outline-cell');

  // Mousedown on the block handle DOES add the outline (armDrag). Releasing without moving
  // is a click, which opens the handle menu (bug 0716 #5) — the outline must stay on the
  // block for as long as that menu is open (bug 0716 #6 extended to the click-to-menu
  // path), then clear once the menu is dismissed.
  await hoverCenter(page, alpha);
  const handleBox = await page.locator(BLOCK_HANDLE_SELECTOR).boundingBox();
  if (!handleBox) {
    throw new Error('block handle has no bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  expect(await classListOf(alpha)).toContain('dd-hover-outline');
  await page.mouse.up();

  await expect(page.locator('.dd-menu-popup:visible')).toBeVisible();
  expect(await classListOf(alpha)).toContain('dd-hover-outline');

  await page.keyboard.press('Escape');
  await expect(page.locator('.dd-menu-popup:visible')).toBeHidden();
  expect(await classListOf(alpha)).not.toContain('dd-hover-outline');
});

test('mousedown on the li, row, and column handles adds their own outline classes', async ({ page }) => {
  await openEditor(page, DOC);

  const nestedLi = page.locator('li', { hasText: 'Nested item' }).last();
  await hoverCenter(page, nestedLi);
  const liHandleBox = await page.locator('.dd-li-handle').boundingBox();
  if (!liHandleBox) {
    throw new Error('li handle has no bounding box');
  }
  await page.mouse.move(liHandleBox.x + liHandleBox.width / 2, liHandleBox.y + liHandleBox.height / 2);
  await page.mouse.down();
  expect(await classListOf(nestedLi)).toContain('dd-hover-outline');
  await page.mouse.up();
  await page.keyboard.press('Escape');

  const cell = page.locator('td', { hasText: 'a1' });
  const row = page.locator('tbody tr', { hasText: 'a1' });
  await hoverCenter(page, cell);
  const rowHandleBox = await page.locator('.dd-row-handle').boundingBox();
  if (!rowHandleBox) {
    throw new Error('row handle has no bounding box');
  }
  await page.mouse.move(rowHandleBox.x + rowHandleBox.width / 2, rowHandleBox.y + rowHandleBox.height / 2);
  await page.mouse.down();
  expect(await classListOf(row)).toContain('dd-hover-outline');
  await page.mouse.up();
  await page.keyboard.press('Escape');

  await hoverCenter(page, cell);
  const colHandleBox = await page.locator('.dd-col-handle').boundingBox();
  if (!colHandleBox) {
    throw new Error('column handle has no bounding box');
  }
  await page.mouse.move(colHandleBox.x + colHandleBox.width / 2, colHandleBox.y + colHandleBox.height / 2);
  await page.mouse.down();
  expect(await classListOf(cell)).toContain('dd-hover-outline-cell');
  await page.mouse.up();
  await page.keyboard.press('Escape');
});

test('clicking "Move down" in the handle menu actually reorders the block', async ({ page }) => {
  await openEditor(page, DOC);
  await hoverCenter(page, page.locator('p', { hasText: 'Alpha paragraph.' }));

  const handleBox = await page.locator(BLOCK_HANDLE_SELECTOR).boundingBox();
  if (!handleBox) {
    throw new Error('block handle has no bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  const popup = page.locator('.dd-menu-popup:visible');
  await expect(popup).toBeVisible();
  await popup.locator('.dd-menu-item', { hasText: 'Move down' }).click();

  const md = await waitForEdit(page);
  expect(md.indexOf('Beta paragraph.')).toBeLessThan(md.indexOf('Alpha paragraph.'));
});

test('hovering a table cell shows both the row handle and the column handle', async ({ page }) => {
  await openEditor(page, DOC);
  await hoverCenter(page, page.locator('td', { hasText: 'a1' }));

  await expect(page.locator('.dd-row-handle')).toHaveCSS('display', 'flex');
  await expect(page.locator('.dd-col-handle')).toHaveCSS('display', 'flex');
});
