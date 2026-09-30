/**
 * Performance Low-End L-11 (T2.3): the hovered block and the drop gap are found by binary search
 * over the Y-ordered top-level blocks instead of reading every block's rect per frame, and a
 * large table/list drag ghost carries only its first GHOST_MAX_ROWS rows/items.
 *
 * The oracles below are the pre-change linear `findBlockAt` / `gapAt` loops, run against the
 * same blocks: the binary search must pick exactly what they pick (contract 1, behavior-neutral).
 * Real hover/drag dispatch through the rAF-coalesced handlers — not reducible to a hand-built
 * DOM snapshot (Plan/WEBVIEW_TEST.md).
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, waitForEdit, clearPosted } from './_harness';

const BLOCK_HANDLE_SELECTOR =
  '.dd-handle:not(.dd-li-handle):not(.dd-row-handle):not(.dd-col-handle):not(.dd-table-handle)';

/** Max getBoundingClientRect calls in one hover or drag frame — a linear scan of this doc reads ~1000+. */
const RECT_READS_PER_FRAME_MAX = 60;

/** 2000 paragraphs with a heading every 50 (2040 blocks), then a 300-item list and a 300-row table. */
function bigDoc(): string {
  const parts: string[] = [];
  for (let i = 0; i < 2000; i++) {
    if (i % 50 === 0) {
      parts.push(`## Section ${i / 50}`);
    }
    parts.push(`Para ${i} text.`);
  }
  parts.push(Array.from({ length: 300 }, (_, i) => `- Item ${i}`).join('\n'));
  parts.push(
    ['| Col A | Col B |', '| --- | --- |', ...Array.from({ length: 300 }, (_, i) => `| a${i} | b${i} |`)].join('\n')
  );
  return parts.join('\n\n') + '\n';
}

interface Probes {
  rectReads: number;
  blocks(): HTMLElement[];
  oracleFindBlockAt(y: number): number;
  oracleGapAt(y: number): number;
}

/** Installs the pre-change oracles and a getBoundingClientRect call counter on `window.__dd`. */
async function installProbes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const orig = Element.prototype.getBoundingClientRect;
    const content = document.getElementById('content') as HTMLElement;
    const probes: Probes = {
      rectReads: 0,
      blocks: () =>
        (Array.from(content.children) as HTMLElement[]).filter(
          (el) => el.hasAttribute('data-line') || el.querySelector('[data-line]') !== null
        ),
      // Pre-change findBlockAt: first non-table block whose rect spans y.
      oracleFindBlockAt(y) {
        const blocks = probes.blocks();
        for (let i = 0; i < blocks.length; i++) {
          if (blocks[i].tagName === 'TABLE') {
            continue;
          }
          const r = orig.call(blocks[i]);
          if (y >= r.top && y <= r.bottom) {
            return i;
          }
        }
        return -1;
      },
      // Pre-change gapAt.
      oracleGapAt(y) {
        const blocks = probes.blocks();
        for (let i = 0; i < blocks.length; i++) {
          const r = orig.call(blocks[i]);
          if (y < r.top + r.height / 2) {
            return i;
          }
        }
        return blocks.length;
      },
    };
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      probes.rectReads++;
      return orig.call(this);
    };
    (window as unknown as { __dd: Probes }).__dd = probes;
  });
}

/** Two frames: the hover/drag rAF armed by the last mouse event has run. */
async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  );
}

async function scrollBlockToCenter(page: Page, index: number): Promise<void> {
  await page.evaluate((i) => {
    (window as unknown as { __dd: Probes }).__dd.blocks()[i].scrollIntoView({ block: 'center' });
  }, index);
}

/** Scrolls block `index`'s top edge to 200 px below the viewport top (clear of the toolbar). */
async function scrollBlockTopIntoView(page: Page, index: number): Promise<void> {
  await page.evaluate((i) => {
    (window as unknown as { __dd: Probes }).__dd.blocks()[i].scrollIntoView({ block: 'start' });
    window.scrollBy(0, -200);
  }, index);
}

async function resetRectReads(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __dd: Probes }).__dd.rectReads = 0;
  });
}

async function rectReads(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __dd: Probes }).__dd.rectReads);
}

async function blockBox(page: Page, index: number): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate((i) => {
    const r = (window as unknown as { __dd: Probes }).__dd.blocks()[i].getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, index);
}

async function blockText(page: Page, index: number): Promise<string> {
  return page.evaluate((i) => (window as unknown as { __dd: Probes }).__dd.blocks()[i].textContent ?? '', index);
}

/** Hovers 40 y positions across the viewport around block `centerIndex` and checks each hover
 * against the oracle's pick: the block handle shows at the picked block's top (a heading's
 * handle spans its section, which starts at the heading), and is hidden when nothing is picked. */
async function sweepAgainstOracle(page: Page, centerIndex: number): Promise<void> {
  await scrollBlockToCenter(page, centerIndex);
  const { x } = await blockBox(page, centerIndex);
  const viewportHeight = page.viewportSize()?.height ?? 720;
  let hits = 0;
  for (let k = 0; k < 40; k++) {
    // Whole pixels: the event's clientY is what both the handler and the oracle see.
    const y = Math.round(80 + ((viewportHeight - 100) * k) / 39);
    await page.mouse.move(x + 20, y);
    await nextFrame(page);
    const { pick, pickTop, handleDisplay, handleTop } = await page.evaluate(
      ({ py, sel }) => {
        const dd = (window as unknown as { __dd: Probes }).__dd;
        const at = dd.oracleFindBlockAt(py);
        const handle = document.querySelector(sel) as HTMLElement;
        return {
          pick: at,
          pickTop: at >= 0 ? dd.blocks()[at].getBoundingClientRect().top : NaN,
          handleDisplay: handle.style.display,
          handleTop: parseFloat(handle.style.top),
        };
      },
      { py: y, sel: BLOCK_HANDLE_SELECTOR }
    );
    if (pick < 0) {
      expect(handleDisplay, `y=${y}: oracle picks nothing`).toBe('none');
      continue;
    }
    hits++;
    expect(handleDisplay, `y=${y}: oracle picks block ${pick}`).toBe('flex');
    expect(Math.abs(handleTop - pickTop), `y=${y}: handle at block ${pick}'s top`).toBeLessThan(0.5);
  }
  expect(hits, 'the sweep must land on real blocks').toBeGreaterThan(10);
}

test.beforeEach(async ({ page }) => {
  await openEditor(page, bigDoc());
  await installProbes(page);
});

test('hover picks the same block as the linear scan at the top, middle and bottom of a 2000-block doc', async ({
  page,
}) => {
  await sweepAgainstOracle(page, 12);
  await sweepAgainstOracle(page, 1000);
  await sweepAgainstOracle(page, 2025);
});

test('a display:none block in the middle of the doc does not break the hover pick', async ({ page }) => {
  // The binary search's first probe lands exactly on this block.
  const hidden = await page.evaluate(() => {
    const blocks = (window as unknown as { __dd: Probes }).__dd.blocks();
    const i = blocks.length >>> 1;
    blocks[i].style.display = 'none';
    return i;
  });
  await sweepAgainstOracle(page, hidden - 1);
});

test('hovering a table body cell shows no block handle', async ({ page }) => {
  const tableIndex = await page.evaluate(() =>
    (window as unknown as { __dd: Probes }).__dd.blocks().findIndex((b) => b.tagName === 'TABLE')
  );
  // The last paragraph shows the block handle first, so hiding it is observable.
  await scrollBlockToCenter(page, tableIndex - 2);
  const above = await blockBox(page, tableIndex - 2);
  await page.mouse.move(above.x + 20, above.y + above.height / 2);
  await expect(page.locator(BLOCK_HANDLE_SELECTOR)).toHaveCSS('display', 'flex');
  await scrollBlockTopIntoView(page, tableIndex);

  const cell = page.locator('td', { hasText: /^a5$/ });
  const cellBox = await cell.boundingBox();
  if (!cellBox) {
    throw new Error('table cell has no bounding box');
  }
  await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2);
  await nextFrame(page);
  await expect(page.locator(BLOCK_HANDLE_SELECTOR)).toHaveCSS('display', 'none');
});

test('a hover frame reads at most a few dozen rects', async ({ page }) => {
  await scrollBlockToCenter(page, 1000);
  const a = await blockBox(page, 1000);
  const b = await blockBox(page, 1001);
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await nextFrame(page);
  await resetRectReads(page);
  await page.mouse.move(b.x + 20, b.y + b.height / 2);
  await nextFrame(page);
  const reads = await rectReads(page);
  console.log(`[T2.3] getBoundingClientRect calls per hover frame (block 1000 -> 1001): ${reads}`);
  expect(reads).toBeLessThanOrEqual(RECT_READS_PER_FRAME_MAX);
  await expect(page.locator(BLOCK_HANDLE_SELECTOR)).toHaveCSS('display', 'flex');
});

test('dragging a mid-doc paragraph down past 3 blocks drops at the linear gapAt pick, reading few rects per frame', async ({
  page,
}) => {
  const src = 1000;
  await scrollBlockToCenter(page, src);
  const srcBox = await blockBox(page, src);
  await page.mouse.move(srcBox.x + 20, srcBox.y + srcBox.height / 2);
  const handle = page.locator(BLOCK_HANDLE_SELECTOR);
  await expect(handle).toHaveCSS('display', 'flex');
  const handleBox = await handle.boundingBox();
  if (!handleBox) {
    throw new Error('block handle has no bounding box');
  }
  const hx = handleBox.x + handleBox.width / 2;
  const target = await blockBox(page, src + 3);
  const dropY = target.y + target.height * 0.3;

  await clearPosted(page);
  await page.mouse.move(hx, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(hx, dropY - 6, { steps: 10 });
  await nextFrame(page);
  await resetRectReads(page);
  await page.mouse.move(hx, dropY);
  await nextFrame(page);
  const reads = await rectReads(page);
  console.log(`[T2.3] getBoundingClientRect calls per drag frame: ${reads}`);
  const gap = await page.evaluate((y) => (window as unknown as { __dd: Probes }).__dd.oracleGapAt(y), dropY);
  const [moved, before, after] = await Promise.all([
    blockText(page, src),
    blockText(page, gap - 1),
    blockText(page, gap),
  ]);
  await page.mouse.up();

  expect(reads).toBeLessThanOrEqual(RECT_READS_PER_FRAME_MAX);
  expect(gap, 'the drop lands below the source').toBeGreaterThan(src + 1);
  const md = await waitForEdit(page);
  const at = (needle: string): number => {
    const i = md.indexOf(needle);
    expect(i, `"${needle}" is missing from the serialized markdown`).toBeGreaterThanOrEqual(0);
    return i;
  };
  expect(at(moved)).toBeGreaterThan(at(before));
  expect(at(moved)).toBeLessThan(at(after));
});

test('a 300-row table drag ghost carries the header and at most 10 body rows, at the table width', async ({
  page,
}) => {
  const tableIndex = await page.evaluate(() =>
    (window as unknown as { __dd: Probes }).__dd.blocks().findIndex((b) => b.tagName === 'TABLE')
  );
  await scrollBlockTopIntoView(page, tableIndex);
  const tableBox = await blockBox(page, tableIndex);
  await page.mouse.move(tableBox.x + 2, tableBox.y + 2);
  const tableHandle = page.locator('.dd-table-handle');
  await expect(tableHandle).toHaveCSS('display', 'flex');
  const handleBox = await tableHandle.boundingBox();
  if (!handleBox) {
    throw new Error('table handle has no bounding box');
  }
  const hx = handleBox.x + handleBox.width / 2;
  const hy = handleBox.y + handleBox.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx, hy - 60, { steps: 5 });

  const ghost = page.locator('.dd-ghost', { has: page.locator('thead') });
  await expect(ghost).toHaveCSS('display', 'block');
  await expect(ghost.locator('thead tr')).toHaveCount(1);
  const bodyRows = await ghost.locator('tbody tr').count();
  expect(bodyRows).toBeGreaterThan(0);
  expect(bodyRows).toBeLessThanOrEqual(10);
  const ghostBox = await ghost.boundingBox();
  if (!ghostBox) {
    throw new Error('ghost has no bounding box');
  }
  expect(Math.abs(ghostBox.width - tableBox.width)).toBeLessThanOrEqual(1);
  await page.mouse.up();
});

test('a 300-item list drag ghost carries at most 10 items', async ({ page }) => {
  const listIndex = await page.evaluate(() =>
    (window as unknown as { __dd: Probes }).__dd.blocks().findIndex((b) => b.tagName === 'UL')
  );
  await scrollBlockTopIntoView(page, listIndex);
  const item = page.locator('li', { hasText: /^Item 1$/ });
  const itemBox = await item.boundingBox();
  if (!itemBox) {
    throw new Error('list item has no bounding box');
  }
  await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2);
  // Surface the whole-list block handle by moving left out of #content.
  await page.mouse.move(-50, itemBox.y + itemBox.height / 2);
  const handle = page.locator(BLOCK_HANDLE_SELECTOR);
  await expect(handle).toHaveCSS('display', 'flex');
  const handleBox = await handle.boundingBox();
  if (!handleBox) {
    throw new Error('block handle has no bounding box');
  }
  const hx = handleBox.x + handleBox.width / 2;
  // The whole-list handle spans all 300 items; grab it near its top, inside the viewport.
  const hy = handleBox.y + 10;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx, hy - 60, { steps: 5 });

  const ghost = page.locator('.dd-ghost', { has: page.locator('li') });
  await expect(ghost).toHaveCSS('display', 'block');
  const items = await ghost.locator('li').count();
  expect(items).toBeGreaterThan(0);
  expect(items).toBeLessThanOrEqual(10);
  await page.mouse.up();
});
