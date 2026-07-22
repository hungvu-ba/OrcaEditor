/**
 * Req 21 US-21.3 — `UC01.` dot-drill (entity-scope.ts): typing '.' right after
 * an already-inserted entity-reference `<a>` opens the shared trigger-popup
 * shell scoped to that entity's own content boundary (Headings + Captions),
 * a heading row with nested captions offers a "›" go-deeper affordance, and
 * picking a leaf caption inserts a real link with the LEAF ID ALONE (the
 * dotted path is never written to the document).
 *
 * No host round trip involved (current-document-only, DOM-mirror query) — no
 * `waitForPosted`/reply choreography needed, unlike entity-declare.spec.ts's
 * Entities-scope flow.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

/** Collapse the caret right at the DOM boundary immediately after `selector`'s element — typing there lands in a fresh text node whose previousSibling is that element. */
async function placeCaretAfter(page: import('@playwright/test').Page, selector: string): Promise<void> {
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content, sel) => {
    const anchor = content.querySelector(sel);
    if (!anchor || !anchor.parentNode) throw new Error(`not found: ${sel}`);
    const parent = anchor.parentNode;
    const idx = Array.prototype.indexOf.call(parent.childNodes, anchor) + 1;
    const range = document.createRange();
    range.setStart(parent, idx);
    range.collapse(true);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(range);
  }, selector);
}

const DOC = [
  'caption::UC01 the top-level use case.',
  '',
  '## Business Rule',
  '',
  'caption::BR01 a nested business rule.',
  '',
  'See [UC01](#UC01) again for context.',
  '',
].join('\n');

test('typing "." after a resolved entity reference opens Headings + Captions scoped to it', async ({ page }) => {
  await openEditor(page, DOC);
  await placeCaretAfter(page, 'a.md-entity-ref');
  await page.keyboard.press('.');

  await expect(page.locator('.trigger-popup-item')).toHaveCount(2);
  const labels = await page.locator('.trigger-popup-group-label').allTextContents();
  expect(labels).toEqual(['Headings', 'Captions']);

  const headingRow = page.locator('.trigger-popup-item').filter({ has: page.locator('.trigger-popup-item-label', { hasText: 'Business Rule' }) });
  await expect(headingRow.locator('.trigger-popup-item-badge')).toHaveText('›'); // go-deeper chevron (has a nested caption).

  const captionRow = page.locator('.trigger-popup-item').filter({ has: page.locator('.trigger-popup-item-label', { hasText: 'BR01' }) });
  await expect(captionRow).toHaveClass(/trigger-popup-item-tint-entity/);
  // Dim breadcrumb — the scope anchor + the heading path down to this caption; discarded on commit, never written to the document.
  await expect(captionRow.locator('.trigger-popup-item-detail')).toHaveText('UC01 › Business Rule');
});

test('picking a leaf caption inserts the leaf id alone as a real link, never the dotted path', async ({ page }) => {
  await openEditor(page, DOC);
  await placeCaretAfter(page, 'a.md-entity-ref');
  await page.keyboard.press('.');

  await page.locator('.trigger-popup-item', { hasText: 'BR01' }).click();
  await expect(page.locator('.trigger-popup')).toBeHidden();

  const refs = await page.locator('#content a.md-entity-ref').allTextContents();
  expect(refs).toEqual(['UC01', 'BR01']); // the original UC01 reference is untouched; BR01 is a new, separate link.
  const brHref = await page.locator('#content a.md-entity-ref', { hasText: 'BR01' }).getAttribute('href');
  expect(brHref).toBe('#BR01');
  // The '.' typed to trigger the drill is gone — never written into the document.
  await expect(page.locator('#content')).not.toContainText('UC01.BR01');
});

test('picking a heading row drills one level deeper (chevron), re-scoping the popup to that heading', async ({
  page,
}) => {
  await openEditor(page, DOC);
  await placeCaretAfter(page, 'a.md-entity-ref');
  await page.keyboard.press('.');

  await page
    .locator('.trigger-popup-item')
    .filter({ has: page.locator('.trigger-popup-item-label', { hasText: 'Business Rule' }) })
    .click();

  // Still open (drilling is a navigation pick, same close+reopen idiom as trigger-at.ts's namespace-narrow), now scoped one level deeper.
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await expect(page.locator('.trigger-popup-item')).toHaveCount(1);
  await expect(page.locator('.trigger-popup-group-label')).toHaveText('Captions');
  await expect(page.locator('.trigger-popup-item', { hasText: 'BR01' })).toBeVisible();
});

test('Escape closes the drill popup without inserting anything', async ({ page }) => {
  await openEditor(page, DOC);
  await placeCaretAfter(page, 'a.md-entity-ref');
  await page.keyboard.press('.');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('#content a.md-entity-ref')).toHaveCount(1); // only the original UC01 reference remains.
});
