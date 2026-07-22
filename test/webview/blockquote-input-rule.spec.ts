/**
 * Group HrCaretTrap (bug 0717 round3, Bugs #7 + #9). A CommonMark blank line
 * produces NO DOM node, so the visual gap directly above a mid-document <hr>
 * has no editable block — a click there resolves Selection.anchorNode to the
 * #content root, and native execCommand then absorbs the adjacent <hr> into a
 * blockquote (Bug #9: `>` typed above `---` becomes `> ---`) or a heading
 * (Bug #7). Two layers guard this:
 *   - Layer 1: renderDocument() ensures an empty <p> sits before every
 *     top-level <hr>, so gap-clicks land in a real caret target.
 *   - Layer 2: formatHeading bails when the anchor is the #content root itself,
 *     never running the corrupting execCommand('formatBlock') next to an <hr>.
 * See media/webview/main.ts (ensureCaretSpotBeforeHr) and
 * media/webview/toolbar.ts (formatHeading).
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted } from './_harness';

/**
 * Wait for the settled 'edit' whose text contains `needle`. scheduleSync
 * debounces per keystroke, so a fast keyboard.type() posts several intermediate
 * edits ("> Quoted" before "> Quoted line" finishes); waitForEdit returns the
 * first one, which races the final content. Poll for the last edit to reach the
 * complete text instead.
 */
async function waitForFinalEdit(page: import('@playwright/test').Page, needle: string): Promise<string> {
  const handle = await page.waitForFunction(
    (text) => {
      const posted = (window as unknown as { __posted: Array<{ type: string; text: string }> }).__posted;
      const last = posted.filter((m) => m.type === 'edit').at(-1);
      return last && last.text.includes(text) ? last.text : false;
    },
    needle,
    { timeout: 2000 }
  );
  return (await handle.jsonValue()) as string;
}

test('Bug #9: a caret trap <p> exists immediately before a mid-document <hr>', async ({ page }) => {
  await openEditor(page, '## Heading A\n\n---\n\n## Heading B');
  const trapOk = await page.locator('#content').evaluate((content) => {
    const hr = content.querySelector(':scope > hr');
    const prev = hr?.previousElementSibling;
    return prev?.nodeName === 'P' && (prev.textContent ?? '').trim() === '';
  });
  expect(trapOk).toBe(true);
});

test('Bug #9: typing `>` in the gap above an <hr> makes a clean blockquote, not `> ---`', async ({
  page,
}) => {
  await openEditor(page, '## Heading A\n\n---\n\n## Heading B');

  // Real click in the visual gap between Heading A and the <hr> — the spot the
  // manual test tells the user to click. With the Layer 1 caret trap present it
  // resolves into the empty <p>; without it, it lands on the #content root.
  const point = await page.locator('#content').evaluate((content) => {
    const headingA = content.querySelector('h2')!;
    const hr = content.querySelector(':scope > hr')!;
    const a = headingA.getBoundingClientRect();
    const h = hr.getBoundingClientRect();
    return { x: h.left + h.width / 2, y: (a.bottom + h.top) / 2 };
  });
  await page.mouse.click(point.x, point.y);

  const anchorTag = await page.evaluate(() => {
    const n = window.getSelection()?.anchorNode ?? null;
    if (!n) return null;
    return n.nodeType === Node.ELEMENT_NODE ? n.nodeName : n.parentElement?.nodeName ?? null;
  });
  expect(anchorTag).toBe('P');

  await clearPosted(page);
  await page.keyboard.type('> Quoted line');
  const md = await waitForFinalEdit(page, 'Quoted line');

  // The <hr> is the actual Bug #9 corruption: before the caret trap it was
  // absorbed into the blockquote (`> ---`). It must stay a standalone thematic
  // break, and the `>` input rule must have produced a real <blockquote>.
  // Bug #12: the full typed text must land INSIDE the blockquote (caret used to
  // escape into #content after the wrap, leaking " line" and losing characters),
  // so assert the complete `> Quoted line`, not just the "Quoted" prefix.
  expect(md).not.toContain('> ---');
  expect(md).toMatch(/^---$/m);
  expect(md).toContain('> Quoted line');
  const blockquoteText = await page
    .locator('#content blockquote p')
    .first()
    .evaluate((p) => p.textContent);
  expect(blockquoteText).toBe('Quoted line');
});

test('Bug #12: `>` input rule on an empty paragraph keeps typed text inside the blockquote', async ({
  page,
}) => {
  // No <hr> anywhere — a genuinely separate defect from Bug #9. The empty
  // paragraph seeded by ensureTrailingParagraph has no text node, so before the
  // fix wrapInBlockquote left the caret at the <blockquote> boundary and the
  // next keystroke escaped into #content beside the quote.
  await openEditor(page, '');
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content) => {
    const p = content.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  await clearPosted(page);
  await page.keyboard.type('> Quoted line');
  const md = await waitForFinalEdit(page, 'Quoted line');

  const dom = await page.locator('#content').evaluate((content) => ({
    // No bare text node leaked beside the blockquote.
    strayText: Array.from(content.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== ''
    ),
    blockquoteText: content.querySelector('blockquote p')?.textContent ?? null,
  }));
  expect(dom.strayText).toBe(false);
  expect(dom.blockquoteText).toBe('Quoted line');
  expect(md.trim()).toBe('> Quoted line');
});

test('Bug #4: typing `> ` inside a blockquote creates a nested blockquote (serializes to `> >`, not `\\>`)', async ({
  page,
}) => {
  // A blockquote with two paragraphs; the second is the one we nest. Before the
  // fix the `>` input rule never fired inside a blockquote, so the typed `> `
  // stayed literal text and turndown escaped it to `\>` (the reported bug).
  await openEditor(page, '> Type here\n>\n> x');

  // Caret at the very start of the paragraph whose text is "x".
  await page.locator('#content').evaluate((content) => {
    const target = Array.from(content.querySelectorAll('blockquote p')).find(
      (p) => (p.textContent ?? '').trim() === 'x'
    )!;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  await clearPosted(page);
  await page.keyboard.type('> ');
  const md = await waitForFinalEdit(page, '> > x');

  // A real nested <blockquote> now wraps the second paragraph...
  const nested = await page
    .locator('#content')
    .evaluate((content) => !!content.querySelector('blockquote > blockquote > p'));
  expect(nested).toBe(true);
  // ...and turndown emits nested quote markers, never an escaped literal `\>`.
  expect(md).toContain('> > x');
  expect(md).not.toContain('\\>');
});

test('Bug #4: the Quote button strips the caret\'s quote level, dropping it one level up', async ({
  page,
}) => {
  await openEditor(page, '> > deeply nested');

  // Caret inside the innermost paragraph of a two-level quote.
  await page.locator('#content').evaluate((content) => {
    const p = content.querySelector('blockquote blockquote p') ?? content.querySelector('blockquote p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  await clearPosted(page);
  await page.locator('#fmt-blockquote').click();
  const md = await waitForFinalEdit(page, 'deeply nested');

  // Only the caret's level is stripped: `> > x` → `> x` (still one quote level),
  // not all the way to plain text.
  expect(md).toContain('> deeply nested');
  expect(md).not.toContain('> > deeply nested');
  const depth = await page.locator('#content').evaluate((content) => {
    let d = 0;
    let el: Element | null = content.querySelector('blockquote p')?.parentElement ?? null;
    while (el) {
      if (el.nodeName === 'BLOCKQUOTE') d++;
      el = el.parentElement;
    }
    return d;
  });
  expect(depth).toBe(1);
});

test('Bug #4: the Quote button removes the caret level + deeper nested quotes, but keeps higher levels', async ({
  page,
}) => {
  // L1 wraps "keep me" and an L2 quote; L2 holds "caret" and a deeper L3 quote.
  await openEditor(page, '> keep me\n>\n> > caret\n> >\n> > > x');

  // Caret in the "caret" paragraph — its nearest quote is L2.
  await page.locator('#content').evaluate((content) => {
    const p = Array.from(content.querySelectorAll('blockquote p')).find(
      (el) => (el.textContent ?? '').trim() === 'caret'
    )!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  await clearPosted(page);
  await page.locator('#fmt-blockquote').click();
  const md = await waitForFinalEdit(page, 'keep me');

  // L1 stays: "keep me" is still quoted. L2 (caret level) and L3 (its child) are
  // gone, so "caret" and "x" drop to L1 — a single `>`, never `> >`.
  expect(md).toContain('> keep me');
  expect(md).toMatch(/^>\s*caret$/m);
  expect(md).toMatch(/^>\s*x$/m);
  expect(md).not.toContain('> > ');

  // The outer L1 blockquote survives and now holds all three paragraphs at depth 1.
  const dom = await page.locator('#content').evaluate((content) => {
    const quotes = Array.from(content.querySelectorAll('blockquote'));
    const maxDepth = quotes.reduce((m, q) => {
      let d = 0;
      let el: Element | null = q;
      while (el) {
        if (el.nodeName === 'BLOCKQUOTE') d++;
        el = el.parentElement;
      }
      return Math.max(m, d);
    }, 0);
    return { count: quotes.length, maxDepth };
  });
  expect(dom.count).toBe(1);
  expect(dom.maxDepth).toBe(1);
});

test('Bug #7: formatHeading on a #content-root selection next to an <hr> does not absorb the hr', async ({
  page,
}) => {
  await openEditor(page, 'Hello world\n\n---\n\n## Next section');

  // Force the degenerate selection the investigation identified: a collapsed
  // caret at the #content root, immediately before the <hr> (what a gap-click
  // produced before the Layer 1 trap existed).
  await page.locator('#content').evaluate((content) => {
    const hr = content.querySelector(':scope > hr')!;
    const idx = Array.from(content.childNodes).indexOf(hr);
    const range = document.createRange();
    range.setStart(content, idx);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  await page.locator('#fmt-heading').click();
  // Layer 2 bails silently (no edit posted), so assert on the DOM directly
  // after letting any (buggy) mutation settle.
  await page.waitForTimeout(300);

  const dom = await page.locator('#content').evaluate((content) => ({
    hrTopLevel: !!content.querySelector(':scope > hr'),
    hrInsideHeading: !!content.querySelector('h1 hr, h2 hr, h3 hr, h4 hr, h5 hr, h6 hr'),
    nextHeading: Array.from(content.querySelectorAll('h2')).some((h) => h.textContent === 'Next section'),
  }));
  expect(dom.hrInsideHeading).toBe(false);
  expect(dom.hrTopLevel).toBe(true);
  expect(dom.nextHeading).toBe(true);
});
