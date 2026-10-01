/**
 * Performance Low-End T3.2: a host 'update' keys its patch plan on the RAW
 * (pre-post-process) render and post-processes only the inserted blocks. These
 * tests pin that the split is invisible: kept blocks — including post-processed
 * ones (math wrappers, fences with a header, diagram frames, caption pills) —
 * end with exactly the line attrs a fresh open stamps, inserted blocks carry
 * their full post-process output, and a patched #content equals a fresh open.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

type Page = import('@playwright/test').Page;

/** Simulate the host pushing a re-render (same channel provider.ts uses). */
async function pushUpdate(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => window.postMessage({ type: 'update', text: t }, '*'), text);
}

/** Push an update and wait until #content's render generation moves past the current one. */
async function pushUpdateAndWait(page: Page, text: string): Promise<void> {
  const generation = (await page.locator('#content').getAttribute('data-render-generation')) ?? '';
  await pushUpdate(page, text);
  await expect(page.locator('#content')).not.toHaveAttribute('data-render-generation', generation);
}

/** Stamp an identity marker (JS property, not attribute) on every #content child. */
async function markBlocks(page: Page): Promise<number> {
  return page.evaluate(() => {
    const children = Array.from(document.querySelectorAll('#content > *'));
    children.forEach((el, i) => {
      (el as HTMLElement & { __p9?: number }).__p9 = i;
    });
    return children.length;
  });
}

/** Marker of every #content child, in order (null = a node the update inserted). */
async function readMarkers(page: Page): Promise<Array<number | null>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#content > *')).map((el) => (el as HTMLElement & { __p9?: number }).__p9 ?? null)
  );
}

/** Every line-attr carrier under #content, in document order. */
async function readLineAttrs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#content [data-line], #content [data-line-end]')).map(
      (el) => `${el.tagName}.${el.classList[0] ?? ''} ${el.getAttribute('data-line')}-${el.getAttribute('data-line-end')}`
    )
  );
}

/** #content innerHTML with the per-session block ids blanked. */
async function readContentHtml(page: Page): Promise<string> {
  return page.evaluate(() =>
    (document.getElementById('content') as HTMLElement).innerHTML.replace(/ data-block-id="[^"]*"/g, '')
  );
}

/** Open `text` in a second page — what a full render of the same source shows. */
async function freshOpen(page: Page, text: string): Promise<Page> {
  const other = await page.context().newPage();
  await openEditor(other, text);
  return other;
}

const MIXED = [
  'Intro',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  'Text with $$x$$ display.',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  'caption::FIG1',
  '',
].join('\n');

test('a line inserted at the top keeps every post-processed block with fresh-render line attrs', async ({ page }) => {
  await openEditor(page, MIXED);
  const count = await markBlocks(page);

  const next = `New top\n\n${MIXED}`;
  await pushUpdate(page, next);
  await expect(page.locator('#content > p').first()).toHaveText('New top');

  // Every original block kept its live node; only the new paragraph was inserted.
  expect(await readMarkers(page)).toEqual([null, ...Array.from({ length: count }, (_, i) => i)]);
  const fresh = await freshOpen(page, next);
  expect(await readLineAttrs(page)).toEqual(await readLineAttrs(fresh));
});

test('kept math wrappers take their lines from the math ranges', async ({ page }) => {
  // Every display is a top-level $$ block, so the range count matches and each
  // wrapper carries data-line — the raw <p> it replaced had none to copy.
  const text = 'Intro\n\n$$\na^2\n$$\n\nMiddle\n\n$$\nb^2\n$$\n';
  await openEditor(page, text);
  await expect(page.locator('#content > .md-math-block[data-line="3"]')).toHaveCount(1);
  const count = await markBlocks(page);

  const next = `Zero\n\n\n${text}`;
  await pushUpdate(page, next);
  await expect(page.locator('#content > p').first()).toHaveText('Zero');

  expect(await readMarkers(page)).toEqual([null, ...Array.from({ length: count }, (_, i) => i)]);
  await expect(page.locator('#content > .md-math-block')).toHaveCount(2);
  const fresh = await freshOpen(page, next);
  expect(await readLineAttrs(page)).toEqual(await readLineAttrs(fresh));
  expect(await readLineAttrs(page)).toContain('DIV.md-math-block 6-8');
});

test('an edited run is replaced and carries its full post-process output', async ({ page }) => {
  const text = 'Intro\n\n$$\na^2\n$$\n\n```js\nlet x = 1;\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\ncaption::FIG1\n\nOutro\n';
  await openEditor(page, text);
  const count = await markBlocks(page);

  // Editing the first and last middle blocks replaces the whole run between them.
  const next = text.replace('a^2', 'b^2').replace('caption::FIG1', 'caption::FIG2');
  await pushUpdate(page, next);
  await expect(page.locator('#content .md-caption')).toHaveText('caption::FIG2');

  const markers = await readMarkers(page);
  expect(markers[0]).toBe(0);
  expect(markers.slice(1, 5)).toEqual([null, null, null, null]);
  expect(markers[5]).toBe(count - 1);

  await expect(page.locator('#content > .md-math-block')).toHaveAttribute('data-tex', /^b\^2\s*$/);
  await expect(page.locator('#content > .md-math-block .md-math-toggle')).toHaveCount(1);
  await expect(page.locator('#content > pre .md-code-header')).toHaveCount(1);
  await expect(page.locator('#content > .md-mermaid > .md-mermaid-chart')).toHaveCount(1);
  await expect(page.locator('#content > .md-mermaid > pre > code.language-mermaid')).toHaveCount(1);
  // The inserted diagram is rendered, not left on its placeholder.
  await expect(page.locator('#content > .md-mermaid > .md-mermaid-chart svg')).toHaveCount(1);
  const fresh = await freshOpen(page, next);
  expect(await readLineAttrs(page)).toEqual(await readLineAttrs(fresh));
});

test('a patched #content equals a fresh open of the same text', async ({ page }) => {
  const base = [
    'Intro',
    '',
    '$$',
    'E = mc^2',
    '$$',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '| a | b |',
    '| --- | --- |',
    '| one | two |',
    '',
    'caption::FIG1',
    '',
    '- one',
    '- two',
    '',
    '  $$',
    '  y^2',
    '  $$',
    '',
    'Outro',
    '',
  ].join('\n');
  const withInline = base.replace('Outro', 'Text with $$x$$ display.\n\nOutro');
  await openEditor(page, base);

  // Top insert, middle edit, then the range count flipping both ways around
  // kept math blocks, top-level and inside a list item (match → mismatch → match).
  for (const next of [`Top\n\n${base}`, `Top\n\n${base.replace('const a = 1;', 'const a = 2;')}`, `Top\n\n${withInline}`, base]) {
    await pushUpdateAndWait(page, next);
    const fresh = await freshOpen(page, next);
    expect(await readContentHtml(page)).toBe(await readContentHtml(fresh));
    await fresh.close();
  }
});
