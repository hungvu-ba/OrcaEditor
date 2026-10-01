/**
 * US-6.10: drag a table column edge to resize it. Hover within RESIZE_HIT_PX of
 * an edge highlights it; the first drag locks the whole table (every column
 * pinned), the dragged column stops at its widest word, and nothing reaches the
 * .md. Needs real layout + mouse events, so it lives here, not in roundtrip.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

const LINE = '.table-col-resize-line';
const LONG_WORD = 'Incomprehensibilities';

// Heading + paragraph first so the header row clears the sticky toolbar.
const DOC =
  '# Heading\n\nSome paragraph above the table.\n\n' +
  '| Name | Description | Notes |\n| --- | --- | --- |\n' +
  `| alpha | short text | x |\n| beta | some ${LONG_WORD} words here | y |\n`;

/** Rendered header-cell widths of the first table. */
async function headerWidths(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const t = document.querySelector('#content table') as HTMLTableElement;
    return Array.from(t.rows[0].cells, (c) => c.getBoundingClientRect().width);
  });
}

/** Viewport point on the right edge of header cell `col`. */
async function headerEdge(page: Page, col: number): Promise<{ x: number; y: number }> {
  return page.evaluate((i) => {
    const r = (document.querySelector('#content table') as HTMLTableElement).rows[0].cells[i].getBoundingClientRect();
    return { x: r.right, y: r.top + r.height / 2 };
  }, col);
}

/** Hover the right edge of header cell `col` (line must show), then drag it by `dx` px. */
async function dragColumnEdge(page: Page, col: number, dx: number): Promise<void> {
  const { x, y } = await headerEdge(page, col);
  await page.mouse.move(x - 1, y);
  await expect(page.locator(LINE)).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(x - 1 + dx, y, { steps: 8 });
  await page.mouse.up();
}

/** Number of line boxes the text `word` occupies inside the first table. */
async function wordLineCount(page: Page, word: string): Promise<number> {
  return page.evaluate((w) => {
    const walker = document.createTreeWalker(document.querySelector('#content table')!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent!.indexOf(w);
      if (at >= 0) {
        const r = document.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + w.length);
        return new Set(Array.from(r.getClientRects(), (b) => Math.round(b.top))).size;
      }
    }
    return -1;
  }, word);
}

function expectWidths(actual: number[], expected: number[]): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((w, i) => expect(Math.abs(w - expected[i]), `column ${i}: ${w} vs ${expected[i]}`).toBeLessThanOrEqual(1));
}

const RESET = '#table-toolbar button[title="Reset column widths"]';

/** Click inside header cell `col` (shows the table toolbar, caret in that cell). */
async function clickHeaderCell(page: Page, col: number): Promise<void> {
  const { x, y } = await headerEdge(page, col);
  await page.mouse.click(x - 30, y);
  await expect(page.locator('#table-toolbar')).toHaveClass(/\bvisible\b/);
}

/** Click the table toolbar button titled `title`. */
async function clickToolbar(page: Page, title: string): Promise<void> {
  await page.locator(`#table-toolbar button[title="${title}"]`).click();
}

/** Re-fit every table (fit mode on, then off) so the lock is re-applied from its widths array. */
async function refitAll(page: Page): Promise<void> {
  for (const on of [true, false]) {
    await page.evaluate(() => window.postMessage({ type: 'runCommand', command: 'toggleTableFitMode' }, '*'));
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('table-fit-mode'))).toBe(on);
  }
  await page.waitForTimeout(100);
}

function editCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'edit').length
  );
}

test.describe('US-6.10 table column resize', () => {
  test('hover near a header edge shows the line and the resize cursor class; moving away clears both', async ({ page }) => {
    await openEditor(page, DOC);
    const { x, y } = await headerEdge(page, 0);
    await page.mouse.move(x + 3, y);
    await expect(page.locator(LINE)).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/\btable-col-resize-hover\b/);

    await page.mouse.move(x - 30, y);
    await expect(page.locator(LINE)).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/\btable-col-resize-hover\b/);
  });

  test('drag widens one column, keeps the others, moves no caret, shows no toolbar, posts no edit', async ({ page }) => {
    await openEditor(page, DOC);
    // Caret in the paragraph above the table.
    await page.evaluate(() => {
      const text = document.querySelector('#content p')!.firstChild!;
      const s = window.getSelection()!;
      s.collapse(text, 4);
    });
    const before = await headerWidths(page);
    await clearPosted(page);

    await dragColumnEdge(page, 0, 80);

    const after = await headerWidths(page);
    expectWidths(after, [before[0] + 80, before[1], before[2]]);
    const caret = await page.evaluate(() => {
      const s = window.getSelection()!;
      return { inP: s.anchorNode === document.querySelector('#content p')!.firstChild, offset: s.anchorOffset };
    });
    expect(caret).toEqual({ inP: true, offset: 4 });
    await expect(page.locator('#table-toolbar')).not.toHaveClass(/\bvisible\b/);
    await expect(page.locator(LINE)).toBeHidden();
    await page.waitForTimeout(800);
    const edits = await page.evaluate(
      () => (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'edit').length
    );
    expect(edits).toBe(0);
  });

  test('control: a plain click inside a cell shows the table toolbar', async ({ page }) => {
    await openEditor(page, DOC);
    const { x, y } = await headerEdge(page, 0);
    await page.mouse.click(x - 30, y);
    await expect(page.locator('#table-toolbar')).toHaveClass(/\bvisible\b/);
  });

  test('a press on an edge without movement leaves the fit-mode table unlocked', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    await openEditor(page, DOC, { tableFitMode: true });
    const fitted = (): Promise<boolean> =>
      page.evaluate(() => (document.querySelector('#content table') as HTMLTableElement).classList.contains('md-table-fit'));
    await expect.poll(fitted).toBe(true);
    const { x, y } = await headerEdge(page, 0);
    await page.mouse.move(x - 1, y);
    await expect(page.locator(LINE)).toBeVisible();
    await page.mouse.down();
    await page.mouse.up();
    expect(await fitted()).toBe(true);

    // Control: a real drag locks the table, which drops the fit class.
    await dragColumnEdge(page, 0, 20);
    expect(await fitted()).toBe(false);
  });

  test('dragging far left stops at the widest word, which stays on one line', async ({ page }) => {
    await openEditor(page, DOC);
    await dragColumnEdge(page, 1, -600);

    const { colW, floor } = await page.evaluate((w) => {
      const t = document.querySelector('#content table') as HTMLTableElement;
      const cell = t.rows[2].cells[1];
      const text = cell.firstChild!;
      const at = text.textContent!.indexOf(w);
      const r = document.createRange();
      r.setStart(text, at);
      r.setEnd(text, at + w.length);
      const cs = getComputedStyle(cell);
      const pad = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce(
        (s, k) => s + parseFloat(cs[k as 'paddingLeft']),
        0
      );
      return { colW: t.rows[0].cells[1].getBoundingClientRect().width, floor: r.getBoundingClientRect().width + pad };
    }, LONG_WORD);
    expect(colW).toBeGreaterThanOrEqual(floor - 1);
    expect(colW).toBeLessThanOrEqual(floor + 3);
    expect(await wordLineCount(page, LONG_WORD)).toBe(1);
  });

  test('locked widths survive fit-mode on/off and a viewport resize', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await openEditor(page, DOC);
    await dragColumnEdge(page, 0, 60);
    const locked = await headerWidths(page);

    const toggleFit = (): Promise<void> =>
      page.evaluate(() => window.postMessage({ type: 'runCommand', command: 'toggleTableFitMode' }, '*'));
    await toggleFit();
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('table-fit-mode'))).toBe(true);
    await page.waitForTimeout(100);
    expectWidths(await headerWidths(page), locked);

    await toggleFit();
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('table-fit-mode'))).toBe(false);
    await page.waitForTimeout(100);
    expectWidths(await headerWidths(page), locked);

    await page.setViewportSize({ width: 700, height: 700 });
    await page.waitForTimeout(300);
    expectWidths(await headerWidths(page), locked);
  });

  test('fit mode: a word longer than a locked column widens it after the pressure re-fit, no mid-word break', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await openEditor(page, DOC, { tableFitMode: true });
    await dragColumnEdge(page, 0, -600);
    const narrow = (await headerWidths(page))[0];

    await page.evaluate(() => {
      const cell = (document.querySelector('#content table') as HTMLTableElement).rows[1].cells[0];
      const r = document.createRange();
      r.selectNodeContents(cell);
      r.collapse(false);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    await page.keyboard.type(' Pneumonoultramicroscopic');
    await page.waitForTimeout(400);

    await expect.poll(async () => (await headerWidths(page))[0]).toBeGreaterThan(narrow + 40);
    expect(await wordLineCount(page, 'Pneumonoultramicroscopic')).toBe(1);
  });

  test('a raw-HTML table with colspan shows no resize line', async ({ page }) => {
    const md =
      '# Heading\n\nSome paragraph above the table.\n\n' +
      '<table>\n<tr><td colspan="2">wide cell</td></tr>\n<tr><td>left</td><td>right</td></tr>\n</table>\n';
    await openEditor(page, md);
    const { x, y } = await page.evaluate(() => {
      const r = (document.querySelector('#content table') as HTMLTableElement).rows[1].cells[0].getBoundingClientRect();
      return { x: r.right, y: r.top + r.height / 2 };
    });
    await page.mouse.move(x - 1, y);
    await page.mouse.move(x, y);
    await page.waitForTimeout(150);
    await expect(page.locator(LINE)).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/\btable-col-resize-hover\b/);
  });

  test('a raw-HTML row longer than the header row has no edge past the header cells', async ({ page }) => {
    const md =
      '# Heading\n\nSome paragraph above the table.\n\n' +
      '<table>\n<tr><td>head</td></tr>\n<tr><td>left</td><td>right</td></tr>\n</table>\n';
    await openEditor(page, md);
    const edge = (i: number): Promise<{ x: number; y: number }> =>
      page.evaluate((c) => {
        const r = (document.querySelector('#content table') as HTMLTableElement).rows[1].cells[c].getBoundingClientRect();
        return { x: r.right, y: r.top + r.height / 2 };
      }, i);
    // Control: the edge of a column the header row has is resizable.
    const first = await edge(0);
    await page.mouse.move(first.x - 1, first.y);
    await expect(page.locator(LINE)).toBeVisible();
    const extra = await edge(1);
    await page.mouse.move(extra.x - 1, extra.y);
    await page.mouse.move(extra.x, extra.y);
    await page.waitForTimeout(150);
    await expect(page.locator(LINE)).toBeHidden();
  });

  test('a move with no button held ends a drag whose mouseup was lost', async ({ page }) => {
    await openEditor(page, DOC);
    const { x, y } = await headerEdge(page, 0);
    await page.mouse.move(x - 1, y);
    await expect(page.locator(LINE)).toBeVisible();
    await page.mouse.down();
    await page.mouse.move(x + 39, y, { steps: 4 });
    await expect(page.locator('body')).toHaveClass(/\btable-col-resizing\b/);
    await page.waitForTimeout(100);
    const mid = await headerWidths(page);

    await page.evaluate(
      (p) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: p.x + 120, clientY: p.y, buttons: 0, bubbles: true })),
      { x, y }
    );

    await expect(page.locator('body')).not.toHaveClass(/\btable-col-resizing\b/);
    await page.waitForTimeout(100);
    expectWidths(await headerWidths(page), mid);
    await page.mouse.up();
  });

  test('insert column right keeps the locked widths; the new column is auto-sized', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await openEditor(page, DOC);
    await dragColumnEdge(page, 0, 60);
    const locked = await headerWidths(page);

    await clickHeaderCell(page, 0);
    await clickToolbar(page, 'Insert column right');
    await refitAll(page);

    const after = await headerWidths(page);
    expectWidths([after[0], after[2], after[3]], locked);
    const newColPinned = await page.evaluate(
      () => (document.querySelector('#content table') as HTMLTableElement).rows[0].cells[1].style.width
    );
    expect(newColPinned).toBe('');
    expect(after[1]).toBeGreaterThan(20);
  });

  test('delete column keeps the remaining locked widths', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await openEditor(page, DOC);
    await dragColumnEdge(page, 0, 60);
    const locked = await headerWidths(page);

    await clickHeaderCell(page, 1);
    await clickToolbar(page, 'Delete current column');
    await refitAll(page);

    expectWidths(await headerWidths(page), [locked[0], locked[2]]);
  });

  test('add row leaves the locked widths unchanged', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await openEditor(page, DOC);
    await dragColumnEdge(page, 0, 60);
    const locked = await headerWidths(page);

    await clickHeaderCell(page, 0);
    await clickToolbar(page, 'Insert row below');

    expectWidths(await headerWidths(page), locked);
    await refitAll(page);
    expectWidths(await headerWidths(page), locked);
  });

  test('drag-moving a locked column carries its width to the new position', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await openEditor(page, DOC);
    await dragColumnEdge(page, 0, 120);
    const locked = await headerWidths(page);

    await page.locator('#content thead th').nth(0).hover();
    const colHandle = page.locator('.dd-col-handle');
    await expect(colHandle).toHaveCSS('display', 'flex');
    const handleBox = (await colHandle.boundingBox())!;
    const nextBox = (await page.locator('#content thead th').nth(1).boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    // Right half of the neighbour: the column drops after it.
    await page.mouse.move(nextBox.x + nextBox.width - 4, nextBox.y + nextBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('#content thead th').nth(1)).toHaveText('Name');

    await refitAll(page);
    expectWidths(await headerWidths(page), [locked[1], locked[0], locked[2]]);
  });

  test('Reset column widths: disabled until a drag, restores pre-drag widths, posts no edit', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await openEditor(page, DOC);
    const before = await headerWidths(page);
    await clickHeaderCell(page, 2);
    await expect(page.locator(RESET)).toBeDisabled();

    await dragColumnEdge(page, 0, 80);
    await expect(page.locator(RESET)).toBeEnabled();
    expect((await headerWidths(page))[0]).toBeGreaterThan(before[0] + 40);
    await clearPosted(page);

    await page.locator(RESET).click();
    expectWidths(await headerWidths(page), before);
    await expect(page.locator(RESET)).toBeDisabled();
    await page.waitForTimeout(800);
    expect(await editCount(page)).toBe(0);
  });

  test('fit mode: Reset gives a previously fitted table its md-table-fit class back', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    await openEditor(page, DOC, { tableFitMode: true });
    const fitted = (): Promise<boolean> =>
      page.evaluate(() => (document.querySelector('#content table') as HTMLTableElement).classList.contains('md-table-fit'));
    await expect.poll(fitted).toBe(true);
    await dragColumnEdge(page, 0, 20);
    expect(await fitted()).toBe(false);

    await clickHeaderCell(page, 1);
    await page.locator(RESET).click();
    expect(await fitted()).toBe(true);
  });
});

/** Send a host `update` and wait until #content shows `marker`. */
async function hostUpdate(page: Page, text: string, marker: string): Promise<void> {
  await page.evaluate((t) => window.postMessage({ type: 'update', text: t }, '*'), text);
  await expect(page.locator('#content')).toContainText(marker);
  await page.waitForTimeout(100);
}

/** Remember the current first table node so a later check can tell kept from replaced. */
async function tagTable(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __oldTable: Element }).__oldTable = document.querySelector('#content table')!;
  });
}

function sameTable(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __oldTable: Element }).__oldTable === document.querySelector('#content table')
  );
}

test.describe('US-6.10 lock across host re-render', () => {
  test('an update editing a cell of the locked table replaces the node and keeps the pinned widths', async ({ page }) => {
    await openEditor(page, DOC);
    await dragColumnEdge(page, 0, 80);
    const locked = await headerWidths(page);
    await tagTable(page);

    await hostUpdate(page, DOC.replace('| x |', '| xx |'), 'xx');

    expect(await sameTable(page)).toBe(false);
    expectWidths(await headerWidths(page), locked);
  });

  test('an update adding a column drops the lock: auto widths', async ({ page }) => {
    const DOC4 = DOC.replace('| Notes |', '| Notes | Extra |')
      .replace('| --- | --- | --- |', '| --- | --- | --- | --- |')
      .replace('| x |', '| x | e |')
      .replace('| y |', '| y | f |');
    await openEditor(page, DOC4);
    const auto = await headerWidths(page);

    await hostUpdate(page, DOC, 'Notes');
    await dragColumnEdge(page, 0, 80);
    await tagTable(page);

    await hostUpdate(page, DOC4, 'Extra');

    expect(await sameTable(page)).toBe(false);
    expectWidths(await headerWidths(page), auto);
  });

  test('an update editing only another block keeps the same table node, still locked', async ({ page }) => {
    await openEditor(page, DOC);
    await dragColumnEdge(page, 0, 80);
    const locked = await headerWidths(page);
    // The drag's width writes mark the table changed, so the next update replaces
    // it (lock restored); only a table pristine since that render is kept.
    const edited = DOC.replace('| x |', '| xx |');
    await hostUpdate(page, edited, 'xx');
    await tagTable(page);

    await hostUpdate(page, edited.replace('Some paragraph above', 'Another paragraph above'), 'Another paragraph');

    expect(await sameTable(page)).toBe(true);
    expectWidths(await headerWidths(page), locked);
    await refitAll(page);
    expectWidths(await headerWidths(page), locked);
  });

  test('a re-render replacing the table mid-drag ends the drag', async ({ page }) => {
    await openEditor(page, DOC);
    const { x, y } = await headerEdge(page, 0);
    await page.mouse.move(x - 1, y);
    await expect(page.locator(LINE)).toBeVisible();
    await page.mouse.down();
    await page.mouse.move(x + 39, y, { steps: 4 });
    await expect(page.locator('body')).toHaveClass(/\btable-col-resizing\b/);
    await tagTable(page);

    await hostUpdate(page, DOC.replace('| x |', '| xx |'), 'xx');
    expect(await sameTable(page)).toBe(false);
    await page.mouse.move(x + 80, y, { steps: 2 });

    await expect(page.locator('body')).not.toHaveClass(/\btable-col-resizing\b/);
    await expect(page.locator(LINE)).toBeHidden();
    await page.mouse.up();
  });

  test('after a drag with the sticky header shown, the clone column widths follow the table', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    const rows = Array.from({ length: 40 }, (_, i) => `| r${i} | text ${i} | n${i} |`).join('\n');
    await openEditor(page, DOC + rows + '\n\nAfter the table.\n');
    // Scroll the header row under the toolbar so the sticky clone shows.
    await page.evaluate(() => {
      const t = document.querySelector('#content table') as HTMLTableElement;
      window.scrollBy(0, t.getBoundingClientRect().top + 200);
    });
    await expect(page.locator('#sticky-table-header')).toHaveClass(/\bvisible\b/);

    // Drag the first column's edge on a body row in the middle of the viewport.
    const { x, y } = await page.evaluate(() => {
      const t = document.querySelector('#content table') as HTMLTableElement;
      const mid = document.documentElement.clientHeight / 2;
      const row = Array.from(t.rows).find((r) => r.getBoundingClientRect().top > mid)!;
      const r = row.cells[0].getBoundingClientRect();
      return { x: r.right, y: r.top + r.height / 2 };
    });
    await page.mouse.move(x - 1, y);
    await expect(page.locator(LINE)).toBeVisible();
    await page.mouse.down();
    await page.mouse.move(x - 1 + 80, y, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('#sticky-table-header')).toHaveClass(/\bvisible\b/);

    const cloneWidths = await page.evaluate(() =>
      Array.from(
        (document.querySelector('#sticky-table-header table') as HTMLTableElement).rows[0].cells,
        (c) => c.getBoundingClientRect().width
      )
    );
    expectWidths(cloneWidths, await headerWidths(page));
  });
});
