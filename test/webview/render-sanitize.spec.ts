/**
 * Security — Audit S-2: a raw `<meta http-equiv="refresh">` HTML block must
 * not survive into the live, connected `#content` — no CSP directive covers
 * meta refresh, so an unsanitized render would attempt navigation just from
 * opening the document. Needs the real webview (main.js's renderDocument +
 * stripMetaRefresh, both browser-only) — domino/test/roundtrip never runs
 * this code path.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('a raw <meta http-equiv="refresh"> HTML block is stripped and never navigates the page', async ({ page }) => {
  const doc =
    '# Heading\n\n<meta http-equiv="refresh" content="0;url=https://example.com/">\n\nAfter the meta tag.\n';
  await openEditor(page, doc);
  const harnessUrl = page.url();

  await expect(page.locator('#content')).toContainText('After the meta tag.');
  expect(await page.locator('#content meta').count()).toBe(0);
  // Give an unsanitized tag time to fire before asserting nothing navigated.
  await page.waitForTimeout(300);
  expect(page.url()).toBe(harnessUrl);
});

test('a document with no raw HTML renders unaffected (sanitizer is a no-op otherwise)', async ({ page }) => {
  await openEditor(page, '# Heading\n\nA normal paragraph with **bold** text.\n');
  await expect(page.locator('#content h1')).toHaveText('Heading');
  await expect(page.locator('#content strong')).toHaveText('bold');
});

// Review finding (step-04 iteration 2, edge case hunter): renderDocument's
// stripMetaRefresh only covered the OPEN-a-document path. Paste/insert
// (insertPastedMarkdown/insertMarkdownAtCaret, via renderPasteHtml in
// main.ts) runs text through the SAME html:true renderer and lands it in the
// live #content via execCommand('insertHTML', ...) — the same S-2 shape,
// through a second entry point. renderPasteHtml now sanitizes too (defense-
// in-depth). NOT covered by a dedicated test here: empirically, Chromium's
// execCommand('insertHTML') already drops a <meta> before it reaches the DOM
// regardless of this fix (verified against this harness — the outcome is
// identical with the line commented out), so a test asserting on the final
// DOM here cannot distinguish fixed from unfixed and would be a tautology —
// see the comment at the renderPasteHtml call site in main.ts for the
// reasoning on why the fix is kept anyway.
