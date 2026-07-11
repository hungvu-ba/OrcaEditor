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

  /**
   * Thay tag của block, giữ nguyên children + căn lề. Dùng execCommand
   * ('insertHTML') thay vì thao tác DOM trần (createElement/appendChild/
   * replaceWith) như trước đây — thao tác DOM trần không được trình duyệt
   * ghi vào lịch sử undo/redo gốc, nên Ctrl/Cmd+Z sau khi đổi heading/đoạn
   * văn không hoàn tác đúng từng bước (cùng lý do đã sửa ở
   * input-rules.ts, xem convertBlockToListItem). Vì nội dung được tạo lại
   * từ chuỗi HTML nên không thể khôi phục đúng offset caret cũ (node cũ bị
   * gỡ khỏi DOM) — đặt caret vào block mới thay vì cố giữ vị trí cũ.
   */
  function replaceBlockTag(block: HTMLElement, tag: string): HTMLElement {
    const align = block.getAttribute('align');
    const alignAttr = align ? ` align="${escapeAttr(align)}"` : '';
    const innerHtml = block.innerHTML;
    const range = document.createRange();
    range.selectNode(block);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('insertHTML', false, `<${tag}${alignAttr}>${innerHtml}</${tag}>`);
    const afterSel = window.getSelection();
    const anchor = afterSel?.anchorNode ? closestElement(afterSel.anchorNode) : null;
    const el = (anchor?.closest(tag) as HTMLElement | null) ?? (content.lastElementChild as HTMLElement);
    placeCaretIn(el);
    return el;
  }

  return { restoreSelection, placeCaretIn, replaceBlockTag };
}
