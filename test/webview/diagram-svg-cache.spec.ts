/**
 * Audit C-2 / T3.4: the mermaid rendered-SVG cache is an LRU of max(32, diagrams
 * on screen) entries. mermaid.ts mints a fresh `md-mermaid-svg-<n>` id only after
 * a cache MISS and hands it to the SVG root, so a re-rendered block whose SVG
 * keeps its old id was a cache HIT and one that gets a new id was a miss
 * (evicted). PlantUML shares the same recallSvg/rememberSvg helpers; it is not
 * repeated here because each PlantUML render costs a WASM engine round trip.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

type Page = import('@playwright/test').Page;

const BLOCK_COUNT = 33;

const block = (n: number): string => '```mermaid\ngraph TD; A-->B' + n + '\n```\n';

/** Simulate the host pushing a re-render (same channel provider.ts uses). */
async function pushUpdate(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => window.postMessage({ type: 'update', text: t }, '*'), text);
}

/**
 * Show only block `n`, wait until its SVG is on screen, return the SVG root id.
 * Clears the diagrams first so the block is a fresh node, not one the patched
 * update keeps as-is (which would keep its id whatever the cache holds).
 */
async function showOnly(page: Page, n: number): Promise<string> {
  await pushUpdate(page, 'No diagrams\n');
  await expect(page.locator('.md-mermaid-chart svg')).toHaveCount(0);
  await pushUpdate(page, block(n));
  const svg = page.locator('.md-mermaid-chart svg');
  await expect(svg).toHaveCount(1);
  await expect(svg).toContainText('B' + n);
  const id = await svg.getAttribute('id');
  expect(id).toMatch(/^md-mermaid-svg-\d+$/);
  return id ?? '';
}

/** SVG root ids of every mermaid chart, in document order. */
async function svgIds(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('.md-mermaid-chart svg')).map((s) => s.id));
}

test('mermaid SVG cache keeps every diagram on screen, then 32 entries, least recently used out', async ({ page }) => {
  test.slow();
  const blocks = Array.from({ length: BLOCK_COUNT }, (_, i) => block(i + 1));
  await openEditor(page, blocks.join('\n'));
  await expect(page.locator('.md-mermaid-chart svg')).toHaveCount(BLOCK_COUNT, { timeout: 60000 });

  const ids = await svgIds(page);
  expect(ids.every((id) => /^md-mermaid-svg-\d+$/.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(BLOCK_COUNT);

  // All 33 were on screen, so none was evicted.
  expect(await showOnly(page, 1)).toBe(ids[0]); // hit -> old id kept, refreshes block 1
  // One diagram on screen now: a new source trims the cache to 32 (blocks 2 and 3 out).
  await showOnly(page, BLOCK_COUNT + 1);
  expect(await showOnly(page, 2)).not.toBe(ids[1]); // miss -> fresh id
  expect(await showOnly(page, 1)).toBe(ids[0]); // refreshed, still cached
});

test('a cache hit refreshes recency, so the touched entry outlives older ones', async ({ page }) => {
  test.slow();
  const blocks = Array.from({ length: BLOCK_COUNT }, (_, i) => block(i + 1));
  await openEditor(page, blocks.join('\n'));
  await expect(page.locator('.md-mermaid-chart svg')).toHaveCount(BLOCK_COUNT, { timeout: 60000 });

  const ids = await svgIds(page);

  // Cache holds 1..33 (oldest = 1). Touching 2 makes 3 the second oldest.
  expect(await showOnly(page, 2)).toBe(ids[1]); // hit, refreshes block 2
  await showOnly(page, BLOCK_COUNT + 1); // new source: evicts 1 and 3 (not 2)
  expect(await showOnly(page, 2)).toBe(ids[1]); // still cached
  expect(await showOnly(page, 3)).not.toBe(ids[2]); // was evicted
});

test('a document with more than 32 diagrams re-renders none of them on host updates or paste', async ({ page }) => {
  test.slow();
  const count = 40;
  const doc = Array.from({ length: count }, (_, i) => block(i + 1)).join('\n');
  const svgs = page.locator('.md-mermaid-chart svg');
  await openEditor(page, doc + '\nedit 0\n');
  await expect(svgs).toHaveCount(count, { timeout: 60000 });
  const ids = await svgIds(page);
  const changed = (now: string[]): number[] => ids.flatMap((id, i) => (now[i] === id ? [] : [i + 1]));

  // Undo / external-change shape: the first update replaces the blocks whose first
  // SVG landed after the observer reconnected; neither may re-run the engine.
  for (const n of [1, 2]) {
    await pushUpdate(page, doc + '\nedit ' + n + '\n');
    await expect(page.locator('#content > p').last()).toHaveText('edit ' + n);
    await expect(svgs).toHaveCount(count);
    expect(changed(await svgIds(page))).toEqual([]);
  }

  // Paste a new diagram at the end: renderAll walks every chart in document order
  // and the engine renders in call order, so once the pasted one lands, any
  // re-render of an existing chart has landed too.
  await page.locator('#content > p').last().evaluate((p) => {
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    (p.closest('#content') as HTMLElement).focus();
  });
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '```mermaid\ngraph TD; A-->Pasted\n```\n');
    document.getElementById('content')!.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    );
  });
  await expect(svgs).toHaveCount(count + 1);
  await expect(svgs.last()).toContainText('Pasted');
  expect(changed((await svgIds(page)).slice(0, count))).toEqual([]);
});
