/**
 * Performance Low-End GATE A (T4.1, audit L-9): the identity net for moving
 * KaTeX out of main.js into a lazily loaded engine. Each fixture pins what a
 * math document renders (formula counts, the TeX every formula carries) and
 * that serializing it gives back the source bytes — green on the eager build,
 * and it must stay green once the math rules render through the lazy engine.
 */
import { test, expect } from '@playwright/test';
import { clearPosted, openEditor, waitForEdit } from './_harness';

type Page = import('@playwright/test').Page;

interface MathFixture {
  name: string;
  /** Ends with the plain paragraph `End`, the one block the test edits. */
  source: string;
  /** Every `.katex` under #content (a display formula holds one too). */
  katex: number;
  /** Every `.katex-display` under #content. */
  display: number;
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
    expect(await readAnnotations(page)).toEqual(fixture.tex);

    // No block is cached right after a render, so this one edit serializes the
    // whole document: everything but the typed character must be the pinned bytes.
    await clearPosted(page);
    await typeAfterEnd(page, '!');
    expect(await waitForEdit(page)).toBe((fixture.serialized ?? fixture.source).replace(/End\n$/, 'End!\n'));
  });
}
