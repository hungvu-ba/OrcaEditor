/**
 * Performance Low-End GATE A (T4.1, audit L-9): the identity net for moving
 * KaTeX out of main.js into a lazily loaded engine. Each fixture pins what a
 * math document renders (formula counts, the TeX every formula carries) and
 * that serializing it gives back the source bytes — green on the eager build,
 * and it must stay green once the math rules render through the lazy engine.
 *
 * T4.6 adds the render lifecycle around the lazy engine: no engine without a
 * formula, a document render held until the engine loads (a slow engine is
 * served late through page.route), the engine-404 stand-in keeping the bytes,
 * and paste / insert / the Edit popover swapping a stand-in in place.
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { clearPosted, openBlankHarness, openEditor, waitForEdit } from './_harness';

type Page = import('@playwright/test').Page;

interface MathFixture {
  name: string;
  /** Ends with the plain paragraph `End`, the one block the test edits. */
  source: string;
  /** Every `.katex` under #content (a display formula holds one too). */
  katex: number;
  /** Every `.katex-display` under #content. */
  display: number;
  /** Every `.katex-error` under #content (a formula KaTeX cannot parse); 0 when omitted. */
  katexError?: number;
  /** TeX of every formula, in document order. */
  tex: string[];
  /** What the document serializes to when that is not `source` itself. */
  serialized?: string;
}

const FIXTURES: MathFixture[] = [
  { name: 'inline $x$', source: 'Inline $x$ here.\n\nEnd\n', katex: 1, display: 0, tex: ['x'] },
  { name: '$$ block', source: 'Before\n\n$$\nE = mc^2\n$$\n\nEnd\n', katex: 1, display: 1, tex: ['E = mc^2\n'] },
  {
    name: 'math in a table cell',
    source: '| Name | Formula |\n| --- | --- |\n| mass | $E = mc^2$ |\n\nEnd\n',
    katex: 1,
    display: 0,
    tex: ['E = mc^2'],
  },
  { name: 'math in a list item', source: '-   first $a^2$\n-   second\n\nEnd\n', katex: 1, display: 0, tex: ['a^2'] },
  {
    // The serializer writes an escaped dollar back with its backslash (T4.7).
    // Unescaped, `$a$` would be a second formula; `$b$` makes the count wait for a render.
    name: 'escaped \\$',
    source: 'Price \\$a\\$ vs $b$.\n\nEnd\n',
    katex: 1,
    display: 0,
    tex: ['b'],
  },
  { name: 'escaped \\$ alone', source: 'Pay \\$a\\$ now.\n\nEnd\n', katex: 0, display: 0, tex: [] },
  { name: 'two formulas on one line', source: 'Both $a$ and $b$ on one line.\n\nEnd\n', katex: 2, display: 0, tex: ['a', 'b'] },
  // The serializer writes an invalid formula back from its TeX, not the error message it shows (T4.8).
  { name: 'invalid inline', source: 'Bad $\\frac{$ tex.\n\nEnd\n', katex: 0, display: 0, katexError: 1, tex: [] },
  { name: 'invalid $$ block', source: 'Before\n\n$$\n\\frac{\n$$\n\nEnd\n', katex: 0, display: 0, katexError: 1, tex: [] },
  // T4.6: bytes below pinned from the eager build (KaTeX inside main.js).
  {
    name: 'block math in a list item',
    source: '-   item\n\n    $$\n    x^2\n    $$\n\n-   next\n\nEnd\n',
    katex: 1,
    display: 1,
    tex: ['x^2\n'],
    serialized: '-   item\n    \n    $$\n    x^2\n    $$\n    \n-   next\n\nEnd\n',
  },
  {
    name: 'inline \\begin{aligned}',
    source: 'Inline $\\begin{aligned}a &= b\\\\ c &= d\\end{aligned}$ here.\n\nEnd\n',
    katex: 1,
    display: 0,
    tex: ['\\begin{aligned}a &= b\\\\ c &= d\\end{aligned}'],
  },
  {
    name: 'inline $$x$$',
    source: 'Inline $$x$$ here.\n\nEnd\n',
    katex: 1,
    display: 1,
    tex: ['x'],
    serialized: 'Inline\n\n$$\nx\n$$\n\nhere.\n\nEnd\n',
  },
  { name: 'code span next to a formula', source: 'Code `$x$` next to $y$.\n\nEnd\n', katex: 1, display: 0, tex: ['y'] },
  {
    name: 'mixed doc',
    source:
      '# Title $t$\n\nText $a+b$ and `$c$`.\n\n$$\n\\sum_{i=1}^{n} i\n$$\n\n-   item $x_1$\n-   plain\n\n| A | B |\n| --- | --- |\n| $z$ | w |\n\n```\ncost $5 and $6\n```\n\n> quote $q$\n\nEnd\n',
    katex: 6,
    display: 1,
    tex: ['t', 'a+b', '\\sum_{i=1}^{n} i\n', 'x_1', 'z', 'q'],
  },
];

/** TeX annotation of every rendered formula, in document order. */
async function readAnnotations(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#content annotation[encoding="application/x-tex"]'), (el) => el.textContent ?? '')
  );
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

for (const fixture of FIXTURES) {
  test(`${fixture.name}: formulas render and the document serializes to the pinned bytes`, async ({ page }) => {
    await openEditor(page, fixture.source);

    await expect(page.locator('#content .katex')).toHaveCount(fixture.katex);
    // Real KaTeX layout, not a source-carrying stand-in: a lazy engine that never loads fails here.
    await expect(page.locator('#content .katex:not(:has(.katex-html .base))')).toHaveCount(0);
    await expect(page.locator('#content .katex-display')).toHaveCount(fixture.display);
    await expect(page.locator('#content .katex-error')).toHaveCount(fixture.katexError ?? 0);
    expect(await readAnnotations(page)).toEqual(fixture.tex);

    // No block is cached right after a render, so this one edit serializes the
    // whole document: everything but the typed character must be the pinned bytes.
    await clearPosted(page);
    await typeAfterEnd(page, '!');
    expect(await waitForEdit(page)).toBe((fixture.serialized ?? fixture.source).replace(/End\n$/, 'End!\n'));
  });
}

// ---------------------------------------------------------------------------
// T4.6: render lifecycle around the lazily loaded math engine
// ---------------------------------------------------------------------------

/** Served by page.route after ENGINE_DELAY_MS, so a render meets math before the engine has loaded. */
const SLOW_ENGINE = { mathEngineUri: 'http://asset.test/math-engine.js' };
/** The script 404s: every formula stays a stand-in. */
const MISSING_ENGINE = { mathEngineUri: 'missing-math-engine.js' };
const ENGINE_DELAY_MS = 750;

async function serveEngineLate(page: Page): Promise<void> {
  const body = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'webview', 'math-engine.js'), 'utf8');
  await page.route('http://asset.test/math-engine.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ENGINE_DELAY_MS));
    await route.fulfill({ body, contentType: 'text/javascript' });
  });
}

function engineScripts(page: Page): Promise<number> {
  return page.evaluate(() => document.head.querySelectorAll('script[src$="math-engine.js"]').length);
}

function renderGeneration(page: Page): Promise<string | null> {
  return page.evaluate(() => document.getElementById('content')?.getAttribute('data-render-generation') ?? null);
}

async function postUpdate(page: Page, text: string, caret?: { caretLine: number; caretCol: number }): Promise<void> {
  await page.evaluate(({ t, c }) => window.postMessage({ type: 'update', text: t, ...c }, '*'), { t: text, c: caret });
}

/** Collapse the caret at `offset` in the first text node of the top-level paragraph reading `text`. */
async function placeCaret(page: Page, text: string, offset: number): Promise<void> {
  await page.evaluate(
    ([t, o]) => {
      const content = document.getElementById('content') as HTMLElement;
      const p = Array.from(content.querySelectorAll(':scope > p')).find((el) => el.textContent === t);
      if (!p?.firstChild) {
        throw new Error(`no paragraph reading ${t}`);
      }
      content.focus();
      const range = document.createRange();
      range.setStart(p.firstChild, o as number);
      range.collapse(true);
      const sel = window.getSelection() as Selection;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    [text, offset] as const
  );
}

function readCaret(page: Page): Promise<{ text: string | null; offset: number }> {
  return page.evaluate(() => {
    const sel = window.getSelection() as Selection;
    return { text: sel.anchorNode?.textContent ?? null, offset: sel.anchorOffset };
  });
}

/** Every formula is real KaTeX layout, none a stand-in. */
async function expectRealKatex(page: Page, count: number): Promise<void> {
  await expect(page.locator('#content .katex')).toHaveCount(count);
  await expect(page.locator('#content .katex:not(:has(.katex-html .base))')).toHaveCount(0);
  await expect(page.locator('#content .katex-fallback')).toHaveCount(0);
}

async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document
      .getElementById('content')
      ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

for (const [name, source] of [
  ['no math', 'Plain paragraph.\n\nEnd\n'],
  ['escaped \\$ only', 'Pay \\$a\\$ now.\n\nEnd\n'],
  ['$x$ only inside a code span', 'Code `$x$` only.\n\nEnd\n'],
]) {
  test(`${name}: the math engine is never loaded`, async ({ page }) => {
    await openEditor(page, source);
    await page.waitForTimeout(200);
    expect(await engineScripts(page)).toBe(0);
    expect(await page.evaluate(() => 'OrcaMathEngine' in window)).toBe(false);
  });
}

test('math doc on a slow engine: rendered once the engine loads, one engine script', async ({ page }) => {
  await serveEngineLate(page);
  await openEditor(page, 'Alpha $x$ and $$\ny\n$$\n\nEnd\n', SLOW_ENGINE);
  await expectRealKatex(page, 2);
  expect(await engineScripts(page)).toBe(1);
});

test('updates during the load are held; the latest shows as real KaTeX, caret and bytes kept', async ({ page }) => {
  await serveEngineLate(page);
  await openEditor(page, 'Alpha paragraph\n\nBeta paragraph\n\nEnd\n', SLOW_ENGINE);
  await placeCaret(page, 'Beta paragraph', 4);
  const before = await renderGeneration(page);

  await postUpdate(page, 'Alpha $x$ paragraph\n\nBeta paragraph\n\nEnd\n');
  await postUpdate(page, 'Alpha $x^2$ paragraph\n\nBeta paragraph\n\nEnd\n');
  await page.waitForTimeout(ENGINE_DELAY_MS / 3);
  // Waiting on the engine: nothing applied.
  expect(await renderGeneration(page)).toBe(before);
  await expect(page.locator('#content .katex')).toHaveCount(0);
  expect(await engineScripts(page)).toBe(1);

  await expectRealKatex(page, 1);
  expect(await readAnnotations(page)).toEqual(['x^2']);
  expect(await readCaret(page)).toEqual({ text: 'Beta paragraph', offset: 4 });

  // `x` was first rendered during the miss: the memo must not serve that stand-in now.
  await postUpdate(page, 'Alpha $x$ again\n\nBeta paragraph\n\nEnd\n');
  await expect(page.locator('#content > p').first()).toContainText('again');
  await expectRealKatex(page, 1);
  expect(await readAnnotations(page)).toEqual(['x']);

  await clearPosted(page);
  await typeAfterEnd(page, '!');
  expect(await waitForEdit(page)).toBe('Alpha $x$ again\n\nBeta paragraph\n\nEnd!\n');
});

test('an update with caretLine / caretCol during the load puts the caret there', async ({ page }) => {
  await serveEngineLate(page);
  await openEditor(page, 'Alpha paragraph\n\nBeta paragraph\n\nEnd\n', SLOW_ENGINE);
  await postUpdate(page, 'Alpha $x$ paragraph\n\nBeta paragraph\n\nEnd\n', { caretLine: 3, caretCol: 2 });
  await expectRealKatex(page, 1);
  expect(await readCaret(page)).toEqual({ text: 'Beta paragraph', offset: 2 });
});

test("'init' of a math doc on a slow engine: #content empty and read-only while held, a held update shown after", async ({
  page,
}) => {
  await serveEngineLate(page);
  const config = await openBlankHarness(page, SLOW_ENGINE);
  await page.evaluate(
    (cfg) => window.postMessage({ type: 'init', text: 'Alpha $x$\n\nEnd\n', docUri: 'file:///harness.md', config: cfg }, '*'),
    config
  );
  await page.waitForTimeout(ENGINE_DELAY_MS / 3);
  expect(await page.evaluate(() => document.getElementById('content')?.childNodes.length)).toBe(0);
  expect(await page.evaluate(() => document.getElementById('content')?.isContentEditable)).toBe(false);
  await page.locator('#content').focus();
  await page.keyboard.type('k');
  await postUpdate(page, 'Alpha $y$ later\n\nEnd\n');

  await expect(page.locator('#content > p').first()).toContainText('later');
  await expectRealKatex(page, 1);
  expect(await readAnnotations(page)).toEqual(['y']);
  expect(await page.evaluate(() => document.getElementById('content')?.isContentEditable)).toBe(true);
  await page.waitForTimeout(400);
  const edits = await page.evaluate(
    () => (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'edit').length
  );
  expect(edits).toBe(0);
});

for (const fixture of FIXTURES) {
  test(`engine 404, ${fixture.name}: stand-ins keep the pinned bytes, later updates render`, async ({ page }) => {
    await openEditor(page, fixture.source, MISSING_ENGINE);

    // Under the 404 an invalid formula gets a stand-in too, not the plugin's error element.
    await expect(page.locator('#content .katex-fallback')).toHaveCount(fixture.katex + (fixture.katexError ?? 0));
    await expect(page.locator('#content .katex-error')).toHaveCount(0);

    await clearPosted(page);
    await typeAfterEnd(page, '!');
    expect(await waitForEdit(page)).toBe((fixture.serialized ?? fixture.source).replace(/End\n$/, 'End!\n'));

    await postUpdate(page, 'Later $m$ text\n\nEnd\n');
    await expect(page.locator('#content > p').first()).toContainText('Later');
    await expect(page.locator('#content .katex-fallback')).toHaveCount(1);
  });
}

test('paste of a formula on a slow engine: the edit already holds it, the stand-in is swapped after the load', async ({
  page,
}) => {
  await serveEngineLate(page);
  await openEditor(page, 'Alpha\n\nEnd\n', SLOW_ENGINE);
  await placeCaret(page, 'Alpha', 5);
  await clearPosted(page);
  await paste(page, ' and $x^2$ more');
  // Still during the load: the formula is on the page as a stand-in (checked before the edit debounce).
  await expect(page.locator('#content .katex-fallback')).toHaveCount(1);
  // Only the formula is asserted: the eager build writes this paste as `Alphaand\n\n$x^2$ more` too.
  expect(await waitForEdit(page)).toContain('$x^2$ more');
  await expectRealKatex(page, 1);
  await expect(page.locator('#content .md-math-inline')).toHaveAttribute('data-tex', 'x^2');
});

test('toolbar Math on a slow engine: the edit already holds the formula, the stand-in is swapped after the load', async ({
  page,
}) => {
  await serveEngineLate(page);
  await openEditor(page, 'Alpha\n\nEnd\n', SLOW_ENGINE);
  await placeCaret(page, 'Alpha', 5);
  await clearPosted(page);
  await page.locator('#fmt-math').click();
  await expect(page.locator('#content .katex-fallback')).toHaveCount(1);
  expect(await waitForEdit(page)).toContain('$x^2+y^2=z^2$');
  await expectRealKatex(page, 1);
});

test('Edit popover Apply renders real KaTeX', async ({ page }) => {
  await openEditor(page, 'Alpha $x$ here.\n\nEnd\n');
  await page.locator('#content .md-math-inline .md-math-toggle').click();
  await page.locator('.md-math-edit-input').fill('y^3');
  await page.locator('.md-math-edit-input').press('ControlOrMeta+Enter');
  await expectRealKatex(page, 1);
  expect(await readAnnotations(page)).toEqual(['y^3']);
});

test('Edit popover Apply with the engine 404: data-tex and the .md stay right', async ({ page }) => {
  await openEditor(page, 'Alpha $x$ here.\n\nEnd\n', MISSING_ENGINE);
  await page.locator('#content .md-math-inline .md-math-toggle').click();
  await page.locator('.md-math-edit-input').fill('y^3');
  await page.locator('.md-math-edit-input').press('ControlOrMeta+Enter');
  await expect(page.locator('#content .md-math-inline')).toHaveAttribute('data-tex', 'y^3');
  await expect(page.locator('#content .katex-fallback')).toHaveCount(1);
  await clearPosted(page);
  await typeAfterEnd(page, '!');
  expect(await waitForEdit(page)).toBe('Alpha $y^3$ here.\n\nEnd!\n');
});

test('a trigger popup open while the first formula arrives: rendered once the popup closes and the engine loads', async ({
  page,
}) => {
  await serveEngineLate(page);
  await openEditor(page, '', SLOW_ENGINE);
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content) => {
    const range = document.createRange();
    range.selectNodeContents(content.querySelector('p') as HTMLElement);
    range.collapse(true);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  // One quick round trip: the deferred update is dropped once the typed `/` syncs (~250 ms).
  const whileOpen = await page.evaluate(
    () =>
      new Promise<{ katex: number; scripts: number }>((resolve) => {
        window.postMessage({ type: 'update', text: 'Injected $x$ while open\n' }, '*');
        setTimeout(() =>
          resolve({
            katex: document.querySelectorAll('#content .katex').length,
            scripts: document.head.querySelectorAll('script[src$="math-engine.js"]').length,
          })
        );
      })
  );
  // Deferred behind the popup: not rendered, so the engine is not even requested yet.
  expect(whileOpen).toEqual({ katex: 0, scripts: 0 });

  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('#content')).toContainText('Injected');
  await expectRealKatex(page, 1);
  // The `/` left by Escape synced during the load; the host text still wins, as on the eager build.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __mirror: string }).__mirror))
    .toBe('Injected $x$ while open\n');
});

test('a popup reopened during the load: a commit made after the load still makes the deferred update stale', async ({
  page,
}) => {
  await serveEngineLate(page);
  await openEditor(page, '', SLOW_ENGINE);
  await page.locator('#content').click();
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await postUpdate(page, 'Injected $x$ while open\n');
  // Escape releases the popup: the flush meets the first formula and holds for the engine.
  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  expect(await engineScripts(page)).toBe(1);
  // A second popup opens during the load and still owns the keyboard when the engine settles.
  await page.keyboard.press('Backspace');
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await page.waitForFunction(() => 'OrcaMathEngine' in window);
  await page.waitForTimeout(100);
  await expect(page.locator('#content')).not.toContainText('Injected');

  // A commit after the load is a local edit the deferred host text never saw: stale, the local DOM wins (eager rule).
  await page.keyboard.type('heading', { delay: 20 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('#content :is(h1, h2, h3, h4, h5, h6)')).toHaveCount(1);
  await page.waitForTimeout(100);
  await expect(page.locator('#content')).not.toContainText('Injected');
});
