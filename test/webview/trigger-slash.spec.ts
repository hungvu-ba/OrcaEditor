/**
 * Req 20 US-20.2 (`/` Define) + US-20.3 (`/` Execute) — trigger-slash.ts wired
 * into the real main.js bundle (unlike trigger-popup-shell.spec.ts, which
 * drives the shell directly with a fake dataSource; here `/` is a real typed
 * character in a real contentEditable).
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted, DEFAULT_DOC_URI } from './_harness';

type Posted = { type: string; text?: string; commandId?: string; docUri?: string };

async function posted(page: import('@playwright/test').Page): Promise<Posted[]> {
  return page.evaluate(() => (window as unknown as { __posted: Posted[] }).__posted);
}

/** Collapse the caret to the start (`atStart`) or end of `selector`'s first match. */
async function placeCaretIn(
  page: import('@playwright/test').Page,
  selector: string,
  atStart: boolean
): Promise<void> {
  await page.locator('#content').click();
  await page.locator(selector).first().evaluate((el, collapseToStart) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(collapseToStart);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, atStart);
}

/** Caret at the very start of #content's (only) empty paragraph. */
async function focusEmptyParagraph(page: import('@playwright/test').Page): Promise<void> {
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
}

test('typing `/` at the start of an empty paragraph opens the popup with Blocks + Insert (no Execute configured)', async ({
  page,
}) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');

  const card = page.locator('.trigger-popup');
  await expect(card).toBeVisible();
  const groupLabels = await card.locator('.trigger-popup-group-label').allTextContents();
  expect(groupLabels).toEqual(['Blocks', 'Insert']);
  const labels = await card.locator('.trigger-popup-item-label').allTextContents();
  expect(labels).toContain('Heading 1');
  expect(labels).toContain("Insert today's date");
});

test('mid-sentence `/` opens the popup but omits the Blocks group (location-sensitive filtering)', async ({
  page,
}) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('Hello ');
  await page.keyboard.type('/');

  const card = page.locator('.trigger-popup');
  await expect(card).toBeVisible();
  const groupLabels = await card.locator('.trigger-popup-group-label').allTextContents();
  expect(groupLabels).toEqual(['Insert']);
});

test('`/` typed mid-word (no preceding whitespace) does not open the popup', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('and');
  await page.keyboard.type('/');
  await page.keyboard.type('or');

  await expect(page.locator('.trigger-popup')).toBeHidden();
  const text = await page.locator('#content p').first().textContent();
  expect(text).toBe('and/or');
});

test('selecting "Heading 1" replaces `/heading 1` with an <h1> as a single undo-step edit', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/heading 1');
  await clearPosted(page);

  await page.locator('.trigger-popup-item', { hasText: 'Heading 1' }).first().click();

  await page.waitForFunction(() => !!document.querySelector('#content h1'));
  const heading = await page.locator('#content h1').first().textContent();
  expect(heading?.trim()).toBe('');
  await expect(page.locator('.trigger-popup')).toBeHidden();

  // flushPendingSync (prior typing) + the delete+insert itself may each post
  // their own 'edit', but the delete-`/heading 1`-then-insert-<h1> part must
  // land as exactly ONE more edit after the action — never a separate
  // delete-only edit followed by an insert-only edit.
  const edits = (await posted(page)).filter((m) => m.type === 'edit');
  expect(edits.length).toBeLessThanOrEqual(2);
  expect(edits.at(-1)?.text).not.toContain('/heading');
});

test('"Insert today\'s date" inserts the configured format mid-sentence (group 2, no empty-paragraph requirement)', async ({
  page,
}) => {
  await openEditor(page, '', { trigger: { dateFormat: 'DD/MM/YYYY', executeCommands: [], mode: 'advanced' } });
  await focusEmptyParagraph(page);
  await page.keyboard.type('Today is ');
  await page.keyboard.type('/date');
  await page.locator('.trigger-popup-item', { hasText: "Insert today's date" }).first().click();

  await expect(page.locator('.trigger-popup')).toBeHidden();
  const text = await page.locator('#content p').first().textContent();
  expect(text).toMatch(/^Today is \d{2}\/\d{2}\/\d{4}$/);
});

test('`/` + space with an empty filter literalizes: popup closes, `/ ` stays as typed text', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.type(' ');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  await page.keyboard.type('b');
  const text = await page.locator('#content p').first().textContent();
  expect(text).toBe('/ b');
});

test('a space typed with a non-empty filter is an ordinary filter character (does not literalize)', async ({
  page,
}) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/heading');
  await page.keyboard.type(' 1');

  await expect(page.locator('.trigger-popup')).toBeVisible();
  const labels = await page.locator('.trigger-popup-item-label').allTextContents();
  expect(labels).toEqual(['Heading 1']);
});

test('Backspace past the `/` closes the popup non-destructively', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/tab');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace'); // deletes the '/' itself
  await expect(page.locator('.trigger-popup')).toBeHidden();
  const text = await page.locator('#content p').first().textContent();
  expect(text).toBe('');
});

test('filter narrows items (diacritic/case-insensitive) and an unmatched filter shows "No matches"', async ({
  page,
}) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/HEADING');
  let labels = await page.locator('.trigger-popup-item-label').allTextContents();
  expect(labels.sort()).toEqual(['Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'].sort());

  for (let i = 0; i < 'HEADING'.length; i++) {
    await page.keyboard.press('Backspace');
  }
  await page.keyboard.type('zzzznotarealitem');
  await expect(page.locator('.trigger-popup-empty')).toHaveText('No matches');
  labels = await page.locator('.trigger-popup-item-label').allTextContents();
  expect(labels).toEqual([]);
});

test('ArrowDown/ArrowUp move the highlight and Enter selects the highlighted item', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/heading');
  await expect(page.locator('.trigger-popup-item')).toHaveCount(6);
  // Default highlight is the first item (Heading 1).
  await expect(page.locator('.trigger-popup-item').first()).toHaveClass(/trigger-popup-item-active/);

  // Down twice → Heading 3 (index 2); Up once → back to Heading 2 (index 1).
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.trigger-popup-item').nth(1)).toHaveClass(/trigger-popup-item-active/);

  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !!document.querySelector('#content h2'));
  await expect(page.locator('.trigger-popup')).toBeHidden();
});

test('Escape closes the popup non-destructively, leaving the typed `/filter` untouched', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/heading');
  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  const text = await page.locator('#content p').first().textContent();
  expect(text).toBe('/heading');
});

test('Execute group: picking a command posts executeCommand with this document\'s uri and deletes the `/filter` with no textual trace', async ({
  page,
}) => {
  await openEditor(page, '', {
    trigger: { dateFormat: 'YYYY-MM-DD', executeCommands: [{ id: 'orcaEditor.openToc', label: 'Show/Hide Table of Contents' }], mode: 'advanced' },
  });
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await clearPosted(page);

  await page.locator('.trigger-popup-item', { hasText: 'Show/Hide Table of Contents' }).first().click();

  await expect(page.locator('.trigger-popup')).toBeHidden();
  const text = await page.locator('#content p').first().textContent();
  expect(text).toBe(''); // command item leaves no textual trace (US-20.3)

  await page.waitForFunction(() => (window as unknown as { __posted: Posted[] }).__posted.some((m) => m.type === 'executeCommand'));
  const exec = (await posted(page)).find((m) => m.type === 'executeCommand');
  expect(exec?.commandId).toBe('orcaEditor.openToc');
  expect(exec?.docUri).toBe(DEFAULT_DOC_URI);
});

test('Execute group is omitted entirely when the membership list is empty', async ({ page }) => {
  await openEditor(page, '', { trigger: { dateFormat: 'YYYY-MM-DD', executeCommands: [], mode: 'advanced' } });
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  const groupLabels = await page.locator('.trigger-popup-group-label').allTextContents();
  expect(groupLabels).not.toContain('Execute');
});

// US-20.2 inherits US-20.1's allowed block types (paragraph, heading H1–H3,
// list item, blockquote). Bug General "Mention Declare" #1 (`/declare` after a
// `###` heading) and #2 (`/` inside a heading/bullet) both came from the `/`
// gate wrongly restricting to a top-level <p>.
test('typing `/` at a start-of-word position inside a heading opens the popup (Mention Declare #1)', async ({
  page,
}) => {
  await openEditor(page, '# Heading\n');
  await placeCaretIn(page, '#content h1', false); // caret at end of the heading text
  await page.keyboard.type(' '); // whitespace → start-of-word boundary
  await page.keyboard.type('/');

  await expect(page.locator('.trigger-popup')).toBeVisible();
  expect(await page.locator('.trigger-popup-item').count()).toBeGreaterThan(0);
});

test('typing `/` at the start of a bullet opens the popup (Mention Declare #2)', async ({ page }) => {
  await openEditor(page, '- item\n');
  await placeCaretIn(page, '#content li', true); // caret at the start of the list item
  await page.keyboard.type('/');

  await expect(page.locator('.trigger-popup')).toBeVisible();
  expect(await page.locator('.trigger-popup-item').count()).toBeGreaterThan(0);
});

/** Build a genuinely empty `<h1>` (caret inside) via the slash command itself. */
async function makeEmptyHeadingWithCaret(page: import('@playwright/test').Page): Promise<void> {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/heading 1');
  await page.locator('.trigger-popup-item', { hasText: 'Heading 1' }).first().click();
  await page.waitForFunction(() => !!document.querySelector('#content h1'));
  await placeCaretIn(page, '#content h1', true);
}

test('`/` at the start of an empty heading offers the full Blocks group (treated as start-of-line)', async ({
  page,
}) => {
  await makeEmptyHeadingWithCaret(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  const groupLabels = await page.locator('.trigger-popup-group-label').allTextContents();
  expect(groupLabels).toContain('Blocks');
  const labels = await page.locator('.trigger-popup-item-label').allTextContents();
  expect(labels).toContain('Heading 2');
  expect(labels).toContain('Table');
});

test('picking an insert-block (Table) inside an empty heading replaces it with a clean top-level block (no nested/stray heading)', async ({
  page,
}) => {
  await makeEmptyHeadingWithCaret(page);
  await page.keyboard.type('/table');
  await page.locator('.trigger-popup-item', { hasText: 'Table' }).first().click();

  await page.waitForFunction(() => !!document.querySelector('#content > table'));
  expect(await page.locator('#content h1').count()).toBe(0); // empty heading gone, not left stray
  expect(await page.locator('#content h1 table, #content table table').count()).toBe(0); // never nested
});

test('picking a convert-block (Heading 2) inside an empty heading converts it in place', async ({ page }) => {
  await makeEmptyHeadingWithCaret(page);
  await page.keyboard.type('/heading 2');
  await page.locator('.trigger-popup-item', { hasText: 'Heading 2' }).first().click();

  await page.waitForFunction(() => !!document.querySelector('#content h2'));
  expect(await page.locator('#content h1').count()).toBe(0);
  expect(await page.locator('#content h2').count()).toBe(1);
});

test('an empty bullet still offers only the inline group (block picks are out of scope for list items)', async ({
  page,
}) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/bullet');
  await page.locator('.trigger-popup-item', { hasText: 'Bulleted list' }).first().click();
  await page.waitForFunction(() => !!document.querySelector('#content li'));

  await placeCaretIn(page, '#content li', true);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  const groupLabels = await page.locator('.trigger-popup-group-label').allTextContents();
  expect(groupLabels).not.toContain('Blocks');
});

test('input-rules stand down while the `/` popup is open (no conflicting `#` heading rule)', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/heading');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  // While the popup owns input, a literal '#'+space typed into the filter must
  // NOT be intercepted by input-rules.ts's own heading shortcut.
  await page.keyboard.type(' #');
  const headingWhileOpen = await page.evaluate(() => !!document.querySelector('#content h1'));
  expect(headingWhileOpen).toBe(false);
});
