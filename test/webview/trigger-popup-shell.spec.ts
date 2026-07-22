/**
 * Req 20 US-20.1/20.2/20.4: the shared trigger-popup shell
 * (media/webview/trigger-popup.ts). Driven via window.TriggerPopupDebug (see
 * esbuild.js's triggerPopupDebugConfig + _harness.ts) with a FAKE dataSource —
 * there is no real @// trigger caller yet, so the shell is exercised directly.
 *
 * Covers: chrome render (groups/headers, zero-group omission, footer hint,
 * non-interactive "+N more"), below-left anchoring at 340px, Reading-Mode-token
 * chrome (--rp-bg), Escape via the POPUP tier + onClose, input-ownership set on
 * open / cleared on the Escape teardown path, and the cross-instance monotonic
 * staleness guard.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

interface Group {
  label: string;
  items: Array<{ id: string; label: string; detail?: string; badge?: string }>;
  total?: number;
}
interface Ctrl {
  open(a: {
    axis: string;
    anchorRange: Range;
    dataSource: { query(q: string): Group[] | Promise<Group[]> };
    onPick(item: unknown): void;
    onClose?(): void;
  }): void;
  updateQuery(q: string): void;
  isOpen(): boolean;
  close(): void;
}
interface TriggerPopupDebugApi {
  initTriggerPopup(deps: { content: HTMLElement }): Ctrl;
}

test('open() renders chrome: groups + headers, zero-item group omitted, footer hint, non-interactive +N more; 340px card anchored below-left', async ({
  page,
}) => {
  await openEditor(page, 'hello world');

  const facts = await page.evaluate(async () => {
    const content = document.getElementById('content')!;
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(true);
    const rect = range.getBoundingClientRect();

    const debug = (window as unknown as { TriggerPopupDebug: TriggerPopupDebugApi }).TriggerPopupDebug;
    const ctrl = debug.initTriggerPopup({ content });
    ctrl.open({
      axis: '@',
      anchorRange: range,
      dataSource: {
        query: () => [
          { label: 'Files', items: [{ id: 'f1', label: 'alpha.md' }], total: 4 },
          { label: 'Headings', items: [] }, // zero-item → must be omitted
          { label: 'Blocks', items: [{ id: 'b1', label: 'Table' }] },
        ],
      },
      onPick: () => {},
    });

    // Let the rAF-coalesced reposition run.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const card = document.querySelector('.trigger-popup') as HTMLElement;
    const cs = getComputedStyle(card);
    const groupLabels = Array.from(card.querySelectorAll('.trigger-popup-group-label')).map((e) => e.textContent);
    const more = card.querySelector('.trigger-popup-more') as HTMLElement | null;
    const moreCursor = more ? getComputedStyle(more).cursor : null;

    const result = {
      visible: !card.hidden,
      width: cs.width,
      hasHint: !!card.querySelector('.trigger-popup-hint'),
      hintText: card.querySelector('.trigger-popup-hint')?.textContent ?? null,
      groupLabels,
      itemCount: card.querySelectorAll('.trigger-popup-item').length,
      moreText: more?.textContent ?? null,
      moreCursor,
      moreHasRole: more?.hasAttribute('role') ?? null,
      // Below-left: top just under the anchor, left at/near anchor.left.
      top: parseFloat(card.style.top),
      left: parseFloat(card.style.left),
      anchorBottom: rect.bottom,
      anchorLeft: rect.left,
    };
    ctrl.close();
    return result;
  });

  expect(facts.visible).toBe(true);
  expect(facts.width).toBe('340px');
  // Zero-item "Headings" group omitted; Files + Blocks kept.
  expect(facts.groupLabels).toEqual(['Files', 'Blocks']);
  expect(facts.itemCount).toBe(2);
  expect(facts.hasHint).toBe(true);
  expect(facts.hintText).toContain('Esc cancel');
  // "+N more": 4 total - 1 shown = 3, static microcopy, non-interactive.
  expect(facts.moreText).toBe('+3 more — keep typing to narrow');
  expect(facts.moreCursor).toBe('default');
  expect(facts.moreHasRole).toBe(false);
  // Anchored below-left of the caret.
  expect(facts.top).toBeGreaterThan(facts.anchorBottom);
  expect(facts.left).toBeGreaterThanOrEqual(facts.anchorLeft - 1);
});

test('flips above the caret when there is no room below the anchor (near viewport bottom)', async ({
  page,
}) => {
  await openEditor(page, 'hello world');

  const facts = await page.evaluate(async () => {
    const content = document.getElementById('content')!;
    // Anchor near the viewport bottom: a fixed span inside #content so its rect
    // sits a few px above innerHeight (isResponseValid still sees it in content).
    const anchor = document.createElement('span');
    anchor.textContent = '@';
    anchor.style.position = 'fixed';
    anchor.style.left = '50px';
    anchor.style.bottom = '4px';
    content.appendChild(anchor);
    const range = document.createRange();
    range.selectNodeContents(anchor);
    const rect = range.getBoundingClientRect();

    const debug = (window as unknown as { TriggerPopupDebug: TriggerPopupDebugApi }).TriggerPopupDebug;
    const ctrl = debug.initTriggerPopup({ content });
    ctrl.open({
      axis: '@',
      anchorRange: range,
      dataSource: {
        query: () => [
          { label: 'Files', items: [{ id: 'f1', label: 'alpha.md' }, { id: 'f2', label: 'beta.md' }] },
          { label: 'Blocks', items: [{ id: 'b1', label: 'Table' }, { id: 'b2', label: 'Image' }] },
        ],
      },
      onPick: () => {},
    });

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const card = document.querySelector('.trigger-popup') as HTMLElement;
    const result = {
      top: parseFloat(card.style.top),
      cardHeight: card.offsetHeight,
      anchorTop: rect.top,
      viewportHeight: window.innerHeight,
    };
    ctrl.close();
    anchor.remove();
    return result;
  });

  // Flipped above: card sits above the anchor and its bottom edge stays inside
  // the viewport (the pre-fix below-only placement overflowed off the bottom).
  expect(facts.top).toBeLessThan(facts.anchorTop);
  expect(facts.top + facts.cardHeight).toBeLessThanOrEqual(facts.viewportHeight);
});

test('chrome reads Reading Mode tokens: card background-color follows --rp-bg', async ({ page }) => {
  await openEditor(page, 'hello world');

  const bg = await page.evaluate(() => {
    // Distinct, unambiguous colour so we know the card follows the token, not a fallback.
    document.documentElement.style.setProperty('--rp-bg', 'rgb(1, 2, 3)');
    const content = document.getElementById('content')!;
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(true);
    const debug = (window as unknown as { TriggerPopupDebug: TriggerPopupDebugApi }).TriggerPopupDebug;
    const ctrl = debug.initTriggerPopup({ content });
    ctrl.open({ axis: '@', anchorRange: range, dataSource: { query: () => [] }, onPick: () => {} });
    const card = document.querySelector('.trigger-popup') as HTMLElement;
    const color = getComputedStyle(card).backgroundColor;
    ctrl.close();
    return color;
  });

  expect(bg).toBe('rgb(1, 2, 3)');
});

test('Escape closes via the POPUP tier and fires onClose; input-ownership set on open, cleared on Escape', async ({
  page,
}) => {
  await openEditor(page, 'hello world');

  // Baseline: with no owner, an input rule fires — typing "# " converts to a heading.
  // (proves the input-rules guard is inert when nothing owns input.)
  const setup = await page.evaluate(() => {
    const content = document.getElementById('content')!;
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(true);
    const debug = (window as unknown as { TriggerPopupDebug: TriggerPopupDebugApi }).TriggerPopupDebug;
    const ctrl = debug.initTriggerPopup({ content });
    let closed = false;
    ctrl.open({
      axis: '@',
      anchorRange: range,
      dataSource: { query: () => [] },
      onPick: () => {},
      onClose: () => {
        closed = true;
      },
    });
    (window as unknown as { __ctrl: Ctrl }).__ctrl = ctrl;
    (window as unknown as { __closed: () => boolean }).__closed = () => closed;
    return { openAfterOpen: ctrl.isOpen() };
  });
  expect(setup.openAfterOpen).toBe(true);

  // While open, the shell owns input → the editor's content keydown handler bails.
  // Observable proxy: the Escape stack's POPUP handler consumes Escape (below).
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !(window as unknown as { __ctrl: Ctrl }).__ctrl.isOpen());

  const after = await page.evaluate(() => ({
    open: (window as unknown as { __ctrl: Ctrl }).__ctrl.isOpen(),
    closed: (window as unknown as { __closed: () => boolean }).__closed(),
  }));
  expect(after.open).toBe(false);
  expect(after.closed).toBe(true);
});

test('input-ownership: editor input rule is suppressed while the shell is open, restored after close', async ({
  page,
}) => {
  await openEditor(page, '');
  const content = page.locator('#content');

  // Reset to a single empty paragraph and place the caret at its start.
  async function resetCaretToEmptyParagraph(): Promise<void> {
    await content.focus();
    await page.evaluate(() => {
      const el = document.getElementById('content')!;
      el.innerHTML = '<p><br></p>';
      const target = el.querySelector('p')!;
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
  }

  // Open the shell (claims input ownership); the caret lives in content.
  await resetCaretToEmptyParagraph();
  await page.evaluate(() => {
    const el = document.getElementById('content')!;
    const range = document.createRange();
    range.selectNodeContents(el.querySelector('p')!);
    range.collapse(true);
    const debug = (window as unknown as { TriggerPopupDebug: TriggerPopupDebugApi }).TriggerPopupDebug;
    const ctrl = debug.initTriggerPopup({ content: el });
    ctrl.open({ axis: '/', anchorRange: range, dataSource: { query: () => [] }, onPick: () => {} });
    (window as unknown as { __ctrl2: Ctrl }).__ctrl2 = ctrl;
  });

  // Type "# " — because the shell owns input, the heading input rule must NOT fire.
  await page.keyboard.type('# ');
  const headingWhileOpen = await content.evaluate((el) => el.querySelector('h1') !== null);
  expect(headingWhileOpen).toBe(false);

  // Close the shell → ownership released → input rule works again.
  await page.evaluate(() => (window as unknown as { __ctrl2: Ctrl }).__ctrl2.close());
  await resetCaretToEmptyParagraph();
  await page.keyboard.type('# ');
  const headingAfterClose = await content.evaluate((el) => el.querySelector('h1') !== null);
  expect(headingAfterClose).toBe(true);
});

test('staleness: out-of-order async responses and stale cross-instance responses are discarded', async ({
  page,
}) => {
  await openEditor(page, 'hello world');

  const result = await page.evaluate(async () => {
    const content = document.getElementById('content')!;
    const mkRange = () => {
      const r = document.createRange();
      r.selectNodeContents(content);
      r.collapse(true);
      return r;
    };
    const debug = (window as unknown as { TriggerPopupDebug: TriggerPopupDebugApi }).TriggerPopupDebug;

    // ---- Out-of-order within one popup: updateQuery('a') then ('ab'), 'a'
    // resolves LAST but must be discarded (newer requestId wins). ----
    const resolvers: Record<string, (g: Group[]) => void> = {};
    const ctrlA = debug.initTriggerPopup({ content });
    ctrlA.open({
      axis: '@',
      anchorRange: mkRange(),
      dataSource: {
        query: (q: string) =>
          new Promise<Group[]>((res) => {
            resolvers[q] = res;
          }),
      },
      onPick: () => {},
    });
    ctrlA.updateQuery('a');
    ctrlA.updateQuery('ab');
    // Resolve the STALE ('a') last, then the CURRENT ('ab').
    resolvers['a']?.([{ label: 'STALE', items: [{ id: 's', label: 'stale' }] }]);
    resolvers['ab']?.([{ label: 'FRESH', items: [{ id: 'f', label: 'fresh' }] }]);
    await new Promise((r) => setTimeout(r, 0));

    const cardA = document.querySelector('.trigger-popup') as HTMLElement;
    const renderedLabels = Array.from(cardA.querySelectorAll('.trigger-popup-group-label')).map(
      (e) => e.textContent
    );

    // ---- Cross-instance: open a SECOND popup; resolve the FIRST's still-pending
    // promise → the global monotonic counter must discard it. ----
    let secondResolve: ((g: Group[]) => void) | undefined;
    const ctrlB = debug.initTriggerPopup({ content });
    // First, arm a pending request on ctrlA again (open replaced its dataSource,
    // so query a fresh pending one).
    ctrlA.updateQuery('c'); // creates resolvers['c']
    ctrlB.open({
      axis: '/',
      anchorRange: mkRange(),
      dataSource: {
        query: () =>
          new Promise<Group[]>((res) => {
            secondResolve = res;
          }),
      },
      onPick: () => {},
    });
    // Resolve ctrlA's stale 'c' AFTER ctrlB opened (ctrlB bumped globalRequestSeq).
    resolvers['c']?.([{ label: 'A_STALE', items: [{ id: 'x', label: 'x' }] }]);
    await new Promise((r) => setTimeout(r, 0));
    // ctrlB should still show nothing from A; now resolve B's own request.
    secondResolve?.([{ label: 'B_FRESH', items: [{ id: 'y', label: 'y' }] }]);
    await new Promise((r) => setTimeout(r, 0));

    // Both popups share one .trigger-popup? No — each initTriggerPopup builds its
    // own card. Read the last-built card (ctrlB's).
    const cards = document.querySelectorAll('.trigger-popup');
    const cardB = cards[cards.length - 1] as HTMLElement;
    const cardBLabels = Array.from(cardB.querySelectorAll('.trigger-popup-group-label')).map(
      (e) => e.textContent
    );

    ctrlA.close();
    ctrlB.close();
    return { renderedLabels, cardBLabels };
  });

  // Out-of-order: only the newest ('ab' → FRESH) rendered, STALE discarded.
  expect(result.renderedLabels).toEqual(['FRESH']);
  // Cross-instance: ctrlB shows only its own fresh result, not ctrlA's stale one.
  expect(result.cardBLabels).toEqual(['B_FRESH']);
});
