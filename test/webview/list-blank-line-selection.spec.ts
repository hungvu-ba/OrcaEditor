/**
 * Two distinct behaviours when a Bullet/Numbered/Task-List click covers a
 * selection that spans something other than plain text, both routed through the
 * shared setBulletList/setNumberedList/toggleTaskItem paths (media/webview/
 * toolbar.ts, list-ops.ts) — and both fixing the old corruption where these
 * cases fell through to the legacy execCommand fallback (empty `*   ` bullets,
 * a literal `*   ---` item, `<ul>` nested in a leftover `<p>`), bug 0717r3 #5:
 *
 *   1. A GENUINELY empty line (a real <p><br></p> produced by pressing Enter)
 *      is SPACING → dropped. It's still a <p> (listable), so resolveTopLevelBlocks
 *      accepts it and computeToList drops empty-textContent blocks. No empty item.
 *   2. An <hr> is CONTENT → PRESERVED, with the list splitting AROUND it.
 *      resolveTopLevelBlocks (strict P/UL/OL) bails, so the click routes through
 *      resolveTopLevelBlockRun -> computeToListAroundAtoms, which keeps the <hr>
 *      verbatim between two lists. The HR cases fail without that atom-aware path
 *      (the old legacy fallback deleted the <hr> / dumped it in as `*   ---`).
 *
 * NOTE: markdown blank lines (`Alpha\n\nBravo`) render as separate paragraphs
 * with NO empty <p> between them, so they can't exercise case 1. The blank <p>
 * only exists once the user physically presses Enter, which this spec does.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

type PWPage = import('@playwright/test').Page;

/** Place a collapsed caret at the end of the paragraph whose text is `pText`. */
async function caretAtEndOf(page: PWPage, pText: string): Promise<void> {
  await page.locator('#content').evaluate((el, text) => {
    const p = Array.from(el.querySelectorAll('p')).find((n) => n.textContent === text)!;
    const range = document.createRange();
    range.selectNodeContents(p.firstChild ?? p);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, pText);
}

/** Selects from the start of `firstText`'s paragraph to the end of `lastText`'s paragraph. */
async function selectParagraphRange(page: PWPage, firstText: string, lastText: string): Promise<void> {
  await page.locator('#content').evaluate(
    (el, [first, last]) => {
      const paragraphs = Array.from(el.querySelectorAll('p'));
      const startP = paragraphs.find((p) => p.textContent === first)!;
      const endP = paragraphs.find((p) => p.textContent === last)!;
      const range = document.createRange();
      range.setStart(startP.firstChild!, 0);
      range.setEnd(endP.firstChild!, (endP.firstChild!.textContent ?? '').length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    [firstText, lastText]
  );
}

/** Count genuinely-empty top-level blocks strictly between the Alpha and Bravo paragraphs. */
async function blankBlocksBetweenAlphaBravo(page: PWPage): Promise<number> {
  return page.locator('#content').evaluate((el) => {
    const ps = Array.from(el.querySelectorAll('p'));
    const alpha = ps.find((p) => p.textContent === 'Alpha')!;
    const bravo = ps.find((p) => p.textContent === 'Bravo')!;
    let n = 0;
    for (let s = alpha.nextElementSibling; s && s !== bravo; s = s.nextElementSibling) {
      if ((s.textContent ?? '').trim() === '') n++;
    }
    return n;
  });
}

/**
 * Reproduce the TC2.3b/2.4b/2.7b setup: two paragraphs Alpha and Bravo, caret at
 * end of Alpha, press Enter twice to insert a genuinely-empty paragraph between
 * them. Asserts the blank <p> really exists so the test can't silently pass
 * without exercising the blank-drop filter.
 */
async function setupBlankBetweenAlphaBravo(page: PWPage): Promise<void> {
  await openEditor(page, 'Alpha\n\nBravo');
  await caretAtEndOf(page, 'Alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await waitForEdit(page); // flush the typing edit so the later waitForEdit sees only the button's edit
  expect(await blankBlocksBetweenAlphaBravo(page)).toBeGreaterThan(0);
}

test('Bullet on a selection spanning a real blank line drops the blank, no empty bullet', async ({ page }) => {
  await setupBlankBetweenAlphaBravo(page);
  await selectParagraphRange(page, 'Alpha', 'Bravo');
  await clearPosted(page);
  await page.locator('#fmt-bullet').click();
  const md = await waitForEdit(page);

  const lines = md.split('\n').filter((l) => l.trim() !== '');
  expect(lines).toEqual(['*   Alpha', '*   Bravo']);
});

test('Numbered on a selection spanning a real blank line drops the blank, no empty item', async ({ page }) => {
  await setupBlankBetweenAlphaBravo(page);
  await selectParagraphRange(page, 'Alpha', 'Bravo');
  await clearPosted(page);
  await page.locator('#fmt-numbered').click();
  const md = await waitForEdit(page);

  const lines = md.split('\n').filter((l) => l.trim() !== '');
  expect(lines).toEqual(['1.  Alpha', '2.  Bravo']);
});

test('Task List on a selection spanning a real blank line drops the blank, no empty checkbox item', async ({ page }) => {
  await setupBlankBetweenAlphaBravo(page);
  await selectParagraphRange(page, 'Alpha', 'Bravo');
  await clearPosted(page);
  await page.locator('#fmt-task').click();
  const md = await waitForEdit(page);

  const lines = md.split('\n').filter((l) => l.trim() !== '');
  expect(lines).toEqual(['*   [ ] Alpha', '*   [ ] Bravo']);
});

test('Bullet on a selection spanning an <hr> keeps the hr, list splits around it, no empty/`---` item', async ({ page }) => {
  await openEditor(page, 'Alpha\n\n---\n\nBravo');
  await selectParagraphRange(page, 'Alpha', 'Bravo');
  await clearPosted(page);
  await page.locator('#fmt-bullet').click();
  const md = await waitForEdit(page);

  const lines = md.split('\n').filter((l) => l.trim() !== '');
  expect(lines).toEqual(['*   Alpha', '---', '*   Bravo']);
});

test('Numbered on a selection spanning an <hr> keeps the hr, list splits around it', async ({ page }) => {
  await openEditor(page, 'Alpha\n\n---\n\nBravo');
  await selectParagraphRange(page, 'Alpha', 'Bravo');
  await clearPosted(page);
  await page.locator('#fmt-numbered').click();
  const md = await waitForEdit(page);

  const lines = md.split('\n').filter((l) => l.trim() !== '');
  expect(lines).toEqual(['1.  Alpha', '---', '1.  Bravo']);
});

test('Task List on a selection spanning an <hr> keeps the hr, list splits around it', async ({ page }) => {
  await openEditor(page, 'Alpha\n\n---\n\nBravo');
  await selectParagraphRange(page, 'Alpha', 'Bravo');
  await clearPosted(page);
  await page.locator('#fmt-task').click();
  const md = await waitForEdit(page);

  const lines = md.split('\n').filter((l) => l.trim() !== '');
  expect(lines).toEqual(['*   [ ] Alpha', '---', '*   [ ] Bravo']);
});
