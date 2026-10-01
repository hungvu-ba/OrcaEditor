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
});
