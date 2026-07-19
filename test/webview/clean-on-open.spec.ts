/**
 * Regression guard: opening a .md file in Orca Editor must NEVER mark the
 * document dirty on its own. The only thing that dirties the TextDocument is
 * the host applying an 'edit' message (provider.ts applyMinimalEdit), so the
 * invariant tested here is: the 'init' → renderDocument path posts no 'edit'.
 *
 * Why this is fragile and worth locking down: the real protection is that
 * renderDocument (main.ts) deliberately does NOT call scheduleSync, and setting
 * content.innerHTML never fires an 'input' event. The secondary syncNow guard
 * (`serialize() === currentText`) does NOT protect here — currentText is the
 * ORIGINAL text while serialize() is turndown(DOM), and turndown is not
 * byte-identical for every input (e.g. CRLF collapses to LF). So if anyone ever
 * adds a scheduleSync() into renderDocument or an init-time module, a
 * non-byte-faithful file would silently go dirty the moment it opens.
 *
 * The inputs below are chosen to be non-byte-faithful on purpose (CRLF line
 * endings; an <hr> that ensureCaretSpotBeforeHr wraps with an empty <p>; a
 * table and math/mermaid that get async post-processing), so a regression that
 * makes init sync would produce an 'edit' that differs from the source and fail
 * the assertion — the second test proves this non-triviality directly.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

/** Count 'edit' messages the webview has posted to the host so far. */
function editCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'edit').length
  );
}

const CRLF_DOC = ['# Title', '', 'First paragraph with trailing spaces.   ', '', '- one', '- two', '', '---', '', 'Done.'].join('\r\n');

const CASES: Array<{ name: string; markdown: string }> = [
  { name: 'CRLF line endings', markdown: CRLF_DOC },
  { name: 'no trailing newline', markdown: '# Heading\n\nA paragraph with no final newline.' },
  { name: 'horizontal rule (empty-<p> caret spot inserted on render)', markdown: 'Above\n\n---\n\nBelow\n' },
  { name: 'table (async column fitting)', markdown: '| A | B |\n| - | - |\n| 1 | 2 |\n' },
  { name: 'math + mermaid (async post-processing)', markdown: '$$a^2 + b^2$$\n\n```mermaid\ngraph TD; A-->B;\n```\n' },
];

for (const { name, markdown } of CASES) {
  test(`opening (${name}) posts no edit — stays clean`, async ({ page }) => {
    await openEditor(page, markdown);
    // Wait well past SYNC_DEBOUNCE_MS (250ms) so any stray scheduleSync would
    // have flushed a debounced 'edit' by now, plus a margin for async
    // math/mermaid post-processing to settle.
    await page.waitForTimeout(700);
    expect(await editCount(page)).toBe(0);
  });
}

test('clicking into plain text to place the caret posts no edit — stays clean', async ({ page }) => {
  await openEditor(page, '# Heading\n\nSome paragraph text to click into.\n');
  // A bare click only moves the caret; contentEditable fires no 'input' for
  // caret placement, and the content click handler (main.ts) only syncs for a
  // task-checkbox toggle — see the next test.
  await page.locator('#content p').click();
  await page.waitForTimeout(700);
  expect(await editCount(page)).toBe(0);
});

test('clicking a task-list checkbox DOES post an edit — the one intentional dirtying click', async ({ page }) => {
  await openEditor(page, '- [ ] todo item\n');
  await page.locator('#content input[type="checkbox"]').click();
  // This click genuinely edits content ([ ] -> [x]), so it must sync.
  const handle = await page.waitForFunction(
    () => (window as unknown as { __posted: Array<{ type: string; text: string }> }).__posted.filter((m) => m.type === 'edit').at(-1),
    undefined,
    { timeout: 2000 }
  );
  const edited = ((await handle.jsonValue()) as { text: string }).text;
  expect(edited).toContain('[x]');
});

test('the CRLF input is genuinely non-byte-faithful, so the no-edit guarantee is non-trivial', async ({ page }) => {
  await openEditor(page, CRLF_DOC);
  await page.waitForTimeout(700);
  // Open path must still be clean.
  expect(await editCount(page)).toBe(0);

  // Now force a real edit: type a character at the end. This is the ONLY path
  // that should ever dirty the document. The resulting serialized markdown must
  // use LF (turndown never emits CR), proving the source (CRLF) would NOT match
  // serialize()'s output — i.e. the guard above cannot rely on the secondary
  // `serialize() === currentText` short-circuit; it truly needs init to skip sync.
  await page.locator('#content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  const handle = await page.waitForFunction(
    () => (window as unknown as { __posted: Array<{ type: string; text: string }> }).__posted.filter((m) => m.type === 'edit').at(-1),
    undefined,
    { timeout: 2000 }
  );
  const edited = ((await handle.jsonValue()) as { text: string }).text;
  expect(edited).not.toContain('\r');
});
