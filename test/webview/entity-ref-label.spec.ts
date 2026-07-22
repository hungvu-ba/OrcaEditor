/**
 * Req 21: an entity mention's display text is `NS_ID label` (the entity's human
 * name follows the code, e.g. `UC01 Submit Leave Request`), not the bare code.
 * postProcessEntityRefs must still recognize such an anchor as an entity
 * reference — the href fragment carries the clean `#NS_ID` and the display text
 * only STARTS WITH that token — so it keeps the `.md-entity-ref` hook (hover /
 * `.` drill / broken-ref detection).
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('a mention whose display text is `NS_ID label` is still tagged as an entity ref', async ({ page }) => {
  await openEditor(page, 'See [UC01 Submit Leave Request](#UC01) for details.\n');

  const ref = page.locator('#content a.md-entity-ref');
  await expect(ref).toHaveCount(1);
  // The full human name is the visible text; the fragment stays the clean token.
  await expect(ref).toHaveText('UC01 Submit Leave Request');
  await expect(ref).toHaveAttribute('href', '#UC01');
});

test('a plain link that merely shares a prefix with the fragment is NOT an entity ref', async ({ page }) => {
  // Display text `UC01x` starts with `UC01` but not at a word boundary (no
  // following space), so `startsWith(fragment + ' ')` rejects it.
  await openEditor(page, 'See [UC01x](#UC01) here.\n');
  await expect(page.locator('#content a.md-entity-ref')).toHaveCount(0);
});
