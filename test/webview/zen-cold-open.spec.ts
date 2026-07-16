/**
 * Bug 0716 #1 regression: cold-opening a file with Zen mode already ON must
 * not visibly animate the toolbar (appear, then slide away). Root cause was a
 * CSS-load-order race — `body.reading-zen #toolbar` (editor.css) bundles the
 * hidden `transform` AND its `transition` in one external-stylesheet rule, so
 * if that stylesheet applied after first paint, the browser treated the
 * already-baked `reading-zen` class as a live change and animated it. The fix
 * bakes the toolbar's hidden state as an inline style (provider.ts's
 * getHtml(), mirrored in _harness.ts) so first paint never depends on
 * external-CSS timing. A `transitionrun` listener attached via
 * page.addInitScript (runs before any page script, catches events from the
 * very first frame) is the proxy for "did an animation play."
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

async function watchToolbarTransitions(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __toolbarTransitions: string[] }).__toolbarTransitions = [];
    document.addEventListener(
      'transitionrun',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (target?.id === 'toolbar') {
          (window as unknown as { __toolbarTransitions: string[] }).__toolbarTransitions.push(e.propertyName);
        }
      },
      true
    );
  });
}

function readToolbarTransitions(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __toolbarTransitions: string[] }).__toolbarTransitions);
}

test('cold-opening with Zen already ON does not animate the toolbar', async ({ page }) => {
  await watchToolbarTransitions(page);
  await openEditor(page, 'hello world', {
    readability: { enabled: false, preset: 'default', palette: 'followTheme', fontFamily: '', zen: true },
  });

  // Baked at first paint — must already be hidden (a real translateY matrix,
  // never the identity 'none'), no transition needed to get there.
  await expect(page.locator('#toolbar')).not.toHaveCSS('transform', 'none');
  expect(await readToolbarTransitions(page)).toEqual([]);
});

test('exiting Zen after a cold-open reveals the toolbar again (inline seed must not stick)', async ({ page }) => {
  await openEditor(page, 'hello world', {
    readability: { enabled: false, preset: 'default', palette: 'followTheme', fontFamily: '', zen: true },
  });
  // Wait for the init-handshake to fully settle: applyFromHost()'s no-anim guard lifts, and (the
  // fix under test) the inline style getHtml() baked onto #toolbar is cleared once JS/CSS classes
  // take over — inline style always beats a CSS class rule, so if it were never cleared, no amount
  // of toggling `reading-zen` off would ever make the toolbar visible/clickable again.
  await page.waitForFunction(() => !document.body.classList.contains('reading-no-anim'));
  expect(await page.locator('#toolbar').getAttribute('style')).toBeNull();

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.body.classList.contains('reading-zen'));

  await expect(page.locator('#toolbar')).toHaveCSS('transform', 'none');
  await expect(page.locator('#toolbar')).toHaveCSS('pointer-events', 'auto');
});

test('a live cross-tab Zen toggle after init still animates the toolbar normally', async ({ page }) => {
  await watchToolbarTransitions(page);
  await openEditor(page, 'hello world', {
    readability: { enabled: false, preset: 'default', palette: 'followTheme', fontFamily: '', zen: false },
  });
  // Wait for the init-handshake's no-anim guard to lift (double rAF after applyFromHost) before
  // toggling, so this only asserts on the steady-state cross-tab path, not the cold-open seed.
  await page.waitForFunction(() => !document.body.classList.contains('reading-no-anim'));

  await page.evaluate(() => window.postMessage({ type: 'zenChanged', zen: true }, '*'));
  await page.waitForFunction(
    () => (window as unknown as { __toolbarTransitions: string[] }).__toolbarTransitions.length > 0
  );

  expect(await readToolbarTransitions(page)).toContain('transform');
});
