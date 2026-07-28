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

// ---------------------------------------------------------------------------
// US-4.30 — PlantUML insert entry points (toolbar split button + slash command),
// mirroring Mermaid US-4.12/US-4.20. Needs the real engine: real toolbar/split-
// caret clicks + execCommand insert + the `/` popup. We assert on the inserted
// frame's raw source (`.md-plantuml-source`, present as soon as the block renders,
// independent of the WASM chart), so these stay fast and don't wait on the engine.
// ---------------------------------------------------------------------------

/** Select the whole first paragraph so the toolbar insert has a caret/selection. */
async function selectFirstParagraph(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const p = document.querySelector('#content p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

test('the PlantUML toolbar button (main face) inserts the default Activity template', async ({ page }) => {
  await openEditor(page, 'Hello world\n');
  await selectFirstParagraph(page);
  await page.locator('#fmt-plantuml').click();

  await expect(page.locator('.md-plantuml')).toHaveCount(1);
  // Distinguishing lines from PLANTUML_ACTIVITY_TEMPLATE (toolbar.ts).
  await expect(page.locator('.md-plantuml-source')).toContainText('Do something');
  await expect(page.locator('.md-plantuml-source')).toContainText('Decision?');
});

test('the PlantUML toolbar dropdown inserts the picked diagram type (Sequence)', async ({ page }) => {
  await openEditor(page, 'Hello world\n');
  await selectFirstParagraph(page);
  await page.locator('#fmt-plantuml ~ .split-caret').click();
  const pop = page.locator('.toolbar-popover[data-for-id="fmt-plantuml"]');
  await expect(pop).toBeVisible();
  await pop.locator('.toolbar-popover-item', { hasText: 'Sequence diagram' }).first().click();

  await expect(page.locator('.md-plantuml')).toHaveCount(1);
  // PLANTUML_SEQUENCE_TEMPLATE — not the Activity default.
  await expect(page.locator('.md-plantuml-source')).toContainText('Alice -> Bob');
  await expect(page.locator('.md-plantuml-source')).not.toContainText('Do something');
});

test('the PlantUML dropdown lists the 4 diagram types (parity with Mermaid)', async ({ page }) => {
  await openEditor(page, '# hi');
  await page.locator('#fmt-plantuml ~ .split-caret').click();
  const pop = page.locator('.toolbar-popover[data-for-id="fmt-plantuml"]');
  await expect(pop).toBeVisible();
  const labels = await pop.locator('.toolbar-popover-item').allTextContents();
  expect(labels.some((l) => l.includes('Activity diagram'))).toBe(true);
  expect(labels.some((l) => l.includes('Sequence diagram'))).toBe(true);
  expect(labels.some((l) => l.includes('Class diagram'))).toBe(true);
  expect(labels.some((l) => l.includes('State diagram'))).toBe(true);
});

test('the `/PlantUML diagram` slash command inserts the default Activity template', async ({ page }) => {
  await openEditor(page, '');
  await page.evaluate(() => {
    const p = document.querySelector('#content p') ?? document.querySelector('#content')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.type('/plantuml');
  await page.locator('.trigger-popup-item', { hasText: 'PlantUML diagram' }).first().click();

  await expect(page.locator('.md-plantuml')).toHaveCount(1);
  await expect(page.locator('.md-plantuml-source')).toContainText('Do something');
});

// Security — Audit S-4: mermaid renders with securityLevel:'strict' (its own
// sanitization); @plantuml/core has no such option, so plantuml.ts must run the
// engine's SVG through sanitizeSvgMarkup itself before assigning innerHTML. A
// fake engine (registered before main.js loads, so the real ~8.5 MB engine is
// never fetched) stands in for @plantuml/core so the test controls the SVG
// content directly instead of hunting for PlantUML syntax that emits it.
/**
 * Registers a fake engine (before main.js loads, so the real ~8.5 MB engine is
 * never fetched) that hands back `svg` verbatim from `renderToString`.
 */
async function stubPlantumlEngine(page: import('@playwright/test').Page, svg: string): Promise<void> {
  await page.addInitScript((svgArg) => {
    (window as unknown as { OrcaPlantumlEngine: unknown }).OrcaPlantumlEngine = {
      renderToString(_lines: string[], onSuccess: (s: string) => void) {
        onSuccess(svgArg);
      },
    };
  }, svg);
}

test('a PlantUML SVG carrying script/handler/foreignObject/xlink:href vectors is sanitized before insertion', async ({
  page,
}) => {
  // review fix (step-04, blind hunter finding): a bare <rect onload> never
  // fires (rect has no load event) and the removed <script>/<a href> tags
  // can't execute in this innerHTML context either way — those three lines
  // proved nothing beyond the markup-absence checks below. A NESTED <svg
  // onload> genuinely fires synchronously on insertion (confirmed empirically
  // against this exact harness), so it is real, executable proof the
  // sanitizer — not just an inert assertion — is what stops it.
  const maliciousSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
    '<script>window.__xss = true;</script>' +
    '<svg onload="window.__xss = true"><rect width="1" height="1"/></svg>' +
    '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">evil</body></foreignObject>' +
    '<a href="javascript:window.__xss = true">link</a>' +
    '<a xlink:href="javascript:window.__xss = true">xlink</a>' +
    '</svg>';
  await stubPlantumlEngine(page, maliciousSvg);

  await openEditor(page, SIMPLE);
  // .first(): the nested <svg onload> payload above means two <svg> elements
  // match this selector once rendered (the outer chart root + the injected
  // nested one) — any() would violate Playwright's strict mode.
  await page.locator('.md-plantuml-chart svg').first().waitFor();

  const chartHtml = await page.locator('.md-plantuml-chart').innerHTML();
  expect(chartHtml).not.toContain('<script');
  expect(chartHtml).not.toContain('onload');
  expect(chartHtml).not.toContain('foreignObject');
  expect(chartHtml).not.toContain('javascript:');
  // The nested <svg onload> would have set this synchronously on insertion
  // had the sanitizer not stripped the attribute first.
  expect(await page.evaluate(() => (window as unknown as { __xss?: boolean }).__xss)).toBeUndefined();
});

// Review fix (step-04, blind hunter + edge case hunter finding, confirmed by
// direct regex execution): the bare `/^\s*javascript:/i` test is bypassable —
// browsers strip ASCII tab/newline/CR from anywhere in a URL before reading
// its scheme, so `jav<TAB>ascript:` never matches the regex yet still
// resolves to and executes as `javascript:` once parsed as a URL.
test('an xlink:href with a control character embedded mid-scheme is still stripped (obfuscated javascript: bypass)', async ({
  page,
}) => {
  const maliciousSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
    '<a xlink:href="jav\tascript:window.__xssObfuscated = true">link</a>' +
    '</svg>';
  await stubPlantumlEngine(page, maliciousSvg);

  await openEditor(page, SIMPLE);
  await page.locator('.md-plantuml-chart svg').waitFor();

  const chartHtml = await page.locator('.md-plantuml-chart').innerHTML();
  expect(chartHtml).not.toContain('javascript:');
  expect(chartHtml).not.toContain('xlink:href');
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
