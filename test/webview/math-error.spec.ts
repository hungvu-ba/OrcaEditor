/**
 * Performance Low-End T4.8 review (pending T4.8.p1): a formula KaTeX cannot
 * parse is one unit like a valid formula — wrapped by postProcessMathDom with
 * `data-tex` from the math plugin's `title`, its error message not editable,
 * fixed through the Edit popover. Byte identity lives in
 * test/roundtrip/math-source.ts and test/webview/math-lazy.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { clearPosted, openEditor, waitForEdit } from './_harness';

type Page = import('@playwright/test').Page;

/** Put the caret at `offset` in the first text node of the top-level paragraph reading `text`. */
async function placeCaretInParagraph(page: Page, text: string, offset: number): Promise<void> {
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

/** Click just inside the right edge of `locator`, vertically centred. */
async function clickRightEdge(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    throw new Error(`${selector} has no box`);
  }
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
}

test('invalid inline formula: wrapped like a valid one, its message not editable', async ({ page }) => {
  await openEditor(page, 'Bad $\\frac{$\n\nEnd\n');

  const wrapper = page.locator('#content .md-math-inline');
  await expect(wrapper).toHaveAttribute('data-tex', '\\frac{');
  await expect(wrapper.locator('.md-math-render[contenteditable="false"] .katex-error')).toHaveCount(1);
  const message = (await wrapper.locator('.katex-error').textContent()) ?? '';
  expect(message).toContain('ParseError');

  // Before the wrapper the click landed inside the error span and the typed text went into it.
  await clickRightEdge(page, '#content > p');
  await page.keyboard.type(' more');
  await expect(wrapper.locator('.katex-error')).toHaveText(message);
});

test('invalid inline formula: the Edit popover opens on its TeX and Apply writes the fixed formula', async ({ page }) => {
  await openEditor(page, 'Bad $\\frac{$ tex.\n\nEnd\n');

  await page.locator('#content .md-math-inline .md-math-toggle').click();
  const input = page.locator('.md-math-edit-input');
  await expect(input).toHaveValue('\\frac{');
  await input.fill('\\frac{a}{b}');
  await input.press('ControlOrMeta+Enter');
  await expect(page.locator('#content .md-math-inline .katex')).toHaveCount(1);
  // Apply re-renders in place; the next edit carries it to the file.
  await clearPosted(page);
  await placeCaretInParagraph(page, 'End', 3);
  await page.keyboard.type('!');
  expect(await waitForEdit(page)).toBe('Bad $\\frac{a}{b}$ tex.\n\nEnd!\n');
});

test('invalid $$ block: Enter at its end never duplicates it in the file', async ({ page }) => {
  const source = 'Before\n\n$$\n\\frac{\n$$\n\nEnd\n';
  await openEditor(page, source);
  await expect(page.locator('#content .md-math-block .md-math-render[contenteditable="false"] .katex-error')).toHaveCount(1);

  // Before the wrapper Chromium cloned the error <p> (class + title) and both halves serialized the TeX.
  await clickRightEdge(page, '#content > .md-math-block');
  await page.keyboard.press('Enter');
  await page.keyboard.type('new para');
  await clearPosted(page);
  await placeCaretInParagraph(page, 'End', 3);
  await page.keyboard.type('!');
  expect(await waitForEdit(page)).toBe(source.replace(/End\n$/, 'End!\n'));
});

test('invalid $$ block: Backspace at the start of the next paragraph acts as after a valid block', async ({ page }) => {
  // Before the wrapper the paragraph merged INTO the error <p> and was dropped from the file.
  const edits: string[] = [];
  for (const tex of ['x', '\\frac{']) {
    await openEditor(page, `Before\n\n$$\n${tex}\n$$\n\nAfter text\n`);
    await clearPosted(page);
    await placeCaretInParagraph(page, 'After text', 0);
    await page.keyboard.press('Backspace');
    edits.push(await waitForEdit(page));
  }
  expect(edits[1]).toBe(edits[0]);
  expect(edits[1]).toContain('After text');
});

test('invalid $$ block: every math block keeps its source line', async ({ page }) => {
  // One error block used to drop data-line from every valid block (range count != display count).
  await openEditor(page, 'Before\n\n$$\n\\frac{\n$$\n\n$$\nx\n$$\n\nEnd\n');
  const lines = await page
    .locator('#content .md-math-block')
    .evaluateAll((els) => els.map((el) => [el.getAttribute('data-line'), el.getAttribute('data-line-end')]));
  expect(lines).toEqual([
    ['3', '5'],
    ['7', '9'],
  ]);
});
