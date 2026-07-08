/**
 * Markdown input rules: gõ tiền tố markdown ở đầu một đoạn văn rồi Space/Enter
 * → tự chuyển block (giống Typora/Notion). KHÔNG tắt escape của turndown nên
 * dấu "-", "#"... nghĩa đen vẫn gõ được bình thường khi không kích hoạt rule.
 *   Space:  "#".."######" → heading · "-"/"*"/"+" → bullet · "1."/"1)" → số
 *           ">" → trích dẫn · "[]"/"[ ]"/"[x]" → task list
 *   Enter:  "---"/"***"/"___" → đường kẻ ngang · "```lang" → khối code
 * Trong ô bảng (td/th), heading/quote/hr/code không áp dụng (không hợp lý ở
 * đó) nhưng bullet/số/task list vẫn gõ được — xem applyCellListInputRule.
 */
import { addCheckbox, closestElement, type DomHelpers } from './dom-utils';

export interface InputRulesContext {
  scheduleSync: () => void;
  dom: DomHelpers;
}

let content: HTMLElement;
let ctx: InputRulesContext;

export function initInputRules(contentEl: HTMLElement, context: InputRulesContext): void {
  content = contentEl;
  ctx = context;

  content.addEventListener('keydown', (e) => {
    // Bỏ qua khi đang gõ tiếng Việt (IME) hoặc có phím bổ trợ.
    if (e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    if (e.key === ' ') {
      if (applySpaceInputRule() || applyCellListInputRule()) {
        e.preventDefault();
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      if (applyEnterInputRule()) {
        e.preventDefault();
      }
    }
  });
}

/**
 * Đoạn văn thuần đang chứa caret — chỉ trả về khi block là <p> nằm trực tiếp
 * trong #content (không nằm trong bảng, list, trích dẫn hay khối code), vì chỉ
 * ở ngữ cảnh đó mới chuyển đổi được sang list/heading/quote một cách an toàn.
 */
function inputRuleParagraph(): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) {
    return null;
  }
  const block = sel.anchorNode
    ? closestElement(sel.anchorNode)?.closest('p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote')
    : null;
  if (!block || block.nodeName !== 'P' || !content.contains(block)) {
    return null;
  }
  if (block.closest('td, th, li, pre, blockquote')) {
    return null;
  }
  return block as HTMLElement;
}

/** Text từ đầu block đến caret — dùng để so khớp tiền tố markdown. */
function textBeforeCaret(block: Element): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return '';
  }
  const range = sel.getRangeAt(0);
  const probe = document.createRange();
  probe.selectNodeContents(block);
  try {
    probe.setEnd(range.startContainer, range.startOffset);
  } catch {
    return '';
  }
  return probe.toString();
}

/** Xoá tiền tố markdown (đoạn từ đầu block đến caret) rồi đặt caret về đầu block. */
function stripMarkerBeforeCaret(block: Element): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return;
  }
  const range = sel.getRangeAt(0);
  const del = document.createRange();
  del.selectNodeContents(block);
  del.setEnd(range.startContainer, range.startOffset);
  del.deleteContents();
  if (!block.firstChild) {
    block.appendChild(document.createElement('br'));
  }
  del.collapse(true);
  sel.removeAllRanges();
  sel.addRange(del);
}

/** Đặt selection (đã collapse) vào CUỐI nội dung của một element. */
function placeCaretAtEnd(el: Element): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Chuyển một đoạn văn (đã bị stripMarkerBeforeCaret làm rỗng) thành mục list
 * — dùng execCommand('insertHTML') thay vì thao tác DOM trần (createElement/
 * appendChild/replaceWith) như trước đây. Lý do đổi: thao tác DOM trần không
 * được trình duyệt ghi vào lịch sử undo/redo gốc, nên Ctrl/Cmd+Z sau khi gõ
 * "- "/"1. " sẽ không hoàn tác đúng — có thể làm mất hẳn định dạng list vừa
 * tạo, hoặc khiến các lần undo sau đó nhảy một khoảng lớn/không nhất quán
 * (lịch sử bị "gãy" tại đúng điểm này). execCommand('insertHTML') là thao
 * tác chỉnh sửa gốc của trình duyệt nên được ghi nhận đúng, Ctrl/Cmd+Z hoàn
 * tác gọn một bước. Trước đây từng tránh execCommand vì
 * execCommand('insert{Un}orderedList') có bug: khi caret ở <p> rỗng đứng
 * ngay sau <p> có nội dung, Chrome canonicalize vị trí này về cuối đoạn văn
 * trước nên lệnh áp dụng nhầm — nhưng insertHTML (thay vì insert{Un}
 * orderedList) không gặp bug đó (đã kiểm chứng thủ công).
 * Nếu ngay phía trước đã là list cùng loại thì gộp <li> mới vào đó, khớp với
 * hành vi merge mặc định của execCommand.
 */
function convertBlockToListItem(block: HTMLElement, ordered: boolean): HTMLLIElement {
  const listTag = ordered ? 'OL' : 'UL';
  const innerHtml = block.innerHTML;
  const prev = block.previousElementSibling;

  if (prev && prev.nodeName === listTag) {
    const lastLi = prev.lastElementChild as HTMLLIElement;
    block.remove();
    placeCaretAtEnd(lastLi);
    document.execCommand('insertHTML', false, `<li>${innerHtml}</li>`);
    const li = findCurrentListItem() ?? (prev.lastElementChild as HTMLLIElement);
    ctx.dom.placeCaretIn(li);
    return li;
  }

  // Phải CHỌN (không chỉ collapse caret vào) toàn bộ nội dung còn lại của
  // block trước khi insertHTML — nếu chỉ collapse, execCommand chèn list mới
  // CẠNH nội dung cũ thay vì thay thế nó, nhân đôi nội dung (đã kiểm chứng:
  // gõ "- " ở đầu một dòng còn chữ phía sau từng bị lặp y hệt chữ đó ra một
  // đoạn văn thừa ngay sau list).
  const replaceRange = document.createRange();
  replaceRange.selectNodeContents(block);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(replaceRange);
  document.execCommand(
    'insertHTML',
    false,
    `<${listTag.toLowerCase()}><li>${innerHtml}</li></${listTag.toLowerCase()}>`
  );
  // Dò <li> mới qua vị trí caret SAU insertHTML (execCommand luôn để caret
  // trong nội dung vừa chèn) thay vì suy ra qua previousSibling/nextSibling
  // của block cũ — nội dung markdown-it render xen text node "\n" giữa các
  // block nên suy luận qua vị trí anh em ruột không đáng tin cậy.
  const li = findCurrentListItem();
  if (!li) {
    throw new Error('convertBlockToListItem: không tìm thấy <li> vừa chèn');
  }
  removeStrayEmptyParagraphAfter(li.closest(listTag.toLowerCase()) as Element);
  ctx.dom.placeCaretIn(li);
  return li;
}

/** <li> đang chứa caret hiện tại (dùng ngay sau execCommand('insertHTML')). */
function findCurrentListItem(): HTMLLIElement | null {
  const sel = window.getSelection();
  const anchor = sel?.anchorNode ? closestElement(sel.anchorNode) : null;
  return (anchor?.closest('li') as HTMLLIElement | null) ?? null;
}

/**
 * Chrome đôi khi để lại một <p></p> hoàn toàn rỗng ngay sau list vừa chèn
 * bằng execCommand('insertHTML') (tách phần "còn lại" của đoạn văn cũ ra một
 * block mới dù đã chọn hết nội dung để thay). Dọn nó đi cho sạch — an toàn vì
 * phần tử này không có nội dung nên không có gì để mất khi undo sau đó.
 */
function removeStrayEmptyParagraphAfter(list: Element | null): void {
  const next = list?.nextElementSibling;
  if (
    next &&
    next.nodeName === 'P' &&
    (next.textContent ?? '').trim() === '' &&
    !next.querySelector('img, input, video, audio, iframe, picture')
  ) {
    next.remove();
  }
}

/** Xử lý các input rule kích hoạt bằng Space. Trả về true nếu đã chuyển đổi. */
function applySpaceInputRule(): boolean {
  const block = inputRuleParagraph();
  if (!block) {
    return false;
  }
  const marker = textBeforeCaret(block);

  const heading = /^(#{1,6})$/.exec(marker);
  if (heading) {
    stripMarkerBeforeCaret(block);
    ctx.dom.replaceBlockTag(block, `h${heading[1].length}`);
    ctx.scheduleSync();
    return true;
  }

  if (marker === '>') {
    stripMarkerBeforeCaret(block);
    document.execCommand('formatBlock', false, 'blockquote');
    ctx.scheduleSync();
    return true;
  }

  const task = /^\[( |x|X)?\]$/.exec(marker);
  if (task) {
    stripMarkerBeforeCaret(block);
    const li = convertBlockToListItem(block, false);
    addCheckbox(li);
    if (task[1] === 'x' || task[1] === 'X') {
      li.querySelector(':scope > input[type="checkbox"]')?.setAttribute('checked', 'checked');
    }
    ctx.scheduleSync();
    return true;
  }

  if (marker === '-' || marker === '*' || marker === '+') {
    stripMarkerBeforeCaret(block);
    convertBlockToListItem(block, false);
    ctx.scheduleSync();
    return true;
  }

  const ordered = /^(\d{1,9})[.)]$/.exec(marker);
  if (ordered) {
    stripMarkerBeforeCaret(block);
    const li = convertBlockToListItem(block, true);
    const start = parseInt(ordered[1], 10);
    if (start !== 1) {
      const list = li.parentElement;
      if (list && list.nodeName === 'OL') {
        list.setAttribute('start', String(start));
      }
    }
    ctx.scheduleSync();
    return true;
  }

  return false;
}

/**
 * Biến thể của applySpaceInputRule dành riêng cho ô bảng (td/th): vì cả ô là
 * MỘT block DOM duy nhất (nhiều "dòng" nối bằng <br> ở cấp con trực tiếp, xem
 * flattenListToBrLines trong pipeline.ts) nên không dùng inputRuleParagraph
 * được — phải tự xác định ranh giới "dòng" chứa caret rồi chỉ chuyển đổi đúng
 * dòng đó. Chỉ hỗ trợ bullet/số/task list (heading/quote/hr/code không hợp lý
 * trong một ô bảng).
 */
function applyCellListInputRule(): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) {
    return false;
  }
  const anchor = sel.anchorNode ? closestElement(sel.anchorNode) : null;
  const block = anchor?.closest('p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote');
  if (!block || (block.nodeName !== 'TD' && block.nodeName !== 'TH') || !content.contains(block)) {
    return false;
  }
  const cell = block as HTMLElement;
  const range = sel.getRangeAt(0);
  const lineStart = cellLineStart(cell, range);

  const probe = document.createRange();
  probe.setStart(cell, lineStart);
  probe.setEnd(range.startContainer, range.startOffset);
  const marker = probe.toString();

  const task = /^\[( |x|X)?\]$/.exec(marker);
  const bullet = /^[-*+]$/.test(marker);
  const ordered = /^(\d{1,9})[.)]$/.exec(marker);
  if (!task && !bullet && !ordered) {
    return false;
  }

  const del = document.createRange();
  del.setStart(cell, lineStart);
  del.setEnd(range.startContainer, range.startOffset);
  del.deleteContents();

  if (task) {
    const li = convertCellLineToListItem(cell, lineStart, false);
    addCheckbox(li);
    if (task[1] === 'x' || task[1] === 'X') {
      li.querySelector(':scope > input[type="checkbox"]')?.setAttribute('checked', 'checked');
    }
  } else if (ordered) {
    const li = convertCellLineToListItem(cell, lineStart, true);
    const start = parseInt(ordered[1], 10);
    if (start !== 1) {
      const list = li.parentElement;
      if (list && list.nodeName === 'OL') {
        list.setAttribute('start', String(start));
      }
    }
  } else {
    convertCellLineToListItem(cell, lineStart, false);
  }
  ctx.scheduleSync();
  return true;
}

/**
 * Chỉ số (offset trong cell.childNodes) đầu "dòng" hiện tại chứa caret. Ranh
 * giới dòng là vị trí ngay sau mỗi <br>/<ul>/<ol> con trực tiếp của ô — <ul>/
 * <ol> cũng tính vì gõ ký tự ngay sau một list luôn bắt đầu dòng mới, kể cả
 * khi trình duyệt đã "nuốt" mất <br> phân cách lúc gõ ký tự đó (Chrome coi
 * <br> cuối ô là placeholder dòng trống nên thay bằng text mới thay vì chèn
 * tiếp sau nó — nếu chỉ dựa vào <br> sẽ mất ranh giới trong trường hợp này).
 */
function cellLineStart(cell: Element, range: Range): number {
  const boundaries = [0];
  Array.from(cell.childNodes).forEach((n, i) => {
    if (n.nodeName === 'BR' || n.nodeName === 'UL' || n.nodeName === 'OL') {
      boundaries.push(i + 1);
    }
  });
  let lineStart = 0;
  for (const b of boundaries) {
    if (range.comparePoint(cell, b) <= 0) {
      lineStart = b;
    } else {
      break;
    }
  }
  return lineStart;
}

/**
 * Nếu dòng ngay trước lineStart đã là list cùng loại (trực tiếp, hoặc cách
 * một <br> phân cách) thì trả về list đó để gộp mục mới vào — khớp hành vi
 * merge của convertBlockToListItem ở top-level. Trả về <br> phân cách (nếu
 * có) để xoá, vì list gộp rồi không cần <br> ngăn cách hai "dòng" nữa.
 */
function cellListMergeTarget(
  cell: Element,
  lineStart: number,
  listTag: 'UL' | 'OL'
): { list: Element; separatorBr: Element | null } | null {
  const children = Array.from(cell.childNodes);
  if (lineStart <= 0) {
    return null;
  }
  const before = children[lineStart - 1];
  if (before.nodeName === listTag) {
    return { list: before as Element, separatorBr: null };
  }
  if (before.nodeName === 'BR' && lineStart >= 2 && children[lineStart - 2].nodeName === listTag) {
    return { list: children[lineStart - 2] as Element, separatorBr: before as Element };
  }
  return null;
}

/**
 * Rút "dòng" hiện tại trong ô bảng (từ lineStart tới <br>/<ul>/<ol> kế tiếp ở
 * cấp con trực tiếp, hoặc tới hết ô) thành một <li> — gộp vào list liền
 * trước nếu cùng loại (xem cellListMergeTarget), nếu không thì tạo list mới.
 * Dùng execCommand('insertHTML') để chèn (thay vì extractContents/insertNode
 * thao tác DOM trần như trước) — cùng lý do với convertBlockToListItem: thao
 * tác DOM trần không vào lịch sử undo/redo gốc nên Ctrl/Cmd+Z sau khi gõ
 * "- "/"1. " trong ô bảng sẽ làm mất/vỡ định dạng list vừa tạo.
 */
function convertCellLineToListItem(cell: HTMLElement, lineStart: number, ordered: boolean): HTMLLIElement {
  const children = Array.from(cell.childNodes);
  let endIdx = children.length;
  for (let i = lineStart; i < children.length; i++) {
    if (children[i].nodeName === 'BR' || children[i].nodeName === 'UL' || children[i].nodeName === 'OL') {
      endIdx = i;
      break;
    }
  }

  const lineRange = document.createRange();
  lineRange.setStart(cell, lineStart);
  lineRange.setEnd(cell, endIdx);
  const container = document.createElement('div');
  container.appendChild(lineRange.cloneContents());
  const innerHtml = container.textContent ? container.innerHTML : '<br>';

  const listTag = ordered ? 'OL' : 'UL';
  const merge = cellListMergeTarget(cell, lineStart, listTag);
  const sel = window.getSelection();

  if (merge) {
    lineRange.deleteContents();
    merge.separatorBr?.remove();
    placeCaretAtEnd(merge.list.lastElementChild as HTMLLIElement);
    document.execCommand('insertHTML', false, `<li>${innerHtml}</li>`);
    const li = findCurrentListItem() ?? (merge.list.lastElementChild as HTMLLIElement);
    ctx.dom.placeCaretIn(li);
    return li;
  }

  sel?.removeAllRanges();
  sel?.addRange(lineRange);
  document.execCommand(
    'insertHTML',
    false,
    `<${listTag.toLowerCase()}><li>${innerHtml}</li></${listTag.toLowerCase()}>`
  );
  // Dò <li> mới qua vị trí caret SAU insertHTML thay vì suy ra qua
  // previousSibling/nextSibling — xem ghi chú tương tự ở convertBlockToListItem.
  const li = findCurrentListItem();
  if (!li) {
    throw new Error('convertCellLineToListItem: không tìm thấy <li> vừa chèn');
  }
  ctx.dom.placeCaretIn(li);
  return li;
}

/** Xử lý các input rule kích hoạt bằng Enter. Trả về true nếu đã chuyển đổi. */
function applyEnterInputRule(): boolean {
  const block = inputRuleParagraph();
  if (!block) {
    return false;
  }
  const text = (block.textContent ?? '').trim();

  if (/^(-{3,}|\*{3,}|_{3,})$/.test(text)) {
    const hr = document.createElement('hr');
    const after = document.createElement('p');
    after.appendChild(document.createElement('br'));
    block.replaceWith(hr);
    hr.after(after);
    ctx.dom.placeCaretIn(after);
    ctx.scheduleSync();
    return true;
  }

  const fence = /^`{3,}([\w+-]*)$/.exec(text);
  if (fence) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = `language-${fence[1] || 'plaintext'}`;
    code.appendChild(document.createElement('br'));
    pre.appendChild(code);
    const after = document.createElement('p');
    after.appendChild(document.createElement('br'));
    block.replaceWith(pre);
    pre.after(after);
    ctx.dom.placeCaretIn(code);
    ctx.scheduleSync();
    return true;
  }

  return false;
}

/** Caret có đang ở ngay đầu nội dung của mục list (không có text đứng trước)? */
export function caretAtStartOfListItem(li: Element, sel: Selection | null): boolean {
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) {
    return false;
  }
  const range = sel.getRangeAt(0);
  const probe = range.cloneRange();
  probe.selectNodeContents(li);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length === 0;
}
