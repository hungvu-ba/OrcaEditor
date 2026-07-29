/**
 * Req 24 US-23.23 — open a comment thread by clicking its highlighted text.
 *
 * Playwright track (Plan/WEBVIEW_TEST.md): every case is a real mouse gesture
 * measured against real laid-out glyph boxes. The feature is a click/drag
 * discrimination over `Range.getClientRects()`, so a hand-built DOM snapshot
 * (`test/roundtrip/`) has no layout to test against and cannot express any of it.
 *
 * TWO HARNESS FACTS shape the assertions here, both measured, not assumed:
 *
 * 1. The popover card is built once at init and shown/hidden — it is never
 *    created per thread. "Not open" is therefore `not.toBeVisible()`; a
 *    `toHaveCount(0)` assertion would fail even with no thread open.
 * 2. **A pointer drag does not select text in this headless Chromium.** Measured:
 *    `mouse.down()` → `mouse.move(steps)` → `mouse.up()` leaves the selection
 *    empty, while it does still fire one `click` (detail 1). That is exploited
 *    rather than worked around: it isolates the two AC3 gates so each can be
 *    mutation-checked on its own — a pointer drag can only be refused by the
 *    travel gate, and a Shift+Click (travel 0, real selection) only by the
 *    collapsed-selection gate. Do not "fix" these into one drag test.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, seedCommentThreads, dismissAnchorLost, DEFAULT_DOC_URI } from './_harness';

const DOC = [
  '# Session expiry', // 1
  '', // 2
  'Alpha paragraph text.', // 3
  '', // 4
  'Beta paragraph text.', // 5
  '', // 6
  'Gamma [link text](https://example.com) tail.', // 7
  '', // 8
  'Delta <img src="pic.png" width="60" height="20"> tail.', // 9
  '', // 10
  '- [ ] Epsilon task item text.', // 11
].join('\n');

interface Posted {
  type: string;
  [key: string]: unknown;
}

async function postedOfType(page: Page, type: string): Promise<Posted[]> {
  return (await page.evaluate(() => (window as unknown as { __posted: Posted[] }).__posted)).filter(
    (m) => m.type === type
  );
}

async function simulate(page: Page, msg: unknown): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, '*'), msg);
}

/** Select chars [from, to) of the nth `<p>`'s first text node. */
async function selectChars(page: Page, pIndex: number, from: number, to: number): Promise<void> {
  await page.locator('#content').evaluate(
    (el, a) => {
      const node = el.querySelectorAll('p')[a.pIndex].firstChild!;
      const range = document.createRange();
      range.setStart(node, a.from);
      range.setEnd(node, a.to);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { pIndex, from, to }
  );
}

/**
 * Select the nth paragraph's whole contents — needed for a paragraph whose text
 * is split by an inline node (`<a>`, `<img>`), where the first text node is far
 * shorter than the visible line and a char-offset range would throw.
 */
async function selectWholeParagraph(page: Page, pIndex: number): Promise<void> {
  await page.locator('#content').evaluate((el, i) => {
    const range = document.createRange();
    range.selectNodeContents(el.querySelectorAll('p')[i]);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, pIndex);
}

/** Turn whatever is selected into a thread, through the real right-click → composer flow. */
async function commentOnSelection(page: Page, body: string): Promise<string> {
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await page.locator('.comment-composer-input').fill(body);
  await page.locator('.comment-composer-submit').click();
  const create = (await postedOfType(page, 'createComment')).at(-1)!;
  await simulate(page, {
    type: 'createCommentResult',
    requestId: create.requestId,
    ok: true,
    author: 'harness-user',
    timestamp: '2026-07-24T10:12:00.000Z',
  });
  return String(create.threadId);
}

async function createThreadOn(page: Page, pIndex: number, from: number, to: number, body: string): Promise<string> {
  await selectChars(page, pIndex, from, to);
  return commentOnSelection(page, body);
}

/** Viewport centre of chars [from, to) of the nth paragraph — where a real click lands. */
async function centreOfChars(page: Page, pIndex: number, from: number, to: number): Promise<{ x: number; y: number }> {
  return page.locator('#content').evaluate(
    (el, a) => {
      const node = el.querySelectorAll('p')[a.pIndex].firstChild!;
      const range = document.createRange();
      range.setStart(node, a.from);
      range.setEnd(node, a.to);
      const r = range.getClientRects()[0];
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    { pIndex, from, to }
  );
}

/** Viewport centre of an element inside `#content`. */
async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number; w: number }> {
  return page.locator(`#content ${selector}`).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
  });
}

/**
 * Wait until anchor resolution has actually settled, by the only signal a spec can
 * observe: the gutter pin. `comment-gutter.ts`'s refresh and
 * `comment-highlight.ts`'s recompute both run off the same `resolve.onChange`, so
 * a rendered pin means the wash for that thread has been computed too.
 *
 * This is NOT optional politeness — resolution is debounced, so a click issued
 * straight after `createCommentResult` races it and lands on text that has no
 * wash yet. Without this the suite is flaky in exactly one direction: it
 * intermittently reports the feature broken.
 *
 * Threads sharing a source line cluster into ONE pin (US-23.2 AC1), so the count
 * is pins, not threads.
 */
async function settleAnchors(page: Page, expectedPins: number): Promise<void> {
  await expect(page.locator('.comment-gutter-pin')).toHaveCount(expectedPins);
}

const popover = (page: Page) => page.locator('.comment-popover');
const popoverBody = (page: Page) => page.locator('.comment-popover-original .comment-popover-body-text');

/**
 * Settle window for asserting an effect did NOT happen. Must exceed
 * `COMMENT_ANCHOR_OPEN_DELAY_MS` (250ms) — the open is armed on `click` and fires
 * on a timer, so sampling earlier would pass before the feature had its chance.
 */
const SETTLE_MS = 500;

/**
 * Record every transition of the popover card's `hidden` flag from now on.
 *
 * Playwright's `not.toBeVisible()` RETRIES until the condition holds, and any
 * fixed pre-wait is spent before it samples at all — so a card that opens and is
 * dismissed 20ms later satisfies it exactly as well as one that never opened. A
 * review found a real transient open hiding behind that (a double-click's leading
 * click), so negative assertions here observe the transition log instead.
 */
async function watchPopover(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __vis: string[] };
    w.__vis = [];
    const card = document.querySelector('.comment-popover') as HTMLElement;
    new MutationObserver(() => w.__vis.push(card.hidden ? 'hidden' : 'shown')).observe(card, {
      attributes: true,
      attributeFilter: ['hidden'],
    });
  });
}

/** Every `hidden` transition since `watchPopover` — `[]` means the card never moved. */
function popoverTransitions(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __vis: string[] }).__vis);
}

/**
 * The card never became visible at ANY point since `watchPopover` — not merely
 * "is closed by the time we look".
 */
async function expectNeverOpened(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  expect(await popoverTransitions(page)).toEqual([]);
  await expect(popover(page)).not.toBeVisible();
}

/**
 * Every "nothing opens" case asserts against this precondition first: creating a
 * thread does NOT open its popover (measured), so a hidden card after the gesture
 * only means something if the card was hidden before it too — otherwise the
 * assertion passes for a thread that was never openable in the first place.
 */
async function expectClosedToStart(page: Page): Promise<void> {
  await expect(popover(page)).not.toBeVisible();
  await watchPopover(page);
}

async function closePopover(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(popover(page)).not.toBeVisible();
}

test.describe('AC1 — a click on the wash opens that thread', () => {
  test('opens the popover for the clicked thread, anchored at the clicked text', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const at = await centreOfChars(page, 0, 2, 3);
    await page.mouse.click(at.x, at.y);

    await expect(popover(page)).toBeVisible();
    await expect(popoverBody(page)).toHaveText('On Alpha.');
    // AC7: placed against the CLICKED text, not against the whole anchored block.
    // Asserted on a single-line paragraph only as a smoke check; the wrapped-line
    // case below is what actually distinguishes the two.
    const box = await page.evaluate(() => {
      const c = document.querySelector('.comment-popover')!.getBoundingClientRect();
      return { top: c.top, left: c.left, bottom: c.bottom };
    });
    expect(box.left).toBeGreaterThan(0);
    expect(box.top).toBeGreaterThan(at.y);
  });

  test('AC7 — the card is placed against the clicked LINE of a wrapped paragraph, not the whole block', async ({
    page,
  }) => {
    const LONG = `# Doc\n\n${'Sentence about the refund queue draining in enqueue order. '.repeat(48)}\n`;
    await openEditor(page, LONG, { commentHighlightOn: true });
    // Anchor a phrase on one of the FIRST lines of a paragraph that wraps over
    // many lines, so "below the clicked line" and "below the block" are hundreds
    // of pixels apart.
    await createThreadOn(page, 0, 9, 25, 'On an early line.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const at = await centreOfChars(page, 0, 9, 25);
    const blockBottom = await page.locator('#content p').first().evaluate((el) => el.getBoundingClientRect().bottom);
    await page.mouse.click(at.x, at.y);
    await expect(popover(page)).toBeVisible();

    const card = await popover(page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    // Premise: the paragraph really is much taller than one line.
    expect(blockBottom - at.y).toBeGreaterThan(120);
    // The card hangs off the clicked line, not off the bottom of the paragraph.
    expect(Math.abs(card.top - at.y)).toBeLessThan(60);
    expect(card.top).toBeLessThan(blockBottom - 60);
  });

  test('AC8 — the card never covers the anchored text it belongs to', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const at = await centreOfChars(page, 0, 2, 3);
    await page.mouse.click(at.x, at.y);
    await expect(popover(page)).toBeVisible();

    const overlaps = await page.evaluate((pt) => {
      const c = document.querySelector('.comment-popover')!.getBoundingClientRect();
      return pt.x >= c.left && pt.x <= c.right && pt.y >= c.top && pt.y <= c.bottom;
    }, at);
    expect(overlaps).toBe(false);
  });

  test('clicking unwashed text in the same paragraph opens nothing', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    // Past the anchored slice — same line, same paragraph, no wash.
    const at = await centreOfChars(page, 0, 12, 20);
    await page.mouse.click(at.x, at.y);
    await expectNeverOpened(page);
  });

  test('with one popover open, clicking a DISTANT thread replaces it (US-23.2 AC3 single-open)', async ({
    page,
  }) => {
    // A tall local fixture, not the shared DOC: the open card is ~325px tall and is
    // placed just under the clicked line, so in a short document it still reaches
    // over the neighbouring paragraphs (see the occlusion test below). The two
    // threads have to be far enough apart for the second to be clickable at all.
    const TALL = ['# Session expiry', '', 'Alpha paragraph text.', '']
      .concat(Array.from({ length: 14 }, (_, i) => `Filler paragraph ${i + 1}.\n`))
      .concat(['Omega paragraph text.', ''])
      .join('\n');
    await openEditor(page, TALL, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    const omega = await page.locator('#content p').count();
    await createThreadOn(page, omega - 1, 0, 5, 'On Omega.');
    await settleAnchors(page, 2);

    const alphaAt = await centreOfChars(page, 0, 2, 3);
    const omegaAt = await centreOfChars(page, omega - 1, 2, 3);
    await page.mouse.click(alphaAt.x, alphaAt.y);
    await expect(popoverBody(page)).toHaveText('On Alpha.');

    // Deliberately WITHOUT closing first — that is the scenario the single-open
    // rule is about. It works because the card's dismissal is an outside
    // *mousedown*, which lands before this route's `click`: the press closes
    // Alpha, then the click opens Omega.
    const cardBox = await popover(page).evaluate((el) => el.getBoundingClientRect().bottom);
    expect(omegaAt.y).toBeGreaterThan(cardBox); // premise: Omega is not under the card
    await page.mouse.click(omegaAt.x, omegaAt.y);
    await expect(popoverBody(page)).toHaveText('On Omega.');
    // NOT `toHaveCount(1)` on `.comment-popover` — the card is a singleton built at
    // init, so that count is 1 even with nothing open and could never detect
    // stacking. One rendered original body is the real assertion.
    await expect(popover(page)).toBeVisible();
    await expect(popoverBody(page)).toHaveCount(1);
  });

  test('an open card occludes the washed text beneath it, so a covered thread is not clickable', async ({
    page,
  }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await createThreadOn(page, 1, 0, 4, 'On Beta.');
    await settleAnchors(page, 2);

    const beta = await centreOfChars(page, 1, 1, 3);
    await page.mouse.click((await centreOfChars(page, 0, 2, 3)).x, (await centreOfChars(page, 0, 2, 3)).y);
    await expect(popoverBody(page)).toHaveText('On Alpha.');

    // Documented consequence, not a bug in the gate chain: the card is placed just
    // under the clicked line and is taller than the gap to the next paragraph, so
    // Beta's washed text is underneath it. AC8 only promises the card keeps clear
    // of ITS OWN anchor, not of every other thread's. The click lands on the
    // card, never reaches `#content`, and Alpha stays open. The gutter pin is
    // immune (it sits in its own lane, which the card does not cover), so the pin
    // remains the route for a comment near an open popover. Asserted so the
    // limitation is measured rather than discovered later.
    const covered = await popover(page).evaluate((el, pt) => {
      const r = el.getBoundingClientRect();
      return pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom;
    }, beta);
    expect(covered).toBe(true);
    await page.mouse.click(beta.x, beta.y);
    await expect(popoverBody(page)).toHaveText('On Alpha.');

    // AC9 is the escape hatch for exactly this: drag the card aside by its header
    // (not a button — `DRAG_IGNORE_SELECTOR` exempts those) and Beta is reachable.
    const grab = await page.locator('.comment-popover-header').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + 6, y: r.top + r.height / 2 };
    });
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + 460, grab.y + 40, { steps: 8 });
    await page.mouse.up();

    const stillCovered = await popover(page).evaluate((el, pt) => {
      const r = el.getBoundingClientRect();
      return pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom;
    }, beta);
    expect(stillCovered).toBe(false);
    await page.mouse.click(beta.x, beta.y);
    await expect(popoverBody(page)).toHaveText('On Beta.');
  });
});

test.describe('AC2 — the "Show Comments" toggle gates the route', () => {
  test('with the toggle off, clicking the anchored text opens nothing', async ({ page }) => {
    await openEditor(page, DOC); // toggle defaults off
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await settleAnchors(page, 1);
    await expect(page.locator('#comment-highlight-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expectClosedToStart(page);

    const at = await centreOfChars(page, 0, 2, 3);
    await page.mouse.click(at.x, at.y);
    await expectNeverOpened(page);
  });

  test('the same click starts working when the toggle goes on, and stops again when it goes off', async ({ page }) => {
    await openEditor(page, DOC);
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await settleAnchors(page, 1);
    const at = await centreOfChars(page, 0, 2, 3);

    await page.locator('#comment-highlight-toggle').click();
    await page.mouse.click(at.x, at.y);
    await expect(popover(page)).toBeVisible();
    await closePopover(page);

    await page.locator('#comment-highlight-toggle').click();
    await expect(page.locator('#comment-highlight-toggle')).toHaveAttribute('aria-pressed', 'false');
    // Re-arm: the legitimate open above is already in the transition log, and
    // `expectNeverOpened` asserts the log is empty.
    await watchPopover(page);
    await page.mouse.click(at.x, at.y);
    await expectNeverOpened(page);
  });
});

test.describe('AC3 — a selection gesture is not a click', () => {
  test('a pointer drag across the wash is refused by the travel gate alone', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const from = await centreOfChars(page, 0, 0, 1);
    const to = await centreOfChars(page, 0, 4, 5);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();

    // Premise of the isolation (see the file header): this engine leaves no
    // selection behind, so the collapsed-selection gate cannot be what refuses
    // this — only the travel gate can. Reverting that gate must fail this test.
    expect(await page.evaluate(() => (window.getSelection()?.toString() ?? '').length)).toBe(0);
    expect(Math.abs(to.x - from.x)).toBeGreaterThan(4);
    await expectNeverOpened(page);
  });

  test('Shift+Click extending a selection over the wash is refused by the collapsed gate alone', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await settleAnchors(page, 1);

    // Caret first (this click is on unwashed text, so it opens nothing), then
    // extend across the wash. mousedown and click share one point, so travel is
    // zero and only the collapsed-selection gate can refuse it.
    const caret = await centreOfChars(page, 0, 12, 13);
    await page.mouse.click(caret.x, caret.y);
    await expectClosedToStart(page);

    const over = await centreOfChars(page, 0, 2, 3);
    await page.keyboard.down('Shift');
    await page.mouse.click(over.x, over.y);
    await page.keyboard.up('Shift');

    expect(await page.evaluate(() => (window.getSelection()?.toString() ?? '').length)).toBeGreaterThan(0);
    await expectNeverOpened(page);
  });

  test('double-clicking settles with the word selected and no popover', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const at = await centreOfChars(page, 0, 2, 3);
    await page.mouse.dblclick(at.x, at.y);

    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('Alpha');
    // AC3 in full: the card never becomes visible at any point, not even for a
    // frame. The leading click of a double-click cannot be told apart from a plain
    // click when it fires, so the open is armed and then CANCELLED by the second
    // `mousedown` (PO decision 2026-07-29: wait out the double-click window rather
    // than ship a visible flash). `expectNeverOpened` reads the transition log, so
    // a regression to the flashing behaviour fails here.
    await expectNeverOpened(page);
  });

  test('triple-clicking settles with the paragraph selected and no popover', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const at = await centreOfChars(page, 0, 2, 3);
    await page.mouse.click(at.x, at.y, { clickCount: 3 });

    expect(await page.evaluate(() => (window.getSelection()?.toString() ?? '').length)).toBeGreaterThan(5);
    // Same as the double-click case: every press after the first cancels the armed
    // open, so the card never appears.
    await expectNeverOpened(page);
  });
});

test.describe('AC4 — gestures another handler already owns', () => {
  test('Cmd/Ctrl+Click is left to the link handler, while the same plain click does open the thread', async ({
    page,
  }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);
    const at = await centreOfChars(page, 0, 2, 3);

    await page.keyboard.down('ControlOrMeta');
    await page.mouse.click(at.x, at.y);
    await page.keyboard.up('ControlOrMeta');
    await expectNeverOpened(page);

    // Positive control on the very same point: without the modifier it opens, so
    // the refusal above is the modifier's doing and not a dead click target.
    await page.mouse.click(at.x, at.y);
    await expect(popover(page)).toBeVisible();
  });

  test('a PLAIN click on a link inside the wash opens the thread and navigates nowhere', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await selectWholeParagraph(page, 2); // "Gamma link text tail." — the <a> splits its text
    await commentOnSelection(page, 'Spans the link.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const link = await centreOf(page, 'a');
    expect(link.w).toBeGreaterThan(0);
    await page.mouse.click(link.x, link.y);

    await expect(popover(page)).toBeVisible();
    await expect(popoverBody(page)).toHaveText('Spans the link.');
    // A plain link click is not navigation in this editor, so nothing was opened.
    expect(await postedOfType(page, 'openLink')).toHaveLength(0);
  });

  // Since the hit test moved to text-node rects, an image's and a checkbox's boxes
  // are never hits at all — these two assert AC4's user-visible outcome, which now
  // falls out of the geometry rather than out of an exclusion list.
  test('clicking an image inside the wash is left to the caret handler', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await selectWholeParagraph(page, 3); // "Delta  tail." — the <img> sits mid-anchor
    await commentOnSelection(page, 'Spans the image.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const img = await centreOf(page, 'img');
    // A zero-width box would put the click on neighbouring text and the refusal
    // below would prove nothing.
    expect(img.w).toBeGreaterThan(0);
    await page.mouse.click(img.x, img.y);
    await expectNeverOpened(page);

    // Positive control: the same thread IS reachable from its text, so the
    // refusal above is the `img` exclusion and not an unresolved anchor.
    const text = await centreOfChars(page, 3, 1, 4);
    await page.mouse.click(text.x, text.y);
    await expect(popoverBody(page)).toHaveText('Spans the image.');
  });
});

test.describe('AC1 — the clickable region is the WASHED region, not the range\'s boxes', () => {
  test('a multi-block anchor does not make a contained block\'s blank margin clickable', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    // Span p0 → p2 so the range FULLY CONTAINS p1. `Range.getClientRects()` reports
    // a fully-contained element's border box, which is content-width — measured at
    // 1053px past p1's last glyph — so hit-testing the range's own rects made the
    // whole empty margin of the middle paragraph open the thread.
    await page.locator('#content').evaluate((el) => {
      const ps = el.querySelectorAll('p');
      const range = document.createRange();
      range.setStart(ps[0].firstChild!, 0);
      range.setEnd(ps[2].firstChild!, 5);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await commentOnSelection(page, 'Spans three paragraphs.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const mid = await page.locator('#content p').nth(1).evaluate((el) => {
      const box = el.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(el);
      return {
        marginX: box.right - 6,
        textRight: text.getClientRects()[0].right,
        y: box.top + box.height / 2,
      };
    });
    // Premise: the probe really is in blank space, far past the glyphs.
    expect(mid.marginX).toBeGreaterThan(mid.textRight + 100);

    await page.mouse.click(mid.marginX, mid.y);
    await expectNeverOpened(page);

    // Positive control: the middle paragraph's TEXT is washed and does open it, so
    // the refusal above is the margin and not an unresolved anchor.
    const onText = await centreOfChars(page, 1, 1, 4);
    await page.mouse.click(onText.x, onText.y);
    await expect(popoverBody(page)).toHaveText('Spans three paragraphs.');
  });

  test('a caption pill inside the wash is left to its own editor, not double-fired', async ({ page }) => {
    // A declaration pill renders its OWN text, so its glyphs are inside the wash's
    // text rects — unlike an image or a checkbox, this one really can be hit and
    // `CLICK_OWNED_ELSEWHERE` is what stops one click opening two anchored cards.
    await openEditor(page, 'caption::UC1\n\nTrailing paragraph text.\n', { commentHighlightOn: true });
    const pill = page.locator('#content .md-caption').first();
    await expect(pill).toHaveCount(1);
    await page.locator('#content').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el.querySelectorAll('p')[0]);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await commentOnSelection(page, 'On the declaration.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const box = await pill.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    });
    expect(box.w).toBeGreaterThan(0);
    await page.mouse.click(box.x, box.y);
    await expectNeverOpened(page);
    // No positive control is possible here — the pill's paragraph holds no ordinary
    // text to click instead. Non-vacuity was established by mutation instead:
    // removing `.md-caption` from `CLICK_OWNED_ELSEWHERE` makes THIS test fail, so
    // the click does reach the pill's glyphs and the exclusion is what refuses it.
  });

  test('a task-list checkbox inside the wash is left to its own toggle handler', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    const li = page.locator('#content li').first();
    await expect(li).toHaveCount(1);
    // Anchor the whole list item's contents, so the checkbox sits INSIDE the range.
    await page.locator('#content').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el.querySelector('li')!);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await commentOnSelection(page, 'On the task item.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const box = await li.locator('input[type="checkbox"]').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    });
    expect(box.w).toBeGreaterThan(0);
    await page.mouse.click(box.x, box.y);
    await expectNeverOpened(page);
    // The displaced handler still did its job — the other half of AC4's clause.
    await expect(li.locator('input[type="checkbox"]')).toBeChecked();
  });
});

test.describe('AC3 — the deferred open must not outlive the gesture', () => {
  test('a gutter pin clicked during the 250ms window wins — the stale timer never replaces it', async ({
    page,
  }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await createThreadOn(page, 1, 0, 4, 'On Beta.');
    await settleAnchors(page, 2);
    await expectClosedToStart(page);

    // Arm the deferred open on Alpha's wash, then — inside the 250ms window — open
    // Beta from its gutter pin. The pin layer is mounted on `document.body`, so a
    // press there never reaches `#content`; with the cancel wired only to `#content`
    // the stale timer fired afterwards and replaced Beta with Alpha, i.e. the
    // reader's LATER, more specific action lost to the earlier one.
    const alpha = await centreOfChars(page, 0, 2, 3);
    await page.mouse.click(alpha.x, alpha.y);
    await page.locator('.comment-gutter-pin').nth(1).click();
    await expect(popoverBody(page)).toHaveText('On Beta.');

    // Well past the armed delay: Beta must still be the open thread.
    await page.waitForTimeout(SETTLE_MS);
    await expect(popoverBody(page)).toHaveText('On Beta.');
  });
});

test.describe('AC8 — the height cap must not break the pin and Comment-tab routes', () => {
  test('an anchored block taller than the viewport is NOT capped — the card keeps its controls', async ({
    page,
  }) => {
    // The gutter-pin and Comment-tab routes pass the whole anchored BLOCK as the
    // rect. When that block is taller than the space around it, both free bands are
    // negative and AC8's own exception applies: accept the overlap. Capping anyway
    // (to a floor) clipped the reply box and the action bar out of a card that is
    // `overflow: hidden`, breaking two routes that existed before this story.
    const HUGE = `# Doc\n\n${'Sentence about the refund queue draining in enqueue order. '.repeat(200)}\n`;
    await openEditor(page, HUGE, { commentHighlightOn: true });
    await createThreadOn(page, 0, 9, 25, 'On a huge block.');
    await settleAnchors(page, 1);

    const blockHeight = await page.locator('#content p').first().evaluate((el) => el.getBoundingClientRect().height);
    const viewport = page.viewportSize()!.height;
    // Premise: the block really is taller than the viewport, or the cap would not
    // be reached and this test would prove nothing.
    expect(blockHeight).toBeGreaterThan(viewport);

    await page.locator('.comment-gutter-pin').first().click();
    await expect(popover(page)).toBeVisible();

    const card = await popover(page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { height: r.height, top: r.top, bottom: r.bottom, maxHeight: (el as HTMLElement).style.maxHeight };
    });
    // Not squeezed to a floor: the CSS 70vh ceiling governs instead.
    expect(card.maxHeight).toBe('');
    expect(card.height).toBeGreaterThan(200);
    // The reply box is a real, visible part of the card rather than clipped away by
    // `overflow: hidden` (the composer is expanded by default, so the collapsed
    // "Reply" button is the hidden one — assert on the box).
    const reply = page.locator('.comment-popover-reply-box');
    await expect(reply).toBeVisible();
    const replyBottom = await reply.evaluate((el) => el.getBoundingClientRect().bottom);
    expect(replyBottom).toBeLessThanOrEqual(card.bottom + 1);
  });
});

test.describe('AC5 — overlapping washes resolve to the narrowest', () => {
  test('the tighter anchor wins where two overlap, and the wider one still opens outside it', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 21, 'Whole sentence.');
    await createThreadOn(page, 0, 6, 15, 'Just the middle.');
    // Same source line, so they cluster into one pin — its "+2" is what proves
    // BOTH anchors resolved; a pin count of 1 would be true after only the first.
    await expect(page.locator('.comment-gutter-pin-count')).toHaveText('+2');
    await expectClosedToStart(page);

    const inner = await centreOfChars(page, 0, 8, 12);
    await page.mouse.click(inner.x, inner.y);
    await expect(popoverBody(page)).toHaveText('Just the middle.');
    await closePopover(page);

    // Outside the inner span only the wide anchor covers the point.
    const outer = await centreOfChars(page, 0, 1, 4);
    await page.mouse.click(outer.x, outer.y);
    await expect(popoverBody(page)).toHaveText('Whole sentence.');
  });
});

test.describe('nothing to click', () => {
  test('a Closed thread has no wash and no click target, while an Open one beside it does', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    // Only a host sync can produce a Closed thread (see seedCommentThreads).
    await seedCommentThreads(
      page,
      [
        {
          threadId: 'closed-1',
          status: 'Closed',
          body: 'Closed thread.',
          recordedText: 'Alpha paragraph text.',
          offsetStart: 0,
          offsetEnd: 5,
          lastKnownLine: 3,
        },
        {
          threadId: 'open-1',
          status: 'Open',
          body: 'Open thread.',
          recordedText: 'Beta paragraph text.',
          offsetStart: 0,
          offsetEnd: 4,
          lastKnownLine: 5,
        },
      ],
      undefined,
      DEFAULT_DOC_URI
    );
    // A Closed thread draws no pin, so this single pin IS the Open one — and its
    // presence is what proves the debounced re-resolution finished.
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const closed = await centreOfChars(page, 0, 2, 3);
    await page.mouse.click(closed.x, closed.y);
    await expectNeverOpened(page);

    // Positive control: the seeding and anchor resolution both work, so the
    // refusal above is the Closed status and not a failed seed.
    const open = await centreOfChars(page, 1, 1, 3);
    await page.mouse.click(open.x, open.y);
    await expect(popoverBody(page)).toHaveText('Open thread.');
  });

  test('a floating thread has no click target', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await settleAnchors(page, 1);
    const at = await centreOfChars(page, 0, 2, 3);

    // Positive control first: the click works while the anchor is live, so the
    // silence below is the lost anchor and not a route that never worked.
    await page.mouse.click(at.x, at.y);
    await expect(popover(page)).toBeVisible();
    await closePopover(page);

    // Gut the document, following comment-panel.spec.ts's own GUTTED fixture:
    // tier 3 parks a thread on any block still spanning its last known line, so
    // merely REWRITING line 3 re-anchors it approximately (measured) — the line
    // has to stop existing for all four tiers to fail.
    await simulate(page, { type: 'update', text: '# Session expiry\n' });
    await dismissAnchorLost(page);
    await settleAnchors(page, 0);
    await expectClosedToStart(page);

    await page.mouse.click(at.x, at.y);
    await expectNeverOpened(page);
  });

  test('a bare-caret anchor keeps its pin but has no washed text to click', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    // offsetStart === offsetEnd: a comment placed at a caret rather than over a
    // selection. It resolves (so it keeps a pin) but spans no characters, so
    // there is nothing painted and nothing to hit-test — the AC1 clause that the
    // clickable region is exactly the washed region, in its sharpest form.
    await seedCommentThreads(
      page,
      [
        {
          threadId: 'caret-1',
          status: 'Open',
          body: 'Caret thread.',
          recordedText: 'Alpha paragraph text.',
          offsetStart: 3,
          offsetEnd: 3,
          lastKnownLine: 3,
        },
      ],
      undefined,
      DEFAULT_DOC_URI
    );
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const at = await centreOfChars(page, 0, 2, 4);
    await page.mouse.click(at.x, at.y);
    await expectNeverOpened(page);

    // Positive control: the thread is perfectly reachable from its pin, so this
    // route's silence is the empty range and not an unresolved thread.
    await page.locator('.comment-gutter-pin').first().click();
    await expect(popoverBody(page)).toHaveText('Caret thread.');
  });

  test('a click in the blank margin right of the line is not resolved to the nearest caret', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    // Anchor the paragraph's TAIL, so a nearest-caret resolution from the margin
    // would snap straight into this wash. The rect hit-test must not.
    await createThreadOn(page, 0, 15, 21, 'On the tail.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const tail = await centreOfChars(page, 0, 15, 21);
    const box = await page.locator('#content p').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { right: r.right };
    });
    const marginX = box.right - 4;
    // Premise: the click must be genuinely past the last glyph.
    expect(marginX).toBeGreaterThan(tail.x + 20);

    await page.mouse.click(marginX, tail.y);
    await expectNeverOpened(page);

    // Positive control: the tail anchor itself is reachable.
    await page.mouse.click(tail.x, tail.y);
    await expect(popoverBody(page)).toHaveText('On the tail.');
  });
});

test.describe('AC6 — opening this way changes nothing about the popover', () => {
  test('the caret stays where it was clicked and focus returns to #content on close', async ({ page }) => {
    await openEditor(page, DOC, { commentHighlightOn: true });
    await createThreadOn(page, 0, 0, 5, 'On Alpha.');
    await settleAnchors(page, 1);
    await expectClosedToStart(page);

    const at = await centreOfChars(page, 0, 2, 3);
    await page.mouse.click(at.x, at.y);
    await expect(popover(page)).toBeVisible();

    // The click was not preventDefault'd, so the browser placed a collapsed caret
    // inside the anchored paragraph.
    expect(
      await page.evaluate(() => {
        const sel = window.getSelection();
        const node = sel?.anchorNode ?? null;
        const el = node instanceof Element ? node : (node?.parentElement ?? null);
        return { collapsed: sel?.isCollapsed === true, inContent: el !== null && el.closest('#content') !== null };
      })
    ).toEqual({ collapsed: true, inContent: true });

    await closePopover(page);
    expect(await page.evaluate(() => document.activeElement?.id ?? '')).toBe('content');
  });
});
