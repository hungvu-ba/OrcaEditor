/**
 * window.prompt không hoạt động trong webview — popup nhỏ tự vẽ, dùng cho
 * "Chèn liên kết"/"Chèn ảnh" của toolbar.
 *
 * opts.fileSearchQuery bật chế độ gợi ý file trong workspace: tìm ngay theo
 * text được select (nếu có), gõ trong ô nhập thì tìm lại theo từ mới
 * (debounce). Chọn gợi ý (click hoặc ↑↓ + Enter) → trả về đường dẫn tương
 * đối đã mã hóa, kèm tên file làm displayText khi không có selection.
 */
import { el, encodeLinkPath, makeDraggable, saveSelection, type DomHelpers } from './dom-utils';
import type { VsCodeApi } from './vscode-api';
import { FILE_SEARCH_DEBOUNCE_MS } from './constants';

export interface FileSuggestion {
  path: string;
  name: string;
  dir: string;
}

export interface PromptController {
  promptInput(
    label: string,
    placeholder: string,
    cb: (value: string | undefined, displayText?: string) => void,
    opts?: { fileSearchQuery?: string }
  ): void;
  /** Gọi từ message handler của main.ts khi nhận 'fileSearchResult' từ extension. */
  notifyFileSearchResult(requestId: number, files: FileSuggestion[]): void;
}

export function initPrompt(vscode: VsCodeApi, dom: DomHelpers): PromptController {
  let fileSearchHandler: ((requestId: number, files: FileSuggestion[]) => void) | undefined;

  function promptInput(
    label: string,
    placeholder: string,
    cb: (value: string | undefined, displayText?: string) => void,
    opts?: { fileSearchQuery?: string }
  ): void {
    const overlay = el('div', 'prompt-overlay');
    const box = el('div', 'prompt-box');
    // Kéo box đi chỗ khác để lộ nội dung phía sau nó đang bị che (vd 1 URL
    // nằm ngay dưới popup) — bug report 2026-07-14 (mục 6): trước đó chỉ kéo
    // được từ 1 thanh handle mỏng ở mép trên, nay bấm được ở bất kỳ đâu trên
    // box (trừ input/nút — `DRAG_IGNORE_SELECTOR` trong dom-utils.ts).
    makeDraggable(box);
    const lbl = el('label', undefined, label);
    const input = el('input');
    input.type = 'text';
    input.placeholder = placeholder;
    const buttons = el('div', 'prompt-buttons');
    const ok = el('button', undefined, 'OK');
    const cancel = el('button', undefined, 'Cancel');
    buttons.append(cancel, ok);
    box.append(lbl, input, buttons);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // --- Gợi ý file trong dự án ---
    let suggestions: FileSuggestion[] = [];
    let activeIndex = -1;
    let searchSeq = 0;
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    const list = el('div', 'prompt-suggestions');
    list.style.display = 'none';
    // Cả khu vực gợi ý file (không chỉ mỗi item) là vùng "không kéo" — box giờ
    // kéo được từ bất kỳ đâu (xem makeDraggable ở trên), nhưng bấm vào đây
    // phải chọn gợi ý, không được bắt đầu kéo box.
    list.setAttribute('data-no-drag', 'true');

    const renderSuggestions = (): void => {
      list.textContent = '';
      list.style.display = suggestions.length ? '' : 'none';
      suggestions.forEach((f, i) => {
        const item = el('div', 'prompt-suggestion' + (i === activeIndex ? ' active' : ''));
        const name = el('span', 'prompt-suggestion-name', f.name);
        const dir = el('span', 'prompt-suggestion-dir', f.dir);
        item.append(name, dir);
        // mousedown + preventDefault: không cướp focus khỏi ô nhập
        item.addEventListener('mousedown', (e) => e.preventDefault());
        item.addEventListener('click', () => close(encodeLinkPath(f.path), f.name));
        list.appendChild(item);
      });
    };

    const requestSearch = (query: string): void => {
      const q = query.trim();
      // Có scheme (https:, mailto:...) → người dùng đang nhập URL, không tìm file
      if (!q || /^[a-z][a-z0-9+.-]*:/i.test(q)) {
        suggestions = [];
        activeIndex = -1;
        renderSuggestions();
        return;
      }
      vscode.postMessage({ type: 'searchFiles', query: q, requestId: ++searchSeq });
    };

    if (opts) {
      box.insertBefore(list, buttons);
      fileSearchHandler = (requestId, files) => {
        if (requestId !== searchSeq) {
          return; // kết quả của lần tìm cũ
        }
        suggestions = files;
        activeIndex = -1;
        renderSuggestions();
      };
      if (opts.fileSearchQuery) {
        requestSearch(opts.fileSearchQuery);
      }
      input.addEventListener('input', () => {
        if (searchTimer !== undefined) {
          clearTimeout(searchTimer);
        }
        searchTimer = setTimeout(() => requestSearch(input.value), FILE_SEARCH_DEBOUNCE_MS);
      });
    }

    const savedSel = saveSelection();
    const close = (value: string | undefined, displayText?: string) => {
      if (searchTimer !== undefined) {
        clearTimeout(searchTimer);
      }
      fileSearchHandler = undefined;
      overlay.remove();
      dom.restoreSelection(savedSel);
      cb(value, displayText);
    };
    ok.addEventListener('click', () => close(input.value.trim() || undefined));
    cancel.addEventListener('click', () => close(undefined));
    // Bấm ra ngoài box (lên nền overlay) → coi như Hủy.
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) {
        close(undefined);
      }
    });
    input.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length > 0) {
        e.preventDefault();
        activeIndex =
          e.key === 'ArrowDown'
            ? (activeIndex + 1) % suggestions.length
            : (activeIndex - 1 + suggestions.length) % suggestions.length;
        renderSuggestions();
      } else if (e.key === 'Enter') {
        const picked = activeIndex >= 0 ? suggestions[activeIndex] : undefined;
        if (picked) {
          close(encodeLinkPath(picked.path), picked.name);
        } else {
          close(input.value.trim() || undefined);
        }
      } else if (e.key === 'Escape') {
        close(undefined);
      }
    });
    input.focus();
  }

  function notifyFileSearchResult(requestId: number, files: FileSuggestion[]): void {
    fileSearchHandler?.(requestId, files);
  }

  return { promptInput, notifyFileSearchResult };
}
