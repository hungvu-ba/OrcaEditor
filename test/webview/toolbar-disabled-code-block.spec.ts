/**
 * US-4.23 — Link/Image toolbar buttons are disabled while the caret sits inside
 * a code block (design state (f)). Needs a real engine: the disabled state is
 * driven by the Selection API + selectionchange, and the no-op behavior is a
 * real click on a live button — neither is reproducible from a DOM snapshot.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

const MD = '```js\nconst x = 1;\n```\n\nAlpha paragraph.\n';

/** Collapse the caret inside the first node matching `selector`. */
async function placeCaret(page: import('@playwright/test').Page, selector: string, offset: number): Promise<void> {
  await page.locator('#content').evaluate(
    (el, args) => {
      const target = el.querySelector(args.selector)!;
      // Descend to the first text node — after highlight.js runs, a code block's
      // content is wrapped in <span class="hljs-*">, so target.firstChild is an
      // element, not the text node we want to place the caret inside.
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      const textNode = walker.nextNode() ?? target;
      const range = document.createRange();
      range.setStart(textNode, Math.min(args.offset, textNode.textContent?.length ?? 0));
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { selector, offset },
  );
}

test('Link/Image become disabled with an explanatory tooltip when caret is inside a code block', async ({ page }) => {
  await openEditor(page, MD);
  await placeCaret(page, 'pre code', 2);

  const link = page.locator('#fmt-link');
  const image = page.locator('#fmt-image');
  await expect(link).toHaveAttribute('aria-disabled', 'true');
  await expect(image).toHaveAttribute('aria-disabled', 'true');
  await expect(link).toHaveAttribute('data-tooltip', 'Link — unavailable inside a code block');
  await expect(image).toHaveAttribute('data-tooltip', 'Image — unavailable inside a code block');
  await expect(link).toHaveCSS('cursor', 'not-allowed');
});

test('clicking a disabled Link button is a no-op (the @ trigger-popup never opens)', async ({ page }) => {
  await openEditor(page, MD);
  await placeCaret(page, 'pre code', 2);
  await expect(page.locator('#fmt-link')).toHaveAttribute('aria-disabled', 'true');

  // force: Playwright treats aria-disabled="true" as not-actionable, but the
  // element is deliberately still clickable by a real user (hover/tooltip must
  // work) — the no-op is enforced by our click handler, not pointer-events.
  await page.locator('#fmt-link').click({ force: true });

  await expect(page.locator('.trigger-popup')).toHaveCount(0);
});

test('Link disables when a selection extends into a code block from outside (focus endpoint inside the pre)', async ({ page }) => {
  await openEditor(page, MD);
  await page.locator('#content').evaluate((el) => {
    const anchorNode = el.querySelector('p')!.firstChild!; // outside the code block
    const pre = el.querySelector('pre code')!;
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    const focusNode = walker.nextNode()!; // inside the code block
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.setBaseAndExtent(anchorNode, 0, focusNode, 1);
  });

  await expect(page.locator('#fmt-link')).toHaveAttribute('aria-disabled', 'true');
});

test('Link/Image re-enable and restore their tooltip when the caret leaves the code block', async ({ page }) => {
  await openEditor(page, MD);
  await placeCaret(page, 'pre code', 2);
  await expect(page.locator('#fmt-link')).toHaveAttribute('aria-disabled', 'true');

  await placeCaret(page, 'p', 0);

  const link = page.locator('#fmt-link');
  await expect(link).not.toHaveAttribute('aria-disabled', 'true');
  await expect(link).toHaveAttribute('data-tooltip', 'Insert link');
});
