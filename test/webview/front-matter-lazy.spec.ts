/**
 * Performance Low-End T4.3 (audit L-9): js-yaml and smol-toml live in the
 * lazily loaded front-matter-engine.js, reached through yaml-shim.ts /
 * toml-shim.ts. Pins that a document without YAML / TOML front matter never
 * loads the engine, that YAML and TOML cards render the same fields once it
 * loads, that serializing gives back the source bytes with the engine loaded
 * and with it 404ing, and that a front-matter card pasted before the load is
 * rebuilt with its fields afterwards.
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { clearPosted, openBlankHarness, openEditor, waitForEdit } from './_harness';

type Page = import('@playwright/test').Page;

const YAML_DOC = '---\ntitle: Sample Document\ntype: spec\nstatus: draft\ncreated: 2026-07-27\ntags: [a, b]\n---\n\n# Heading\n\nEnd\n';
const TOML_DOC = '+++\ntitle = "Hugo Doc"\ntype = "post"\nstatus = "draft"\ncreated = 2026-07-27\ntags = ["a", "b"]\n+++\n\n# Heading\n\nEnd\n';
const JSON_DOC =
  '{\n  "title": "JSON Doc",\n  "type": "post",\n  "status": "draft",\n  "created": "2026-07-27",\n  "tags": ["a", "b"]\n}\n\n# Heading\n\nEnd\n';
const INVALID_YAML = '---\nthis has no colon\ntitle: still here\n---\n\n# Heading\n\nEnd\n';
const INVALID_TOML = '+++\na = 1\nb = 2\nkey = \n+++\n\n# Heading\n\nEnd\n';
const NON_MAP_YAML = '---\n- alpha\n- beta\n---\n\n# Heading\n\nEnd\n';

/** Served by page.route after ENGINE_DELAY_MS, so a render meets front matter before the engine has loaded. */
const SLOW_ENGINE = { frontMatterEngineUri: 'http://asset.test/front-matter-engine.js' };
/** The script 404s: every shim call after the failed load throws. */
const MISSING_ENGINE = { frontMatterEngineUri: 'missing-fm-engine.js' };
const ENGINE_DELAY_MS = 750;

async function serveEngineLate(page: Page): Promise<void> {
  const body = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'webview', 'front-matter-engine.js'), 'utf8');
  await page.route('http://asset.test/front-matter-engine.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ENGINE_DELAY_MS));
    await route.fulfill({ body, contentType: 'text/javascript' });
  });
}

function engineScripts(page: Page, file: string): Promise<number> {
  return page.evaluate((f) => document.head.querySelectorAll(`script[src$="${f}"]`).length, file);
}

/** Type `text` at the end of the closing `End` paragraph — a real edit, so the next sync serializes every block. */
async function typeAfterEnd(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const content = document.getElementById('content') as HTMLElement;
    const end = Array.from(content.querySelectorAll(':scope > p')).find((p) => p.textContent === 'End');
    const node = end?.firstChild;
    if (!node) {
      throw new Error('fixture has no closing End paragraph');
    }
    content.focus();
    const range = document.createRange();
    range.setStart(node, 3);
    range.collapse(true);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, t);
  }, text);
}

async function expectSerializedSource(page: Page, source: string): Promise<void> {
  await clearPosted(page);
  await typeAfterEnd(page, '!');
  expect(await waitForEdit(page)).toBe(source.replace(/End\n$/, 'End!\n'));
}

for (const [name, source] of [
  ['no front matter', '# Heading\n\nEnd\n'],
  ['JSON front matter', JSON_DOC],
]) {
  test(`${name}: the front-matter engine is never loaded`, async ({ page }) => {
    await openEditor(page, source);
    await expect(page.locator('#content h1')).toHaveText('Heading');
    await page.waitForTimeout(200);
    expect(await engineScripts(page, 'front-matter-engine.js')).toBe(0);
    expect(await page.evaluate(() => 'OrcaFrontMatterEngine' in window)).toBe(false);
  });
}

test('JSON front matter still renders its card without the engine', async ({ page }) => {
  await openEditor(page, JSON_DOC);
  const fm = page.locator('.md-front-matter');
  await expect(fm.locator('.md-fm-row-title')).toHaveText('JSON Doc');
  await expect(fm.locator('.md-fm-count')).toHaveText('5 fields');
});

test('YAML card on a slow engine renders its fields once the engine loads', async ({ page }) => {
  await serveEngineLate(page);
  await openEditor(page, YAML_DOC, SLOW_ENGINE);
  const fm = page.locator('.md-front-matter');
  await expect(fm.locator('.md-fm-row-title')).toHaveText('Sample Document');
  await expect(fm.locator('.md-fm-count')).toHaveText('5 fields');
  await fm.locator('.md-fm-toggle').click();
  await expect(fm.locator('.md-fm-title')).toHaveText('Sample Document');
  await expect(fm.locator('.md-fm-badges')).toContainText('spec');
  await expect(fm.locator('.md-fm-badges')).toContainText('draft');
  await expect(fm.locator('.md-fm-badges')).toContainText('created 2026-07-27');
  await expect(fm.locator('.md-fm-grid')).toContainText('tags');
  expect(await engineScripts(page, 'front-matter-engine.js')).toBe(1);
  await expect(page.locator('#content [data-fm-engine-miss]')).toHaveCount(0);
});

test('TOML card on a slow engine renders its fields once the engine loads', async ({ page }) => {
  await serveEngineLate(page);
  await openEditor(page, TOML_DOC, SLOW_ENGINE);
  const fm = page.locator('.md-front-matter');
  await expect(fm).toHaveAttribute('data-fm-format', 'toml');
  await expect(fm.locator('.md-fm-row-title')).toHaveText('Hugo Doc');
  await expect(fm.locator('.md-fm-count')).toHaveText('5 fields');
  await fm.locator('.md-fm-toggle').click();
  await expect(fm.locator('.md-fm-badges')).toContainText('post');
  await expect(fm.locator('.md-fm-badges')).toContainText('created 2026-07-27');
  await expect(fm.locator('.md-fm-grid')).toContainText('tags');
});

for (const [name, source] of [
  ['YAML', YAML_DOC],
  ['TOML', TOML_DOC],
  ['JSON', JSON_DOC],
  ['invalid YAML', INVALID_YAML],
  ['invalid TOML', INVALID_TOML],
  ['non-map YAML', NON_MAP_YAML],
]) {
  test(`engine loaded, ${name}: serializes to the source bytes`, async ({ page }) => {
    await openEditor(page, source);
    await expect(page.locator('#content .md-front-matter')).toHaveCount(1);
    await expectSerializedSource(page, source);
  });

  test(`engine 404, ${name}: serializes to the source bytes`, async ({ page }) => {
    await openEditor(page, source, MISSING_ENGINE);
    await expect(page.locator('#content .md-front-matter')).toHaveCount(1);
    await expectSerializedSource(page, source);
  });
}

test('engine 404: the YAML card keeps its raw rows, the TOML card shows its invalid frame', async ({ page }) => {
  await openEditor(page, YAML_DOC, MISSING_ENGINE);
  const yaml = page.locator('.md-front-matter');
  await expect(yaml.locator('.md-fm-count')).toHaveText('5 lines');
  await expect(yaml.locator('.md-fm-grid-row-raw')).toHaveCount(5);
  await expect(yaml.locator('.md-fm-grid-row-raw').first()).toHaveText('title: Sample Document');

  await openEditor(page, TOML_DOC, MISSING_ENGINE);
  const toml = page.locator('.md-front-matter');
  await expect(toml).toHaveAttribute('data-fm-view', 'invalid');
  await expect(toml).toHaveAttribute('data-fm-format', 'toml');
  await expect(toml.locator('.md-fm-error-body')).toContainText('title = "Hugo Doc"');
});

test('YAML front matter and math on slow front-matter engine: both engine scripts, one hold, rendered together', async ({
  page,
}) => {
  await serveEngineLate(page);
  const config = await openBlankHarness(page, SLOW_ENGINE);
  await page.evaluate(
    (cfg) =>
      window.postMessage({ type: 'init', text: '---\ntitle: With Math\n---\n\nAlpha $x$\n\nEnd\n', docUri: 'file:///harness.md', config: cfg }, '*'),
    config
  );
  // Held on both engines: the math engine loads at once, the page waits for the front-matter one.
  await page.waitForTimeout(ENGINE_DELAY_MS / 3);
  expect(await page.evaluate(() => document.getElementById('content')?.childNodes.length)).toBe(0);
  expect(await engineScripts(page, 'math-engine.js')).toBe(1);
  expect(await engineScripts(page, 'front-matter-engine.js')).toBe(1);

  await expect(page.locator('.md-front-matter .md-fm-row-title')).toHaveText('With Math');
  await expect(page.locator('#content .katex')).toHaveCount(1);
  await expect(page.locator('#content .katex-fallback')).toHaveCount(0);
  expect(await page.evaluate(() => document.getElementById('content')?.getAttribute('data-render-generation'))).toBe('1');
});

/** Select the first paragraph and paste `text` over it as plain text. */
async function pasteOverFirstParagraph(page: Page, text: string): Promise<void> {
  await page.evaluate(() => {
    const content = document.getElementById('content') as HTMLElement;
    const p = content.querySelector(':scope > p') as HTMLElement;
    content.focus();
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await clearPosted(page);
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document
      .getElementById('content')
      ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test('pasting YAML front-matter text before the load: the card shows its field once the engine loads', async ({ page }) => {
  await serveEngineLate(page);
  await openEditor(page, 'Alpha\n\nEnd\n', SLOW_ENGINE);
  await pasteOverFirstParagraph(page, '---\ntitle: Pasted\n---');
  const fm = page.locator('#content .md-front-matter');
  // Paste never waits: the stand-in card is in place before the engine arrives.
  await expect(fm).toHaveAttribute('data-fm-engine-miss', '', { timeout: ENGINE_DELAY_MS / 3 });
  await expect(fm.locator('.md-fm-count')).toHaveText('0 fields', { timeout: ENGINE_DELAY_MS / 3 });
  expect(await waitForEdit(page)).toContain('---\ntitle: Pasted\n---');

  await expect(fm.locator('.md-fm-row-title')).toHaveText('Pasted');
  await expect(fm.locator('.md-fm-count')).toHaveText('1 field');
  await expect(fm).not.toHaveAttribute('data-fm-engine-miss', '');
  expect(await engineScripts(page, 'front-matter-engine.js')).toBe(1);
});

test('pasting YAML front-matter text when the engine 404s: the card falls back to its raw rows', async ({ page }) => {
  await openEditor(page, 'Alpha\n\nEnd\n', MISSING_ENGINE);
  await pasteOverFirstParagraph(page, '---\ntitle: Pasted\n---');
  expect(await waitForEdit(page)).toContain('---\ntitle: Pasted\n---');

  const fm = page.locator('#content .md-front-matter');
  await expect(fm.locator('.md-fm-count')).toHaveText('1 line');
  await expect(fm.locator('.md-fm-grid-row-raw')).toHaveText('title: Pasted');
  await expect(fm).not.toHaveAttribute('data-fm-engine-miss', '');
});
