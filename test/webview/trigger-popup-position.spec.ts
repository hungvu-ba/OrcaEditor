/**
 * Req 20 (Mention Declare bugs 3 & 4) — shared @// trigger popup positioning.
 *
 * Bug 3: declaring `/` on an empty new line must anchor the popup to that line,
 * not to the top-left corner (a collapsed Range on an empty block yields a zero
 * client rect, so the anchor math used to read (0,0)). Driven through the real
 * main.js `/` trigger on a real empty <p>.
 *
 * Bug 4: the `@` popup must keep the vertical position it first showed at when a
 * scope switch resizes the card, re-clamping only when the new height would push
 * it off the viewport edge. Driven via the TriggerPopupDebug shell so the anchor
 * geometry and the card's content size are both controlled deterministically.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

interface Group {
  label: string;
  items: Array<{ id: string; label: string }>;
}
interface Ctrl {
  open(a: {
    axis: string;
    anchorRange: Range;
    dataSource: { query(q: string): Group[] | Promise<Group[]> };
    onPick(item: unknown): void;
  }): void;
  updateQuery(q: string): void;
  close(): void;
}
interface TriggerPopupDebugApi {
  initTriggerPopup(deps: { content: HTMLElement }): Ctrl;
}

// ---------------------------------------------------------------------------
// Bug 3 — declare `/` on an empty line anchors to the line, not the corner.
// ---------------------------------------------------------------------------

test('bug 3: `/` on an empty new line anchors the popup to that line, not the top-left corner', async ({ page }) => {
  await openEditor(page, 'filler line');
  // Append an empty paragraph well below the first line and put the caret in it,
  // so the anchor is a collapsed Range on an empty block (zero client rects).
  await page.locator('#content').evaluate((content) => {
    const empty = document.createElement('p');
    empty.appendChild(document.createElement('br'));
    content.appendChild(empty);
    const range = document.createRange();
    range.setStart(empty, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.type('/');

  const card = page.locator('.trigger-popup');
  await expect(card).toBeVisible();

  const boxes = await page.evaluate(() => {
    const p = document.querySelectorAll('#content p')[1] as HTMLElement; // the empty one
    const pr = p.getBoundingClientRect();
    const cr = (document.querySelector('.trigger-popup') as HTMLElement).getBoundingClientRect();
    return { pTop: pr.top, pLeft: pr.left, cardTop: cr.top, cardLeft: cr.left };
  });

  // Anchored to the caret's line: top at/below the line, left aligned to it —
  // NOT clamped to the (4,4) top-left corner as the zero-rect bug produced.
  expect(boxes.cardTop).toBeGreaterThanOrEqual(boxes.pTop - 1);
  expect(Math.abs(boxes.cardLeft - boxes.pLeft)).toBeLessThan(30);
});

// ---------------------------------------------------------------------------
// Bug 4 — stable top across a scope-switch resize (shell, controlled geometry).
// ---------------------------------------------------------------------------

/**
 * Open the debug shell at a caret pushed low in a short viewport (so the card
 * can't fit below the caret and its top depends on the card height — the regime
 * where the pre-fix code jumped on resize). `startBig` picks the first render's
 * size; toggling drives the resize under test. Returns the shell's own applied
 * `top` (card.style.top) and height before and after the switch.
 */
async function measureResize(page: Page, startBig: boolean): Promise<{
  top1: number;
  top2: number;
  h1: number;
  h2: number;
  vh: number;
}> {
  await page.setViewportSize({ width: 800, height: 340 });
  await openEditor(page, '');
  return page.evaluate(async (startBig) => {
    const content = document.getElementById('content')!;
    content.textContent = '';
    const spacer = document.createElement('div');
    // Push the anchor near the viewport bottom so the card can't fit below it
    // (its top then depends on the card height — the regime the pre-fix code
    // jumped in), and so a max-height tall card genuinely overflows the edge.
    spacer.style.height = window.innerHeight - 60 + 'px';
    content.appendChild(spacer);
    const p = document.createElement('p');
    p.textContent = 'anchor';
    content.appendChild(p);
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.collapse(true);

    const tall: Group = { label: 'G', items: Array.from({ length: 12 }, (_, i) => ({ id: 'i' + i, label: 'Item ' + i })) };
    const short: Group = { label: 'G', items: [{ id: 'x', label: 'Only one' }] };
    let big = startBig;

    const debug = (window as unknown as { TriggerPopupDebug: TriggerPopupDebugApi }).TriggerPopupDebug;
    const ctrl = debug.initTriggerPopup({ content });
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    ctrl.open({ axis: '@', anchorRange: range, dataSource: { query: () => [big ? tall : short] }, onPick: () => {} });
    await raf();
    const card = document.querySelector('.trigger-popup') as HTMLElement;
    const top1 = parseFloat(card.style.top);
    const h1 = card.offsetHeight;

    big = !big;
    ctrl.updateQuery('x'); // re-runs the query → renders the other size → repositions
    await raf();
    const top2 = parseFloat(card.style.top);
    const h2 = card.offsetHeight;

    return { top1, top2, h1, h2, vh: window.innerHeight };
  }, startBig);
}

test('bug 4: switching to a smaller card keeps the first-shown top (no vertical jump)', async ({ page }) => {
  const m = await measureResize(page, true); // tall first, then short
  expect(m.h1).toBeGreaterThan(m.h2); // the resize is real (card got shorter)
  expect(Math.abs(m.top2 - m.top1)).toBeLessThan(0.5); // top is frozen at the first value
});

test('bug 4: switching to a taller card that would overflow re-clamps up to stay on-screen', async ({ page }) => {
  const m = await measureResize(page, false); // short first, then tall
  expect(m.h2).toBeGreaterThan(m.h1); // the resize is real (card got taller)
  expect(m.top2).toBeLessThan(m.top1); // frozen top would clip → re-clamped upward
  expect(m.top2 + m.h2).toBeLessThanOrEqual(m.vh - 4); // and it stays fully within the viewport
});
