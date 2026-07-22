/**
 * bug_General.md → Mention Declare C.5–8: the filter text typed into a trigger
 * popup (`@` / slash / declare) and the committing Enter must NOT leak into the
 * contentEditable editor.
 *
 * Two root defects are exercised:
 *  - Defect A (5,6,7,8): trigger-popup.ts used to consume Enter only when a row
 *    was committable — an empty / async-pending / disabled list let Enter fall
 *    through to #content as a literal paragraph break (and left the typed run
 *    behind). The fix consumes Enter for the whole open session.
 *  - Defect B (7): openDeclareIdStep opened its popup only AFTER the entity
 *    fetch resolved, leaving an async window where typed id text + Enter landed
 *    as raw editor input. The fix opens the popup up-front (fetch inside its
 *    async query), so the popup owns input across the fetch.
 *
 * The harness has no real host, so each round trip (searchFiles / namespaceList
 * / entitySearch) is answered by hand — same technique as entity-declare.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, popupQueryValue } from './_harness';

interface Posted {
  type: string;
  requestId?: number;
  query?: string;
  namespace?: string;
}

/** Number of block children of #content — a leaked Enter (insertParagraph) adds a second block. */
async function blockCount(page: Page): Promise<number> {
  return page.locator('#content').evaluate((el) => el.childElementCount);
}

/** Wait for the most recent posted message of `type`. */
async function waitForPosted(page: Page, type: string): Promise<Posted> {
  const handle = await page.waitForFunction(
    (t) => (window as unknown as { __posted: Posted[] }).__posted.filter((m) => m.type === t).at(-1),
    type
  );
  return (await handle.jsonValue()) as Posted;
}

async function focusEmptyParagraph(page: Page): Promise<void> {
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

// ── Bug 8: slash menu, filter matches nothing, Enter ────────────────────────
test('bug8: slash + no-match filter + Enter is swallowed (no newline, run intact)', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/zzznope');

  await expect(page.locator('.trigger-popup')).toBeVisible();
  await expect(page.locator('.trigger-popup-empty')).toHaveText('No matches');

  await page.keyboard.press('Enter');

  // Enter consumed: popup stays, no extra block. The `/` marker stays inline in the
  // editor; the `zzznope` filter is owned by the popup input, never in #content.
  await expect(page.locator('.trigger-popup')).toBeVisible();
  expect(await blockCount(page)).toBe(1);
  await expect(page.locator('#content')).toHaveText('/');
  expect(await popupQueryValue(page)).toBe('zzznope');
});

// ── Bug 6: @ file search, results still pending, Enter ──────────────────────
test('bug6: @ + search text + Enter while results pending does not leak text/newline', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('@foo');

  await expect(page.locator('.trigger-popup')).toBeVisible();
  await waitForPosted(page, 'searchFiles'); // request dispatched; deliberately NOT answered yet

  await page.keyboard.press('Enter');

  // Pending list → Enter consumed: no newline, nothing committed. The `foo` filter
  // lives in the popup input, so only the inline `@` marker is in the editor.
  await expect(page.locator('.trigger-popup')).toBeVisible();
  expect(await blockCount(page)).toBe(1);
  await expect(page.locator('#content a')).toHaveCount(0);
  await expect(page.locator('#content')).toHaveText('@');

  // Once results arrive, Enter commits the first file and deletes the `@foo` run.
  const req = await waitForPosted(page, 'searchFiles');
  await page.evaluate(
    (r) =>
      window.postMessage(
        { type: 'fileSearchResult', requestId: r.requestId, files: [{ path: 'Doc.md', name: 'Doc.md', dir: '' }] },
        '*'
      ),
    req
  );
  await expect(page.locator('.trigger-popup-item')).toHaveCount(1);
  await page.keyboard.press('Enter');

  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('#content a')).toHaveCount(1);
  await expect(page.locator('#content')).not.toContainText('@foo');
});

// ── Bug 5: pick "declare", namespace list still pending, Enter ──────────────
test('bug5: declare → Enter while namespace list pending inserts no newline', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/declare');
  await page.locator('.trigger-popup-item', { hasText: 'Declare entity' }).first().click();

  await expect(page.locator('.trigger-popup')).toBeVisible();
  await waitForPosted(page, 'namespaceList'); // pending — not answered

  await page.keyboard.press('Enter');

  // No committable namespace yet → Enter consumed, no paragraph break.
  await expect(page.locator('.trigger-popup')).toBeVisible();
  expect(await blockCount(page)).toBe(1);
});

// ── Bug 8 (execute command): /filter → Execute command, Enter runs it clean ─
// Regression: `/fo` → "Focus mode" → Enter must run the command AND delete the
// `/fo` run with no newline (not: run command + keep `fo` + insert a newline).
test('bug8-exec: slash filter to an Execute command, Enter runs it and deletes the run (no newline)', async ({ page }) => {
  await openEditor(page, '', {
    trigger: { dateFormat: 'YYYY-MM-DD', executeCommands: [{ id: 'orcaEditor.toggleZen', label: 'Focus mode' }], mode: 'advanced' },
  });
  await focusEmptyParagraph(page);
  await page.keyboard.type('/fo');
  await expect(page.locator('.trigger-popup-item', { hasText: 'Focus mode' })).toBeVisible();

  await page.keyboard.press('Enter');

  await expect(page.locator('.trigger-popup')).toBeHidden();
  // No `fo` residue, no extra block/newline in the editor.
  await expect(page.locator('#content')).not.toContainText('fo');
  expect(await blockCount(page)).toBe(1);
  // The command was actually dispatched to the host.
  await page.waitForFunction(() =>
    (window as unknown as { __posted: { type: string; commandId?: string }[] }).__posted.some(
      (m) => m.type === 'executeCommand' && m.commandId === 'orcaEditor.toggleZen'
    )
  );
});

// ── Bug 6 (commit path): @ + search, results shown, Enter deletes the run ───
// Regression: previously pressing Enter (vs clicking) kept the typed `@…` run
// AND inserted a newline; only a click cleared it. Enter must behave like click.
test('bug6: @ + search, results shown, Enter commits link and deletes the typed run (no newline)', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('@xy');

  const req = await waitForPosted(page, 'searchFiles');
  await page.evaluate(
    (r) =>
      window.postMessage(
        { type: 'fileSearchResult', requestId: r.requestId, files: [{ path: 'Report.md', name: 'Report.md', dir: '' }] },
        '*'
      ),
    req
  );
  await expect(page.locator('.trigger-popup-item')).toHaveCount(1);
  await page.keyboard.press('Enter');

  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('#content a')).toHaveCount(1);
  // The `@xy` search run is gone (deleted on commit), not left in the document.
  await expect(page.locator('#content')).not.toContainText('xy');
});

// ── Bug 7 (full flow): type an existing namespace, pick it via Enter ────────
// Regression: reopening the shell for the namespace step left the slash menu's
// "Declare entity" row committable, so Enter fed `action:declare-entity` into
// the namespace pick → a corrupt `are-entity` namespace. Enter must pick the
// real namespace and commit the correct token.
test('bug7-flow: declare, type existing namespace, Enter picks it and commits the right token', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/declare');
  await page.locator('.trigger-popup-item', { hasText: 'Declare entity' }).first().click();

  const nsReq = await waitForPosted(page, 'namespaceList');
  await page.evaluate(
    (r) =>
      window.postMessage(
        { type: 'namespaceListResult', requestId: r.requestId, ready: true, namespaces: [{ name: 'UC', count: 1 }] },
        '*'
      ),
    nsReq
  );
  // Namespace list rendered; type the existing name and pick it with Enter.
  await expect(page.locator('.trigger-popup-item', { hasText: /^UC/ })).toBeVisible();
  await page.keyboard.type('UC');
  expect(await popupQueryValue(page)).toBe('UC');
  await page.keyboard.press('Enter');

  // Enter picked the real UC namespace — NOT the stale slash "Declare entity" row.
  const entReq = await waitForPosted(page, 'entitySearch');
  expect(entReq.namespace).toBe('UC');
  await page.evaluate(
    (r) =>
      window.postMessage(
        {
          type: 'entityResult',
          requestId: r.requestId,
          ready: true,
          entities: [{ namespace: 'UC', id: '01', file: 'file:///p/F.md', line: 2, title: 'A' }],
        },
        '*'
      ),
    entReq
  );
  await expect(page.locator('.trigger-popup-item-label')).toBeVisible();
  await page.keyboard.press('Enter'); // accept the suggested id

  await expect(page.locator('.trigger-popup')).toBeHidden();
  // Correct token — not a corrupt `caption::are-entity…`.
  await expect(page.locator('#content .md-caption')).toHaveText('caption::UC02');
  expect(await blockCount(page)).toBe(1);
});

// ── Bug B1: `/` + Enter double-counts under a Vietnamese IME ────────────────
// One physical Enter fires TWO Enter keydowns (IME compose-confirm + real Enter)
// with no keyup between them. Enter#1 picks "Declare entity" → the namespace step
// reopens via queueMicrotask; Enter#2 — a separate event landing after the
// reopen — used to commit the first namespace and cascade straight into the
// id/caption step ("vào thẳng menu tạo caption cho namespace đầu tiên"). The
// queueMicrotask reopen only guards the SAME event, not a second one. The fix:
// a reopened stage refuses to commit until an intervening keyup.
//
// Reproduced deterministically without a real IME: the two keydowns are
// dispatched in separate tasks (so the reopen microtask flushes between them)
// with NO keyup between. The cascade is only observable when the reopened stage
// renders synchronously — so the namespace cache is warmed first.

/** Dispatch a bare Enter keydown to the focused element (no keyup) — one half of an IME double-Enter. */
async function dispatchEnterKeydown(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  );
}

/** Dispatch an Enter keyup to the focused element — the key release that arms a deliberate next press. */
async function dispatchEnterKeyup(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
  );
}

/** How many `entitySearch` messages have been posted so far (id/caption step opened = one per open). */
async function entitySearchCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __posted: Posted[] }).__posted.filter((m) => m.type === 'entitySearch').length
  );
}

test('bugB1: IME double-Enter (two keydowns, no keyup) does not cascade namespace→caption', async ({ page }) => {
  await openEditor(page, '');

  // 1) Warm the namespace cache so the reopened namespace step renders synchronously
  //    (that is the only window in which a second Enter could cascade).
  await focusEmptyParagraph(page);
  await page.keyboard.type('/declare');
  await page.locator('.trigger-popup-item', { hasText: 'Declare entity' }).first().click();
  const nsReq = await waitForPosted(page, 'namespaceList');
  await page.evaluate(
    (r) =>
      window.postMessage(
        { type: 'namespaceListResult', requestId: r.requestId, ready: true, namespaces: [{ name: 'UC', count: 1 }] },
        '*'
      ),
    nsReq
  );
  await expect(page.locator('.trigger-popup-item', { hasText: /^UC/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();

  // 2) Second declare. Reset to a clean empty paragraph (the declare flow leaves a
  //    bare <p></p> whose caret is unreliable), then Enter-pick "Declare entity"
  //    and fire a second Enter keydown with NO keyup between — the IME double-Enter.
  await page.locator('#content').evaluate((c) => {
    c.innerHTML = '<p><br></p>';
  });
  await focusEmptyParagraph(page);
  await page.keyboard.type('/declare');
  await expect(page.locator('.trigger-popup-item', { hasText: 'Declare entity' })).toBeVisible();
  const beforeEnt = await entitySearchCount(page);

  await dispatchEnterKeydown(page); // Enter#1 → picks "Declare entity" → namespace step reopens (warm cache, guarded)
  await dispatchEnterKeydown(page); // Enter#2 → must be swallowed by the guard, NOT commit the namespace

  // Still on the namespace step: UC visible, and NO entitySearch fired (id/caption step never opened).
  await expect(page.locator('.trigger-popup-item', { hasText: /^UC/ })).toBeVisible();
  expect(await entitySearchCount(page)).toBe(beforeEnt);
  expect(await blockCount(page)).toBe(1);

  // 3) Release Enter (keyup) then press it deliberately — now the namespace commits
  //    and the flow advances one stage (guard does not permanently block).
  await dispatchEnterKeyup(page);
  await dispatchEnterKeydown(page);

  const entReq = await waitForPosted(page, 'entitySearch');
  expect(entReq.namespace).toBe('UC');
  expect(await entitySearchCount(page)).toBe(beforeEnt + 1);
});

// ── Bug 7: declare id step, entity fetch pending, typed id + Enter ──────────
test('bug7: declare id typed during the entity-fetch window is not leaked and commits correctly', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/declare');
  await page.locator('.trigger-popup-item', { hasText: 'Declare entity' }).first().click();

  const nsReq = await waitForPosted(page, 'namespaceList');
  await page.evaluate(
    (r) =>
      window.postMessage(
        { type: 'namespaceListResult', requestId: r.requestId, ready: true, namespaces: [{ name: 'UC', count: 0 }] },
        '*'
      ),
    nsReq
  );
  await page.locator('.trigger-popup-item-label', { hasText: /^UC$/ }).first().click();

  // Id-step popup is now open (fix: opened up-front), entity fetch dispatched but
  // NOT answered — this is the old async gap where `7` + Enter used to leak.
  const entReq = await waitForPosted(page, 'entitySearch');
  expect(entReq.namespace).toBe('UC');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  await page.keyboard.type('7');
  await page.keyboard.press('Enter'); // still pending → consumed, no commit, no newline

  await expect(page.locator('.trigger-popup')).toBeVisible();
  expect(await blockCount(page)).toBe(1);
  await expect(page.locator('#content .md-caption')).toHaveCount(0);

  // Entities arrive; the typed `7` is the live query → commit is caption::UC7.
  await page.evaluate(
    (r) => window.postMessage({ type: 'entityResult', requestId: r.requestId, ready: true, entities: [] }, '*'),
    entReq
  );
  await expect(page.locator('.trigger-popup-item-label')).toHaveText('Declare UC7');
  await page.keyboard.press('Enter');

  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('#content .md-caption')).toHaveText('caption::UC7');
  expect(await blockCount(page)).toBe(1);
});
