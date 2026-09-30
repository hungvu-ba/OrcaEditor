/**
 * US-19.27 contract 13 (T1.6): fit-mode edit-time re-fit policy. A keystroke never
 * re-fits; pressure (overflow / edited cell grown ≥ 2 lines as its row's tallest)
 * widens only the edited column after FIT_PRESSURE_MS; paste re-fits at once; IME
 * composition is skipped; no spare width → full re-fit; every re-fit keeps the edited cell's viewport top.
 * T1.11: settle (caret leaves the table / editor blur / FIT_IDLE_SETTLE_MS idle) is the
 * edit-time re-fit that narrows back; a panel resize keeps widths until FIT_RESIZE_SETTLE_MS.
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
    // Both waits stay inside FIT_IDLE_SETTLE_MS (2000) of the last key — past it the idle settle runs.
    await page.waitForTimeout(700);
    expectSame(await widths(page), grown);

    await page.keyboard.press('Tab');
    await page.waitForTimeout(700);
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

  test('pasting an image into a cell (async host round-trip) re-fits once the image has loaded, not just the debounced pressure path', async ({ page }) => {
    await openTable20(page);
    await caretAtEnd(page, LIKELIHOOD);
    const before = await widths(page);
    // A real, loadable image (not a broken src): 250x200 at the ~90px-wide Likelihood
    // column renders ~90x72 — tall enough to be the row's tallest cell by far, but it
    // never overflows its own width (CSS max-width: 100%) and, being a single DOM
    // mutation with no prior state, never trips the "grown >= 2 lines from baseline"
    // pressure signal either (the baseline is captured AFTER the insert). Only the
    // discrete paste hook (`insertImageAt` -> `ctx.afterInsert`) can re-fit this.
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 250;
      canvas.height = 200;
      canvas.getContext('2d')!.fillRect(0, 0, 250, 200);
      return canvas.toDataURL('image/png');
    });
    // The saved asset loads after the insert: serve it 600 ms late (past FIT_PRESSURE_MS,
    // before FIT_IDLE_SETTLE_MS), so only a re-fit that waits for the image sees its size.
    // A <base> sends the relative `assets/...` src to the routed origin.
    const assetName = 'table-fit-refit-policy-test-image.png';
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    await page.route('http://asset.test/assets/**', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill({ body: png, contentType: 'image/png' });
    });
    await page.evaluate(() => {
      const base = document.createElement('base');
      base.href = 'http://asset.test/';
      document.head.prepend(base);
    });

    await page.evaluate(async (blobDataUrl) => {
      const blob = await (await fetch(blobDataUrl)).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'wide.png', { type: 'image/png' }));
      document.getElementById('content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, dataUrl);
    // requestSave() reads the blob and measures it async before posting to the host —
    // wait for that 'pasteImage' request, then reply as the host would.
    const handle = await page.waitForFunction(() => {
      const posted = (window as unknown as { __posted: Array<{ type: string; requestId: number }> }).__posted;
      return posted.find((m) => m.type === 'pasteImage')?.requestId ?? null;
    });
    const requestId = (await handle.jsonValue()) as number;
    await page.evaluate(
      ({ requestId, relativePath }) => window.postMessage({ type: 'pasteImageResult', requestId, relativePath }, '*'),
      { requestId, relativePath: `assets/${assetName}` }
    );
    await expect
      .poll(async () => (await widths(page))[LIKELIHOOD], { timeout: 1500, intervals: [50] })
      .toBeGreaterThan(before[LIKELIHOOD] + 1);
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

/** Widen Likelihood with TOKEN_12 (grow-only), then delete it: the column stays wide until a settle. */
async function widenThenClear(page: Page): Promise<{ before: number[]; grown: number[] }> {
  const before = await widths(page);
  await caretAtEnd(page, LIKELIHOOD);
  await page.keyboard.type(` ${TOKEN_12}`);
  await expect.poll(async () => (await widths(page))[LIKELIHOOD], { timeout: 1000, intervals: [50] }).toBeGreaterThan(before[LIKELIHOOD] + 1);
  for (let i = 0; i < TOKEN_12.length + 1; i++) {
    await page.keyboard.press('Backspace');
  }
  const grown = await widths(page);
  expectSame(grown, before, LIKELIHOOD);
  return { before, grown };
}

test.describe('US-19.27 settle and resize re-fits (TABLE_20, fit on, viewport 1000)', () => {
  test('the caret leaving the table settles: the widened column narrows back, the cell top holds', async ({ page }) => {
    await openTable20(page);
    const { before, grown } = await widenThenClear(page);
    const top = await cellTop(page, LIKELIHOOD);
    await page.locator('#content p', { hasText: 'Filler paragraph 30.' }).click();
    await expect.poll(async () => (await widths(page))[LIKELIHOOD], { timeout: 1000, intervals: [50] }).toBeLessThan(grown[LIKELIHOOD] - 1);
    expectSame(await widths(page), before);
    expect(Math.abs((await cellTop(page, LIKELIHOOD)) - top)).toBeLessThanOrEqual(2);
  });

  test('2 s idle with the caret in the table settles', async ({ page }) => {
    await openTable20(page);
    const { before, grown } = await widenThenClear(page);
    const top = await cellTop(page, LIKELIHOOD);
    await page.waitForTimeout(1000);
    expectSame(await widths(page), grown);
    await expect.poll(async () => (await widths(page))[LIKELIHOOD], { timeout: 2500, intervals: [100] }).toBeLessThan(grown[LIKELIHOOD] - 1);
    expectSame(await widths(page), before);
    expect(Math.abs((await cellTop(page, LIKELIHOOD)) - top)).toBeLessThanOrEqual(2);
  });

  test('Tab between cells of the same table does not settle', async ({ page }) => {
    await openTable20(page);
    const { grown } = await widenThenClear(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(600);
    expectSame(await widths(page), grown);
  });

  test('a panel widening keeps widths while events arrive, re-fits 150 ms after the last', async ({ page }) => {
    await openTable20(page);
    const fresh = await widths(page);
    // An applied layout that still fits but is far from optimal: 60 px moved from Mitigation to Contingency.
    await page.evaluate(
      ({ from, to }) => {
        const t = document.querySelector('#content table') as HTMLTableElement;
        for (const row of Array.from(t.rows)) {
          for (const [i, d] of [[from, -60], [to, 60]]) {
            const c = row.cells[i];
            const w = `${parseFloat(c.style.width) + d}px`;
            c.style.width = w;
            c.style.maxWidth = w;
          }
        }
      },
      { from: MITIGATION, to: MITIGATION + 1 }
    );
    const shifted = await widths(page);
    expect(shifted[MITIGATION]).toBeLessThan(fresh[MITIGATION] - 50);
    for (let i = 1; i <= 5; i++) {
      await page.setViewportSize({ width: 1000 + 2 * i, height: 700 });
      await page.waitForTimeout(50);
      expectSame(await widths(page), shifted);
    }
    await expect.poll(async () => (await widths(page))[MITIGATION], { timeout: 1000, intervals: [50] }).toBeGreaterThan(shifted[MITIGATION] + 30);
  });
});
