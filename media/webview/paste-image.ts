/**
 * Dán ảnh từ clipboard: đọc Blob ảnh (từ 'paste' event, hoặc fallback async
 * Clipboard API — cùng lý do iframe lồng nhau không luôn bắn 'paste' kèm
 * clipboardData khi gõ phím tắt, xem pasteFromClipboardApi trong main.ts),
 * gửi base64 lên host để lưu thành file thật (case 'pasteImage' trong
 * provider.ts), rồi chèn <img> tại đúng vị trí caret lúc dán bằng đường dẫn
 * tương đối host trả về. Round-trip qua host là async nên phải saveSelection()
 * ngay lúc dán và restoreSelection() trước khi chèn — caret có thể đã đổi chỗ
 * trong lúc chờ (xem pattern tương tự trong prompt.ts cho tìm file async).
 */
import { encodeLinkPath, escapeAttr, saveSelection, showToast, type DomHelpers } from './dom-utils';
import type { VsCodeApi } from './vscode-api';
import { PASTE_IMAGE_DEDUPE_MS } from './constants';

export interface PasteImageController {
  /** true nếu clipboard event chứa ảnh (đã nhận xử lý — caller không cần fallback text nữa). */
  handlePasteEvent(e: ClipboardEvent): boolean;
  /** Fallback Cmd/Ctrl+V qua async Clipboard API. Trả false nếu clipboard không có ảnh. */
  tryPasteImageFromClipboardApi(): Promise<boolean>;
  /** Gọi từ message handler của main.ts khi nhận 'pasteImageResult' từ host. */
  notifyResult(requestId: number, relativePath?: string, error?: string): void;
}

export function initPasteImage(
  vscode: VsCodeApi,
  ctx: { scheduleSync: () => void; dom: DomHelpers }
): PasteImageController {
  let seq = 0;
  const pendingRanges = new Map<number, Range | undefined>();
  /** Dấu thời gian requestSave gần nhất — chặn trùng khi cả keydown fallback lẫn 'paste' event thật cùng tìm thấy ảnh cho cùng 1 lượt dán (xem PASTE_IMAGE_DEDUPE_MS). */
  let lastRequestAt = 0;

  function insertImageAt(range: Range | undefined, relPath: string): void {
    ctx.dom.restoreSelection(range);
    document.execCommand('insertHTML', false, `<img src="${escapeAttr(encodeLinkPath(relPath))}" alt="">`);
    ctx.scheduleSync();
  }

  function requestSave(blob: Blob, mime: string): void {
    const now = Date.now();
    if (now - lastRequestAt < PASTE_IMAGE_DEDUPE_MS) {
      return; // Đã được đường paste kia (keydown fallback / 'paste' event thật) xử lý cho cùng lượt dán này.
    }
    lastRequestAt = now;
    const requestId = ++seq;
    pendingRanges.set(requestId, saveSelection());
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      if (!base64) {
        pendingRanges.delete(requestId);
        return;
      }
      vscode.postMessage({ type: 'pasteImage', requestId, mime, dataBase64: base64 });
    };
    reader.onerror = () => pendingRanges.delete(requestId);
    reader.readAsDataURL(blob);
  }

  function findImageItem(items: DataTransferItemList | undefined): DataTransferItem | undefined {
    if (!items) {
      return undefined;
    }
    return Array.from(items).find((item) => item.kind === 'file' && item.type.startsWith('image/'));
  }

  function handlePasteEvent(e: ClipboardEvent): boolean {
    const item = findImageItem(e.clipboardData?.items);
    const blob = item?.getAsFile();
    if (!item || !blob) {
      return false;
    }
    requestSave(blob, item.type);
    return true;
  }

  async function tryPasteImageFromClipboardApi(): Promise<boolean> {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith('image/'));
        if (imageType) {
          requestSave(await item.getType(imageType), imageType);
          return true;
        }
      }
    } catch {
      // Không có quyền clipboard-read, hoặc clipboard không có ảnh — im lặng bỏ qua.
    }
    return false;
  }

  function notifyResult(requestId: number, relPath?: string, error?: string): void {
    const range = pendingRanges.get(requestId);
    pendingRanges.delete(requestId);
    if (relPath) {
      insertImageAt(range, relPath);
    } else if (error) {
      showToast(error);
    }
  }

  return { handlePasteEvent, tryPasteImageFromClipboardApi, notifyResult };
}
