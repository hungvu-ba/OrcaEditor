/**
 * US-4.24 — toolbar control order (wireframe) + overflow-collapse priority.
 * Needs a real engine: order is real DOM, and the collapse is ResizeObserver-
 * driven layout reacting to viewport width — not reproducible from a snapshot.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

// Full wireframe order (US-4.24). ids live on plain buttons and on split-buttons'
// `.split-main`. The "•••" more button (.toolbar-more) has no id and is excluded.
const EXPECTED_ORDER = [
  'fmt-undo', 'fmt-redo',
  'fmt-bold', 'fmt-italic', 'fmt-strike', 'fmt-inline-code', 'fmt-clear',
  'fmt-heading',
  'fmt-bullet', 'fmt-numbered', 'fmt-task', 'fmt-blockquote',
  'fmt-table', 'fmt-hr',
  'fmt-link', 'fmt-image',
  'fmt-codeblock', 'fmt-math', 'fmt-mermaid',
  'reading-toggle', 'zen-toggle', 'toc-toggle',
];

// collapsePriority per id (smaller = collapses first). Pinned ids are absent.
const PRIORITY: Record<string, number> = {
  'fmt-mermaid': 1, 'fmt-math': 2, 'fmt-codeblock': 3, 'fmt-hr': 4, 'fmt-table': 5,
  'fmt-blockquote': 6, 'fmt-task': 7, 'fmt-clear': 8, 'fmt-inline-code': 9,
  'fmt-strike': 10, 'zen-toggle': 11,
};
const PINNED = ['fmt-undo', 'fmt-redo', 'fmt-bold', 'fmt-italic', 'fmt-heading', 'fmt-bullet', 'fmt-numbered', 'fmt-link', 'fmt-image', 'reading-toggle', 'toc-toggle'];

test('controls appear in the wireframe order at rest', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await openEditor(page, '# hi');

  const ids = await page.evaluate(() => {
    const known = new Set([
      'fmt-undo', 'fmt-redo', 'fmt-bold', 'fmt-italic', 'fmt-strike', 'fmt-inline-code', 'fmt-clear',
      'fmt-heading', 'fmt-bullet', 'fmt-numbered', 'fmt-task', 'fmt-blockquote', 'fmt-table', 'fmt-hr',
      'fmt-link', 'fmt-image', 'fmt-codeblock', 'fmt-math', 'fmt-mermaid', 'reading-toggle', 'zen-toggle', 'toc-toggle',
    ]);
    return [...document.querySelectorAll('#toolbar [id]')].map((el) => el.id).filter((id) => known.has(id));
  });

  expect(ids).toEqual(EXPECTED_ORDER);
});

test('a very narrow toolbar collapses every collapsible (incl. Zen) into "•••" and keeps pinned controls', async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 800 });
  await openEditor(page, '# hi');

  await expect(page.locator('.toolbar-more')).toBeVisible();
  for (const id of Object.keys(PRIORITY)) {
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  for (const id of PINNED) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
});

test('collapsibles hide by ascending priority (lowest-priority prefix), and widening restores them', async ({ page }) => {
  await openEditor(page, '# hi');

  // At any partial width the hidden set must be a prefix of the priority order:
  // every hidden item's priority < every still-visible collapsible's priority.
  for (const width of [1000, 820, 680, 560, 460]) {
    await page.setViewportSize({ width, height: 800 });
    // poll (not one-shot evaluate) so the read waits for the ResizeObserver-
    // driven recalcOverflow to settle after the viewport change.
    await expect
      .poll(() =>
        page.evaluate((pri) => {
          const rendered = (id: string) => (document.getElementById(id)?.getClientRects().length ?? 0) > 0;
          const hidden: number[] = [];
          const visible: number[] = [];
          for (const [id, p] of Object.entries(pri)) (rendered(id) ? visible : hidden).push(p as number);
          const maxHidden = hidden.length ? Math.max(...hidden) : -Infinity;
          const minVisible = visible.length ? Math.min(...visible) : Infinity;
          return maxHidden > minVisible; // violation: a low-priority stayed while a higher-priority collapsed
        }, PRIORITY),
      )
      .toBe(false);
  }

  // Widen fully → nothing hidden.
  await page.setViewportSize({ width: 1400, height: 800 });
  for (const id of Object.keys(PRIORITY)) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
});
