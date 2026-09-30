/**
 * Audit C-2 / T3.4: the mermaid rendered-SVG cache is a 32-entry LRU. mermaid.ts
 * mints a fresh `md-mermaid-svg-<n>` id only after a cache MISS and hands it to
 * the SVG root, so a re-rendered block whose SVG keeps its old id was a cache
 * HIT and one that gets a new id was a miss (evicted). PlantUML shares the same
 * recallSvg/rememberSvg helpers; it is not repeated here because each PlantUML
 * render costs a WASM engine round trip.
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
  return (await svg.getAttribute('id')) ?? '';
}

test('mermaid SVG cache keeps 32 entries, least recently used out', async ({ page }) => {
  test.slow();
  const blocks = Array.from({ length: BLOCK_COUNT }, (_, i) => block(i + 1));
  await openEditor(page, blocks.join('\n'));
  await expect(page.locator('.md-mermaid-chart svg')).toHaveCount(BLOCK_COUNT, { timeout: 60000 });

  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.md-mermaid-chart svg')).map((s) => s.id)
  );
  expect(ids.every((id) => /^md-mermaid-svg-\d+$/.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(BLOCK_COUNT);

  // Blocks 2..33 are cached; block 1 was pushed out by block 33.
  expect(await showOnly(page, 1)).not.toBe(ids[0]); // miss -> fresh id (evicts block 2)
  expect(await showOnly(page, 33)).toBe(ids[32]); // hit -> old id kept
});

test('a cache hit refreshes recency, so the touched entry outlives older ones', async ({ page }) => {
  test.slow();
  const blocks = Array.from({ length: BLOCK_COUNT }, (_, i) => block(i + 1));
  await openEditor(page, blocks.join('\n'));
  await expect(page.locator('.md-mermaid-chart svg')).toHaveCount(BLOCK_COUNT, { timeout: 60000 });

  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.md-mermaid-chart svg')).map((s) => s.id)
  );

  // Cache holds 2..33 (oldest = 2). Touching 2 makes 3 the oldest.
  expect(await showOnly(page, 2)).toBe(ids[1]); // hit, refreshes block 2
  expect(await showOnly(page, 1)).not.toBe(ids[0]); // miss, evicts block 3 (not 2)
  expect(await showOnly(page, 2)).toBe(ids[1]); // still cached
  expect(await showOnly(page, 3)).not.toBe(ids[2]); // was evicted
});
