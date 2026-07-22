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

/**
 * Req 21 US-21.2 — relative path from `fromUri`'s directory to `toUri` (both
 * `document.uri.toString()`-shaped absolute URIs, e.g. `file:///a/b.md`). Used
 * by trigger-at.ts's Entities scope: `EntitySuggestion.file` is an absolute
 * declaring-file uri (unlike Files-scope results, which the host already
 * relativizes server-side), so the webview relativizes it here before building
 * an href. Falls back to `toUri` unchanged when the two aren't same-origin/
 * same-scheme (nothing sane to relativize against).
 */
export function relativeLinkPath(fromUri: string, toUri: string): string {
  let fromUrl: URL;
  let toUrl: URL;
  try {
    fromUrl = new URL(fromUri);
    toUrl = new URL(toUri);
  } catch {
    return toUri;
  }
  if (fromUrl.protocol !== toUrl.protocol || fromUrl.host !== toUrl.host) {
    return toUri;
  }
  const fromParts = decodeURIComponent(fromUrl.pathname).split('/').slice(0, -1);
  const toParts = decodeURIComponent(toUrl.pathname).split('/');
  let i = 0;
  while (i < fromParts.length && i < toParts.length - 1 && fromParts[i] === toParts[i]) i++;
  const ups = fromParts.length - i;
  const rel = [...Array(ups).fill('..'), ...toParts.slice(i)];
  return rel.join('/') || toParts[toParts.length - 1];
}

/**
 * Reads a blob as a `data:` URL (resolves to '' on error). Used instead of
 * `URL.createObjectURL` (which produces a `blob:` URL) because the webview's
 * CSP `img-src` only allows `${webview.cspSource}` and `data:` — no `blob:` —
 * so any `<img>` pointed at a blob: URL silently fails to load (see provider.ts
 * `getHtml` CSP). paste-image needs the full data: URL to measure the image;
 * external-drop only needs the base64 slice below.
 */
export function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(blob);
  });
}

/** The base64 payload of a `data:...;base64,<payload>` URL (from `readAsDataUrl`). */
export function dataUrlToBase64(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
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

/**
 * Existing task-checkbox child of `li`, covering both DOM shapes this
 * codebase renders: "tight" (checkbox is a direct `<li>` child) and "loose"
 * (checkbox is nested in the `<li>`'s child `<p>` — see the `taskCheckbox`
 * rule in turndown.ts, which documents/relies on the same distinction).
 * Returns null if `li` has no checkbox in either shape. Shared by
 * `addCheckbox` and toolbar.ts's `toggleTaskItem`/`stripCheckboxFrom` so
 * "does this `<li>` already have a checkbox" is answered consistently
 * everywhere — a narrower tight-only check lets a loose item's checkbox go
 * undetected and get double-added (bug 0716 #10 follow-up).
 */
export function findTaskCheckbox(li: Element): HTMLInputElement | null {
  return (
    (li.querySelector(':scope > input[type="checkbox"]') as HTMLInputElement | null) ??
    (li.querySelector(':scope > p > input[type="checkbox"]') as HTMLInputElement | null)
  );
}

export function addCheckbox(li: HTMLLIElement | HTMLElement): void {
  if (findTaskCheckbox(li)) {
    // Already a task item (tight or loose shape) — no-op (idempotency guard against duplicate/stacked checkboxes).
    return;
  }
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
 * Warning-triangle+bang icon (Req 20 US-20.9 / Req 21 US-21.3 broken-reference
 * marker/tooltip/toolbar-badge — same glyph everywhere, per the wireframe's
 * "shared visual language"). `size` in px; color follows `currentColor`, so
 * callers set it via CSS `color` (warning tokens), never a hardcoded hex here.
 */
export function warningTriangleIcon(size: number): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex-shrink:0;">` +
    '<path d="M8 2 L15 14 H1 Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
    '<line x1="8" y1="6" x2="8" y2="9.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '<circle cx="8" cy="11.5" r="0.7" fill="currentColor"/>' +
    '</svg>'
  );
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

/**
 * Offset ký tự (tính bằng Range.toString()) từ đầu `root` tới (node,
 * nodeOffset) — null nếu node đó không nằm trong root. Dùng để "chụp" vị
 * trí caret trước khi block bị tạo lại từ chuỗi HTML (không thể giữ
 * nguyên tham chiếu node cũ), rồi suy ngược lại vị trí tương ứng ở block
 * mới bằng offset ký tự (nội dung text không đổi, chỉ đổi tag bao ngoài).
 * Top-level (không thuộc createDomHelpers's closure) — không phụ thuộc gì
 * riêng của #content, nên list-ops.ts tái dùng được không cần duplicate.
 */
export function getOffsetWithin(root: Element, node: Node, nodeOffset: number): number | null {
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

/**
 * Text from the start of `block` up to `range`'s start (i.e. everything left of
 * the caret within `block`). Shared reader for adjacency checks — e.g. the paste
 * smart-gap in main.ts needs the single char immediately before the caret
 * (`textBeforeCaret(block, range).slice(-1)`). Consumed by trigger-at/slash and
 * main.ts; input-rules.ts keeps its own `(block)` variant that resolves the
 * selection internally (different signature).
 */
export function textBeforeCaret(block: Element, range: Range): string {
  const probe = document.createRange();
  probe.selectNodeContents(block);
  try {
    probe.setEnd(range.startContainer, range.startOffset);
  } catch {
    return '';
  }
  return probe.toString();
}

/**
 * Mirror of `textBeforeCaret`: text from `range`'s start to the end of `block`
 * (everything right of the caret within `block`). Used to read the char
 * immediately after the caret (`textAfterCaret(block, range).slice(0, 1)`).
 */
export function textAfterCaret(block: Element, range: Range): string {
  const probe = document.createRange();
  probe.selectNodeContents(block);
  try {
    probe.setStart(range.startContainer, range.startOffset);
  } catch {
    return '';
  }
  return probe.toString();
}

/**
 * Tạo một <p><br></p> rỗng — "chỗ thoát" caret / block trống mặc định, dùng ở
 * nhiều nơi (chèn/xoá bảng, input rule hr/fence, đảm bảo có <p> cuối tài liệu).
 * Rule 'emptyParagraph' của turndown bỏ mọi <p> rỗng khi lưu nên KHÔNG đổi Markdown.
 */
export function emptyParagraph(): HTMLParagraphElement {
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  return p;
}

/**
 * Tạo phần tử với className + text tuỳ chọn — gom cụm createElement + gán
 * className (+ textContent) lặp lại khi dựng DOM popover/dialog. `text` chỉ set
 * khi được truyền (undefined ≠ ''), giữ nguyên hành vi từng chỗ gọi cũ.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

export interface DomHelpers {
  restoreSelection(range: Range | undefined): void;
  placeCaretIn(el: Element | null | undefined, selectContents?: boolean): void;
  placeCaretAfter(el: Element): void;
  /** Đặt caret/selection theo offset ký tự (Range.toString()) tính từ đầu `el`. Collapsed khi start === end. */
  placeCaretAtOffsets(el: Element, start: number, end: number): void;
  replaceBlockTag(block: HTMLElement, tag: string): HTMLElement;
  wrapInBlockquote(block: HTMLElement): HTMLElement;
}

/**
 * Helper cần biết #content (để focus lại sau khi đặt caret/selection) — tạo
 * một lần trong main.ts rồi truyền xuống các module khác qua ctx.
 */
export function createDomHelpers(content: HTMLElement): DomHelpers {
  /** Áp một Range làm vùng chọn hiện tại rồi focus lại #content — phần đuôi chung của mọi helper đặt caret/selection bên dưới. */
  function applyRange(range: Range): void {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    content.focus();
  }

  function restoreSelection(range: Range | undefined): void {
    if (!range) {
      return;
    }
    applyRange(range);
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
    applyRange(range);
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
    applyRange(range);
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
    applyRange(range);
  }

  /**
   * Phần tử vừa được chèn vào chỗ `block` cũ từng đứng (nay qua Range.insertNode
   * trong replaceBlockTag/wrapInBlockquote — HLR 22 Phase 2.5/2.6; trước kia
   * execCommand('insertHTML')) — suy ra bằng VỊ TRÍ DOM (previousElementSibling
   * đã lưu từ trước khi block bị thay) thay vì đoán qua window.getSelection() sau
   * khi chèn: Chrome không phải lúc nào cũng đặt selection bên trong phần tử vừa chèn
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
   * Thay tag của block, giữ nguyên children + căn lề (HLR 22 Phase 2.5).
   *
   * Dùng MỘT cơ chế cho MỌI chiều: Range.deleteContents() + Range.insertNode()
   * trên fragment dựng từ <template> — KHÔNG qua execCommand('insertHTML') hay
   * execCommand('formatBlock'). Cả hai verb native đó đều có bug đã kiểm chứng
   * thủ công cho một số chiều đổi tag:
   *   - insertHTML (ReplaceSelectionCommand) khi block NGUỒN là heading: (1)
   *     đích 'p' → Chrome bỏ qua HTML chèn, giữ tag heading cũ và merge <p>
   *     liền sau vào (bug "bấm lần 2 không revert về normal text"); (2) đích
   *     heading khác → style heading cũ rò rỉ sang block liền sau.
   *   - formatBlock khi bấm lặp trên heading → heading lồng heading (h1 trong
   *     h1, font-size phình dần).
   * Chèn Range trực tiếp không đi qua ReplaceSelectionCommand nên né sạch cả
   * ba — cùng lý do commitListOpDirect (list-ops.ts) né bug outdent. Đánh đổi
   * (chấp nhận, như commitListOpDirect/applyBlockMove): thao tác không tự nằm
   * trên native undo stack, nhưng Ctrl+Z/Y ở extension này đều uỷ cho
   * TextDocument nên không phải hồi quy.
   *
   * Vì node cũ bị gỡ khỏi DOM (mất tham chiếu Range cũ) — lưu vị trí/vùng chọn
   * bằng offset ký tự trong block CŨ (getOffsetWithin) rồi khôi phục trong
   * phần tử MỚI (placeCaretAtOffsets); nội dung text không đổi nên offset ánh
   * xạ 1-1. Chỉ mất caret khi không có selection → đặt về đầu block mới.
   */
  function replaceBlockTag(block: HTMLElement, tag: string): HTMLElement {
    const align = block.getAttribute('align');
    const parent = block.parentElement;
    const prevElement = block.previousElementSibling;
    // Phần tử vừa được chèn (suy theo vị trí DOM), fallback về block cuối #content.
    const resolveInserted = (): HTMLElement =>
      (parent && findInsertedElement(parent, prevElement)) ?? (content.lastElementChild as HTMLElement);

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
    range.deleteContents();
    const template = document.createElement('template');
    template.innerHTML = `<${tag}${alignAttr}>${innerHtml}</${tag}>`;
    range.insertNode(template.content);

    const el = resolveInserted();

    if (startOffset !== null && endOffset !== null) {
      placeCaretAtOffsets(el, startOffset, endOffset);
    } else {
      placeCaretIn(el);
    }
    content.focus();
    return el;
  }

  /**
   * Bọc `block` (p/heading top-level) vào một <blockquote> MỚI, giữ nguyên block
   * bên trong — <blockquote><p>…</p></blockquote>, đúng shape canonical mà
   * markdown-it dựng lại từ "> …" (HLR 22 Phase 2.6, thay cho
   * execCommand('formatBlock','blockquote') vốn wrap qua ReplaceSelectionCommand
   * và lồng quote khi bấm lặp — caller đã tự chặn lặp bằng closest('blockquote')).
   * Cùng cơ chế direct-Range insert + khôi phục caret theo offset ký tự như
   * replaceBlockTag ngay trên (nội dung text không đổi nên offset trong block cũ
   * ánh xạ 1-1 vào blockquote mới); cùng đánh đổi no-native-undo đã chấp nhận.
   */
  function wrapInBlockquote(block: HTMLElement): HTMLElement {
    const parent = block.parentElement;
    const prevElement = block.previousElementSibling;

    const selBefore = window.getSelection();
    let startOffset: number | null = null;
    let endOffset: number | null = null;
    if (selBefore && selBefore.rangeCount > 0) {
      const r = selBefore.getRangeAt(0);
      startOffset = getOffsetWithin(block, r.startContainer, r.startOffset);
      endOffset = selBefore.isCollapsed ? startOffset : getOffsetWithin(block, r.endContainer, r.endOffset);
    }

    const wrappedHtml = `<blockquote>${block.outerHTML}</blockquote>`;
    const range = document.createRange();
    range.selectNode(block);
    range.deleteContents();
    const template = document.createElement('template');
    template.innerHTML = wrappedHtml;
    range.insertNode(template.content);

    const el =
      ((parent ? findInsertedElement(parent, prevElement) : null) as HTMLElement | null) ??
      (content.lastElementChild as HTMLElement);

    // Empty source block (e.g. `>` input rule fired on an empty paragraph): the
    // wrapped inner block has no text node for locateOffset to descend into, so
    // an offset-based caret resolves to the <blockquote> boundary (blockquote,0)
    // and the next keystroke escapes into #content beside the quote (leaking the
    // typed text out of the blockquote). Place the caret INSIDE the inner block,
    // adding a <br> placeholder first so the empty block is a valid caret host.
    const inner = (el?.firstElementChild as HTMLElement | null) ?? el;
    if (inner && (inner.textContent ?? '') === '') {
      if (!inner.firstChild) {
        inner.appendChild(document.createElement('br'));
      }
      placeCaretIn(inner);
    } else if (startOffset !== null && endOffset !== null) {
      placeCaretAtOffsets(el, startOffset, endOffset);
    } else {
      placeCaretIn(el);
    }
    content.focus();
    return el;
  }

  return { restoreSelection, placeCaretIn, placeCaretAfter, placeCaretAtOffsets, replaceBlockTag, wrapInBlockquote };
}
