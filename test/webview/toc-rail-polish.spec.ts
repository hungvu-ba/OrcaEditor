/**
 * TOC Rail wireframe-alignment polish (Plan/UI/TOC Rail — UI Implementation Plan.md):
 *  1. Resize-drag lag bug — while body.toc-resizing, #toc-panel's transition must
 *     drop `width` so a live drag is 1:1 with the cursor (the open/close slide,
 *     driven by body.toc-open only, keeps its width easing).
 *  3. Reading-palette theming — under a reading-palette-* class the depth pills
 *     and the progress ring must adopt the palette accent (--rp-link), not the
 *     fixed VS Code blue.
 *  4. Empty state — "no match" shows a clickable reset link that restores all
 *     levels in place; "headless" shows a muted hint and no reset link.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';
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

// No H1 at all: default level-2 shows the H2s, but filtering to H1 hides
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

async function setDepth(page: Page, level: 1 | 2 | 3): Promise<void> {
  await page.locator(`.toc-depth-btn[data-level="${level}"]`).click();
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
  await expect(page.locator('.toc-depth-btn.active')).toHaveAttribute('data-level', '3');
});

test('headless empty state shows a hint and no reset link', async ({ page }) => {
  await openToc(page, 'Just a paragraph, no headings at all.\n\nAnother paragraph.');

  await expect(page.locator('#toc-empty')).toBeVisible();
  await expect(page.locator('.toc-empty-hint')).toBeVisible();
  await expect(page.locator('.toc-empty-reset')).toHaveCount(0);
});

test('a document with only H4+ headings shows no reset link (reset to H1–H3 would be a dead-end)', async ({ page }) => {
  // Headings exist but none are selectable (pills only reach H3), so a reset
  // could never reveal them — the message must stand alone, no dead affordance.
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

// --- Item 3: reading-palette theming --------------------------------------

test('depth pills and progress ring adopt the palette accent under a reading palette', async ({ page }) => {
  await openToc(page, DOC, { readability: SEPIA });

  const { accent, fg, btnColor, ringStroke } = await page.evaluate(() => {
    const mk = (v: string) => {
      const p = document.createElement('span');
      p.style.color = v;
      document.body.appendChild(p);
      const c = getComputedStyle(p).color;
      p.remove();
      return c;
    };
    const accent = mk('var(--toc-accent)');
    const fg = mk('var(--toc-fg)');
    const btn = document.querySelector('.toc-depth-btn.active') as HTMLElement;
    const fill = document.querySelector('#toc-progress-ring .toc-progress-fill') as SVGElement;
    return {
      accent,
      fg,
      btnColor: getComputedStyle(btn).color,
      ringStroke: fill ? getComputedStyle(fill).stroke : '',
    };
  });

  const VSCODE_BLUE = 'rgb(55, 148, 255)'; // #3794ff — the non-palette fallback
  expect(accent).not.toBe('');
  expect(accent).not.toBe(VSCODE_BLUE);
  // Borderless-filter design (US-19.24): active pill text = --toc-fg on a soft
  // accent fill; the progress ring fill re-tints to the palette accent.
  expect(btnColor).toBe(fg);
  expect(ringStroke).toBe(accent);
});
