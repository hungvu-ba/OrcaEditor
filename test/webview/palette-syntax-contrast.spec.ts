/**
 * bug_General #7: code-block syntax highlighting and Mermaid diagrams must
 * follow the active READING PALETTE, not just the VS Code theme. On a dark VS
 * Code theme with a light palette (Sepia), both used to keep dark-optimized
 * (light-on-dark) colors on a light background → washed out.
 *
 * Both cases need the real webview engine: hljs runs in the real render
 * pipeline, mermaid.render is async, and the palette switch drives the real
 * apply() → refreshTheme() wiring — a hand-built DOM snapshot can't exercise
 * them. `vscode-dark` is injected before bootstrap so it is present at first
 * render, reproducing the exact "dark theme + light palette" mismatch.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

/** Simulate a dark VS Code theme: the class must exist before the webview renders. */
async function simulateDarkVsCodeTheme(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => document.body.classList.add('vscode-dark'));
  });
}

test('code-block syntax colors follow a light palette on a dark VS Code theme', async ({ page }) => {
  await simulateDarkVsCodeTheme(page);
  await openEditor(page, '```js\nconst x = 1;\n// a comment\n```\n', {
    readability: { enabled: true, preset: 'comfortable', palette: 'sepia', fontFamily: '', zen: false },
  });

  await expect(page.locator('body')).toHaveClass(/reading-palette-sepia/);

  const keyword = page.locator('#content .hljs-keyword').first();
  const comment = page.locator('#content .hljs-comment').first();
  await keyword.waitFor();

  // Light-theme token colors (readable dark-on-light), NOT the dark defaults
  // (#569cd6 keyword / #57a64a comment) that a dark VS Code theme would leave.
  await expect(keyword).toHaveCSS('color', 'rgb(0, 0, 255)'); // #00f
  await expect(comment).toHaveCSS('color', 'rgb(0, 128, 0)'); // #008000
});

test('Mermaid re-renders with the light theme when a light palette is applied', async ({ page }) => {
  await simulateDarkVsCodeTheme(page);
  // followTheme + dark VS Code theme → first render uses mermaid's dark theme.
  await openEditor(page, '```mermaid\ngraph TD; A-->B; B-->C\n```\n');

  const svg = page.locator('.md-mermaid-chart svg');
  await svg.waitFor();
  const darkThemeSvg = await svg.evaluate((el) => el.outerHTML);

  // Switch to Sepia (a light palette) exactly as a host broadcast would — this
  // drives applyReadingModeFromHost → apply() → onStyleApplied → refreshTheme.
  await page.evaluate(() =>
    window.postMessage(
      { type: 'readingModeChanged', enabled: true, preset: 'comfortable', palette: 'sepia' },
      '*'
    )
  );
  await expect(page.locator('body')).toHaveClass(/reading-palette-sepia/);

  // The background lightness flipped dark→light, so the diagram must re-render
  // under mermaid's light theme — its SVG markup differs from the dark one.
  await expect
    .poll(async () => svg.evaluate((el) => el.outerHTML))
    .not.toBe(darkThemeSvg);
});
