/**
 * US-2.8: PlantUML diagram frames end-to-end. Needs the real webview engine —
 * the engine bundle is fetched at runtime via an injected <script>, renders
 * through WebAssembly, and the toggle/zoom paths are real click events. None of
 * that is reachable from test/roundtrip/ (domino), which only covers the DOM
 * wrapping and serialization.
 *
 * Rendering pulls in an ~8.5 MB bundle and compiles WASM, so the render-bearing
 * cases get an extended timeout.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

const SIMPLE = '```plantuml\n@startuml\nAlice -> Bob : Hello\n@enduml\n```\n';

/** True when the lazily-injected engine <script> is present in the page. */
async function engineRequested(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => !!document.querySelector('script[src*="plantuml-engine"]'));
}

test('a document with no PlantUML block never loads the engine (lazy-load)', async ({ page }) => {
  await openEditor(page, '# Heading\n\nJust prose, and a mermaid block:\n\n```mermaid\ngraph TD; A-->B\n```\n');
  // Mermaid still renders — proving the document fully rendered before we assert.
  await page.locator('.md-mermaid-chart svg').waitFor();

  expect(await engineRequested(page)).toBe(false);
});

test('a ```plantuml fence renders an SVG diagram', async ({ page }) => {
  test.slow();
  await openEditor(page, SIMPLE);

  await page.locator('.md-plantuml-chart svg').waitFor({ timeout: 60000 });
  expect(await engineRequested(page)).toBe(true);
  await expect(page.locator('.md-plantuml-chart')).not.toHaveClass(/md-plantuml-error/);
});

test('multiple diagrams in one document all render (single-threaded engine is serialized)', async ({ page }) => {
  test.slow();
  // renderAll() fires every frame at once, but the TeaVM engine renders one at a
  // time — concurrent renderToString calls used to leave all-but-one hung on the
  // "Rendering…" placeholder. Graphviz-backed kinds (class/usecase/…) are the ones
  // that clashed, so cover a mix of them alongside a plain sequence diagram.
  const doc =
    '```plantuml\n@startuml\nAlice -> Bob : Hi\n@enduml\n```\n\n' +
    '```plantuml\n@startuml\nclass A\nclass B\nA --> B\n@enduml\n```\n\n' +
    '```plantuml\n@startuml\nactor U\nU -- (UC1)\n@enduml\n```\n\n' +
    '```plantuml\n@startuml\n[*] --> S1\nS1 --> [*]\n@enduml\n```\n\n' +
    '```plantuml\n@startuml\ncomponent C1\ncomponent C2\nC1 --> C2\n@enduml\n```\n';
  await openEditor(page, doc);

  // Every frame must end up with an SVG and none stuck on the placeholder or errored.
  await expect(page.locator('.md-plantuml-chart svg')).toHaveCount(5, { timeout: 60000 });
  await expect(page.locator('.md-plantuml-chart.md-plantuml-error')).toHaveCount(0);
});

test('toggle flips between chart and source, and re-renders on the way back', async ({ page }) => {
  test.slow();
  await openEditor(page, SIMPLE);
  const frame = page.locator('.md-plantuml');
  await page.locator('.md-plantuml-chart svg').waitFor({ timeout: 60000 });

  await page.locator('.md-plantuml-toggle').click();
  await expect(frame).toHaveAttribute('data-plantuml-view', 'code');
  await expect(page.locator('.md-plantuml-source')).toBeVisible();
  await expect(page.locator('.md-plantuml-chart')).toBeHidden();

  await page.locator('.md-plantuml-toggle').click();
  await expect(frame).toHaveAttribute('data-plantuml-view', 'chart');
  await expect(page.locator('.md-plantuml-chart svg')).toHaveCount(1);
  await expect(page.locator('.md-plantuml-source')).toBeHidden();
});

test('source edited in code view is what gets rendered on switching back', async ({ page }) => {
  test.slow();
  await openEditor(page, SIMPLE);
  await page.locator('.md-plantuml-chart svg').waitFor({ timeout: 60000 });

  await page.locator('.md-plantuml-toggle').click();
  await expect(page.locator('.md-plantuml')).toHaveAttribute('data-plantuml-view', 'code');

  // Rewrite the source in place, as hand-editing the visible <pre> would.
  await page.evaluate(() => {
    const code = document.querySelector('.md-plantuml-source code');
    if (code) {
      code.textContent = '@startuml\nCharlie -> Dana : Renamed\n@enduml\n';
    }
  });

  await page.locator('.md-plantuml-toggle').click();
  await expect(page.locator('.md-plantuml-chart svg')).toHaveCount(1);
  // The new participant name proves the re-render used the edited source, not a
  // cached SVG of the original (the cache is keyed by source hash).
  await expect(page.locator('.md-plantuml-chart svg')).toContainText('Charlie', { timeout: 60000 });
});

test('Zoom opens the diagram in the shared lightbox; Esc closes it', async ({ page }) => {
  test.slow();
  await openEditor(page, SIMPLE);
  await page.locator('.md-plantuml-chart svg').waitFor({ timeout: 60000 });

  await page.locator('.md-plantuml-zoom').click();
  const lightbox = page.locator('#md-lightbox');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator('#md-lightbox-stage svg')).toHaveCount(1);
  // The engine draws dark-on-transparent, so the zoom stage must carry the
  // light-canvas marker to stay readable over the dark overlay (see lightbox CSS).
  await expect(page.locator('#md-lightbox-stage')).toHaveAttribute('data-canvas', 'light');

  await page.keyboard.press('Escape');
  await expect(lightbox).toBeHidden();
});

test('an engine that fails to load shows an error and falls back to code view', async ({ page }) => {
  await openEditor(page, SIMPLE, { plantumlEngineUri: 'does-not-exist-plantuml-engine.js' });

  const chart = page.locator('.md-plantuml-chart');
  await expect(chart).toHaveClass(/md-plantuml-error/);
  await expect(chart).toContainText('Failed to render PlantUML diagram');
  // Fallback to code view so the user sees their source instead of a dead frame.
  await expect(page.locator('.md-plantuml')).toHaveAttribute('data-plantuml-view', 'code');
  await expect(page.locator('.md-plantuml-source')).toBeVisible();
  // The rest of the document is unaffected by the failed load.
  await expect(page.locator('#content')).toContainText('Alice -> Bob : Hello');
});
