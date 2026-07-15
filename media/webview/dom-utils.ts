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

/**
 * true nếu chuỗi có dạng URL tuyệt đối (có scheme, vd "https://", "mailto:") —
 * dùng để KHÔNG áp encodeLinkPath lên URL (sẽ phá "://" và query string
 * "?a=1&b=2"): chỉ path tương đối trong workspace mới cần/được encode.
 */
export function isAbsoluteUrl(s: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s);
}

export function saveSelection(): Range | undefined {
  const sel = window.getSelection();
  return sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : undefined;
}

/**
 * US-19.7: người dùng bật "reduce motion" ở OS → mọi cuộn bằng JS phải nhảy
 * thẳng thay vì animate mượt (bổ trợ cho khối CSS `prefers-reduced-motion`,
 * vốn chỉ tắt được transition/animation/`scroll-behavior` khai báo trong CSS,
 * không chạm tới scrollIntoView/scrollTo có behavior:'smooth' đặt trong JS).
 */
export function scrollBehavior(): ScrollBehavior {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth';
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

/**
 * Phần tử nào trong `target` KHÔNG bắt đầu kéo khi mousedown lên nó — input/
 * button/link cần giữ hành vi click/gõ bình thường, `[data-no-drag]` là cửa
 * thoát chung cho các vùng tương tác khác (vd danh sách gợi ý file trong
 * `.prompt-box`) mà dom-utils.ts không biết tên class cụ thể của caller.
 */
const DRAG_IGNORE_SELECTOR = 'input, textarea, select, button, a, [contenteditable="true"], [data-no-drag]';

/**
 * Cho phép kéo (drag) `target` bằng mousedown ở BẤT KỲ đâu trong `target`,
 * trừ các phần tử tương tác (`DRAG_IGNORE_SELECTOR`) — bug report 2026-07-14
 * (test/2026-07-13/bug.md, mục 6): trước đó chỉ kéo được từ 1 thanh handle
 * mỏng (`.prompt-drag-handle`, US-17.2), nay mở rộng ra cả viền/thân box.
 * `target` chuyển từ vị trí do layout quyết định (vd flexbox căn giữa) sang
 * `position: fixed` với toạ độ tự do ngay ở lần kéo đầu tiên, giữ nguyên vị
 * trí hiện tại lúc đó (không giật chỗ). Vị trí luôn bị clamp trong viewport,
 * tính lại kích thước `target` ở MỖI lần di chuyển (không chỉ lúc bắt đầu) vì
 * nội dung bên trong có thể đổi cao/rộng giữa chừng (vd danh sách gợi ý file
 * hiện/ẩn). Hàm thuần, không phụ thuộc gì riêng của `.prompt-box` — dùng
 * chung được cho mọi popup/popover kéo-thả khác (US-17.1).
 *
 * Không cần cờ chặn riêng cho "click ra ngoài đóng popup" trong lúc kéo: thao
 * tác kéo luôn bắt đầu bằng mousedown TRÊN target (không phải overlay bao
 * ngoài), nên target event của sự kiện đó không bao giờ là chính overlay —
 * listener đóng popup ở nơi gọi (kiểm tra `e.target === overlay`) tự nhiên
 * không khớp.
 */
export function makeDraggable(target: HTMLElement): void {
  target.addEventListener('mousedown', (e) => {
    if (e.button !== 0) {
      return;
    }
    if ((e.target as HTMLElement).closest(DRAG_IGNORE_SELECTOR)) {
      return;
    }
    e.preventDefault();
    const rect = target.getBoundingClientRect();
    target.style.position = 'fixed';
    target.style.margin = '0';
    target.style.left = `${rect.left}px`;
    target.style.top = `${rect.top}px`;
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    target.classList.add('dragging');

    const onMove = (ev: MouseEvent): void => {
      const size = target.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - size.width);
      const maxTop = Math.max(0, window.innerHeight - size.height);
      target.style.left = `${Math.min(Math.max(0, startLeft + (ev.clientX - startX)), maxLeft)}px`;
      target.style.top = `${Math.min(Math.max(0, startTop + (ev.clientY - startY)), maxTop)}px`;
    };
    const onUp = (): void => {
      target.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/**
 * Định vị `el` (đã `position: fixed`, thường vừa append vào `document.body`)
 * gần `anchorRect` mà KHÔNG đè lên nó — ưu tiên bên dưới anchor, lật lên trên
 * nếu không đủ chỗ; clamp ngang/dọc trong viewport. Cùng pattern anchor-popup
 * đã dùng ở `cross-file-search.ts` (`positionPopover`/`positionBubble`) nhưng
 * viết generic để tái dùng cho popup khác (vd `.md-math-edit-popover`) mà
 * không phải chép lại logic clamp.
 */
export function positionNear(el: HTMLElement, anchorRect: DOMRect, gap = 8): void {
  const elRect = el.getBoundingClientRect();
  const hasRoomBelow = anchorRect.bottom + gap + elRect.height <= window.innerHeight;
  const top = hasRoomBelow ? anchorRect.bottom + gap : anchorRect.top - gap - elRect.height;
  const left = Math.min(Math.max(4, anchorRect.left), window.innerWidth - elRect.width - 4);
  el.style.position = 'fixed';
  el.style.top = `${Math.max(4, Math.min(top, window.innerHeight - elRect.height - 4))}px`;
  el.style.left = `${left}px`;
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
