/**
 * TOC toggle must preserve the reading position, and clicking a TOC row must not
 * leave a focus ring on it. Three behaviors a hand-built DOM snapshot can't check
 * (they need real click/focus/scroll + the body.toc-open padding reflow):
 *
 *  1. Clicking a TOC link places the caret at the heading, so closing the panel
 *     (which runs invokeAction's content.focus()) reveals THAT heading instead of
 *     scrolling the stale document-top caret back to the top.
 *  2. Opening/closing the panel reflows #content (body padding-right); the line
 *     the user was reading keeps its on-screen vertical position.
 *  3. A mouse click on a TOC row does not leave it focused (no yellow focus ring);
 *     focus moves into #content.
 *
 * reduced-motion is emulated so scrollBehavior() is instant and the padding
 * transition collapses — the anchor pin then corrects on the first frame,
 * making the assertions deterministic.
 *
 * Toggles/link-clicks are dispatched via el.click() inside page.evaluate rather
 * than Playwright's locator.click(): locator.click scrolls the page to bring the
 * (position:sticky) toolbar button "into view", a test-only scroll that would mask
 * the very position-preservation under test. A real user click carries no such scroll.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

// Long, heading-dense doc so headings sit far apart and the page is scrollable.
const DOC = Array.from({ length: 8 }, (_, i) => {
  const n = i + 1;
  const body = Array.from({ length: 4 }, (_, j) => `Body paragraph ${n}.${j + 1} lorem ipsum dolor sit amet.`).join(
    '\n\n'
  );
  return `## Section ${n}\n\n${body}`;
}).join('\n\n');

async function setup(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1200, height: 800 });
  await openEditor(page, DOC);
}

/** Toggle the panel via a genuine element click, with no locator auto-scroll. */
function toggleToc(page: Page): Promise<void> {
  return page.evaluate(() => (document.getElementById('toc-toggle') as HTMLElement).click());
}

/** Viewport top of the #content heading whose text is exactly `text`. */
function headingTop(page: Page, text: string): Promise<number> {
  return page.evaluate((t) => {
    const h = Array.from(document.querySelectorAll('#content h1,#content h2,#content h3')).find(
      (el) => (el.textContent ?? '').trim() === t
    );
    return h ? h.getBoundingClientRect().top : NaN;
  }, text);
}

test('clicking a TOC link sets the caret at the heading and closing keeps it in view (no jump to top)', async ({
  page,
}) => {
  await setup(page);
  await toggleToc(page); // open
  await expect(page.locator('#toc-panel')).toBeVisible();

  // Click a deep row so, without the fix, the stale top caret would be obvious on close.
  await page.evaluate(() => {
    const link = Array.from(document.querySelectorAll('#toc-list a')).find(
      (a) => (a.textContent ?? '').trim() === 'Section 6'
    ) as HTMLElement;
    link.click();
  });
  await page.waitForTimeout(120);

  // Bug 1: caret landed inside the clicked heading.
  const caretHeading = await page.evaluate(() => {
    const node = window.getSelection()?.anchorNode;
    const el = node instanceof HTMLElement ? node : node?.parentElement;
    return el?.closest('h1,h2,h3')?.textContent?.trim() ?? null;
  });
  expect(caretHeading).toBe('Section 6');

  // Bug 3: after the full click, focus is in #content — placeCaretIn moved it —
  // so no focus ring is left on the row.
  const active = await page.evaluate(() => document.activeElement?.id ?? '');
  expect(active).toBe('content');

  const topBefore = await headingTop(page, 'Section 6');
  const scrollBefore = await page.evaluate(() => window.scrollY);
  expect(scrollBefore).toBeGreaterThan(100); // scrolled down to Section 6

  await toggleToc(page); // close
  await page.waitForTimeout(150);

  const topAfter = await headingTop(page, 'Section 6');
  const scrollAfter = await page.evaluate(() => window.scrollY);
  // The heading stays put on screen instead of the page jumping to top.
  expect(Math.abs(topAfter - topBefore)).toBeLessThan(8);
  expect(scrollAfter).toBeGreaterThan(100);
});

test('a mouse press on a TOC row does not focus the row (no click focus ring)', async ({ page }) => {
  await setup(page);
  await toggleToc(page); // open
  await expect(page.locator('#toc-panel')).toBeVisible();

  // A real mousedown at the row's coordinates: without the mousedown
  // preventDefault the <a> would grab focus here (painting the focus ring);
  // with the fix, focus never lands on the row. Isolated on mousedown because
  // the later click's placeCaretIn would focus #content regardless.
  const box = await page.locator('#toc-list a', { hasText: 'Section 3' }).boundingBox();
  if (!box) throw new Error('TOC row not found');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const rowFocused = await page.evaluate(
    () => document.activeElement?.classList.contains('toc-item') ?? false
  );
  await page.mouse.up();
  expect(rowFocused).toBe(false);

  // Keyboard Tab still focuses a row (a11y focus-visible ring survives).
  const canKeyboardFocus = await page.evaluate(() => {
    const row = document.querySelector('#toc-list a.toc-item') as HTMLElement;
    row.focus();
    return document.activeElement === row;
  });
  expect(canKeyboardFocus).toBe(true);
});

test('toggling the TOC preserves the focused line on-screen position (open and close)', async ({ page }) => {
  await setup(page);

  // Scroll down and put the caret in a visible mid-doc block; tag that exact
  // element so we measure ITS viewport top before/after (the selection may move
  // during toggle/focus, so we must not re-derive the block from the selection).
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.evaluate(() => {
    const content = document.getElementById('content') as HTMLElement;
    const threshold = document.getElementById('toolbar')?.offsetHeight ?? 0;
    const block = (Array.from(content.children) as HTMLElement[]).find(
      (el) => el.getBoundingClientRect().bottom > threshold + 20
    )!;
    block.setAttribute('data-anchor', '1');
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    content.focus();
  });

  const anchorTop = (): Promise<number> =>
    page.evaluate(() => document.querySelector('[data-anchor="1"]')!.getBoundingClientRect().top);

  const topBefore = await anchorTop();

  await toggleToc(page); // open
  await page.waitForTimeout(150);
  const topAfterOpen = await anchorTop();
  expect(Math.abs(topAfterOpen - topBefore)).toBeLessThan(8);

  await toggleToc(page); // close
  await page.waitForTimeout(150);
  const topAfterClose = await anchorTop();
  expect(Math.abs(topAfterClose - topBefore)).toBeLessThan(8);
});
