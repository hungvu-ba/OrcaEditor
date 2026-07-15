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
  /**
   * US-17.6 (M4): ảnh kéo-thả từ ngoài vào — tái dùng nguyên luồng save+insert
   * của paste, chỉ khác ở NGUỒN gọi và vị trí chèn (range tại điểm thả, không
   * phải selection hiện tại lúc paste). `fillCell` = true khi điểm thả nằm
   * trong 1 ô bảng (US-17.4) → chèn `style="width:100%"` thay vì width đo
   * được, để ảnh khít theo cột thay vì theo kích thước gốc.
   */
  saveDroppedImage(blob: Blob, mime: string, range: Range | undefined, fillCell: boolean): void;
}

export function initPasteImage(
  vscode: VsCodeApi,
  ctx: { scheduleSync: () => void; dom: DomHelpers }
): PasteImageController {
  let seq = 0;
  /** Mỗi request đang chờ host lưu file: caret lúc dán + độ rộng hiển thị đo được (px, đã chia devicePixelRatio) + có chèn vào ô bảng (US-17.4, width:100%) hay không. */
  const pending = new Map<number, { range: Range | undefined; width?: number; fillCell?: boolean }>();
  /** Dấu thời gian requestSave gần nhất — chặn trùng khi cả keydown fallback lẫn 'paste' event thật cùng tìm thấy ảnh cho cùng 1 lượt dán (xem PASTE_IMAGE_DEDUPE_MS). Chỉ áp cho paste (2 đường có thể race); drop (M4) luôn có đúng 1 nguồn nên bỏ qua chặn này. */
  let lastRequestAt = 0;

  function insertImageAt(range: Range | undefined, relPath: string, width?: number, fillCell?: boolean): void {
    ctx.dom.restoreSelection(range);
    // Có width đo được → chèn kèm attribute để ảnh giữ kích thước gốc (theo CSS
    // px, đã chia devicePixelRatio cho screenshot retina) thay vì bị max-width:100%
    // kéo giãn full bề ngang cửa sổ. Ảnh to hơn cửa sổ vẫn được max-width:100%
    // thu nhỏ lại cho vừa. img có attribute ngoài src/alt/title → turndown giữ
    // nguyên HTML thô (rule htmlImgWithAttrs) nên width/style được lưu vào .md.
    // fillCell (US-17.4, thả ảnh vào ô bảng) ưu tiên hơn width đo được — ảnh
    // khít theo cột (co giãn theo cột) chứ không giữ kích thước gốc cố định.
    const sizeAttr = fillCell ? ' style="width:100%"' : width ? ` width="${width}"` : '';
    document.execCommand(
      'insertHTML',
      false,
      `<img src="${escapeAttr(encodeLinkPath(relPath))}" alt=""${sizeAttr}>`
    );
    ctx.scheduleSync();
  }

  /**
   * Đo kích thước tự nhiên của blob ảnh rồi ghi độ rộng hiển thị mong muốn vào
   * entry pending tương ứng. Chia cho devicePixelRatio: screenshot chụp trên màn
   * retina có số pixel vật lý gấp đôi kích thước "nhìn thấy", nếu để nguyên sẽ
   * tràn cửa sổ và bị max-width:100% kéo về đúng bề ngang cửa sổ (chính là hành
   * vi cần bỏ). Round-trip lưu file qua host là async nên phép đo này (cũng async)
   * gần như luôn xong trước khi notifyResult chèn ảnh; nếu chưa kịp → chèn không
   * width, ảnh vẫn hiện đúng (chỉ mất lần đầu, mở lại file vẫn không có size).
   */
  function measureWidth(requestId: number, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const probe = new Image();
    probe.onload = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(probe.naturalWidth / dpr);
      const entry = pending.get(requestId);
      if (entry && w > 0) {
        entry.width = w;
      }
      URL.revokeObjectURL(url);
    };
    probe.onerror = () => URL.revokeObjectURL(url);
    probe.src = url;
  }

  /**
   * `explicit` (US-17.6, M4 — drop): range đã biết (điểm thả) + có nằm trong
   * ô bảng hay không, bỏ qua dedupe (drop chỉ có đúng 1 nguồn gọi, không có
   * race kiểu keydown-fallback/paste event như clipboard paste ở dưới).
   */
  function requestSave(blob: Blob, mime: string, explicit?: { range: Range | undefined; fillCell: boolean }): void {
    const now = Date.now();
    if (!explicit && now - lastRequestAt < PASTE_IMAGE_DEDUPE_MS) {
      return; // Đã được đường paste kia (keydown fallback / 'paste' event thật) xử lý cho cùng lượt dán này.
    }
    lastRequestAt = now;
    const requestId = ++seq;
    pending.set(requestId, { range: explicit ? explicit.range : saveSelection(), fillCell: explicit?.fillCell });
    measureWidth(requestId, blob);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      if (!base64) {
        pending.delete(requestId);
        return;
      }
      vscode.postMessage({ type: 'pasteImage', requestId, mime, dataBase64: base64 });
    };
    reader.onerror = () => pending.delete(requestId);
    reader.readAsDataURL(blob);
  }

  function saveDroppedImage(blob: Blob, mime: string, range: Range | undefined, fillCell: boolean): void {
    requestSave(blob, mime, { range, fillCell });
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
    const entry = pending.get(requestId);
    pending.delete(requestId);
    if (relPath) {
      insertImageAt(entry?.range, relPath, entry?.width, entry?.fillCell);
    } else if (error) {
      showToast(error);
    }
  }

  return { handlePasteEvent, tryPasteImageFromClipboardApi, notifyResult, saveDroppedImage };
}
