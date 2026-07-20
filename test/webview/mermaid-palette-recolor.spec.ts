/**
 * Matrix G2 (Phase 4): Mermaid diagram colors follow the READING PALETTE's
 * --rp-* tokens, not a fixed default — recoloring is driven by mermaid.render's
 * async themeVariables and the palette-change → refreshTheme() wiring, so it
 * needs the real webview engine (test/roundtrip/ domino cannot run mermaid.render
 * or dispatch the palette-change message). Also guards the scope rule that the
 * shared lightbox overlay (US-19.22) stays fixed-dark regardless of palette.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('diagram SVG recolors when the reading palette changes', async ({ page }) => {
  await openEditor(page, '```mermaid\ngraph TD; A-->B; B-->C\n```\n', {
    readability: { enabled: true, preset: 'comfortable', palette: 'sepia', fontFamily: '', zen: false },
  });

  const svg = page.locator('.md-mermaid-chart svg');
  await svg.waitFor();
  const sepiaSvg = await svg.evaluate((el) => el.outerHTML);

  // Switch to Paper — a different light palette (same brightness as sepia, so
  // the dark/default mermaid theme name alone would NOT change) but with
  // distinct --rp-* colors, exercising the color-signature re-render path.
  await page.evaluate(() =>
    window.postMessage(
      { type: 'readingModeChanged', enabled: true, preset: 'comfortable', palette: 'paper' },
      '*'
    )
  );
  await expect(page.locator('body')).toHaveClass(/reading-palette-paper/);

  await expect.poll(async () => svg.evaluate((el) => el.outerHTML)).not.toBe(sepiaSvg);
});

test('mermaid lightbox stays fixed-dark across palette changes (US-19.22)', async ({ page }) => {
  await openEditor(page, '```mermaid\ngraph TD; A-->B\n```\n', {
    readability: { enabled: true, preset: 'comfortable', palette: 'dark', fontFamily: '', zen: false },
  });

  await page.locator('.md-mermaid-chart svg').waitFor();
  await page.locator('.md-mermaid-zoom').click();

  const lightbox = page.locator('#md-lightbox');
  await expect(lightbox).toBeVisible();
  await expect(lightbox).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.85)');

  await page.keyboard.press('Escape');
  await expect(lightbox).toBeHidden();

  // Switch to a light palette and re-open the lightbox — overlay must not have
  // picked up any --rp-* palette color.
  await page.evaluate(() =>
    window.postMessage(
      { type: 'readingModeChanged', enabled: true, preset: 'comfortable', palette: 'paper' },
      '*'
    )
  );
  await expect(page.locator('body')).toHaveClass(/reading-palette-paper/);

  await page.locator('.md-mermaid-zoom').click();
  await expect(lightbox).toBeVisible();
  await expect(lightbox).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.85)');
});
