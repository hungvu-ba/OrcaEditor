/**
 * US-4.26 — toolbar control sizes derive from one fixed --toolbar-base-height
 * knob via ratios. Needs a real engine to resolve calc() computed values.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('control sizes equal today\'s px at the default --toolbar-base-height (no visual change)', async ({ page }) => {
  await openEditor(page, '# hi');
  const s = await page.evaluate(() => {
    const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!);
    const btn = cs('#toolbar button');
    return {
      btnH: btn.height,
      btnMinW: btn.minWidth,
      icon: cs('#toolbar button svg').width,
      sepH: cs('#toolbar .toolbar-sep').height,
      sepMargin: cs('#toolbar .toolbar-sep').marginLeft,
    };
  });
  expect(s.btnH).toBe('30px');
  expect(s.btnMinW).toBe('32px');
  expect(s.icon).toBe('20px');
  expect(s.sepH).toBe('20px');
  expect(s.sepMargin).toBe('5px');
});

test('changing --toolbar-base-height scales every derived size proportionally (single knob)', async ({ page }) => {
  await openEditor(page, '# hi');
  const s = await page.evaluate(() => {
    document.documentElement.style.setProperty('--toolbar-base-height', '80px'); // 2x
    const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!);
    const btn = cs('#toolbar button');
    return { btnH: btn.height, btnMinW: btn.minWidth, icon: cs('#toolbar button svg').width, sepH: cs('#toolbar .toolbar-sep').height };
  });
  expect(s.btnH).toBe('60px');
  expect(s.btnMinW).toBe('64px');
  expect(s.icon).toBe('40px');
  expect(s.sepH).toBe('40px');
});
