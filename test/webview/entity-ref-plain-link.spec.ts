/**
 * bug_General Mention Declare #2: an entity REFERENCE renders as a normal
 * hyperlink, NOT a muted pill (PO decision 2026-07-22). postProcessEntityRefs
 * still stamps `.md-entity-ref` (JS/selector hook), but markdown.css carries no
 * base pill rule for it, so it inherits the standard content-link appearance.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('an entity reference renders as a plain hyperlink, not a pill', async ({ page }) => {
  await openEditor(page, 'See [UC01](#UC01) for details.\n');

  const ref = page.locator('#content a.md-entity-ref');
  await expect(ref).toHaveCount(1);

  // No pill treatment: transparent background + no rounded-capsule radius.
  const tokens = await ref.evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, borderRadius: s.borderTopLeftRadius };
  });
  expect(tokens.background).toBe('rgba(0, 0, 0, 0)');
  expect(tokens.borderRadius).toBe('0px');
});
