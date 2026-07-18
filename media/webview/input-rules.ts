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
import { addCheckbox, closestElement, emptyParagraph, type DomHelpers } from './dom-utils';

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
      if (applySpaceInputRule() || applyBlockquoteNestInputRule() || applyCellListInputRule()) {
        e.preventDefault();
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      if (applyEnterInputRule() || applyTaskListEnterRule()) {
        e.preventDefault();
      }
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      if (applyListBoundaryDeleteRule()) {
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
 * Chèn một <li> bằng execCommand('insertHTML') (thao tác gốc → Ctrl/Cmd+Z hoàn
 * tác gọn một bước, xem ghi chú ở convertBlockToListItem) rồi trả về <li> vừa
 * chèn. Người gọi tự lo phần thiết lập selection/range trước khi gọi và phần
 * dọn dẹp riêng sau khi gọi.
 *   - mode 'merge': gộp vào list sẵn có — đặt caret cuối `lastLi` rồi chèn
 *     `<li>…</li>`; nếu không dò được <li> mới qua vị trí caret thì lùi về
 *     phần tử con cuối cùng của list (khớp fallback cũ ở cả hai hàm gọi).
 *   - mode 'new': người gọi phải CHỌN sẵn range nội dung cần thay; chèn cả
 *     `<listTag><li>…</li></listTag>`; không dò được thì ném lỗi.
 */
function insertListItemViaExec(
  innerHtml: string,
  listTag: string,
  mode: 'merge' | 'new',
  lastLi?: HTMLElement
): HTMLLIElement {
  if (mode === 'merge') {
    placeCaretAtEnd(lastLi as HTMLElement);
    document.execCommand('insertHTML', false, `<li>${innerHtml}</li>`);
    const li =
      findCurrentListItem() ?? ((lastLi as HTMLElement).parentElement!.lastElementChild as HTMLLIElement);
    ctx.dom.placeCaretIn(li);
    return li;
  }

  const tag = listTag.toLowerCase();
  document.execCommand('insertHTML', false, `<${tag}><li>${innerHtml}</li></${tag}>`);
  // Dò <li> mới qua vị trí caret SAU insertHTML (execCommand luôn để caret
  // trong nội dung vừa chèn) thay vì suy ra qua previousSibling/nextSibling
  // của block cũ — nội dung markdown-it render xen text node "\n" giữa các
  // block nên suy luận qua vị trí anh em ruột không đáng tin cậy.
  const li = findCurrentListItem();
  if (!li) {
    throw new Error('insertListItemViaExec: không tìm thấy <li> vừa chèn');
  }
  ctx.dom.placeCaretIn(li);
  return li;
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
    return insertListItemViaExec(innerHtml, listTag, 'merge', lastLi);
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
  const li = insertListItemViaExec(innerHtml, listTag, 'new');
  removeStrayEmptyParagraphAfter(li.closest(listTag.toLowerCase()) as Element);
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

// Post-`<li>`-creation tail shared by the top-level and table-cell task-item
// rules: add the checkbox, mark it checked for "[x]"/"[X]", place the caret.
// The `<li>` creation + marker removal differ per call site and stay there.
function finishTaskItem(li: HTMLLIElement, task: RegExpExecArray): void {
  addCheckbox(li);
  if (task[1] === 'x' || task[1] === 'X') {
    li.querySelector(':scope > input[type="checkbox"]')?.setAttribute('checked', 'checked');
  }
  placeCaretAtBlockStart(li);
}

// Ordered-list start-number tail shared by the same two rules: a non-1 start
// stamps `start` on the parent `<ol>`. Operates only on the created `<li>`.
function applyOrderedStart(li: HTMLLIElement, ordered: RegExpExecArray): void {
  const start = parseInt(ordered[1], 10);
  if (start !== 1) {
    const list = li.parentElement;
    if (list && list.nodeName === 'OL') {
      list.setAttribute('start', String(start));
    }
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
    // HLR 22 Phase 2.6: `block` is a guaranteed top-level <p> here
    // (inputRuleParagraph), so the direct-Range wrap applies unconditionally —
    // no execCommand('formatBlock') and no legacy fallback needed.
    ctx.dom.wrapInBlockquote(block);
    ctx.scheduleSync();
    return true;
  }

  const task = /^\[( |x|X)?\]$/.exec(marker);
  if (task) {
    stripMarkerBeforeCaret(block);
    finishTaskItem(convertBlockToListItem(block, false), task);
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
    applyOrderedStart(convertBlockToListItem(block, true), ordered);
    ctx.scheduleSync();
    return true;
  }

  return false;
}

/**
 * Trích dẫn lồng: khi caret ở đầu một <p> nằm TRỰC TIẾP trong <blockquote> và
 * gõ "> " → bọc riêng đoạn đó vào một <blockquote> con. inputRuleParagraph cố
 * tình bỏ qua ngữ cảnh blockquote (chỉ nhận <p> top-level), nên xử lý riêng ở
 * đây. Chỉ hỗ trợ ">" — heading/list bên trong quote không thuộc phạm vi này.
 * turndown serialize <blockquote> đệ quy nên quote lồng ra "> > ..." thay vì bị
 * escape thành "\>" như khi để nguyên text "> ..." trong <p>.
 */
function applyBlockquoteNestInputRule(): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) {
    return false;
  }
  const anchor = sel.anchorNode ? closestElement(sel.anchorNode) : null;
  const block = anchor?.closest('p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote');
  if (
    !block ||
    block.nodeName !== 'P' ||
    block.parentElement?.nodeName !== 'BLOCKQUOTE' ||
    !content.contains(block)
  ) {
    return false;
  }
  if (textBeforeCaret(block) !== '>') {
    return false;
  }
  stripMarkerBeforeCaret(block);
  ctx.dom.wrapInBlockquote(block as HTMLElement);
  ctx.scheduleSync();
  return true;
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
    finishTaskItem(convertCellLineToListItem(cell, lineStart, false), task);
  } else if (ordered) {
    applyOrderedStart(convertCellLineToListItem(cell, lineStart, true), ordered);
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
    return insertListItemViaExec(innerHtml, listTag, 'merge', merge.list.lastElementChild as HTMLLIElement);
  }

  sel?.removeAllRanges();
  sel?.addRange(lineRange);
  return insertListItemViaExec(innerHtml, listTag, 'new');
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
    const after = emptyParagraph();
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
    const after = emptyParagraph();
    block.replaceWith(pre);
    pre.after(after);
    ctx.dom.placeCaretIn(code);
    ctx.scheduleSync();
    return true;
  }

  return false;
}

/**
 * Enter trong một mục task list ("- [ ] ...") → mục mới tách ra cũng phải có
 * checkbox, khớp hành vi Notion/Typora. Mặc định trình duyệt split <li> lúc
 * Enter chỉ nhân bản định dạng inline bao quanh caret (b/i/span...); checkbox
 * là <input> đứng TRƯỚC caret (sibling, không phải wrapper) nên không được
 * nhân bản — <li> mới sinh ra mất cả checkbox lẫn class task-list-item. Áp
 * dụng cho cả task item trong ô bảng (convertCellLineToListItem tạo <li>
 * giống hệt cấu trúc top-level nên dùng chung được, không cần phân biệt).
 * Dùng execCommand('insertHTML') để chèn <li> mới — cùng lý do undo/redo với
 * insertListItemViaExec (xem convertBlockToListItem).
 */
function applyTaskListEnterRule(): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) {
    return false;
  }
  const anchor = sel.anchorNode ? closestElement(sel.anchorNode) : null;
  const li = anchor?.closest('li') as HTMLLIElement | null;
  if (!li || !content.contains(li) || !li.classList.contains('task-list-item')) {
    return false;
  }
  // Có sub-list lồng trực tiếp trong mục này — để hành vi mặc định xử lý,
  // tránh xáo trộn cấu trúc con khi tách <li>.
  if (li.querySelector(':scope > ul, :scope > ol')) {
    return false;
  }

  const range = sel.getRangeAt(0);
  const afterRange = document.createRange();
  afterRange.selectNodeContents(li);
  afterRange.setStart(range.startContainer, range.startOffset);

  if ((li.textContent ?? '').trim() === '') {
    // <li> task rỗng hoàn toàn → để trình duyệt tự outdent như list thường.
    return false;
  }

  const container = document.createElement('div');
  container.appendChild(afterRange.cloneContents());
  const afterHtml = container.textContent ? container.innerHTML : '<br>';
  afterRange.deleteContents();

  const listTag = li.parentElement?.nodeName === 'OL' ? 'OL' : 'UL';
  const newLi = insertListItemViaExec(afterHtml, listTag, 'merge', li);
  addCheckbox(newLi);
  placeCaretAtBlockStart(newLi);
  ctx.scheduleSync();
  return true;
}

/** Selector các block "cấp lá" mà một vùng chọn có thể bắt đầu/kết thúc bên trong. */
const DELETE_BLOCK_SEL = 'li, p, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th';

/** Block cấp lá gần nhất chứa `node` (li/đoạn văn/heading/ô bảng...). */
function deleteBlockAncestor(node: Node): Element | null {
  const el = closestElement(node);
  return el ? el.closest(DELETE_BLOCK_SEL) : null;
}

/** Block coi như "rỗng, xoá được": không còn text nhìn thấy và không nhúng media (checkbox task thì kệ). */
function isEmptyDeletableBlock(el: Element): boolean {
  return (el.textContent ?? '').trim() === '' && !el.querySelector('img, video, audio, iframe, picture');
}

/** Đặt caret (đã collapse) về đầu nội dung `el` — với task item thì ngay sau checkbox. */
function placeCaretAtBlockStart(el: Element): void {
  const range = document.createRange();
  const checkbox =
    el.nodeName === 'LI' ? el.querySelector(':scope > input[type="checkbox"]') : null;
  if (checkbox) {
    range.setStartAfter(checkbox);
  } else {
    range.selectNodeContents(el);
  }
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  content.focus();
}

/**
 * Xoá đúng vùng chọn `range` trải TỪ `startBlock` SANG `endBlock` mà GIỮ NGUYÊN
 * danh tính hai block ở hai đầu (không để trình duyệt gộp chéo thẻ). Ba bước:
 *   1. Xoá phần đuôi startBlock (từ điểm bắt đầu vùng chọn tới hết block).
 *   2. Xoá phần đầu endBlock (từ đầu block tới điểm kết thúc vùng chọn).
 *   3. Xoá mọi node NẰM GIỮA hai block — dùng setStartAfter/setEndBefore để hai
 *      mép nằm NGOÀI startBlock/endBlock nên bản thân hai block không bị đụng.
 * Sau đó dọn block rỗng ở đầu (nếu user chọn từ đầu nó) và đặt lại caret.
 */
function deleteAcrossBlocksKeepingIdentity(range: Range, startBlock: Element, endBlock: Element): void {
  // Chốt 4 mép TRƯỚC khi xoá — deleteContents() mutate DOM có thể dời điểm cuối
  // của live selection `range`, đọc lại range.endContainer sau bước 1 sẽ sai.
  // startBlock ≠ endBlock (khác cây con) nên xoá trong startBlock không đụng
  // endContainer/endOffset đã chốt.
  const startContainer = range.startContainer;
  const startOffset = range.startOffset;
  const endContainer = range.endContainer;
  const endOffset = range.endOffset;

  const tail = document.createRange();
  tail.setStart(startContainer, startOffset);
  tail.setEnd(startBlock, startBlock.childNodes.length);
  tail.deleteContents();

  const head = document.createRange();
  head.setStart(endBlock, 0);
  head.setEnd(endContainer, endOffset);
  head.deleteContents();

  const between = document.createRange();
  between.setStartAfter(startBlock);
  between.setEndBefore(endBlock);
  between.deleteContents();

  const startLi = startBlock.closest('li');
  if (startLi && isEmptyDeletableBlock(startLi)) {
    const list = startLi.parentElement;
    startLi.remove();
    if (list && !list.querySelector(':scope > li')) {
      list.remove();
    }
  } else if (!startLi && startBlock.parentElement === content && isEmptyDeletableBlock(startBlock)) {
    startBlock.remove();
  }

  placeCaretAtBlockStart(endBlock);
}

/**
 * Bug #4: xoá vắt qua ranh giới list. Khi vùng chọn trải TỪ một <li> SANG một
 * block khác list (heading/đoạn văn đứng sau list, hoặc ngược lại) rồi user bấm
 * Backspace/Delete, contentEditable mặc định hay GỘP block kia vào trong list —
 * biến heading thành bullet item, mất định dạng (đúng ảnh chụp bug report #4:
 * xoá dòng cuối list làm heading "Bug Analysis" thành bullet). Ta tự xoá đúng
 * vùng chọn mà giữ nguyên hai block ở hai đầu.
 *
 * CHỈ can thiệp đúng trường hợp vắt qua ranh giới list (start-block ≠ end-block,
 * ít nhất một đầu là <li> thuộc list KHÁC đầu kia, và không dính bảng) — mọi
 * thao tác xoá khác giữ nguyên hành vi mặc định của trình duyệt.
 */
function applyListBoundaryDeleteRule(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return false;
  }
  const range = sel.getRangeAt(0);
  const startBlock = deleteBlockAncestor(range.startContainer);
  const endBlock = deleteBlockAncestor(range.endContainer);
  if (
    !startBlock ||
    !endBlock ||
    startBlock === endBlock ||
    !content.contains(startBlock) ||
    !content.contains(endBlock)
  ) {
    return false;
  }
  // Không đụng khi hai đầu ở khác "khung bảng" — tránh phá cấu trúc <table>.
  if (startBlock.closest('table') !== endBlock.closest('table')) {
    return false;
  }
  const startLi = startBlock.closest('li');
  const endLi = endBlock.closest('li');
  const startList = startLi?.parentElement ?? null;
  const endList = endLi?.parentElement ?? null;
  const crossesListBoundary =
    (!!startLi && (!endLi || startList !== endList)) || (!!endLi && (!startLi || startList !== endList));
  if (!crossesListBoundary) {
    return false;
  }

  deleteAcrossBlocksKeepingIdentity(range, startBlock, endBlock);
  ctx.scheduleSync();
  return true;
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
