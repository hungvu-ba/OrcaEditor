/**
 * Bug: copy trong editor chỉ ghi text/plain (Markdown), nên dán ra công cụ rich
 * text bên ngoài (email, Word...) phơi ra cú pháp .md thô thay vì giữ format.
 * Fix: copy handler ghi thêm text/html render từ Markdown đó, còn text/plain vẫn
 * là Markdown để dán ngược vào editor convert đúng. Phải chạy trên browser engine
 * thật vì cần 'copy' event + ClipboardEvent.clipboardData thực (test/roundtrip/
 * dùng domino không dispatch event, không có clipboardData).
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('copy writes both Markdown text/plain and formatted text/html', async ({ page }) => {
  await openEditor(page, 'hello **world**');
  const content = page.locator('#content');

  // Chọn toàn bộ đoạn (gồm cả phần in đậm).
  await content.evaluate((el) => {
    const p = el.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  // Dispatch 'copy' thật với một DataTransfer thật rồi đọc lại hai định dạng.
  const clip = await content.evaluate((el) => {
    const dt = new DataTransfer();
    const evt = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(evt);
    return { plain: dt.getData('text/plain'), html: dt.getData('text/html') };
  });

  // text/plain giữ nguyên Markdown (round-trip dán lại vào editor).
  expect(clip.plain.trim()).toBe('hello **world**');
  // text/html là HTML đã format — có <strong>, không còn cú pháp ** thô.
  expect(clip.html).toMatch(/<strong>world<\/strong>/);
  expect(clip.html).not.toContain('**');
});
