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
  placeCaretAfter(el: Element): void;
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
   * Đặt caret ngay SAU el (không chọn nội dung el) — dùng khi click vào ảnh:
   * <img> là phần tử inline không có vị trí caret "bên trong" hợp lý, nên đặt
   * caret bên phải nó để người dùng Enter xuống dòng ngay được, thay vì trình
   * duyệt để nguyên trạng thái "chọn ảnh như object" (không gõ/Enter được).
   */
  function placeCaretAfter(el: Element): void {
    const range = document.createRange();
    range.setStartAfter(el);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    content.focus();
  }

  /**
   * Offset ký tự (tính bằng Range.toString()) từ đầu `root` tới (node,
   * nodeOffset) — null nếu node đó không nằm trong root. Dùng để "chụp" vị
   * trí caret trước khi block bị tạo lại từ chuỗi HTML (không thể giữ
   * nguyên tham chiếu node cũ), rồi suy ngược lại vị trí tương ứng ở block
   * mới bằng offset ký tự (nội dung text không đổi, chỉ đổi tag bao ngoài).
   */
  function getOffsetWithin(root: Element, node: Node, nodeOffset: number): number | null {
    if (!root.contains(node)) {
      return null;
    }
    const probe = document.createRange();
    probe.selectNodeContents(root);
    try {
      probe.setEnd(node, nodeOffset);
    } catch {
      return null;
    }
    return probe.toString().length;
  }

  /** Tìm (text node, offset trong node đó) ứng với offset ký tự tính từ đầu `root`. */
  function locateOffset(root: Element, offset: number): { node: Node; offset: number } {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let lastText: Text | null = null;
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      lastText = node;
      if (remaining <= node.data.length) {
        return { node, offset: remaining };
      }
      remaining -= node.data.length;
    }
    return lastText ? { node: lastText, offset: lastText.data.length } : { node: root, offset: 0 };
  }

  /** Đặt selection trong `el` theo offset ký tự (từ getOffsetWithin) — khôi phục đúng vị trí/vùng chọn cũ. */
  function placeCaretAtOffsets(el: Element, start: number, end: number): void {
    const startPos = locateOffset(el, start);
    const endPos = locateOffset(el, end);
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    content.focus();
  }

  /**
   * Phần tử vừa được execCommand('insertHTML') chèn vào chỗ `block` cũ từng
   * đứng — suy ra bằng VỊ TRÍ DOM (previousElementSibling đã lưu từ trước khi
   * block bị thay) thay vì đoán qua window.getSelection() sau insertHTML:
   * Chrome không phải lúc nào cũng đặt selection bên trong phần tử vừa chèn
   * như kỳ vọng, khiến việc đoán chọn nhầm phần tử (từng fallback về
   * content.lastElementChild — block cuối tài liệu, không liên quan).
   * Dùng previousElementSibling/nextElementSibling (nhảy thẳng qua text
   * node) chứ không phải previousSibling/nextSibling thô: execCommand
   * ('insertHTML') có thể tự dọn/gộp các text node khoảng trắng ("\n"
   * markdown-it để lại xen giữa block) quanh vị trí chèn — đã kiểm chứng
   * thủ công text node "\n" liền sau `block` bị xoá mất sau insertHTML,
   * khiến việc dò qua nextSibling (node thô) chọn sai hẳn phần tử.
   * previousElementSibling là Element nên không bị gộp/xoá kiểu đó.
   */
  function findInsertedElement(parent: Element, prevElement: Element | null): HTMLElement | null {
    return (prevElement ? prevElement.nextElementSibling : parent.firstElementChild) as HTMLElement | null;
  }

  /**
   * Thay tag của block, giữ nguyên children + căn lề.
   *
   * Khi block NGUỒN đang là heading (h1-h6), dùng execCommand('formatBlock')
   * thay vì insertHTML — đã kiểm chứng thủ công 2 bug của insertHTML riêng
   * cho trường hợp này: (1) đích là 'p' → Chrome bỏ qua hoàn toàn HTML được
   * chèn, giữ nguyên tag heading cũ và merge nốt nội dung <p> liền sau vào
   * trong đó (nguyên nhân chính của bug "bấm lần 2 không revert về normal
   * text"); (2) đích là heading khác → style heading cũ "rò rỉ" sang block
   * liền sau (nó bị gắn thành heading dù HTML chèn vào là gì). formatBlock
   * không dính cả hai và tự giữ đúng caret/vùng chọn (kể cả xuyên qua
   * formatting lồng như bold) — không cần khôi phục offset thủ công. Chỉ mất
   * thuộc tính align nên set lại sau.
   *
   * Khi block nguồn KHÔNG phải heading (vd <p> → h1, xem applySpaceInputRule/
   * formatHeading), tiếp tục dùng execCommand('insertHTML') như cũ — đã kiểm
   * chứng hoạt động đúng cho chiều này. Lý do không dùng formatBlock cho cả
   * hai chiều: Chrome có bug tạo heading lồng nhau khi bấm lặp lại
   * formatBlock('h1') trên một heading (h1 trong h1 → font-size phình dần),
   * xem lịch sử — insertHTML tránh được bug đó cho chiều tạo heading mới.
   * Vì nội dung được tạo lại từ chuỗi HTML nên node cũ bị gỡ khỏi DOM (không
   * giữ được tham chiếu Range cũ) — khôi phục vị trí/vùng chọn bằng offset ký
   * tự (xem getOffsetWithin/placeCaretAtOffsets) thay vì luôn đặt caret về
   * đầu block như trước đây.
   */
  function replaceBlockTag(block: HTMLElement, tag: string): HTMLElement {
    const align = block.getAttribute('align');
    const parent = block.parentElement;
    const prevElement = block.previousElementSibling;

    if (/^H[1-6]$/.test(block.tagName)) {
      document.execCommand('formatBlock', false, tag);
      const el = (parent && findInsertedElement(parent, prevElement)) ?? (content.lastElementChild as HTMLElement);
      if (align) {
        el.setAttribute('align', align);
      }
      content.focus();
      return el;
    }

    const alignAttr = align ? ` align="${escapeAttr(align)}"` : '';
    const innerHtml = block.innerHTML;

    const selBefore = window.getSelection();
    let startOffset: number | null = null;
    let endOffset: number | null = null;
    if (selBefore && selBefore.rangeCount > 0) {
      const r = selBefore.getRangeAt(0);
      startOffset = getOffsetWithin(block, r.startContainer, r.startOffset);
      endOffset = selBefore.isCollapsed ? startOffset : getOffsetWithin(block, r.endContainer, r.endOffset);
    }

    const range = document.createRange();
    range.selectNode(block);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('insertHTML', false, `<${tag}${alignAttr}>${innerHtml}</${tag}>`);

    const el = (parent && findInsertedElement(parent, prevElement)) ?? (content.lastElementChild as HTMLElement);

    if (startOffset !== null && endOffset !== null) {
      placeCaretAtOffsets(el, startOffset, endOffset);
    } else {
      placeCaretIn(el);
    }
    return el;
  }

  return { restoreSelection, placeCaretIn, placeCaretAfter, replaceBlockTag };
}
