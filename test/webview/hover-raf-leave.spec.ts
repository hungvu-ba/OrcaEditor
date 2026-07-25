/**
 * Regression: rAF-coalesced hover (perf P3/P4) must not re-show a handle after
 * the cursor has left #content. The coalescing stashes the latest clientX/Y and
 * runs the hover body in a requestAnimationFrame. If a frame is armed by the last
 * inside-`mousemove` and then `mouseleave` clears the handle, the still-pending
 * frame used to fire afterwards with the stale inside coordinates and re-display
 * the handle at its old spot ("stuck handle"). The fix cancels the pending frame
 * in each `mouseleave`, so leave is the authority on exit (as it was before the
 * coalescing). The synchronous mousemove→mouseleave dispatch below reproduces the
 * exact ordering — two `page.mouse.move` calls can't, since a frame elapses
 * between them and the first rAF would already have run. (Plan/WEBVIEW_TEST.md)
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

const BLOCK_HANDLE_SELECTOR =
  '.dd-handle:not(.dd-li-handle):not(.dd-row-handle):not(.dd-col-handle):not(.dd-table-handle)';

const DOC = `# Heading

Alpha paragraph.

| Col A | Col B |
| --- | --- |
| a1 | b1 |
`;

/** Arm a coalesced hover frame from an inside point, then immediately leave
 * #content — both in one JS turn, before the rAF frame can run. */
async function armThenLeave(page: import('@playwright/test').Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate((el) => {
    const content = document.getElementById('content');
    if (!content) {
      throw new Error('#content missing');
    }
    const r = el.getBoundingClientRect();
    content.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        bubbles: true,
      }),
    );
    content.dispatchEvent(
      new MouseEvent('mouseleave', {
        clientX: 1,
        clientY: 1,
        relatedTarget: document.body,
      }),
    );
  });
  // Let the (possibly still-pending) frame run — two frames to be safe.
  await page.evaluate(
    () => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))),
  );
}

test('P3: block drag handle does not re-appear after leaving #content (stuck-handle regression)', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const alpha = page.locator('p', { hasText: 'Alpha paragraph.' });
  const box = await alpha.boundingBox();
  if (!box) {
    throw new Error('paragraph has no bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(BLOCK_HANDLE_SELECTOR)).toHaveCSS('display', 'flex');

  await armThenLeave(page, 'p:has-text("Alpha paragraph.")');

  await expect(page.locator(BLOCK_HANDLE_SELECTOR)).toHaveCSS('display', 'none');
});

test('P4: table row handle does not re-appear after leaving #content (stuck-handle regression)', async ({
  page,
}) => {
  await openEditor(page, DOC);
  const cell = page.locator('td', { hasText: 'a1' });
  const box = await cell.boundingBox();
  if (!box) {
    throw new Error('cell has no bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.dd-row-handle')).toHaveCSS('display', 'flex');

  await armThenLeave(page, 'td:has-text("a1")');

  await expect(page.locator('.dd-row-handle')).toHaveCSS('display', 'none');
});
