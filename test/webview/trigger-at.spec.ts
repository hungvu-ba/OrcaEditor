/**
 * Req 20 US-20.1 (`@` Reference) + US-20.6 (ghost-text + `](` alt-trigger) +
 * US-20.7 (scope tabs) — trigger-at.ts wired into the real main.js bundle (a
 * real `@`/`[`/`(` typed into a real contentEditable, driving the shared
 * trigger-popup.ts shell). Files-scope results are injected by replying to the
 * `searchFiles` message the webview posts (the harness's fake host does not
 * auto-answer), mirroring the real `fileSearchResult` round trip.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

interface Posted {
  type: string;
  query?: string;
  requestId?: number;
}
interface FileReply {
  path: string;
  name: string;
  dir: string;
}
interface NamespaceReply {
  name: string;
  count: number;
}
interface EntityReply {
  namespace: string;
  id: string;
  file: string;
  line: number;
  title: string;
}

/** Reply to the most recent `searchFiles` the webview posted, like the host's `fileSearchResult`. */
async function replyLastFileSearch(page: Page, files: FileReply[]): Promise<void> {
  await page.evaluate((files) => {
    const posted = (window as unknown as { __posted: Posted[] }).__posted;
    const req = [...posted].reverse().find((m) => m.type === 'searchFiles');
    if (!req) throw new Error('no searchFiles posted');
    window.postMessage({ type: 'fileSearchResult', requestId: req.requestId, files }, '*');
  }, files);
}

/** Reply to the most recent `namespaceList` the webview posted, like the host's `namespaceListResult` (Req 21 US-21.2). */
async function replyLastNamespaceList(page: Page, ready: boolean, namespaces: NamespaceReply[]): Promise<void> {
  await page.evaluate(
    ({ ready, namespaces }) => {
      const posted = (window as unknown as { __posted: Posted[] }).__posted;
      const req = [...posted].reverse().find((m) => m.type === 'namespaceList');
      if (!req) throw new Error('no namespaceList posted');
      window.postMessage({ type: 'namespaceListResult', requestId: req.requestId, ready, namespaces }, '*');
    },
    { ready, namespaces }
  );
}

/** Reply to the most recent `entitySearch` the webview posted, like the host's `entityResult` (Req 21 US-21.2). */
async function replyLastEntitySearch(page: Page, ready: boolean, entities: EntityReply[]): Promise<void> {
  await page.evaluate(
    ({ ready, entities }) => {
      const posted = (window as unknown as { __posted: Posted[] }).__posted;
      const req = [...posted].reverse().find((m) => m.type === 'entitySearch');
      if (!req) throw new Error('no entitySearch posted');
      window.postMessage({ type: 'entityResult', requestId: req.requestId, ready, entities }, '*');
    },
    { ready, entities }
  );
}

/** Place a collapsed caret at the start of the paragraph whose text is `paraText`. */
async function caretAtStartOfParagraph(page: Page, paraText: string): Promise<void> {
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content, paraText) => {
    const p = Array.from(content.querySelectorAll('p')).find((el) => el.textContent === paraText);
    const target = p ?? content.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, paraText);
}

/** Select the whole text of the paragraph whose text is `paraText`. */
async function selectParagraphText(page: Page, paraText: string): Promise<void> {
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content, paraText) => {
    const p = Array.from(content.querySelectorAll('p')).find((el) => el.textContent === paraText)!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, paraText);
}

/** Select the display text of the first `<a>` in the document (the "select a link" gesture). */
async function selectLinkText(page: Page): Promise<void> {
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content) => {
    const a = content.querySelector('a')!;
    const range = document.createRange();
    range.selectNodeContents(a);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

test('bare `@` shows current-document headings only (no file dump), with a level badge', async ({ page }) => {
  await openEditor(page, '# Alpha\n\n## Beta\n\ntext');
  await caretAtStartOfParagraph(page, 'text');
  await page.keyboard.type('@');

  const card = page.locator('.trigger-popup');
  await expect(card).toBeVisible();
  await expect(card.locator('.trigger-popup-group-label')).toHaveText(['Headings']);
  const labels = await card.locator('.trigger-popup-item-label').allTextContents();
  expect(labels).toEqual(['Alpha', 'Beta']);
  // No Files search is fired for a bare `@`.
  const searched = await page.evaluate(() =>
    (window as unknown as { __posted: Posted[] }).__posted.some((m) => m.type === 'searchFiles')
  );
  expect(searched).toBe(false);
});

test('scope tabs are All / Files / Headings / Entities in Advanced mode (default)', async ({ page }) => {
  await openEditor(page, '# Alpha\n\ntext');
  await caretAtStartOfParagraph(page, 'text');
  await page.keyboard.type('@');
  const pills = await page.locator('.trigger-popup-pill').allTextContents();
  expect(pills).toEqual(['All', 'Files', 'Headings', 'Entities']);
});

test('Entities scope tab is hidden in Simple mode (Req 21 US-21.5)', async ({ page }) => {
  await openEditor(page, '# Alpha\n\ntext', { trigger: { dateFormat: 'YYYY-MM-DD', executeCommands: [], mode: 'simple' } });
  await caretAtStartOfParagraph(page, 'text');
  await page.keyboard.type('@');
  const pills = await page.locator('.trigger-popup-pill').allTextContents();
  expect(pills).toEqual(['All', 'Files', 'Headings']);
});

test('ghost-text single-match within the active scope + Tab accepts (inserts the heading link)', async ({ page }) => {
  await openEditor(page, '# Alpha\n\n## Beta\n\ntext');
  await caretAtStartOfParagraph(page, 'text');
  await page.keyboard.type('@');
  // Narrow to the Headings scope so the single-match count is a pure local scan.
  await page.locator('.trigger-popup-pill', { hasText: 'Headings' }).click();
  await page.keyboard.type('al'); // matches only "Alpha"

  const ghost = page.locator('.trigger-popup-ghost');
  await expect(ghost).toBeVisible();
  await expect(page.locator('.trigger-popup-ghost-text')).toHaveText('pha'); // "al" + "pha" = "Alpha"

  await page.keyboard.press('Tab');
  await page.waitForFunction(() => !!document.querySelector('#content a[href="#alpha"]'));
  const link = page.locator('#content a[href="#alpha"]');
  await expect(link).toHaveText('Alpha');
  await expect(page.locator('.trigger-popup')).toBeHidden();
});

test('`](` alternate trigger opens the popup seeded with the bracket text, preserving display on pick', async ({
  page,
}) => {
  await openEditor(page, 'text');
  await caretAtStartOfParagraph(page, 'text');
  // Hand-type `[Alpha](` — the `(` after `]` opens the picker via the input event.
  await page.keyboard.type('[Alpha](');

  await expect(page.locator('.trigger-popup')).toBeVisible();
  // Seeded query is the bracket text.
  const seeded = await page.evaluate(
    () => [...(window as unknown as { __posted: Posted[] }).__posted].reverse().find((m) => m.type === 'searchFiles')?.query
  );
  expect(seeded).toBe('Alpha');

  await replyLastFileSearch(page, [{ path: 'target.md', name: 'target.md', dir: '.' }]);
  await page.locator('.trigger-popup-item', { hasText: 'target.md' }).first().click();

  await page.waitForFunction(() => !!document.querySelector('#content a[href="target.md"]'));
  // Display text is the hand-typed `[Alpha]`, untouched; only the URL is filled.
  await expect(page.locator('#content a[href="target.md"]')).toHaveText('Alpha');
});

test('`](` does not fire on paste (only on typed input)', async ({ page }) => {
  await openEditor(page, 'text');
  await caretAtStartOfParagraph(page, 'text');
  await page.locator('#content').evaluate((content) => {
    const p = content.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    // Simulate a paste ending in "](" — inputType insertFromPaste must not trigger.
    p.insertBefore(document.createTextNode('[x]('), p.firstChild);
    p.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', data: null, bubbles: true }));
  });
  await expect(page.locator('.trigger-popup')).toBeHidden();
});

test('scope selection is sticky across popup opens (session-global per editor)', async ({ page }) => {
  await openEditor(page, '# Alpha\n\ntext');
  await caretAtStartOfParagraph(page, 'text');
  await page.keyboard.type('@');
  await page.locator('.trigger-popup-pill', { hasText: 'Headings' }).click();
  await expect(page.locator('.trigger-popup-pill-active')).toHaveText('Headings');
  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();

  // Escape is non-destructive, so the literal '@' stays; remove it to get back to
  // a clean start-of-word before reopening.
  await page.keyboard.press('Backspace');
  // Reopen — the last-chosen scope (Headings) is remembered.
  await page.keyboard.type('@');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await expect(page.locator('.trigger-popup-pill-active')).toHaveText('Headings');
});

test('Ctrl+Tab cycles the scope tabs', async ({ page }) => {
  await openEditor(page, '# Alpha\n\ntext');
  await caretAtStartOfParagraph(page, 'text');
  await page.keyboard.type('@');
  await expect(page.locator('.trigger-popup-pill-active')).toHaveText('All');
  await page.keyboard.press('Control+Tab');
  await expect(page.locator('.trigger-popup-pill-active')).toHaveText('Files');
  await page.keyboard.press('Control+Tab');
  await expect(page.locator('.trigger-popup-pill-active')).toHaveText('Headings');
});

test('Escape after a collapsed `@filter` is non-destructive: the typed text stays literal', async ({ page }) => {
  await openEditor(page, 'text');
  await caretAtStartOfParagraph(page, 'text');
  await page.keyboard.type('@foo');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  const text = await page.locator('#content p').first().textContent();
  expect(text).toBe('@footext');
});

test('Escape with an active selection preserves the selection and inserts no link', async ({ page }) => {
  await openEditor(page, 'link me');
  await selectParagraphText(page, 'link me');
  await page.keyboard.type('@'); // intercepted at keydown; the selection is untouched
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  // No link created; text unchanged and the selection is restored.
  await expect(page.locator('#content a')).toHaveCount(0);
  expect(await page.locator('#content p').first().textContent()).toBe('link me');
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  expect(selected).toBe('link me');
});

test('selection-aware insert (createLink branch): `@` + pick sets href on the selection, keeping display text', async ({
  page,
}) => {
  await openEditor(page, 'link me');
  await selectParagraphText(page, 'link me');
  await page.keyboard.type('@');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await replyLastFileSearch(page, [{ path: 'docs/target.md', name: 'target.md', dir: 'docs' }]);
  await page.locator('.trigger-popup-item', { hasText: 'target.md' }).first().click();

  await page.waitForFunction(() => !!document.querySelector('#content a[href="docs/target.md"]'));
  // Display text is the original selection, preserved; only href is set.
  await expect(page.locator('#content a[href="docs/target.md"]')).toHaveText('link me');
});

test('bug 10: Backspace/typing in a selection-mode `@` popup edits the filter, never the editor link', async ({
  page,
}) => {
  await openEditor(page, 'go to [Doc](Doc.md) now');
  await selectLinkText(page);
  await page.keyboard.type('@'); // intercepted at keydown → selection mode, filter seeded with the link text
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await expect(page.locator('.trigger-popup-query-text')).toHaveText('Doc');

  await page.keyboard.press('Backspace');
  // Filter loses its last char; the link in the document is untouched.
  await expect(page.locator('.trigger-popup-query-text')).toHaveText('Do');
  await expect(page.locator('#content a')).toHaveCount(1);
  await expect(page.locator('#content a')).toHaveText('Doc');

  await page.keyboard.type('x');
  await expect(page.locator('.trigger-popup-query-text')).toHaveText('Dox');
  await expect(page.locator('#content a')).toHaveText('Doc');
});

test('bug 9: abandoning a selection-mode `@` popup releases it so the next `@` still opens', async ({ page }) => {
  await openEditor(page, 'go to [Doc](Doc.md) now');
  await selectLinkText(page);
  await page.keyboard.type('@');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  // Abandon the popup by moving the caret off the link (user clicks elsewhere).
  await page.locator('#content').evaluate((content) => {
    const p = content.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false); // collapse to end of the paragraph
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.locator('.trigger-popup')).toBeHidden();
  const owner = await page.evaluate(() => (window as unknown as { __mdInputOwner?: string }).__mdInputOwner ?? null);
  expect(owner).toBeNull();
  // Abandoning must NOT snap the selection back onto the link (onPopupClose's
  // restore is for cancel/Escape only) — the link stays intact and the caret
  // where the user moved it.
  await expect(page.locator('#content a')).toHaveText('Doc');

  // The next `@` at a start-of-word spot must open a fresh popup (not be swallowed)
  // and must type at the caret, never over the (no-longer-selected) link.
  await page.keyboard.type(' @');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await expect(page.locator('#content a')).toHaveText('Doc');
});

test('collapsed insert (insertHTML branch): `@` + Enter on a heading inserts a fresh fragment link', async ({
  page,
}) => {
  await openEditor(page, '# Target\n\ntext');
  await caretAtStartOfParagraph(page, 'text');
  await page.keyboard.type('@'); // bare → current-doc headings, first highlighted
  await expect(page.locator('.trigger-popup-item', { hasText: 'Target' })).toBeVisible();
  await page.keyboard.press('Enter');

  await page.waitForFunction(() => !!document.querySelector('#content a[href="#target"]'));
  await expect(page.locator('#content a[href="#target"]')).toHaveText('Target');
  await expect(page.locator('.trigger-popup')).toBeHidden();
});

// ---------------------------------------------------------------------------
// Req 20 US-20.8 — the Link/Image toolbar buttons open this SAME `@` popup
// (the old prompt.ts modal is deleted). See toolbar-disabled-code-block.spec.ts
// for the caret-in-code-block disabled state.
// ---------------------------------------------------------------------------

test('Link toolbar button, collapsed caret: opens the @ popup and picking a heading inserts a fresh link', async ({
  page,
}) => {
  await openEditor(page, '# Target\n\ntext');
  await caretAtStartOfParagraph(page, 'text');
  await page.locator('#fmt-link').click();

  await expect(page.locator('.trigger-popup')).toBeVisible();
  // Same scope tabs as real `@` typing (not a stripped-down variant).
  const pills = await page.locator('.trigger-popup-pill').allTextContents();
  expect(pills).toEqual(['All', 'Files', 'Headings', 'Entities']);
  await page.locator('.trigger-popup-item', { hasText: 'Target' }).click();

  await page.waitForFunction(() => !!document.querySelector('#content a[href="#target"]'));
  await expect(page.locator('#content a[href="#target"]')).toHaveText('Target');
  await expect(page.locator('.trigger-popup')).toBeHidden();
});

test('Link toolbar button, active selection: preserves the selected text as display, only sets href', async ({
  page,
}) => {
  await openEditor(page, 'link me');
  await selectParagraphText(page, 'link me');
  await page.locator('#fmt-link').click();
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await replyLastFileSearch(page, [{ path: 'docs/target.md', name: 'target.md', dir: 'docs' }]);
  await page.locator('.trigger-popup-item', { hasText: 'target.md' }).first().click();

  await page.waitForFunction(() => !!document.querySelector('#content a[href="docs/target.md"]'));
  await expect(page.locator('#content a[href="docs/target.md"]')).toHaveText('link me');
});

test('Image toolbar button: Files-only (no bare-open dump), picking a file inserts a bare <img>', async ({ page }) => {
  await openEditor(page, '# Target\n\ntext');
  await caretAtStartOfParagraph(page, 'text');
  await page.locator('#fmt-image').click();
  await expect(page.locator('.trigger-popup')).toBeVisible();
  // Bare-open shows nothing (no heading dump — a heading fragment is never a valid image src).
  await expect(page.locator('.trigger-popup-item')).toHaveCount(0);

  await page.keyboard.type('pic');
  await replyLastFileSearch(page, [{ path: 'assets/pic.png', name: 'pic.png', dir: 'assets' }]);
  await page.locator('.trigger-popup-item', { hasText: 'pic.png' }).first().click();

  await page.waitForFunction(() => !!document.querySelector('#content img[src="assets/pic.png"]'));
  await expect(page.locator('#content img[src="assets/pic.png"]')).toHaveAttribute('alt', '');
  await expect(page.locator('.trigger-popup')).toBeHidden();
});

test('Image toolbar button with an active selection: replaces the selected text with the picked image', async ({
  page,
}) => {
  await openEditor(page, 'photo here');
  await selectParagraphText(page, 'photo here');
  await page.locator('#fmt-image').click();
  await expect(page.locator('.trigger-popup')).toBeVisible();
  // Selected text is used as a one-shot query seed (no further typing needed/supported).
  const seeded = await page.evaluate(
    () => [...(window as unknown as { __posted: Posted[] }).__posted].reverse().find((m) => m.type === 'searchFiles')?.query
  );
  expect(seeded).toBe('photo here');

  await replyLastFileSearch(page, [{ path: 'pic.png', name: 'pic.png', dir: '.' }]);
  await page.locator('.trigger-popup-item', { hasText: 'pic.png' }).first().click();

  await page.waitForFunction(() => !!document.querySelector('#content img[src="pic.png"]'));
  await expect(page.locator('#content p').first()).not.toContainText('photo here');
});

// ---------------------------------------------------------------------------
// Req 21 US-21.2 — the `@` popup's Entities scope tab (Advanced-mode only,
// see the earlier "Simple mode" test), wired to entitySearch/namespaceList.
// ---------------------------------------------------------------------------

/** Open a bare `@` and switch to the Entities scope pill. */
async function openEntitiesScope(page: Page, paraText: string): Promise<void> {
  await caretAtStartOfParagraph(page, paraText);
  await page.keyboard.type('@');
  await page.locator('.trigger-popup-pill', { hasText: 'Entities' }).click();
}

test('Entities scope: still-indexing shows a distinct spinner state, not "No matches"', async ({ page }) => {
  await openEditor(page, 'text');
  await openEntitiesScope(page, 'text');

  await replyLastNamespaceList(page, false, []);
  await expect(page.locator('.trigger-popup-item', { hasText: 'Indexing workspace…' })).toBeVisible();
  await expect(page.locator('.trigger-popup-empty')).toBeHidden();
});

test('Entities scope: bare tab lists namespaces (already count-desc from the host), capped with a "keep typing" footnote', async ({
  page,
}) => {
  await openEditor(page, 'text');
  await openEntitiesScope(page, 'text');

  await replyLastNamespaceList(page, true, [
    { name: 'UC', count: 12 },
    { name: 'SC', count: 9 },
    { name: 'RE', count: 7 },
    { name: 'MSG', count: 4 },
    { name: 'EMT', count: 2 },
    { name: 'Noti', count: 1 },
    { name: 'BR', count: 1 },
  ]);

  // Capped to 5, host's own count-desc order kept as-is. `toHaveText` polls
  // (unlike `allTextContents`) — the reply's render lands via an async
  // postMessage round trip, not synchronously within this call.
  await expect(page.locator('.trigger-popup-item-label')).toHaveText(['UC', 'SC', 'RE', 'MSG', 'EMT']);
  await expect(page.locator('.trigger-popup-more')).toHaveText('+2 more — keep typing');
});

test('Entities scope: picking a namespace narrows to its id+title list with a "‹ All namespaces" back-row', async ({
  page,
}) => {
  await openEditor(page, 'text');
  await openEntitiesScope(page, 'text');
  await replyLastNamespaceList(page, true, [{ name: 'UC', count: 2 }]);
  await page.locator('.trigger-popup-item', { hasText: 'UC' }).click();

  await replyLastEntitySearch(page, true, [
    { namespace: 'UC', id: '01', file: 'file:///target.md', line: 3, title: 'Login flow' },
    { namespace: 'UC', id: '02', file: 'file:///target.md', line: 10, title: '' },
  ]);

  await expect(page.locator('.trigger-popup-item-label')).toHaveText(['‹ All namespaces', 'UC01', 'UC02']);
  await expect(page.locator('.trigger-popup-item', { hasText: 'UC01' })).toHaveClass(/trigger-popup-item-tint-entity/);

  // Back-row returns to the bare namespace list (a fresh namespaceList round trip).
  await page.locator('.trigger-popup-item', { hasText: '‹ All namespaces' }).click();
  await replyLastNamespaceList(page, true, [{ name: 'UC', count: 2 }]);
  await expect(page.locator('.trigger-popup-item-label')).toHaveText(['UC']);
});

test('Entities scope: typing runs the combined id+title fuzzy search across all namespaces', async ({ page }) => {
  await openEditor(page, 'text');
  await openEntitiesScope(page, 'text');
  await replyLastNamespaceList(page, true, [{ name: 'UC', count: 1 }]);
  await page.keyboard.type('login');

  const posted = await page.evaluate(() =>
    [...(window as unknown as { __posted: Posted[] }).__posted].reverse().find((m) => m.type === 'entitySearch')
  );
  expect(posted?.query).toBe('login');

  await replyLastEntitySearch(page, true, [
    { namespace: 'UC', id: '01', file: 'file:///target.md', line: 3, title: 'Login flow' },
  ]);
  await expect(page.locator('.trigger-popup-item-label')).toHaveText(['UC01']);

  await page.locator('.trigger-popup-item', { hasText: 'UC01' }).click();
  await page.waitForFunction(() => !!document.querySelector('#content a[href="target.md#UC01"]'));
  await expect(page.locator('#content a[href="target.md#UC01"]')).toHaveText('UC01');
});
