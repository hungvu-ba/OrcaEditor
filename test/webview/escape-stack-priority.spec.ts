/**
 * Req 20 US-20.4 (AC #35): the shared capture-phase Escape arbiter
 * (media/webview/escape-stack.ts). Per keypress only the highest-priority ACTIVE
 * handler (the first, in priority-descending order, whose handler returns true)
 * runs and consumes the key; if none is active the key falls through untouched.
 *
 * Driven via window.EscapeStackDebug (see esbuild.js's escapeStackDebugConfig +
 * _harness.ts) because the real sources — drag, trigger popup, cross-file, Zen —
 * can't all be made simultaneously active from a spec, and the POPUP tier has no
 * real caller yet (its consumer lands with the trigger popup). A real-behavior
 * smoke at the end proves the readability (Zen) rewire still works end-to-end.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

interface EscapeStackDebugApi {
  ESCAPE_PRIORITY: { DRAG: number; POPUP: number; CROSS_FILE: number; ZEN: number };
  registerEscapeHandler(priority: number, handler: () => boolean): { dispose(): void };
}

test('only the highest-priority active handler runs; falls through when none active; dispose deregisters', async ({
  page,
}) => {
  await openEditor(page, 'hello world');

  // Per-handler activeness toggles so the same registration can flip between
  // active (returns true) and inactive (returns false) across dispatches.
  const cases = await page.evaluate(() => {
    const debug = (window as unknown as { EscapeStackDebug: EscapeStackDebugApi }).EscapeStackDebug;
    const P = debug.ESCAPE_PRIORITY;
    const ran: string[] = [];
    const active = { drag: true, popup: true, crossFile: true, zen: true };
    const mk = (name: keyof typeof active, tier: string) => () => {
      if (!active[name]) return false;
      ran.push(tier);
      return true;
    };
    const dDrag = debug.registerEscapeHandler(P.DRAG, mk('drag', 'DRAG'));
    const dPopup = debug.registerEscapeHandler(P.POPUP, mk('popup', 'POPUP'));
    const dCf = debug.registerEscapeHandler(P.CROSS_FILE, mk('crossFile', 'CROSS_FILE'));
    const dZen = debug.registerEscapeHandler(P.ZEN, mk('zen', 'ZEN'));
    const dispatch = () => {
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, ran: ran.slice() };
    };

    ran.length = 0;
    const c1 = dispatch();
    active.drag = false;
    ran.length = 0;
    const c2 = dispatch();
    active.popup = false;
    active.crossFile = false;
    active.zen = false;
    ran.length = 0;
    const c3 = dispatch();
    active.drag = true;
    active.popup = true;
    dDrag.dispose();
    ran.length = 0;
    const c4 = dispatch();

    dPopup.dispose();
    dCf.dispose();
    dZen.dispose();
    return { c1, c2, c3, c4 };
  });

  // 1. Single-fire: only DRAG, event consumed.
  expect(cases.c1.ran).toEqual(['DRAG']);
  expect(cases.c1.prevented).toBe(true);

  // 2. DRAG inactive → POPUP wins, no lower tier.
  expect(cases.c2.ran).toEqual(['POPUP']);
  expect(cases.c2.prevented).toBe(true);

  // 3. None active → nothing runs, not consumed.
  expect(cases.c3.ran).toEqual([]);
  expect(cases.c3.prevented).toBe(false);

  // 4. DRAG disposed → POPUP now wins.
  expect(cases.c4.ran).toEqual(['POPUP']);
  expect(cases.c4.prevented).toBe(true);
});

test('real behavior: Zen exits on Escape via the ZEN tier (readability rewire)', async ({ page }) => {
  await openEditor(page, 'hello world', {
    readability: { enabled: false, mode: 'standard', fontFamily: '', zen: true },
  });
  await page.waitForFunction(() => document.body.classList.contains('reading-zen'));

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.body.classList.contains('reading-zen'));

  await expect(page.locator('#toolbar')).toHaveCSS('transform', 'none');
});
