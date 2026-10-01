/**
 * Performance Low-End audit L-3 (T5.1): the fit-mode measurement cost on the
 * 302 × 13 table — Range rect reads, getComputedStyle calls and CDP LayoutCount
 * per render fit, typing refit (grow-only and full), settle refit, structural
 * edit, panel resize and fit toggle. Counts go to test annotations, never
 * asserted; the only assertion is that the fitted widths stay FIT_WIDTHS_302X13
 * (contract 1 — T5.5 must reproduce them exactly).
 */
import { test, expect, type Page } from '@playwright/test';
import { openBlankHarness, postInit } from './_harness';

const ROWS = 302;
const COLS = 13;
const EDIT_ROW = 150;
const EDIT_COL = 6;
/** Settle refit fires FIT_IDLE_SETTLE_MS (2000) after the last input. */
const SETTLE_WAIT_MS = 2500;
/** Overflows its 143 px floor column → the pressure refit widens only that column (growOnlyCol). */
const TOKEN_GROW = 'x'.repeat(30);
/**
 * Wider than column + spare. The table sits at its floors in the scroll branch
 * (Σ floors > panel), so the grow-only pass still widens the column and the
 * full-refit fallback never runs — the annotation records that path as it is.
 */
const TOKEN_WIDE = 'y'.repeat(250);

// Rounded first-row widths fitTableColumns leaves on bigTableDoc at 1400 × 900.
const FIT_WIDTHS_302X13: number[] = [143, 143, 143, 143, 143, 143, 143, 143, 143, 143, 147, 146, 147];

function bigTableDoc(): string {
  const cell = (r: number, c: number): string => `cell r${r} c${c} lorem ip`.slice(0, 20).padEnd(20, '.');
  const row = (r: number): string => `| ${Array.from({ length: COLS }, (_, c) => cell(r, c)).join(' | ')} |`;
  const lines = [row(0), `|${Array.from({ length: COLS }, () => ' --- ').join('|')}|`];
  for (let r = 1; r < ROWS; r++) lines.push(row(r));
  const wrapping = 'Wrapping lorem ipsum dolor sit amet. '.repeat(40);
  return `# Before table\n\nIntro paragraph.\n\n## The table\n\n${lines.join('\n')}\n\n## After table\n\n${wrapping}\n\nOutro paragraph.\n`;
}

/** Runs `action` and returns the CDP LayoutCount delta across it. */
async function layoutCountDelta(page: Page, action: () => Promise<void>): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const layoutCount = async (): Promise<number> => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0;
  };
  const before = await layoutCount();
  await action();
  const delta = (await layoutCount()) - before;
  await cdp.detach();
  return delta;
}

/** Counts every Range.getBoundingClientRect / getComputedStyle call in the page world. */
async function installCounters(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __fitCounts: { rangeRects: number; computedStyles: number } };
    w.__fitCounts = { rangeRects: 0, computedStyles: 0 };
    const rangeRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
      w.__fitCounts.rangeRects++;
      return rangeRect.call(this);
    };
    const computed = window.getComputedStyle;
    window.getComputedStyle = function (el: Element, pseudo?: string | null): CSSStyleDeclaration {
      w.__fitCounts.computedStyles++;
      return computed.call(window, el, pseudo);
    };
  });
}

function readCounts(page: Page): Promise<{ rangeRects: number; computedStyles: number }> {
  return page.evaluate(() => ({ ...(window as unknown as { __fitCounts: { rangeRects: number; computedStyles: number } }).__fitCounts }));
}

async function fitCost(page: Page, action: () => Promise<void>): Promise<{ rangeRects: number; computedStyles: number; layouts: number }> {
  const before = await readCounts(page);
  const layouts = await layoutCountDelta(page, action);
  const after = await readCounts(page);
  return { rangeRects: after.rangeRects - before.rangeRects, computedStyles: after.computedStyles - before.computedStyles, layouts };
}

function annotate(what: string, cost: { rangeRects: number; computedStyles: number; layouts: number }): void {
  test.info().annotations.push({
    type: 'fitCost',
    description: `${what}: rangeRects=${cost.rangeRects} computedStyles=${cost.computedStyles} layouts=${cost.layouts}`,
  });
}

/** Rounded border-box width of every cell of the table's first row. */
function widths(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const t = document.querySelector('#content table') as HTMLTableElement;
    return Array.from(t.rows[0].cells, (c) => Math.round(c.getBoundingClientRect().width));
  });
}

/** Opens the harness, then returns the cost of the init render plus 500 ms (ResizeObserver refit + FIT_RESIZE_SETTLE_MS). */
async function openFixture(page: Page): Promise<{ rangeRects: number; computedStyles: number; layouts: number }> {
  await installCounters(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  const config = await openBlankHarness(page, { tableFitMode: true });
  return fitCost(page, async () => {
    await postInit(page, bigTableDoc(), config);
    await expect(page.locator('#content table tr')).toHaveCount(ROWS);
    await page.waitForTimeout(500);
  });
}

/** Collapsed caret at the end of body cell (row, col), like table-fit-refit-policy's caretAtEnd. */
async function caretAtEnd(page: Page, row: number, col: number): Promise<void> {
  await page.evaluate(
    ({ r, i }) => {
      const t = document.querySelector('#content table') as HTMLTableElement;
      const cell = t.rows[r].cells[i];
      cell.scrollIntoView({ block: 'center' });
      (document.getElementById('content') as HTMLElement).focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(cell);
      range.collapse(false);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(range);
    },
    { r: row, i: col }
  );
}

test.describe('L-3 fit-mode cost on the 302 × 13 table (fit on, viewport 1400)', () => {
  test.describe.configure({ timeout: 60_000 });

  test('(a) render fit and (d) the fitted widths', async ({ page }) => {
    annotate('render fit', await openFixture(page));
    const got = await widths(page);
    test.info().annotations.push({ type: 'widths', description: JSON.stringify(got) });
    expect(got).toEqual(FIT_WIDTHS_302X13);
  });

  test('(b) typing refits and (c) the settle refit', async ({ page }) => {
    await openFixture(page);
    const before = await widths(page);
    await caretAtEnd(page, EDIT_ROW, EDIT_COL);
    const grow = await fitCost(page, async () => {
      await page.keyboard.type(` ${TOKEN_GROW}`);
      await page.waitForTimeout(800);
    });
    annotate('typing refit, grow-only', grow);
    const grown = await widths(page);
    expect(grown[EDIT_COL]).toBeGreaterThan(before[EDIT_COL] + 1);
    for (let i = 0; i < grown.length; i++) {
      if (i !== EDIT_COL) {
        expect(Math.abs(grown[i] - before[i]), `column ${i}`).toBeLessThanOrEqual(1);
      }
    }

    annotate('settle refit', await fitCost(page, () => page.waitForTimeout(SETTLE_WAIT_MS)));

    await caretAtEnd(page, EDIT_ROW + 2, EDIT_COL);
    annotate(
      'typing refit, token wider than column + spare',
      await fitCost(page, async () => {
        await page.keyboard.type(` ${TOKEN_WIDE}`);
        await page.waitForTimeout(800);
      })
    );
  });

  test('(e) structural edits via the table toolbar', async ({ page }) => {
    await openFixture(page);
    const cell = (r: number, c: number): string => `#content td:text-is("${`cell r${r} c${c} lorem ip`.slice(0, 20).padEnd(20, '.')}")`;
    const tableEdit = async (selector: string, action: string): Promise<void> => {
      await page.locator(selector).first().click();
      await page.waitForTimeout(300);
      annotate(
        action,
        await fitCost(page, async () => {
          await page.locator(`#table-toolbar button[title="${action}"]`).click();
          await page.waitForTimeout(SETTLE_WAIT_MS);
        })
      );
    };
    await tableEdit(cell(EDIT_ROW, EDIT_COL), 'Insert row below');
    await expect(page.locator('#content table tr')).toHaveCount(ROWS + 1);
    await tableEdit(cell(EDIT_ROW, EDIT_COL), 'Delete current row');
    await expect(page.locator('#content table tr')).toHaveCount(ROWS);
    await tableEdit(cell(EDIT_ROW + 1, EDIT_COL), 'Insert column right');
    await expect(page.locator('#content table tr').first().locator('th')).toHaveCount(COLS + 1);
    await tableEdit('#content th:text-is("New Column")', 'Delete current column');
    await expect(page.locator('#content table tr').first().locator('th')).toHaveCount(COLS);
  });

  test('(f) panel resize and (g) fit toggle off then on', async ({ page }) => {
    await openFixture(page);
    annotate(
      'panel resize 1400 → 1200',
      await fitCost(page, async () => {
        await page.setViewportSize({ width: 1200, height: 900 });
        await page.waitForTimeout(500);
      })
    );
    const toggle = (): Promise<void> =>
      page.evaluate(() => window.postMessage({ type: 'runCommand', command: 'toggleTableFitMode' }, '*'));
    annotate(
      'fit toggle off',
      await fitCost(page, async () => {
        await toggle();
        await expect(page.locator('body.table-fit-mode')).toHaveCount(0);
        await page.waitForTimeout(300);
      })
    );
    annotate(
      'fit toggle on',
      await fitCost(page, async () => {
        await toggle();
        await expect(page.locator('body.table-fit-mode')).toHaveCount(1);
        await page.waitForTimeout(300);
      })
    );
  });
});
