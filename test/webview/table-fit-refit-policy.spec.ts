/**
 * US-19.27 contract 13 (T1.6): fit-mode edit-time re-fit policy. A keystroke never
 * re-fits; pressure (overflow / edited cell grown ≥ 2 lines as its row's tallest)
 * widens only the edited column after FIT_PRESSURE_MS; paste re-fits at once; IME
 * composition is skipped; no spare width → full re-fit; every re-fit keeps the edited cell's viewport top.
 * Needs real layout, keyboard and Selection, so it lives here, not roundtrip.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';
import { TABLE_20 } from './table-area-fixtures';

const MITIGATION = 3;
const LIKELIHOOD = 1;
/** Overflows Likelihood (90 px) but fits it plus the table's ~76 px spare → grow-only. */
const TOKEN_12 = 'x'.repeat(12);
/** Wider than column + spare → no spare → full re-fit (contract 13). */
const TOKEN_60 = 'x'.repeat(60);
/** Filler above the table so the page scrolls and the anchor has something to hold. */
const FILLER = Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i + 1}.`).join('\n\n');

async function openTable20(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1000, height: 700 });
  await openEditor(page, `${FILLER}\n\n${TABLE_20}`, { tableFitMode: true });
  await page.locator('#content table').waitFor();
  // Wait until the render and ResizeObserver fit passes agree.
  let prev = '';
  await expect
    .poll(
      async () => {
        const cur = (await widths(page)).join('|');
        const same = cur === prev;
        prev = cur;
        return same;
      },
      { timeout: 8000, intervals: [150] }
    )
    .toBe(true);
  await page.evaluate(() => {
    const t = document.querySelector('#content table') as HTMLElement;
    window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 120);
  });
}

/** Border-box width of every column, from the first body row. */
async function widths(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const t = document.querySelector('#content table') as HTMLTableElement;
    return Array.from(t.tBodies[0].rows[0].cells).map((c) => Math.round(c.getBoundingClientRect().width * 10) / 10);
  });
}

/** Viewport top of body cell (0, col). */
async function cellTop(page: Page, col: number): Promise<number> {
  return page.evaluate((i) => {
    const t = document.querySelector('#content table') as HTMLTableElement;
    return t.tBodies[0].rows[0].cells[i].getBoundingClientRect().top;
  }, col);
}

/** Collapsed caret at the end of body cell (0, col). */
async function caretAtEnd(page: Page, col: number): Promise<void> {
  await page.evaluate((i) => {
    const t = document.querySelector('#content table') as HTMLTableElement;
    const cell = t.tBodies[0].rows[0].cells[i];
    (document.getElementById('content') as HTMLElement).focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(cell);
    r.collapse(false);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  }, col);
}

function expectSame(a: number[], b: number[], except = -1): void {
  expect(a.length).toBe(b.length);
  a.forEach((w, i) => {
    if (i !== except) {
      expect(Math.abs(w - b[i]), `column ${i}: ${w} vs ${b[i]}`).toBeLessThanOrEqual(1);
    }
  });
}

test.describe('US-19.27 edit-time re-fit policy (TABLE_20, fit on, viewport 1000)', () => {
  test('typing two words in a Mitigation cell moves no column edge', async ({ page }) => {
    await openTable20(page);
    const before = await widths(page);
    await caretAtEnd(page, MITIGATION);
    await page.keyboard.type(' extra words');
    await page.waitForTimeout(1500);
    expectSame(await widths(page), before);
  });

  test('an unbreakable token widens only its column; deleting keeps it; Tab changes nothing', async ({ page }) => {
    await openTable20(page);
    const before = await widths(page);
    await caretAtEnd(page, LIKELIHOOD);
    const top = await cellTop(page, LIKELIHOOD);
    await page.keyboard.type(` ${TOKEN_12}`);
    // FIT_PRESSURE_MS (300) + one re-fit, well inside 500 ms of the last key.
    await expect.poll(async () => (await widths(page))[LIKELIHOOD], { timeout: 500, intervals: [50] }).toBeGreaterThan(before[LIKELIHOOD] + 1);
    const grown = await widths(page);
    expectSame(grown, before, LIKELIHOOD);
    expect(Math.abs((await cellTop(page, LIKELIHOOD)) - top)).toBeLessThanOrEqual(2);

    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Backspace');
    }
    await page.waitForTimeout(1500);
    expectSame(await widths(page), grown);

    await page.keyboard.press('Tab');
    await page.waitForTimeout(1000);
    expectSame(await widths(page), grown);
  });

  test('a token wider than column + spare → full re-fit, the cell stops overflowing', async ({ page }) => {
    await openTable20(page);
    const before = await widths(page);
    await caretAtEnd(page, LIKELIHOOD);
    const top = await cellTop(page, LIKELIHOOD);
    await page.keyboard.type(` ${TOKEN_60}`);
    await expect.poll(async () => (await widths(page))[LIKELIHOOD], { timeout: 1000, intervals: [50] }).toBeGreaterThan(before[LIKELIHOOD] + 1);
    const overflow = await page.evaluate((i) => {
      const c = (document.querySelector('#content table') as HTMLTableElement).tBodies[0].rows[0].cells[i];
      return c.scrollWidth - c.clientWidth;
    }, LIKELIHOOD);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(Math.abs((await cellTop(page, LIKELIHOOD)) - top)).toBeLessThanOrEqual(2);
  });

  test('paste into a cell re-fits within one frame and keeps the cell top', async ({ page }) => {
    await openTable20(page);
    await caretAtEnd(page, LIKELIHOOD);
    const top = await cellTop(page, LIKELIHOOD);
    const before = await widths(page);
    // Paste, then read the widths after exactly one animation frame.
    const after = await page.evaluate(async (text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      document.getElementById('content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const t = document.querySelector('#content table') as HTMLTableElement;
      return Array.from(t.tBodies[0].rows[0].cells).map((c) => Math.round(c.getBoundingClientRect().width * 10) / 10);
    }, ` ${TOKEN_60}`);
    expect(after[LIKELIHOOD]).toBeGreaterThan(before[LIKELIHOOD] + 1);
    expect(Math.abs((await cellTop(page, LIKELIHOOD)) - top)).toBeLessThanOrEqual(2);
  });

  test('IME: an input with isComposing never re-fits; compositionend does', async ({ page }) => {
    await openTable20(page);
    const before = await widths(page);
    await caretAtEnd(page, LIKELIHOOD);
    // Mimic an IME: the text lands in the DOM while composing, input carries isComposing.
    await page.evaluate((token) => {
      const content = document.getElementById('content')!;
      content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const sel = window.getSelection()!;
      sel.getRangeAt(0).insertNode(document.createTextNode(` ${token}`));
      sel.collapseToEnd();
      content.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText' }));
    }, TOKEN_60);
    await page.waitForTimeout(1000);
    expectSame(await widths(page), before);

    await page.evaluate(() => {
      document.getElementById('content')!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await expect.poll(async () => (await widths(page))[LIKELIHOOD], { timeout: 1000 }).toBeGreaterThan(before[LIKELIHOOD] + 1);
  });
});
