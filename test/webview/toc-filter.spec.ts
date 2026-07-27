/**
 * US-10.6: TOC heading-level filter — filters .toc-item entries by heading level,
 * persists per-tab via vscode.setState() (tocMaxLevel), and falls scrollspy back
 * to the nearest visible ancestor when the actual nearest heading is filtered out.
 * US-10.8 moved the control itself out of the header (3 in-panel pills) into the
 * dock's `⋯` overflow menu under an "Outline depth" section; every behaviour below
 * is unchanged, only the surface the test drives it through moved. Also a
 * regression check for bug 0716 #7 (TOC drag & drop removed entirely): dragging a
 * .toc-item must no longer reorder document headings.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit, openDepthMenu, setDepth, expectActiveDepth } from './_harness';

/** Paragraph filler so the document is tall enough to actually scroll. */
function filler(section: string, lines = 30): string {
  return Array.from({ length: lines }, (_, i) => `${section} filler line ${i + 1}.`).join('\n\n');
}

// level<=2 heading count is 4 (H1 A, H2 A1, H2 A2, H1 B) — well under the
// >20 smart-fallback threshold, so the default depth is always 3.
const DOC = `# H1 A

${filler('A')}

## H2 A1

${filler('A1')}

### H3 A1a

${filler('A1a')}

## H2 A2

${filler('A2')}

# H1 B

${filler('B')}
`;

async function openToc(page: Page, markdown = DOC): Promise<void> {
  await openEditor(page, markdown);
  // force: true — #toc-toggle is one of many toolbar buttons subject to the
  // toolbar's own width-based overflow logic (unrelated to this feature); under
  // parallel test workers its ResizeObserver recalc can lag, transiently
  // reporting the button "outside the viewport". force bypasses that
  // actionability wait and dispatches the click directly.
  await page.locator('#toc-toggle').click({ force: true });
}

test('defaults to H1-H2-H3 (level 3) when heading count is below the smart-fallback threshold', async ({ page }) => {
  await openToc(page);
  await expectActiveDepth(page, 3);
  // All five headings visible at the H1–H2–H3 default: H1 A, H2 A1, H3 A1a, H2 A2, H1 B.
  await expect(page.locator('.toc-item')).toHaveCount(5);
  await expect(page.locator('.toc-item.toc-level-3')).toHaveCount(1);
});

test('smart-fallback: a dense doc (>20 H1–H3 headings) defaults to H2, not H1 or H3', async ({ page }) => {
  // 1 H1 + 10 H2 + 10 H3 = 21 headings at level<=3 (>20) but only 11 at
  // level<=2. So the fallback must key off the level<=3 count and step the
  // default down to H2 — showing the H1+H2 (11) and hiding every H3.
  const dense =
    `# Top\n\n${filler('T', 2)}\n\n` +
    Array.from({ length: 10 }, (_, i) => `## Sec ${i + 1}\n\n${filler('S', 2)}\n\n### Sub ${i + 1}\n\n${filler('s', 2)}`).join(
      '\n\n'
    );
  await openToc(page, dense);

  await expectActiveDepth(page, 2);
  await expect(page.locator('.toc-item.toc-level-3')).toHaveCount(0);
  await expect(page.locator('.toc-item')).toHaveCount(11); // 1 H1 + 10 H2
});

test('picking each Outline depth row filters visible .toc-item entries by level', async ({ page }) => {
  await openToc(page);

  await setDepth(page, 1);
  await expect(page.locator('.toc-item')).toHaveCount(2); // H1 A, H1 B
  await expect(page.locator('.toc-item.toc-level-2')).toHaveCount(0);
  await expect(page.locator('.toc-item.toc-level-3')).toHaveCount(0);

  await setDepth(page, 2);
  await expect(page.locator('.toc-item')).toHaveCount(4);
  await expect(page.locator('.toc-item.toc-level-3')).toHaveCount(0);

  await setDepth(page, 3);
  await expect(page.locator('.toc-item')).toHaveCount(5);
  await expect(page.locator('.toc-item.toc-level-3')).toHaveCount(1);
});

test('scrolling to an H3 while filtered to H1-H2 highlights the nearest visible ancestor', async ({ page }) => {
  await openToc(page);
  // H1–H2–H3 is the default now, so narrow to H1–H2 to hide the H3 under test.
  await setDepth(page, 2);
  await expectActiveDepth(page, 2);

  await page.locator('h3', { hasText: 'H3 A1a' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));

  await expect(page.locator('.toc-item.active')).toHaveText('H2 A1');
});

test('editing content triggers a debounced rebuild and the filter level is preserved', async ({ page }) => {
  await openToc(page);
  await setDepth(page, 1);
  await expect(page.locator('.toc-item')).toHaveCount(2);

  await clearPosted(page);
  await page.locator('#content p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' extra text');
  await waitForEdit(page); // scheduleSync + toc.refresh() share the same 250ms debounce window

  await expectActiveDepth(page, 1);
  await expect(page.locator('.toc-item')).toHaveCount(2);
});

test('the depth menu is fully keyboard-operable and hands focus back to the ⋯ button', async ({ page }) => {
  await openToc(page);
  const focused = (): Promise<string> => page.evaluate(() => document.activeElement?.textContent ?? '');

  // Opening focuses the CHECKED row (default H1–H2–H3), not blindly the first —
  // a single-select menu opens at its current value.
  await page.locator('.right-dock-menu-btn').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.right-dock-menu')).toBeVisible();
  expect(await focused()).toMatch(/H1–H2–H3$/);

  // ↑/↓ traverse and wrap; Home/End jump. None of them may scroll the document
  // behind the open menu, which is what an unhandled arrow key would do.
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toMatch(/H1$/); // wrapped past the last row
  await page.keyboard.press('ArrowUp');
  expect(await focused()).toMatch(/H1–H2–H3$/);
  await page.keyboard.press('Home');
  expect(await focused()).toMatch(/H1$/);
  await page.keyboard.press('End');
  expect(await focused()).toMatch(/H1–H2–H3$/);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // Enter on a row applies it. Focus must land back on the ⋯ button — it lives in
  // the strip, i.e. inside #toc-panel, which is what keeps the dock's own Escape
  // handler (it requires focus inside the panel) alive after a menu interaction.
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.locator('.right-dock-menu')).toBeHidden();
  await expect(page.locator('.right-dock-menu-btn')).toBeFocused();
  await expect(page.locator('.toc-item')).toHaveCount(2); // H1 A, H1 B

  // Escape takes the menu first, then the panel — only reachable because focus
  // came back inside the panel above.
  await openDepthMenu(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.right-dock-menu')).toBeHidden();
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '300px');
  await page.keyboard.press('Escape');
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '0px');
});

test('a .toc-item is not natively draggable (no native link-drag ghost)', async ({ page }) => {
  await openToc(page);
  const draggable = await page.locator('.toc-item').first().evaluate((el) => (el as HTMLAnchorElement).draggable);
  expect(draggable).toBe(false);
});

test('mousedown+move on a .toc-item no longer reorders headings (TOC-drag removed)', async ({ page }) => {
  await openToc(page);
  await setDepth(page, 3);
  await expect(page.locator('.toc-item')).toHaveCount(5);

  const headingsBefore = await page.locator('#content :is(h1, h2, h3)').allTextContents();

  const first = page.locator('.toc-item').first();
  const box = await first.boundingBox();
  if (!box) {
    throw new Error('TOC item has no bounding box');
  }
  await clearPosted(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 3 + 40, { steps: 10 });
  await page.mouse.up();

  // Give any (would-be) debounced sync a chance to fire, then confirm none did.
  await page.waitForTimeout(400);
  const posted = await page.evaluate(() => (window as unknown as { __posted: Array<{ type: string }> }).__posted);
  expect(posted.filter((m) => m.type === 'edit')).toHaveLength(0);

  const headingsAfter = await page.locator('#content :is(h1, h2, h3)').allTextContents();
  expect(headingsAfter).toEqual(headingsBefore);
});
