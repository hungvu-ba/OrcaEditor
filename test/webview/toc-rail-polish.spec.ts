/**
 * TOC Rail wireframe-alignment polish (Plan/UI/TOC Rail — UI Implementation Plan.md):
 *  1. Resize-drag lag bug — while body.toc-resizing, #toc-panel's transition must
 *     drop `width` so a live drag is 1:1 with the cursor (the open/close slide,
 *     driven by body.toc-open only, keeps its width easing).
 *  3. Reading-palette theming — under a reading-mode-* palette the progress bar
 *     and the `⋯` menu's depth rows (US-10.8's home for the former depth pills)
 *     must adopt the palette accent, not the fixed VS Code blue.
 *  4. Empty state — "no match" shows a clickable reset link that restores all
 *     levels in place; "headless" shows a muted hint and no reset link.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, setDepth } from './_harness';
import type { InitConfig } from '../../src/shared/messages';

function filler(section: string, lines = 8): string {
  return Array.from({ length: lines }, (_, i) => `${section} filler line ${i + 1}.`).join('\n\n');
}

// H1 A, H2 A1, H3 A1a, H2 A2, H1 B — same shape as toc-filter.spec's DOC.
const DOC = `# H1 A

${filler('A')}

## H2 A1

${filler('A1')}

### H3 A1a

${filler('A1a')}

## H2 A2

${filler('A2')}

# H1 B

${filler('B')}
`;

// No H1 at all: the default level-3 shows the H2s/H3, but filtering to H1 hides
// everything → the "no match" empty state.
const DOC_NO_H1 = `## Only H2 A

${filler('A')}

### H3 A1

${filler('A1')}

## H2 B

${filler('B')}
`;

const SEPIA: InitConfig['readability'] = {
  enabled: true,
  mode: 'sepia',
  fontFamily: '',
  zen: false,
};

async function openToc(page: Page, markdown = DOC, cfg: Partial<InitConfig> = {}): Promise<void> {
  await openEditor(page, markdown, cfg);
  await page.locator('#toc-toggle').click({ force: true });
}

// --- Item 1: resize-drag lag ---------------------------------------------

test('open panel eases width, but while dragging (body.toc-resizing) width is dropped from the transition', async ({ page }) => {
  await openToc(page);

  const open = await page.locator('#toc-panel').evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(open).toContain('width'); // toggle-driven slide still animates width

  const dragging = await page.locator('#toc-panel').evaluate((el) => {
    document.body.classList.add('toc-resizing');
    const t = getComputedStyle(el).transitionProperty;
    document.body.classList.remove('toc-resizing');
    return t;
  });
  expect(dragging).not.toContain('width'); // live drag applies width instantly
});

test('while dragging, the content (body) and toolbar track the panel edge instantly (no transition lag)', async ({ page }) => {
  await openToc(page);
  const toolbar = page.locator('#toolbar');

  // Not dragging: body padding-right + toolbar margin/padding ease over the slide.
  expect(await page.evaluate(() => getComputedStyle(document.body).transitionDuration)).not.toBe('0s');
  expect(await toolbar.evaluate((el) => getComputedStyle(el).transitionDuration)).not.toBe('0s');

  // Dragging: both must be instant so the editor doesn't lag behind the drag.
  const { body, tb } = await page.evaluate(() => {
    document.body.classList.add('toc-resizing');
    const r = {
      body: getComputedStyle(document.body).transitionDuration,
      tb: getComputedStyle(document.getElementById('toolbar')!).transitionDuration,
    };
    document.body.classList.remove('toc-resizing');
    return r;
  });
  expect(body).toBe('0s');
  expect(tb).toBe('0s');
});

// --- Item 4: empty states -------------------------------------------------

test('no-match empty state shows a reset link that restores all levels in place', async ({ page }) => {
  await openToc(page, DOC_NO_H1);
  await setDepth(page, 1); // no H1 exists → every heading filtered out

  await expect(page.locator('#toc-empty')).toBeVisible();
  await expect(page.locator('.toc-item')).toHaveCount(0);
  const reset = page.locator('.toc-empty-reset');
  await expect(reset).toBeVisible();

  await reset.click();

  await expect(page.locator('#toc-empty')).toHaveCount(0);
  // Show H1–H2–H3 → all three headings (H2, H3, H2) now render.
  await expect(page.locator('.toc-item')).toHaveCount(3);
  // US-10.8: the link still resets in ONE click (it does not merely open the `⋯`
  // menu) — the menu is only where the depth control now lives, and it must come
  // up already reflecting the reset.
  await page.locator('.right-dock-menu-btn').click();
  await expect(page.locator('.right-dock-menu-item[aria-checked="true"]')).toHaveText(/H1–H2–H3$/);
});

test('headless empty state shows a hint and no reset link', async ({ page }) => {
  await openToc(page, 'Just a paragraph, no headings at all.\n\nAnother paragraph.');

  await expect(page.locator('#toc-empty')).toBeVisible();
  await expect(page.locator('.toc-empty-hint')).toBeVisible();
  await expect(page.locator('.toc-empty-reset')).toHaveCount(0);
});

test('a document with only H4+ headings shows no reset link (reset to H1–H3 would be a dead-end)', async ({ page }) => {
  // Headings exist but none are selectable (the depth rows only reach H3), so a
  // reset could never reveal them — the message stands alone, no dead affordance.
  await openToc(page, `#### Deep A\n\n${filler('A')}\n\n##### Deeper B\n\n${filler('B')}`);

  await expect(page.locator('#toc-empty')).toBeVisible();
  await expect(page.locator('.toc-item')).toHaveCount(0);
  await expect(page.locator('.toc-empty-reset')).toHaveCount(0);
});

// --- Long-title truncation (regression: flat-row was display:flex, which
//     broke text-overflow:ellipsis so long titles clipped without "…") --------

test('a long heading title is truncated with ellipsis, not clipped flush', async ({ page }) => {
  const longTitle = 'List Blocks — UI Implementation Plan for the outline rail panel';
  await openToc(page, `# ${longTitle}\n\n${filler('A')}`);

  const item = page.locator('.toc-item').first();
  const { display, textOverflow, overflow, clipped } = await item.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      display: cs.display,
      textOverflow: cs.textOverflow,
      overflow: cs.overflowX,
      clipped: el.scrollWidth > el.clientWidth, // content wider than the box → ellipsis renders
    };
  });
  expect(display).toBe('block'); // flex would put text in an anonymous item ellipsis can't reach
  expect(textOverflow).toBe('ellipsis');
  expect(overflow).toBe('hidden');
  expect(clipped).toBe(true);
});

// --- US-10.8: the restacked header's vertical budget ----------------------

test('the restacked header costs 31px above the outline list, 63px with the tab strip', async ({ page }) => {
  await openToc(page);

  // The 110px the budget came down from was #toc-header + #toc-filter-bar; assert
  // they are gone, or a future zero-height #toc-header would keep the px math
  // green while the AC is violated.
  await expect(page.locator('#toc-header')).toHaveCount(0);
  await expect(page.locator('#toc-filter-bar')).toHaveCount(0);

  const { headerPx, stripPx, clearsToolbar } = await page.evaluate(() => {
    const tabpanel = document.getElementById('toc-tabpanel')!.getBoundingClientRect();
    const list = document.getElementById('toc-list')!.getBoundingClientRect();
    const strip = document.querySelector('.right-dock-tabs')!.getBoundingClientRect();
    const toolbar = document.getElementById('toolbar')!.getBoundingClientRect();
    return {
      headerPx: Math.round(list.top - tabpanel.top),
      stripPx: Math.round(strip.height),
      clearsToolbar: strip.top >= toolbar.bottom - 1,
    };
  });

  // 3px progress bar + 28px meta row. Measured to the list, not to the first
  // .toc-item, so #toc-list's own row padding isn't counted as header chrome.
  expect(headerPx).toBe(31);
  expect(stripPx).toBe(32);
  // Both figures above are margin-independent, so they would still hold if the
  // strip lost the toolbar clearance that US-10.8 moved onto it and the whole
  // restacked header rendered behind the sticky #toolbar. Assert the clearance
  // directly — it is what makes the 63px budget real rather than arithmetic.
  expect(clearsToolbar).toBe(true);
});

// --- Item 3: reading-palette theming --------------------------------------

test('progress bar, meta row and the depth menu adopt the palette under a reading palette', async ({ page }) => {
  await openToc(page, DOC, { readability: SEPIA });
  // The depth rows only exist while the menu is open (built on each open).
  await page.locator('.right-dock-menu-btn').click();

  const { accent, muted, track, barFill, checkColor, metaColor } = await page.evaluate(() => {
    const mk = (v: string) => {
      const p = document.createElement('span');
      p.style.color = v;
      document.body.appendChild(p);
      const c = getComputedStyle(p).color;
      p.remove();
      return c;
    };
    const check = document.querySelector('.right-dock-menu-item[aria-checked="true"] .right-dock-menu-check');
    return {
      accent: mk('var(--toc-accent)'),
      muted: mk('var(--toc-muted)'),
      track: mk('var(--toc-progress-track)'),
      barFill: getComputedStyle(document.querySelector('.toc-progress-fill')!).backgroundColor,
      checkColor: check ? getComputedStyle(check).color : '',
      metaColor: getComputedStyle(document.getElementById('toc-meta')!).color,
    };
  });

  const VSCODE_BLUE = 'rgb(55, 148, 255)'; // #3794ff — the non-palette fallback
  expect(accent).not.toBe('');
  expect(accent).not.toBe(VSCODE_BLUE);
  // AC4: bar fill and the checked depth row both ride --toc-accent; the meta row
  // rides --toc-muted; and the bar's track is its own per-palette token, which
  // must resolve (an unset var would collapse the 3px bar to transparent).
  expect(barFill).toBe(accent);
  expect(checkColor).toBe(accent);
  expect(metaColor).toBe(muted);
  expect(track).not.toBe('');
  expect(track).not.toBe(VSCODE_BLUE);
});
