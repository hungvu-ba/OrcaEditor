/**
 * External file-drop targeting (HLR section 17, US-17.6): dragging a file from
 * Finder/Explorer onto #content must (a) show a visible highlight at the exact
 * spot it will land, and (b) drop at the mouse-hover point — falling back to the
 * END of the file when the point resolves no caret (empty margin below the last
 * block), instead of the stale pre-drag caret. Needs real DragEvents with a real
 * DataTransfer.files, so it lives here (test/roundtrip/ dispatches no events).
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

/** Dispatch a real DragEvent carrying one file (so dataTransfer.types includes 'Files'). */
async function dragFile(
  page: Page,
  type: 'dragover' | 'drop',
  clientX: number,
  clientY: number,
  mime: string,
  name: string
): Promise<void> {
  await page.evaluate(
    ({ type, clientX, clientY, mime, name }) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], name, { type: mime }));
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, clientX, clientY, dataTransfer: dt });
      document.getElementById('content')!.dispatchEvent(ev);
    },
    { type, clientX, clientY, mime, name }
  );
}

/** Complete the host round-trip: read the requestId the webview posted, reply with a saved path. */
async function replySaved(page: Page, msgType: 'dropFile', relativePath: string): Promise<void> {
  const handle = await page.waitForFunction((t) => {
    const posted = (window as unknown as { __posted: Array<{ type: string; requestId: number }> }).__posted;
    return posted.find((m) => m.type === t)?.requestId ?? null;
  }, msgType);
  const requestId = (await handle.jsonValue()) as number;
  await page.evaluate(
    ({ requestId, relativePath }) => window.postMessage({ type: 'dropFileResult', requestId, relativePath }, '*'),
    { requestId, relativePath }
  );
}

test('dragover with a file shows the drop caret at the hover point', async ({ page }) => {
  await openEditor(page, 'First paragraph.\n\nSecond paragraph.\n');
  const box = (await page.locator('#content p').nth(1).boundingBox())!;
  await dragFile(page, 'dragover', box.x + box.width / 2, box.y + box.height / 2, 'application/pdf', 'notes.pdf');

  await page.waitForFunction(() => {
    const c = document.querySelector('.dd-drop-caret') as HTMLElement | null;
    return !!c && getComputedStyle(c).display !== 'none';
  });
  const rect = await page.evaluate(() => {
    const r = document.querySelector('.dd-drop-caret')!.getBoundingClientRect();
    return { top: r.top, height: r.height };
  });
  // A real caret: non-zero height, sitting within the hovered paragraph's band.
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.top).toBeGreaterThanOrEqual(box.y - 4);
  expect(rect.top).toBeLessThanOrEqual(box.y + box.height + 4);
});

test('dragover a file over a table cell highlights the cell, not the caret', async ({ page }) => {
  await openEditor(page, '| A | B |\n| - | - |\n| c1 | c2 |\n');
  const box = (await page.locator('#content td').first().boundingBox())!;
  await dragFile(page, 'dragover', box.x + box.width / 2, box.y + box.height / 2, 'image/png', 'shot.png');

  await page.waitForFunction(() => !!document.querySelector('.dd-drop-target-cell'));
  await expect(page.locator('#content td.dd-drop-target-cell')).toHaveCount(1);
  const caretHidden = await page.evaluate(() => {
    const c = document.querySelector('.dd-drop-caret') as HTMLElement | null;
    return !c || getComputedStyle(c).display === 'none';
  });
  expect(caretHidden).toBe(true);
});

test('Escape mid-drag cancels: highlight clears and a following drop inserts nothing', async ({ page }) => {
  await openEditor(page, 'First paragraph.\n\nSecond paragraph.\n');
  const box = (await page.locator('#content p').nth(1).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await dragFile(page, 'dragover', cx, cy, 'application/pdf', 'notes.pdf');
  await page.waitForFunction(() => {
    const c = document.querySelector('.dd-drop-caret') as HTMLElement | null;
    return !!c && getComputedStyle(c).display !== 'none';
  });

  // Escape while dragging → caret vanishes.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const c = document.querySelector('.dd-drop-caret') as HTMLElement | null;
    return !c || getComputedStyle(c).display === 'none';
  });

  // Releasing after cancel must post nothing to the host.
  await clearPosted(page);
  await dragFile(page, 'drop', cx, cy, 'application/pdf', 'notes.pdf');
  await page.waitForTimeout(150);
  const posted = await page.evaluate(
    () => (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'dropFile').length
  );
  expect(posted).toBe(0);
});

test('dropping where no caret resolves falls back to end of file', async ({ page }) => {
  await openEditor(page, 'First paragraph.\n\nSecond paragraph.\n');
  // Force the no-caret branch (dropping into empty margin / over an atomic node).
  await page.evaluate(() => {
    (document as unknown as { caretRangeFromPoint: () => Range | null }).caretRangeFromPoint = () => null;
  });
  const box = (await page.locator('#content').boundingBox())!;
  await clearPosted(page);
  await dragFile(page, 'drop', box.x + 10, box.y + 10, 'application/pdf', 'notes.pdf');
  await replySaved(page, 'dropFile', 'assets/notes.pdf');

  const md = await waitForEdit(page);
  expect(md).toContain('[notes.pdf](assets/notes.pdf)');
  // Landed at the end, after the last block — not at the stale start-of-doc caret.
  expect(md.indexOf('[notes.pdf]')).toBeGreaterThan(md.indexOf('Second paragraph'));
});
