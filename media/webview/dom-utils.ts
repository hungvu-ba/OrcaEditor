/**
 * Tiện ích DOM dùng chung giữa toolbar, table, input-rules, prompt: thao tác
 * caret/selection, escape chuỗi, icon SVG, toast nhỏ.
 */
import { TOAST_DURATION_MS } from './constants';

export function closestElement(node: Node): HTMLElement | null {
  return node instanceof HTMLElement ? node : node.parentElement;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/**
 * Mã hóa từng đoạn đường dẫn để href hợp lệ trong markdown. encodeURIComponent
 * bỏ qua ( ) nhưng ngoặc không cân bằng phá cú pháp [text](url) → mã hóa luôn.
 */
export function encodeLinkPath(p: string): string {
  return p
    .split('/')
    .map((seg) => (seg === '..' ? seg : encodeURIComponent(seg).replace(/\(/g, '%28').replace(/\)/g, '%29')))
    .join('/');
}

export function saveSelection(): Range | undefined {
  const sel = window.getSelection();
  return sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : undefined;
}

export function addCheckbox(li: HTMLLIElement | HTMLElement): void {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'task-list-item-checkbox';
  li.insertBefore(input, li.firstChild);
  li.classList.add('task-list-item');
  li.parentElement?.classList.add('contains-task-list');
}

/** Icon SVG 16px, màu theo theme qua currentColor. */
export function svgIcon(inner: string): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Toast nhỏ góc dưới phải, tự ẩn sau vài giây. */
export function showToast(message: string): void {
  let toast = document.getElementById('wysiwyg-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'wysiwyg-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimer !== undefined) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(() => toast?.classList.remove('show'), TOAST_DURATION_MS);
}

export interface DomHelpers {
  restoreSelection(range: Range | undefined): void;
  placeCaretIn(el: Element | null | undefined, selectContents?: boolean): void;
  replaceBlockTag(block: HTMLElement, tag: string): HTMLElement;
}

/**
 * Helper cần biết #content (để focus lại sau khi đặt caret/selection) — tạo
 * một lần trong main.ts rồi truyền xuống các module khác qua ctx.
 */
export function createDomHelpers(content: HTMLElement): DomHelpers {
  function restoreSelection(range: Range | undefined): void {
    if (!range) {
      return;
    }
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    content.focus();
  }

  /** Đặt caret vào element; selectContents=true chọn cả nội dung (kiểu bảng tính). */
  function placeCaretIn(el: Element | null | undefined, selectContents = false): void {
    if (!el) {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!selectContents || (el.textContent ?? '').trim() === '') {
      range.collapse(true);
    }
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    content.focus();
  }

  /** Thay tag của block, giữ nguyên children + căn lề + vị trí caret. */
  function replaceBlockTag(block: HTMLElement, tag: string): HTMLElement {
    const sel = window.getSelection();
    const saved = sel && sel.rangeCount > 0 ? { node: sel.anchorNode, offset: sel.anchorOffset } : null;
    const el = document.createElement(tag);
    const align = block.getAttribute('align');
    if (align) {
      el.setAttribute('align', align);
    }
    while (block.firstChild) {
      el.appendChild(block.firstChild);
    }
    block.replaceWith(el);
    if (saved?.node && el.contains(saved.node)) {
      const range = document.createRange();
      try {
        range.setStart(saved.node, saved.offset);
      } catch {
        range.selectNodeContents(el);
      }
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
      content.focus();
    } else {
      placeCaretIn(el);
    }
    return el;
  }

  return { restoreSelection, placeCaretIn, replaceBlockTag };
}
