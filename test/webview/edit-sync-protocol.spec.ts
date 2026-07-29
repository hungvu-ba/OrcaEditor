/**
 * Performance Audit P-8 — the webview half of the diff-shaped 'edit' protocol,
 * driven through the REAL bundle.
 *
 * `test/unit.ts` covers the protocol against a model of both ends (provider.ts
 * imports 'vscode' and cannot load there). That model proves the DESIGN but
 * cannot regress when `media/webview/main.ts` does — review found the two
 * production pieces below had no test that would fail if they were deleted:
 *
 *  - `case 'requestFullSync'`: the entire self-healing path. Break it (send
 *    `serialize()` instead of `currentText`, drop `baseRev`, delete the case)
 *    and every suite stayed green while the real app resync-loops forever.
 *  - the `appliedRev` lifecycle, whose load-bearing invariant is that a push the
 *    webview DEFERS must not be adopted — "saying 'I am on rev N' while holding
 *    rev N-1's text is exactly the lie that would let a diff apply at the wrong
 *    offsets" (main.ts). Every other spec posts rev-less updates, which pins
 *    both sides at rev 0 and makes the rev gate unreachable.
 *
 * These assert on the wire messages the webview posts, which is exactly what the
 * host reads — no model in the middle.
 */
import { test, expect, type Page } from '@playwright/test';
import { computeMinimalEdit } from '../../src/text-utils';
import { openEditor, clearPosted } from './_harness';

interface PostedEdit {
  type: string;
  text?: string;
  baseRev?: number;
  start?: number;
  oldEnd?: number;
  newText?: string;
  baseLength?: number;
  seq?: number;
}

/** Every 'edit' the webview has posted since the last clearPosted(). */
async function postedEdits(page: Page): Promise<PostedEdit[]> {
  return page.evaluate(
    () => (window as unknown as { __posted: PostedEdit[] }).__posted.filter((m) => m.type === 'edit')
  );
}

/** Every 'requestFullPush' the webview has posted since the last clearPosted(). */
async function postedFullPushRequests(page: Page): Promise<PostedEdit[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __posted: PostedEdit[] }).__posted.filter(
        (m) => m.type === 'requestFullPush'
      )
  );
}

/**
 * Performance Audit P-8 (reverse half): inject a DIFF-shaped host push, the shape
 * `provider.ts`'s `updateMessage` composes. `base` is the text the host believes
 * the webview holds, and the offsets come from the PRODUCTION differ — a
 * hand-rolled prefix/suffix walk here would pass against payloads the host no
 * longer produces the day `computeMinimalEdit`'s boundary policy changes. Only
 * `page.evaluate` callbacks run in the page, so this Node-side import is fine.
 */
async function pushUpdateDiff(
  page: Page,
  base: string,
  next: string,
  opts: { rev: number; baseRev: number; baseSeq: number }
): Promise<void> {
  const diff = computeMinimalEdit(base, next)!;
  await page.evaluate(
    (m) => window.postMessage(m, '*'),
    { type: 'update', ...diff, baseLength: base.length, ...opts }
  );
  await page.waitForTimeout(40);
}

/** Inject a host push on the same channel provider.ts uses, carrying its rev. */
async function pushUpdate(page: Page, text: string, rev: number): Promise<void> {
  await page.evaluate(({ t, r }) => window.postMessage({ type: 'update', text: t, rev: r }, '*'), { t: text, r: rev });
  await page.waitForTimeout(40);
}

/** Ask the webview to resync, exactly as the host does when it refuses a diff. */
async function requestFullSync(page: Page): Promise<void> {
  await page.evaluate(() => window.postMessage({ type: 'requestFullSync' }, '*'));
  await page.waitForTimeout(40);
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

test('a steady-state sync posts a diff, not the document', async ({ page }) => {
  await openEditor(page, 'alpha\n');
  await page.locator('#content p').click();
  await clearPosted(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' beta ');

  const edits = await postedEdits(page);
  expect(edits.length).toBeGreaterThan(0);
  const diff = edits.at(-1)!;
  // The shape itself is the finding: `newText` present, and no full document.
  expect(typeof diff.newText).toBe('string');
  expect(typeof diff.baseLength).toBe('number');
  expect(typeof diff.baseRev).toBe('number');
  // What crosses the wire is the edit, not the file.
  expect(diff.newText!.length).toBeLessThan('alpha beta\n'.length);
});

test('requestFullSync is answered with the full current text, not a diff', async ({ page }) => {
  await openEditor(page, 'alpha\n');
  await page.locator('#content p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' beta');
  // Let the debounced sync land so currentText is the post-typing text.
  await page.waitForTimeout(400);
  await clearPosted(page);

  await requestFullSync(page);

  const edits = await postedEdits(page);
  expect(edits).toHaveLength(1);
  const reply = edits[0];
  // Full-text variant: `text` present, and it is the whole document — this is
  // what re-anchors the host's mirror.
  expect(reply.text).toBe('alpha beta\n');
  expect(reply.newText).toBeUndefined();
  expect(reply.baseRev).toBe(0); // openEditor's init carries no rev -> 0
});

test('a rendered push is adopted: the next diff is stamped with that rev', async ({ page }) => {
  await openEditor(page, 'alpha\n');
  await pushUpdate(page, 'gamma\n', 9);
  await expect(page.locator('#content')).toHaveText('gamma');

  await page.locator('#content p').click();
  await clearPosted(page);
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.waitForTimeout(400);

  const edits = await postedEdits(page);
  expect(edits.length).toBeGreaterThan(0);
  // Adopted, so the host's mirror at rev 9 is the right base for this diff.
  expect(edits.at(-1)!.baseRev).toBe(9);
});

test('a DEFERRED push is not adopted: the resync reply still reports the old rev', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  // The popup owns the keyboard, so this push is stashed, never rendered.
  await pushUpdate(page, 'host wrote this\n', 12);
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await expect(page.locator('#content')).not.toContainText('host wrote this');

  await clearPosted(page);
  await requestFullSync(page);

  const edits = await postedEdits(page);
  expect(edits).toHaveLength(1);
  // The invariant: we hold rev-0 text, so we must claim rev 0 — never 12.
  // Claiming 12 would let the host rebuild a diff against text we never rendered.
  expect(edits[0].baseRev).toBe(0);
  expect(edits[0].text).not.toContain('host wrote this');
});

test('the deferred push is adopted only once the popup releases and it renders', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await pushUpdate(page, 'host wrote this\n', 12);

  // Escape cancels the popup, releasing input ownership -> the flush renders it.
  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('#content')).toContainText('host wrote this');

  await clearPosted(page);
  await requestFullSync(page);

  const edits = await postedEdits(page);
  expect(edits).toHaveLength(1);
  expect(edits[0].baseRev).toBe(12); // rendered at last, so now we are on 12
});

// ---------------------------------------------------------------------------
// P-8 reverse half: the host→webview 'update' also ships only the changed
// region. The render/caret half of this cannot be proven by test/unit.ts's model
// — it exercises the real markdown-it + P-9 block patch through the bundle.
// ---------------------------------------------------------------------------

test('a diff-shaped push renders exactly what the full-text push would have', async ({ page }) => {
  const base = 'alpha\n\nbeta\n';
  await openEditor(page, base);
  await clearPosted(page);

  // openEditor's init carries no rev, so both counters are 0 — the base the host
  // would have diffed against.
  await pushUpdateDiff(page, base, 'alpha\n\ngamma\n', { rev: 7, baseRev: 0, baseSeq: 0 });

  await expect(page.locator('#content')).toContainText('gamma');
  await expect(page.locator('#content')).not.toContainText('beta');
  await expect(page.locator('#content')).toContainText('alpha');
  expect(await postedFullPushRequests(page)).toHaveLength(0);

  // The rebuilt text became `currentText`, so the next diff must index INTO it and
  // be stamped with the rev that push carried — this is what proves the webview
  // adopted the diff as a real document state, not just painted it.
  await page.locator('#content p').last().click();
  await clearPosted(page);
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.waitForTimeout(400);

  const edits = await postedEdits(page);
  expect(edits.length).toBeGreaterThan(0);
  const diff = edits.at(-1)!;
  expect(diff.baseRev).toBe(7);
  expect(diff.baseLength).toBe('alpha\n\ngamma\n'.length);
});

test('a diff push against a rev we never adopted is refused, not spliced', async ({ page }) => {
  await openEditor(page, 'alpha\n');
  await clearPosted(page);

  // baseRev 5 while the webview is on 0: the host's mirror is anchored to a push
  // this webview deferred or dropped, so the offsets index a text we do not hold.
  await pushUpdateDiff(page, 'alpha\n', 'omega\n', { rev: 6, baseRev: 5, baseSeq: 0 });

  expect(await postedFullPushRequests(page)).toHaveLength(1);
  await expect(page.locator('#content')).toHaveText('alpha');
  expect(await postedEdits(page)).toHaveLength(0); // nothing was serialized back
});

test('a diff push that predates our own in-flight edit is refused (the seq gate)', async ({ page }) => {
  await openEditor(page, 'alpha\n');
  await page.locator('#content p').click();
  // LENGTH-PRESERVING on purpose: 'alpha' -> 'alphX'. That is what makes this the
  // seq gate's test and not `baseLength`'s — with the local edit the same length
  // as the base, `rebuildFromEditDiff` would happily splice, and `baseRev` is
  // unchanged because a webview-authored advance bumps no rev. Probe-verified:
  // remove the seq check and this test applies '?' to the WRONG base.
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('X');
  await page.waitForTimeout(400);
  await clearPosted(page);

  // The host composed this against the pre-typing text and still believes seq 0 —
  // exactly what an 'edit' still in flight looks like.
  await pushUpdateDiff(page, 'alpha\n', 'alpha?\n', { rev: 3, baseRev: 0, baseSeq: 0 });

  expect(await postedFullPushRequests(page)).toHaveLength(1);
  await expect(page.locator('#content')).toHaveText('alphX');
});

test('a diff push arriving while a popup owns input is deferred, then rendered', async ({ page }) => {
  await openEditor(page, '');
  await focusEmptyParagraph(page);
  await page.keyboard.type('/');
  await expect(page.locator('.trigger-popup')).toBeVisible();

  // Typing '/' armed the 250 ms sync debounce, and if it fires it bumps `localSeq`.
  // Hardcoding baseSeq: 0 would then be refused instead of deferred — the defer
  // path this test exists for would silently stop being exercised on a slow run.
  // Wait it out, then take the seq the webview actually reported: that IS the
  // host's `mirrorSeq`, since the host learns the count from this very message.
  await page.waitForTimeout(400);
  const baseSeq = (await postedEdits(page)).at(-1)?.seq ?? 0;
  await clearPosted(page);

  await pushUpdateDiff(page, '/\n', 'host wrote this\n', { rev: 12, baseRev: 0, baseSeq });
  // Resolved but NOT rendered: the popup keeps the editor keyboard.
  await expect(page.locator('.trigger-popup')).toBeVisible();
  await expect(page.locator('#content')).not.toContainText('host wrote this');
  expect(await postedFullPushRequests(page)).toHaveLength(0);

  await page.keyboard.press('Escape');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  await expect(page.locator('#content')).toContainText('host wrote this');

  await clearPosted(page);
  await requestFullSync(page);
  const edits = await postedEdits(page);
  expect(edits).toHaveLength(1);
  expect(edits[0].text).toContain('host wrote this'); // the diff's own result
  expect(edits[0].baseRev).toBe(12);
});
