/**
 * TOC toggle lag (Plan/TOC Toggle Lag — Analysis.md, bug inside US-10.1): the
 * panel slides with a compositor-only transform and body/#toolbar ease no
 * padding/margin, so #content reflows once per toggle instead of on every frame
 * of the slide. The fixture is one 302 × 13 table between three headings — the
 * shape that made a toggle cost 35–39 layouts — plus a long paragraph after the
 * table whose rewrap moves the caret line below it (browser scroll anchoring
 * keeps a table row still, not that line).
 *
 * The anchor is held once in the toggle's task, after build's layout reads, and
 * re-held on the next frame and after the fit settle — no per-frame pin loop, no
 * layout of its own (T2.3). Close costs ≤ 8 LayoutCount; open still costs 11:
 * build's four forced layouts and the toolbar overflow's four are outside T2.3.
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
  const wrapping = 'Wrapping lorem ipsum dolor sit amet. '.repeat(40);
  return `# Before table\n\nIntro paragraph.\n\n## The table\n\n${lines.join('\n')}\n\n## After table\n\n${wrapping}\n\nOutro paragraph.\n`;
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
  expect(openLayouts).toBeLessThanOrEqual(11);
  expect(closeLayouts).toBeLessThanOrEqual(8);
});

/** Puts the caret in the paragraph below the table, scrolls it on screen and
 * returns its viewport top. */
async function caretInOutro(page: Page): Promise<number> {
  return page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('#content p')).find((el) =>
      el.textContent!.includes('Outro paragraph')
    ) as HTMLElement;
    p.scrollIntoView({ block: 'center' });
    const range = document.createRange();
    range.setStart(p.firstChild!, 2);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return p.getBoundingClientRect().top;
  });
}

function outroTop(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (Array.from(document.querySelectorAll('#content p')).find((el) =>
        el.textContent!.includes('Outro paragraph')
      ) as HTMLElement).getBoundingClientRect().top
  );
}

async function clickToggle(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('toc-toggle')!.click());
  await page.waitForTimeout(400);
}

test('fit mode: the caret line below the table keeps its viewport top across open and close', async ({ page }) => {
  await openFixture(page, { tableFitMode: true });
  const before = await caretInOutro(page);

  await clickToggle(page);
  const afterOpen = await outroTop(page);
  expect(Math.abs(afterOpen - before)).toBeLessThanOrEqual(2);

  await clickToggle(page);
  const afterClose = await outroTop(page);
  expect(Math.abs(afterClose - afterOpen)).toBeLessThanOrEqual(2);
});

test('fit mode: a wheel right after opening still scrolls the page', async ({ page }) => {
  await openFixture(page, { tableFitMode: true });
  const before = await caretInOutro(page);
  await page.mouse.move(300, 450);

  await page.evaluate(() => document.getElementById('toc-toggle')!.click());
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(400);

  expect((await outroTop(page)) - before).toBeGreaterThan(300);
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
