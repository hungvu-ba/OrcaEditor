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

/** Runs `action` and returns the CDP LayoutCount delta across it. */
async function layoutCountDelta(page: Page, action: () => Promise<void>): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const layoutCount = async (): Promise<number> => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0;
  };
  const before = await layoutCount();
  await action();
  const delta = (await layoutCount()) - before;
  await cdp.detach();
  return delta;
}

/** Toggles the panel with a DOM click (no Playwright actionability layout) and
 * returns the LayoutCount delta read 400 ms later. */
function toggleLayoutCount(page: Page): Promise<number> {
  return layoutCountDelta(page, async () => {
    await page.evaluate(() => document.getElementById('toc-toggle')!.click());
    await page.waitForTimeout(400);
  });
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

// --- Resize drag (T2.2): only --toc-width follows the pointer; --toc-reserve
// (body padding-right) catches up 150 ms after the pointer rests and on release.

function rootVar(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => parseFloat(document.documentElement.style.getPropertyValue(n)), name);
}

function bodyPaddingRight(page: Page): Promise<number> {
  return page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingRight));
}

/** Opens the panel and presses a real pointer on #toc-resize; returns the press x. */
async function pressResizer(page: Page): Promise<number> {
  await clickToggle(page);
  const box = (await page.locator('#toc-resize').boundingBox())!;
  const x = Math.round(box.x + box.width / 2);
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  return x;
}

test('resize drag: --toc-width follows each move, body padding waits for a 150 ms rest', async ({ page }) => {
  await openFixture(page);
  const x0 = await pressResizer(page);
  const y = 450;
  const padBefore = await bodyPaddingRight(page);
  const innerWidth = await page.evaluate(() => window.innerWidth);

  let x = x0;
  for (let i = 0; i < 20; i++) {
    x -= 5;
    await page.mouse.move(x, y);
    expect(await rootVar(page, '--toc-width')).toBe(innerWidth - x);
    expect(await bodyPaddingRight(page)).toBe(padBefore);
    await page.waitForTimeout(16);
  }

  await page.waitForTimeout(200);
  expect(await bodyPaddingRight(page)).toBe(26 + innerWidth - x);
  await page.mouse.up();
});

// LayoutCount cannot tell a panel-only layout from a table re-layout: the panel
// width and the #toolbar padding (still --toc-width, contract 4) lay out on
// every move either way (~7 per move). What the debounce removes is the
// #content width change, so that is what this counts.
test('resize drag: 20 moves never resize #content', async ({ page }) => {
  await openFixture(page);
  let x = await pressResizer(page);
  await page.evaluate(() => {
    const w = window as unknown as { contentResizes: number };
    w.contentResizes = 0;
    let first = true;
    new ResizeObserver(() => {
      if (first) first = false;
      else w.contentResizes++;
    }).observe(document.getElementById('content')!);
  });
  await page.waitForTimeout(50);
  const layouts = await layoutCountDelta(page, async () => {
    for (let i = 0; i < 20; i++) {
      x -= 5;
      await page.mouse.move(x, 450);
      await page.waitForTimeout(16);
    }
  });
  const contentResizes = () => page.evaluate(() => (window as unknown as { contentResizes: number }).contentResizes);
  console.log(`[toc-toggle-lag] resize drag LayoutCount over 20 moves=${layouts}`);
  expect(await contentResizes()).toBe(0);

  await page.mouse.up();
  await expect.poll(contentResizes).toBe(1);
});

test('resize drag: pointerup right after a move applies the content reserve at once', async ({ page }) => {
  await openFixture(page);
  const x = (await pressResizer(page)) - 60;
  const innerWidth = await page.evaluate(() => window.innerWidth);
  await page.mouse.move(x, 450);
  await page.mouse.up();
  expect(await bodyPaddingRight(page)).toBe(26 + innerWidth - x);
});

test('window narrowing after a drag to 480px clamps panel and reserve together', async ({ page }) => {
  await openFixture(page);
  await pressResizer(page);
  const innerWidth = await page.evaluate(() => window.innerWidth);
  await page.mouse.move(innerWidth - 480, 450);
  await page.mouse.up();
  expect(await rootVar(page, '--toc-width')).toBe(480);

  // 1200 × 0.35 = 420 clamps the panel; 1200 ≥ 560 + 420 + 26 keeps it out of isNarrowViewport.
  await page.setViewportSize({ width: 1200, height: 900 });
  // Both vars are read in one evaluate, so equal values mean one handler wrote them together.
  await expect
    .poll(() => page.evaluate(() => ['--toc-width', '--toc-reserve'].map((n) => document.documentElement.style.getPropertyValue(n))))
    .toEqual(['420px', '420px']);
  await expect(page.locator('body')).toHaveClass(/toc-open/);
});

test('Zen + TOC open: #toolbar right edge sits on the viewport edge', async ({ page }) => {
  await openFixture(page, { readability: { enabled: false, mode: 'standard', fontFamily: '', zen: true } });
  await clickToggle(page);
  const { right, clientWidth } = await page.locator('#toolbar').evaluate((el) => ({
    right: el.getBoundingClientRect().right,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(right).toBe(clientWidth);
});
