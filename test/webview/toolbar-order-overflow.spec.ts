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

// collapsePriority per id (smaller = collapses first). Every id'd control is now
// collapsible: left formatting collapses FIRST (1–19), the right utility cluster
// LAST (Focus 20, Outline 21, Reading 22). Only "•••" (.toolbar-more) and the ⋮
// kebab (.toolbar-more-options) never collapse — they have no id and are absent.
const PRIORITY: Record<string, number> = {
  'fmt-mermaid': 1, 'fmt-math': 2, 'fmt-codeblock': 3, 'fmt-hr': 4, 'fmt-table': 5,
  'fmt-blockquote': 6, 'fmt-task': 7, 'fmt-clear': 8, 'fmt-inline-code': 9,
  'fmt-strike': 10, 'fmt-italic': 11, 'fmt-bold': 12, 'fmt-numbered': 13,
  'fmt-bullet': 14, 'fmt-image': 15, 'fmt-link': 16, 'fmt-heading': 17,
  'fmt-redo': 18, 'fmt-undo': 19, 'zen-toggle': 20, 'toc-toggle': 21, 'reading-toggle': 22,
};

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

test('an extremely narrow toolbar collapses EVERY control into "•••", leaving only "•••" and the ⋮ kebab', async ({ page }) => {
  // 200px: even the right utility cluster (Reading/Focus/Outline) has collapsed.
  // The only always-visible controls are "•••" (overflow menu) and the ⋮ kebab.
  await page.setViewportSize({ width: 200, height: 800 });
  await openEditor(page, '# hi');

  await expect(page.locator('.toolbar-more')).toBeVisible();
  await expect(page.locator('.toolbar-more-options')).toBeVisible();
  for (const id of Object.keys(PRIORITY)) {
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
});

test('the right utility cluster (Reading/Focus/Outline) survives longer than the left formatting controls', async ({ page }) => {
  // At a mid-narrow width the left formatting buttons collapse first while the
  // higher-priority right cluster stays visible — the requested hide order.
  await page.setViewportSize({ width: 400, height: 800 });
  await openEditor(page, '# hi');

  await expect(page.locator('.toolbar-more')).toBeVisible();
  // A low-priority left formatting control is gone...
  await expect(page.locator('#fmt-mermaid')).toBeHidden();
  await expect(page.locator('#fmt-bold')).toBeHidden();
  // ...while the whole right cluster + kebab remain.
  for (const id of ['reading-toggle', 'zen-toggle', 'toc-toggle']) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
  await expect(page.locator('.toolbar-more-options')).toBeVisible();
});

test('the ⋮ kebab stays inside the visible toolbar band at every width (hidden last)', async ({ page }) => {
  await openEditor(page, '# hi');

  // The kebab (createMoreOptionsButton) is the .toolbar-more-options button. It
  // is the last DOM child, so without the sticky pin it is the FIRST thing the
  // toolbar's overflow:hidden clips off the right edge. Assert it never leaves
  // the toolbar's content-box band, even when the right cluster overflows.
  for (const width of [1400, 340, 220]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const tb = document.getElementById('toolbar')!;
          const kebab = tb.querySelector('.toolbar-more-options') as HTMLElement;
          const tbr = tb.getBoundingClientRect();
          const kr = kebab.getBoundingClientRect();
          const cs = getComputedStyle(tb);
          const padL = parseFloat(cs.paddingLeft);
          const padR = parseFloat(cs.paddingRight);
          // In-band: within the toolbar content box (inside its horizontal padding).
          return kr.width > 0 && kr.left >= tbr.left + padL - 1 && kr.right <= tbr.right - padR + 1;
        }),
      )
      .toBe(true);
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
