/**
 * Performance Low-End T4.2 (audit L-9): the math and front-matter engine
 * bundles build on their own and publish the API lazy-engines.ts expects.
 * Each bundle is injected as a <script> into the harness page (it sits beside
 * main.js in dist/webview) and its window global is called directly.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

/** Inject dist/webview/<file> as a <script> and wait until it has run. */
async function injectBundle(page: Page, file: string): Promise<void> {
  await page.evaluate(
    (src) =>
      new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.addEventListener('load', () => resolve());
        script.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
        document.head.appendChild(script);
      }),
    file
  );
}

test('math-engine.js publishes OrcaMathEngine.renderToString', async ({ page }) => {
  await openEditor(page, 'Plain text.\n');
  await injectBundle(page, 'math-engine.js');
  const html = await page.evaluate(() => {
    const engine = (window as unknown as { OrcaMathEngine: { renderToString(tex: string): string } }).OrcaMathEngine;
    return engine.renderToString('x^2');
  });
  const hasKatexSpan = await page.evaluate((markup) => {
    const host = document.createElement('div');
    host.innerHTML = markup;
    return !!host.querySelector('span.katex');
  }, html);
  expect(hasKatexSpan).toBe(true);
});

test('front-matter-engine.js publishes OrcaFrontMatterEngine.load / parse', async ({ page }) => {
  await openEditor(page, 'Plain text.\n');
  await injectBundle(page, 'front-matter-engine.js');
  const parsed = await page.evaluate(() => {
    const engine = (
      window as unknown as {
        OrcaFrontMatterEngine: { load(text: string): unknown; parse(text: string): unknown };
      }
    ).OrcaFrontMatterEngine;
    return { yaml: engine.load('a: 1'), toml: engine.parse('a = 1') };
  });
  expect(parsed.yaml).toEqual({ a: 1 });
  expect(parsed.toml).toEqual({ a: 1 });
});
