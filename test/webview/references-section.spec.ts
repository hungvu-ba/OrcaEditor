/**
 * Req 20 US-20.5 — `/add reference` wired into the real main.js bundle:
 *   - invocation: `/add ref` + pick posts an `addReference` message with docUri;
 *   - broken-nav: a plain click on a ⚠️ References entry scrolls to the first
 *     body occurrence and opens the quick-correct popover there;
 *   - healthy-open: a plain click on a healthy entry posts `openLink` (no scroll).
 *
 * The scan/merge itself is host-side + pure (test/roundtrip/references-section.ts);
 * here we only exercise the webview trigger item + the References-entry click
 * navigation, which need real events / Selection API.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted, DEFAULT_DOC_URI } from './_harness';

type Posted = { type: string; href?: string; docUri?: string };

async function posted(page: import('@playwright/test').Page): Promise<Posted[]> {
  return page.evaluate(() => (window as unknown as { __posted: Posted[] }).__posted);
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

test('typing `/add ref` and picking "Add reference" posts addReference with this document\'s uri', async ({
  page,
}) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/add ref');
  await clearPosted(page);

  const item = page.locator('.trigger-popup-item', { hasText: 'Add reference' });
  await expect(item).toBeVisible();
  await item.first().click();

  await expect(page.locator('.trigger-popup')).toBeHidden();
  const text = await page.locator('#content p').first().textContent();
  expect(text).toBe(''); // the typed `/add ref` is deleted, no textual trace

  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some((m) => m.type === 'addReference')
  );
  const msg = (await posted(page)).find((m) => m.type === 'addReference');
  expect(msg?.docUri).toBe(DEFAULT_DOC_URI);
});

test('plain-clicking a broken (⚠️) References entry navigates to the first body occurrence + opens quick-correct', async ({
  page,
}) => {
  await openEditor(
    page,
    [
      '# Doc',
      '',
      'See [Old Guide](missing.md) here.',
      '',
      '## References',
      '',
      '- ⚠️ [Old Guide](missing.md)',
      '',
    ].join('\n')
  );

  // The body link (not the References entry) is the nav target.
  const bodyAnchor = page.locator('#content p a[href="missing.md"]');
  await expect(bodyAnchor).toHaveCount(1);

  // The References entry is the LAST anchor with that href (inside the <ul>).
  const refEntry = page.locator('#content ul a[href="missing.md"]');
  await refEntry.click();

  await expect(page.locator('.quick-correct-popover')).toBeVisible();
  // The body occurrence got the transient flash class (removed ~1.2s later).
  await expect(bodyAnchor).toHaveClass(/ref-nav-flash/);
});

test('plain-clicking a healthy References entry opens its target (openLink), no navigation flash', async ({
  page,
}) => {
  await openEditor(
    page,
    ['[Real](here.md) in the body.', '', '## References', '', '- [Real](here.md)', ''].join('\n')
  );
  await clearPosted(page);

  const refEntry = page.locator('#content ul a[href="here.md"]');
  await refEntry.click();

  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some((m) => m.type === 'openLink')
  );
  const msg = (await posted(page)).find((m) => m.type === 'openLink');
  expect(msg?.href).toBe('here.md');

  // Healthy path never flashes a body occurrence and the popover stays closed.
  await expect(page.locator('#content p a[href="here.md"]')).not.toHaveClass(/ref-nav-flash/);
  await expect(page.locator('.quick-correct-popover')).toBeHidden();
});
