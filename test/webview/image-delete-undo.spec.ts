/**
 * Bug 2 (2026-07-18 report): delete an existing image (click the image → caret
 * lands after it via main.ts's click handler → Backspace), then undo. The user
 * observes the asset file is restored but the image does NOT reappear in the
 * editor. This drives the WEBVIEW half: after the delete syncs, feed the same
 * 'update' the host sends on undo (original text carrying the image back) and
 * assert the <img> re-renders. If this passes, the webview restores content
 * correctly and the fault is host-side (undo update / asset-restore race); if it
 * fails, the re-render itself is dropping the restored image.
 *
 * The host↔webview undo round-trip needs the real VS Code host (verified
 * manually); here we post the 'update' message directly, same as undo-caret.spec.
 */
import { test, expect } from '@playwright/test';
import { openEditor, clearPosted, waitForEdit } from './_harness';

const DOC = ['Hello', '', '![pic](assets/pasted-image-1.png)', '', 'World'].join('\n');

test('deleting an image then undo (host update) restores the image element', async ({ page }) => {
  await openEditor(page, DOC);

  // Image rendered as an <img> element.
  await expect(page.locator('#content img')).toHaveCount(1);

  clearPosted(page);

  // Click the image: main.ts places a collapsed caret right AFTER the <img>.
  await page.locator('#content img').click();
  // Backspace deletes the <img> just before the caret (native contentEditable).
  await page.keyboard.press('Backspace');

  // The delete must have synced to the host with the image removed.
  const editText = await waitForEdit(page);
  expect(editText).not.toContain('pasted-image-1.png');
  await expect(page.locator('#content img')).toHaveCount(0);

  // Undo: the host re-applies the original text (image back) and sends 'update'
  // with the caret at the change site (line 3 in the source).
  await page.evaluate(
    (text) => window.postMessage({ type: 'update', text, caretLine: 3, caretCol: 0 }, '*'),
    DOC
  );
  await page.waitForFunction(() => !document.querySelector('#content')?.textContent?.includes('placeholder'));

  // The image element must be back in the editor.
  await expect(page.locator('#content img')).toHaveCount(1);
});
