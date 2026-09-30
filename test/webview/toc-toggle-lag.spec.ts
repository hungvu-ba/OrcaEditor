/**
 * TOC toggle lag (Plan/TOC Toggle Lag — Analysis.md, bug inside US-10.1): the
 * panel slides with a compositor-only transform and body/#toolbar ease no
 * padding/margin, so #content reflows once per toggle instead of on every frame
 * of the slide. The fixture is one 302 × 13 table between three headings — the
 * shape that made a toggle cost 35–39 layouts.
 *
 * LayoutCount per open/close is logged, not asserted (T2.3 reads it as its
 * before number and adds the bound).
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';
import type { InitConfig } from '../../src/shared/messages';

const ROWS = 302;
const COLS = 13;

function bigTableDoc(): string {
  const cell = (r: number, c: number): string => `cell r${r} c${c} lorem ip`.slice(0, 20).padEnd(20, '.');
  const row = (r: number): string => `| ${Array.from({ length: COLS }, (_, c) => cell(r, c)).join(' | ')} |`;
  const lines = [row(0), `|${Array.from({ length: COLS }, () => ' --- ').join('|')}|`];
  for (let r = 1; r < ROWS; r++) lines.push(row(r));
  return `# Before table\n\nIntro paragraph.\n\n## The table\n\n${lines.join('\n')}\n\n## After table\n\nOutro paragraph.\n`;
}

async function openFixture(page: Page, cfg: Partial<InitConfig> = {}): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openEditor(page, bigTableDoc(), cfg);
  await expect(page.locator('#content table tr')).toHaveCount(ROWS);
}

/** Toggles the panel with a DOM click (no Playwright actionability layout) and
 * returns the LayoutCount delta read 400 ms later. */
async function toggleLayoutCount(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const layoutCount = async (): Promise<number> => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0;
  };
  const before = await layoutCount();
  await page.evaluate(() => document.getElementById('toc-toggle')!.click());
  await page.waitForTimeout(400);
  const delta = (await layoutCount()) - before;
  await cdp.detach();
  return delta;
}

/** Transition properties of `el` whose duration is non-zero. */
function easedProps(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluate((el) => {
    const cs = getComputedStyle(el);
    const props = cs.transitionProperty.split(',').map((x) => x.trim());
    const durs = cs.transitionDuration.split(',').map((x) => parseFloat(x));
    return props.filter((_, i) => durs[i % durs.length] > 0);
  });
}

test('closed panel is off-canvas without page scroll; open slides it to transform none', async ({ page }) => {
  await openFixture(page);
  const panel = page.locator('#toc-panel');

  await expect(panel).toHaveCSS('visibility', 'hidden');
  expect(await panel.evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
  const noHScroll = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await noHScroll()).toBe(true);

  const openLayouts = await toggleLayoutCount(page);
  expect(await panel.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  await expect(panel).toHaveCSS('visibility', 'visible');

  const closeLayouts = await toggleLayoutCount(page);
  await expect(panel).toHaveCSS('visibility', 'hidden');
  expect(await noHScroll()).toBe(true);

  console.log(`[toc-toggle-lag] LayoutCount open=${openLayouts} close=${closeLayouts}`);
});

test('body and #toolbar ease no padding/margin, so the content reflows once per toggle', async ({ page }) => {
  await openFixture(page);
  for (const open of [false, true]) {
    if (open) await page.evaluate(() => document.getElementById('toc-toggle')!.click());
    for (const selector of ['body', '#toolbar']) {
      const eased = await easedProps(page, selector);
      expect(eased).not.toContain('padding-right');
      expect(eased).not.toContain('margin-right');
      expect(eased).not.toContain('all');
    }
  }
});

test('Zen keeps the #toolbar transform slide', async ({ page }) => {
  await openFixture(page, { readability: { enabled: false, mode: 'standard', fontFamily: '', zen: true } });
  const tb = await page.locator('#toolbar').evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(tb).toContain('transform');
});
