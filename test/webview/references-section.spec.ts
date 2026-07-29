/**
 * Req 20 US-20.5 — `/add reference` wired into the real main.js bundle:
 *   - invocation: `/add ref` + pick posts an `addReference` message with docUri;
 *   - plain click on a References entry (broken ⚠️ or healthy) is a no-op —
 *     same as any other link in the document, no special navigation;
 *   - Cmd/Ctrl+Click on a References entry still posts `openLink`, exactly
 *     like a normal link.
 *
 * The scan/merge itself is host-side + pure (test/roundtrip/references-section.ts);
 * here we only exercise the webview trigger item + the References-entry click
 * behavior, which need real events / Selection API.
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

test('plain-clicking a broken (⚠️) References entry does nothing — no navigation, no quick-correct popover', async ({
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
  await clearPosted(page);

  // The References entry is the LAST anchor with that href (inside the <ul>).
  const refEntry = page.locator('#content ul a[href="missing.md"]');
  await refEntry.click();

  await expect(page.locator('.quick-correct-popover')).toBeHidden();
  const msgs = await posted(page);
  expect(msgs.some((m) => m.type === 'openLink')).toBe(false);
});

test('plain-clicking a healthy References entry does nothing — no openLink posted', async ({ page }) => {
  await openEditor(
    page,
    ['[Real](here.md) in the body.', '', '## References', '', '- [Real](here.md)', ''].join('\n')
  );
  await clearPosted(page);

  const refEntry = page.locator('#content ul a[href="here.md"]');
  await refEntry.click();

  const msgs = await posted(page);
  expect(msgs.some((m) => m.type === 'openLink')).toBe(false);
});

test('Cmd/Ctrl+clicking a References entry still opens its target via openLink, same as any other link', async ({
  page,
}) => {
  await openEditor(
    page,
    ['[Real](here.md) in the body.', '', '## References', '', '- [Real](here.md)', ''].join('\n')
  );
  await clearPosted(page);

  // Dispatched directly (not Playwright's click({modifiers})) — same technique
  // broken-ref-marker.spec.ts uses for a Cmd/Ctrl+Click, which reliably fires
  // the app's own metaKey/ctrlKey branch without invoking a real browser
  // new-tab gesture.
  await page.evaluate(() => {
    const a = document.querySelector('#content ul a[href="here.md"]') as HTMLElement;
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
  });

  await page.waitForFunction(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some((m) => m.type === 'openLink')
  );
  const msg = (await posted(page)).find((m) => m.type === 'openLink');
  expect(msg?.href).toBe('here.md');
});
