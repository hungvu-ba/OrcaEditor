/**
 * The Ctrl/Cmd+F find box is `position: fixed` at z-index 500, so nothing in the
 * flow pushes it down — at the old `top: 6px` it painted straight over the
 * sticky #toolbar and hid its controls. It now clears the toolbar by 6px, which
 * moves it into the band where toolbar dropdowns and the image-zoom button open,
 * so those have to keep winning. Geometry only a real engine can resolve
 * (clamp()/calc() over the runtime-measured --toolbar-height), hence the webview
 * track.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

/** The 6px breathing room authored into `#search-box`'s `top`. */
const GAP_PX = 6;

/** Opens the find box the way a user does (⌘F on macOS, Ctrl+F elsewhere). */
async function openFindBox(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('#search-box')).toBeVisible();
}

/** Live geometry of the two surfaces plus the var the offset is built on. */
function readGeometry(page: Page) {
  return page.evaluate(() => {
    const toolbarEl = document.getElementById('toolbar')!;
    const box = document.getElementById('search-box')!.getBoundingClientRect();
    const toolbar = toolbarEl.getBoundingClientRect();
    return {
      boxTop: box.top,
      boxBottom: box.bottom,
      boxLeft: box.left,
      boxRight: box.right,
      toolbarBottom: toolbar.bottom,
      // offsetHeight, not rect.height: Zen translates the toolbar off-screen.
      toolbarHeight: toolbarEl.offsetHeight,
      cssVar: getComputedStyle(document.documentElement).getPropertyValue('--toolbar-height').trim(),
      viewportHeight: window.innerHeight,
    };
  });
}

test('the find box clears the sticky toolbar by exactly the authored gap', async ({ page }) => {
  await openEditor(page, '# hi\n\nsome text\n');
  await openFindBox(page);
  const r = await readGeometry(page);

  // Exact, not `>=`: the CSS fallback (48px) is LARGER than the real toolbar
  // (~43px), so a `>=` assertion would still pass if syncToolbarHeightVar()
  // (main.ts) stopped publishing --toolbar-height — the very dependency this
  // offset is built on. Pin the var too.
  expect(r.cssVar).toMatch(/^\d+(\.\d+)?px$/);
  expect(parseFloat(r.cssVar)).toBeCloseTo(r.toolbarHeight, 1);
  expect(r.boxTop - r.toolbarBottom).toBeCloseTo(GAP_PX, 1);
});

test('no toolbar button is hidden underneath the open find box, even when the row overflows', async ({ page }) => {
  // Narrow enough that the width-based overflow split (US-4.7) actually fires,
  // so the buttons still on the row are the ones a user can reach directly.
  await page.setViewportSize({ width: 520, height: 720 });
  await openEditor(page, '# hi\n\nsome text\n');
  await expect(page.locator('#toolbar .toolbar-more')).toBeVisible();
  await openFindBox(page);
  const r = await readGeometry(page);

  const covered = await page.evaluate(
    (rect) =>
      [...document.querySelectorAll<HTMLElement>('#toolbar button')]
        .filter((b) => b.offsetParent !== null)
        .filter((b) => {
          // Full rect intersection — a half-open predicate would be satisfied
          // by the toolbar-clearance invariant alone and could never fail.
          const q = b.getBoundingClientRect();
          return q.right > rect.boxLeft && q.left < rect.boxRight && q.bottom > rect.boxTop && q.top < rect.boxBottom;
        })
        // Toolbar buttons label themselves with aria-label (toolbar.ts), and
        // their content is an icon — title/textContent would print "?".
        .map((b) => b.getAttribute('aria-label') || b.id || '?'),
    r
  );
  expect(covered).toEqual([]);
});

test('a toolbar dropdown opened from the keyboard is not swallowed by the find box', async ({ page }) => {
  await openEditor(page, '# hi\n\nsome text\n');
  // Open the menu first, then the box: a mousedown on the trigger closes the
  // box (search.ts click-outside), so this is the order that leaves both open —
  // same end state the keyboard route (Tab to ⋮, Enter) reaches.
  await page.locator('#toolbar .toolbar-more-options').click();
  const menu = page.locator('.toolbar-popover.toolbar-more-options-menu');
  await expect(menu).toBeVisible();
  await openFindBox(page);
  await expect(menu).toBeVisible();

  // The menu anchors at the trigger's `rect.bottom + 4`, i.e. inside the box's
  // band — so hit-testing, not geometry, is the guarantee that matters.
  const ownerOfFirstRow = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('.toolbar-more-options-menu > *')!;
    const q = row.getBoundingClientRect();
    const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
    if (hit?.closest('.toolbar-more-options-menu')) {
      return 'menu';
    }
    return hit?.closest('#search-box') ? 'search-box' : 'neither';
  });
  expect(ownerOfFirstRow).toBe('menu');
});

test('a short pane keeps the whole find box on screen', async ({ page }) => {
  await openEditor(page, '# hi\n\nsome text\n');
  // A horizontal editor split (or high webview zoom) can leave less height than
  // toolbar + box; the clamp trades the gap for staying reachable.
  await page.setViewportSize({ width: 900, height: 70 });
  await openFindBox(page);
  const r = await readGeometry(page);

  expect(r.boxTop).toBeGreaterThanOrEqual(0);
  expect(r.boxBottom).toBeLessThanOrEqual(r.viewportHeight);
});

test('the image-zoom button stays clickable when it is floored into the find box band', async ({ page }) => {
  // Sized images live in the .md as raw <img> HTML; the src need not resolve —
  // width/height still give the broken image a real 800×300 layout box, which is
  // all positionBtn() measures.
  await openEditor(
    page,
    `<img src="assets/wide.png" width="1200" height="300">\n\n${'filler paragraph\n\n'.repeat(40)}`
  );
  const img = page.locator('#content img').first();
  await expect(img).toBeVisible();

  // Scroll the image's top under the toolbar: that is the only state where
  // positionBtn() falls back to its floor instead of tracking the image.
  await page.evaluate(() => window.scrollBy(0, 120));
  await openFindBox(page);
  // Hover near the image's right edge — the button is right-aligned to it — at a
  // y that is inside the viewport, since the image's own top is now above it.
  const imgBox = (await img.boundingBox())!;
  await page.mouse.move(imgBox.x + imgBox.width - 40, 120);
  await expect(page.locator('#img-zoom-btn')).toBeVisible();

  const owner = await page.evaluate(() => {
    const q = document.getElementById('img-zoom-btn')!.getBoundingClientRect();
    const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
    if (hit?.closest('#img-zoom-btn')) {
      return 'zoom';
    }
    return hit?.closest('#search-box') ? 'search-box' : 'neither';
  });
  expect(owner).toBe('zoom');
});

test('Zen keeps the offset so even a revealed toolbar cannot cover the box', async ({ page }) => {
  await openEditor(page, '# hi\n\nsome text\n', {
    readability: { enabled: true, mode: 'sepia', fontFamily: '', zen: true },
  });
  await openFindBox(page);
  const hidden = await readGeometry(page);
  // Zen parks the toolbar off-screen (translateY(-100%)) but keeps its height,
  // and #content reserves that strip — the box sits in it.
  expect(hidden.toolbarHeight).toBeGreaterThan(0);
  expect(hidden.boxTop).toBeGreaterThanOrEqual(hidden.toolbarHeight);

  // Now the state the offset actually exists for: the reveal handler
  // (readability.ts) arms on a deep pointer, then fires near the top edge — a
  // band that includes the box's own rect, so this is reached by simply moving
  // the mouse onto the box.
  await page.mouse.move(400, 400);
  await page.mouse.move(400, 10);
  await expect(page.locator('body')).toHaveClass(/reading-zen-reveal/);
  await expect
    .poll(async () => (await readGeometry(page)).toolbarBottom, { timeout: 2000 })
    .toBeGreaterThan(0); // slid back down

  const revealed = await readGeometry(page);
  expect(revealed.boxTop).toBeGreaterThanOrEqual(revealed.toolbarBottom);
});
