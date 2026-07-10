/**
 * Webview WYSIWYG cho Markdown:
 *  - Render bằng markdown-it (giống VS Code Markdown Preview).
 *  - #content là contentEditable; mọi thay đổi được serialize về markdown
 *    (turndown) và gửi cho extension (debounce).
 *  - Update từ ngoài (text editor, git...) → render lại, giữ vị trí scroll.
 *
 * File này chỉ còn vai trò "composition root": khởi tạo renderer/turndown,
 * nối các module tính năng (toolbar, table, input-rules, prompt, search, toc)
 * lại với nhau, và xử lý các sự kiện xuyên suốt cả trang (sync, paste, mở
 * link, phím tắt định dạng).
 */
import {
  MarkdownRenderer,
  createTurndown,
  findOrphanNestedListPair,
  normalizeMarkdown,
  postProcessMathDom,
  postProcessMermaidDom,
  prepareDomForSerialize,
} from './pipeline';
import { initSearch } from './search';
import { initToc } from './toc';
import { initMermaid } from './mermaid';
import { initLineGutter } from './gutter';
import { closestElement, createDomHelpers } from './dom-utils';
import { initPrompt } from './prompt';
import { initToolbar, syncTocButton, toggleInlineCode } from './toolbar';
import { initTable, navigateCells, warnIfComplexTableList } from './table';
import { initInputRules, caretAtStartOfListItem } from './input-rules';
import type { VsCodeApi } from './vscode-api';
import type { HostToWebview, InitConfig, WebviewToHost } from '../../src/shared/messages';
import { SYNC_DEBOUNCE_MS, SCROLL_SAVE_DEBOUNCE_MS } from './constants';

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

/** Gửi message tới host theo đúng hợp đồng WebviewToHost (C3). */
function postToHost(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}
const content = document.getElementById('content') as HTMLDivElement;
const toolbarEl = document.getElementById('toolbar') as HTMLDivElement;
const gutterEl = document.getElementById('line-gutter') as HTMLDivElement | null;

let renderer: MarkdownRenderer | undefined;
const turndown = createTurndown();
const search = initSearch(content);
const toc = initToc(content);
const mermaidView = initMermaid(content);
const lineGutter = initLineGutter(content, gutterEl, () => renderer);
let lineNumbersEnabled = false;
const dom = createDomHelpers(content);
const prompt = initPrompt(vscode, dom);
const table = initTable(content, toolbarEl, { scheduleSync, dom });
initToolbar(content, toolbarEl, {
  vscode,
  scheduleSync,
  dom,
  toc,
  promptInput: prompt.promptInput,
});
initInputRules(content, { scheduleSync, dom });

/** Markdown hiện tại mà webview đã biết (đã render hoặc đã gửi lên). */
let currentText = '';
let syncTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------------------
// Khởi tạo
// ---------------------------------------------------------------------------

document.execCommand('defaultParagraphSeparator', false, 'p');

window.addEventListener('message', (event) => {
  const msg = event.data as HostToWebview;
  switch (msg.type) {
    case 'init': {
      const cfg: Partial<InitConfig> = msg.config ?? { breaks: false, linkify: true };
      renderer = new MarkdownRenderer({ breaks: !!cfg.breaks, linkify: !!cfg.linkify });
      applyPreviewFontSettings(cfg);
      lineNumbersEnabled = cfg.showLineNumbers !== false;
      document.body.classList.toggle('md-line-numbers', lineNumbersEnabled);
      renderDocument(msg.text ?? '');
      restoreScroll();
      if (cfg.autoOpenToc !== false && !toc.isOpen()) {
        toc.toggle();
        syncTocButton();
      }
      break;
    }
    case 'update': {
      if (msg.text === currentText) {
        break;
      }
      renderDocument(msg.text ?? '');
      break;
    }
    case 'fileSearchResult': {
      prompt.notifyFileSearchResult(Number(msg.requestId ?? 0), msg.files ?? []);
      break;
    }
  }
});

postToHost({ type: 'ready' });

function applyPreviewFontSettings(cfg: Partial<InitConfig>): void {
  const root = document.documentElement;
  if (cfg.wordWrap) {
    document.body.classList.add('wordWrap');
  }
  if (typeof cfg.fontSize === 'number') {
    root.style.setProperty('--markdown-font-size', `${cfg.fontSize}px`);
  }
  if (typeof cfg.lineHeight === 'number') {
    root.style.setProperty('--markdown-line-height', String(cfg.lineHeight));
  }
  if (typeof cfg.fontFamily === 'string' && cfg.fontFamily.trim()) {
    root.style.setProperty('--markdown-font-family', String(cfg.fontFamily));
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderDocument(markdown: string): void {
  if (!renderer) {
    return;
  }
  currentText = markdown;
  const scrollTop = window.scrollY;
  const { html } = renderer.render(markdown);
  content.innerHTML = html;
  postProcessMathDom(content, document, renderer.getLastMathBlockRanges());
  postProcessMermaidDom(content, document);
  ensureTrailingParagraph();
  mermaidView.renderAll();
  table.hideTableToolbar();
  if (lineNumbersEnabled) {
    lineGutter.refreshFromDom();
  }
  window.scrollTo({ top: scrollTop });
  saveScrollSoon();
  // Nội dung vừa dựng lại — range highlight cũ đã hỏng, tìm lại nếu đang mở.
  search.refresh();
  // Heading có thể đã đổi — dựng lại mục lục nếu panel đang mở.
  toc.refresh();
}

/**
 * contentEditable cần ít nhất một block để đặt caret. Ngoài ra, nếu phần tử
 * CUỐI là khối "atom"/"bẫy caret" — Mermaid, công thức, front matter, code
 * block, bảng, <hr> — thì không có chỗ đặt con trỏ ngay phía sau nó nên không
 * thể thêm nội dung mới xuống dưới (Mermaid ở chế độ biểu đồ là nặng nhất:
 * toàn bộ vùng nhìn thấy đều contenteditable=false). Đảm bảo luôn có một <p>
 * rỗng ở cuối để làm "chỗ thoát".
 *
 * An toàn với serialize: rule 'emptyParagraph' của turndown bỏ mọi <p> rỗng
 * khi lưu (xem pipeline.ts) nên <p> thêm vào KHÔNG làm đổi Markdown, không gây
 * sync/diff giả.
 */
const TRAILING_TRAP_SELECTOR =
  '.md-mermaid, .md-math-block, .md-front-matter, pre, table, hr, [contenteditable="false"]';

function ensureTrailingParagraph(): void {
  const last = content.lastElementChild;
  if (!last) {
    content.innerHTML = '<p><br></p>';
    return;
  }
  if (last.matches(TRAILING_TRAP_SELECTOR)) {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    content.appendChild(p);
  }
}

// ---------------------------------------------------------------------------
// Serialize + đồng bộ về extension
// ---------------------------------------------------------------------------

function scheduleSync(): void {
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(syncNow, SYNC_DEBOUNCE_MS);
}

function syncNow(): void {
  syncTimer = undefined;
  // Vẫn phải turndown để có markdown mà so sánh, nhưng chỉ khi nội dung THỰC SỰ
  // đổi mới parse lại gutter (markdown-it lần 2) + gửi edit — bỏ hẳn hai bước
  // này ở nhịp debounce mà nội dung không đổi (finding P-03).
  const markdown = serialize();
  if (markdown === currentText) {
    return;
  }
  if (lineNumbersEnabled) {
    lineGutter.refreshFromMarkdown(markdown);
  }
  currentText = markdown;
  postToHost({ type: 'edit', text: markdown });
}

function serialize(): string {
  const clone = content.cloneNode(true) as HTMLElement;
  // cloneNode không copy property 'checked' — đồng bộ từ DOM thật sang attribute.
  const liveInputs = content.querySelectorAll('input[type="checkbox"]');
  const cloneInputs = clone.querySelectorAll('input[type="checkbox"]');
  liveInputs.forEach((live, i) => {
    const c = cloneInputs[i];
    if (!c) {
      return;
    }
    if ((live as HTMLInputElement).checked) {
      c.setAttribute('checked', 'checked');
    } else {
      c.removeAttribute('checked');
    }
  });
  prepareDomForSerialize(clone, document);
  const md = turndown.turndown(clone);
  return normalizeMarkdown(md);
}

// ---------------------------------------------------------------------------
// Sự kiện chỉnh sửa
// ---------------------------------------------------------------------------

/**
 * Chỉ những inputType này (xoá/cắt/undo/redo/dán) mới có thể sinh ra lỗi
 * "orphan nested list" của Chromium (xem fixOrphanNestedListItems). Gõ chữ
 * bình thường (insertText...) không bao giờ tạo cấu trúc này nên bỏ qua để
 * không quét querySelectorAll('li') toàn tài liệu mỗi keystroke (finding P-04).
 */
const ORPHAN_LIST_INPUT_TYPES = new Set([
  'deleteContentBackward',
  'deleteContentForward',
  'deleteByCut',
  'historyUndo',
  'historyRedo',
  'insertFromPaste',
]);

content.addEventListener('input', (e) => {
  // inputType rỗng (một số trình duyệt/thao tác không đặt) → quét cho chắc.
  const inputType = (e as InputEvent).inputType;
  if (!inputType || ORPHAN_LIST_INPUT_TYPES.has(inputType)) {
    fixOrphanNestedListItems();
  }
  scheduleSync();
  search.refresh();
  toc.refresh();
});

/**
 * Sửa lỗi Chromium: xoá, cắt (Cmd/Ctrl+X) hoặc undo/redo đè lên ranh giới giữa
 * text của một mục list và danh sách con lồng ngay trong mục đó có thể tách
 * nhầm danh sách con ra một <li> rỗng đứng SAU — nhìn như bullet con "nhảy"
 * xuống dòng dưới (xem findOrphanNestedListPair trong pipeline.ts, dùng chung
 * với normalizeListDom lúc serialize). Chạy lại sau MỌI sự kiện input để tự
 * sửa ngay trên DOM đang hiển thị — kể cả sau khi chính execCommand('undo')
 * của trình duyệt tái diễn lỗi tương tự.
 *
 * Phải sửa qua execCommand('insertHTML') chứ không appendChild/remove trần:
 * thao tác DOM trần tuy sửa được cấu trúc ngay lúc đó nhưng làm lịch sử
 * undo/redo gốc của trình duyệt tham chiếu tới node đã bị dọn đi — Cmd+Z ngay
 * sau đó dựng lại cây rác (mất nội dung) thay vì phục hồi đúng trạng thái
 * trước lệnh xoá gốc (đã kiểm chứng thủ công: appendChild/remove trần khiến
 * undo lần đầu cho ra kết quả sai hẳn cấu trúc/nội dung; qua execCommand thì
 * undo lần 1 lùi về đúng bước xoá gốc (còn lỗi), undo lần 2 phục hồi đúng y hệt
 * nội dung ban đầu).
 */
function fixOrphanNestedListItems(): void {
  let guard = 0;
  for (;;) {
    const pair = findOrphanNestedListPair(content);
    if (!pair || ++guard > 50) {
      return;
    }
    const mergedHtml = pair.prev.innerHTML + (pair.nested as HTMLElement).outerHTML;
    const range = document.createRange();
    range.setStartBefore(pair.prev);
    range.setEndAfter(pair.wrapper);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('insertHTML', false, `<li>${mergedHtml}</li>`);
  }
}

// Trước khi unload/ẩn/mất focus — đẩy nốt thay đổi đang chờ.
function flushPendingSync(): void {
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer);
    syncNow();
  }
}

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushPendingSync();
  }
});
window.addEventListener('blur', flushPendingSync);
window.addEventListener('pagehide', flushPendingSync);

// Copy/cut: mặc định trình duyệt lấy text/plain của vùng chọn theo cách riêng
// (bảng → cột cách nhau bằng tab, không phải cú pháp pipe "| a | b |"); dán
// lại (qua handler 'paste' bên dưới, chỉ đọc text/plain rồi render bằng
// markdown-it) sẽ mất hẳn cấu trúc bảng/list. Ghi đè text/plain bằng chính
// Markdown (cùng turndown dùng để lưu file) của đúng vùng đang chọn — copy
// rồi paste (kể cả dán ra ngoài editor) luôn giữ đúng định dạng.
function copySelectionAsMarkdown(e: ClipboardEvent): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return false;
  }
  const wrapper = document.createElement('div');
  wrapper.appendChild(sel.getRangeAt(0).cloneContents());
  prepareDomForSerialize(wrapper, document);
  const md = normalizeMarkdown(turndown.turndown(wrapper));
  if (!md.trim()) {
    return false;
  }
  e.preventDefault();
  e.clipboardData?.setData('text/plain', md);
  return true;
}

content.addEventListener('copy', copySelectionAsMarkdown);

content.addEventListener('cut', (e) => {
  if (copySelectionAsMarkdown(e)) {
    document.execCommand('delete');
    scheduleSync();
  }
});

// Paste: chỉ lấy text/plain (tránh dán HTML bừa từ ngoài vào làm hỏng cấu
// trúc), rồi render lại bằng chính markdown-it của app. Nếu chèn thẳng làm
// text thô, cú pháp Markdown copy từ file .md khác (**bold**, # heading,
// `code`, [link](...)...) sẽ nằm lại như text thường; khi serialize ngược về
// Markdown, turndown sẽ escape các ký tự đó (\*\*bold\*\*...) để giữ nguyên ý
// "đây là text thường" — kết quả là toàn bộ format bị chèn thêm dấu \ và vỡ.
content.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (text) {
    insertPastedMarkdown(text);
  }
});

/**
 * Fallback cho Cmd/Ctrl+V: iframe webview lồng nhau của VS Code custom editor
 * không phải lúc nào cũng bắn sự kiện 'paste' kèm clipboardData khi phím tắt
 * được gõ (khác với Paste qua menu chuột phải, vẫn đi qua handler ở trên).
 * Dùng thẳng async Clipboard API — vốn được VS Code cấp quyền cho webview —
 * làm đường dự phòng độc lập với cơ chế 'paste' event của trình duyệt.
 */
function pasteFromClipboardApi(): void {
  navigator.clipboard
    .readText()
    .then((text) => {
      if (text) {
        insertPastedMarkdown(text);
      }
    })
    .catch(() => {
      /* Không có quyền clipboard-read — bỏ qua, đã có handler 'paste' ở trên lo trường hợp còn lại. */
    });
}

/**
 * Chèn text vừa dán vào vị trí caret. Render qua markdown-it trước (cùng
 * renderer dùng cho toàn bộ tài liệu) để cú pháp Markdown được hiểu đúng
 * thành nội dung có định dạng, thay vì nằm lại như text thô rồi bị turndown
 * escape ngược khi serialize. Text thường (không có cú pháp Markdown) vẫn ra
 * y hệt như insertText cũ nhờ bước "bóc <p> đơn" bên dưới.
 */
function insertPastedMarkdown(text: string): void {
  const html = renderPasteHtml(text);
  if (!html) {
    document.execCommand('insertText', false, text);
    return;
  }
  document.execCommand('insertHTML', false, html);
  // Có thể vừa chèn một khối ```mermaid``` mới — dựng SVG cho nó (renderAll
  // quét lại toàn bộ content nên cũng vô hại với các biểu đồ có sẵn, chỉ tốn
  // thêm chút công tính lại chứ không phá cấu trúc).
  mermaidView.renderAll();
}

/**
 * Render text vừa dán thành HTML để chèn. Nếu kết quả chỉ là một <p> duy nhất
 * (dán một dòng giữa câu, không có cú pháp block nào) thì bóc thẻ <p> ra —
 * tránh tạo ngắt đoạn ngoài ý muốn khi dán chữ thường vào giữa văn bản.
 *
 * postProcessMathDom/postProcessMermaidDom phải chạy trên `tmp` (fragment
 * rời, tách biệt) chứ KHÔNG được chạy trên `content` (DOM sống): hai hàm này
 * bọc thêm wrapper quanh mỗi <span class="katex">/<code class="language-
 * mermaid"> tìm thấy mà không kiểm tra đã bọc hay chưa — chạy lại trên toàn
 * bộ content sẽ bọc chồng (double-wrap) luôn cả những khối math/mermaid đã có
 * sẵn từ trước trong tài liệu, không chỉ đoạn vừa dán.
 */
function renderPasteHtml(text: string): string {
  if (!renderer) {
    return '';
  }
  const { html } = renderer.render(text);
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  postProcessMathDom(tmp, document, renderer.getLastMathBlockRanges());
  postProcessMermaidDom(tmp, document);
  if (tmp.children.length === 1 && tmp.firstElementChild?.tagName === 'P') {
    return tmp.firstElementChild.innerHTML;
  }
  return tmp.innerHTML;
}

// Checkbox task list: toggle bằng chuột.
content.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLInputElement && target.type === 'checkbox') {
    e.preventDefault();
    const checked = !target.hasAttribute('checked');
    if (checked) {
      target.setAttribute('checked', 'checked');
    } else {
      target.removeAttribute('checked');
    }
    target.checked = checked;
    scheduleSync();
    return;
  }
  // Cmd/Ctrl+Click mở liên kết. Luôn chặn cả preventDefault lẫn propagation:
  // preload của VS Code webview có listener click ở document sẽ resolve href
  // qua <base> (https://file+.vscode-resource...) rồi mở ra BROWSER nếu sự
  // kiện lọt tới nó — kể cả khi mình đã preventDefault.
  const anchor = target.closest('a');
  if (anchor) {
    e.preventDefault();
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) {
      openLink(anchor.getAttribute('href') ?? '');
    }
  }
});

// Middle-click (auxclick) cũng bị preload mở ra browser — chặn nốt.
content.addEventListener('auxclick', (e) => {
  if ((e.target as HTMLElement).closest('a')) {
    e.preventDefault();
    e.stopPropagation();
  }
});

function openLink(href: string): void {
  if (!href) {
    return;
  }
  if (href.startsWith('#')) {
    scrollToAnchor(href.slice(1));
    return;
  }
  postToHost({ type: 'openLink', href });
}

function scrollToAnchor(fragment: string): void {
  const decoded = decodeURIComponent(fragment).toLowerCase();
  const headings = content.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const h of Array.from(headings)) {
    const slug = (h.textContent ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}-]/gu, '');
    if (slug === decoded) {
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Phím tắt định dạng
// ---------------------------------------------------------------------------

content.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey) {
    switch (e.key.toLowerCase()) {
      case 's':
        // Flush thay đổi đang chờ debounce trước khi VS Code lưu file
        flushPendingSync();
        return; // không preventDefault — để VS Code xử lý save
      case 'b':
        e.preventDefault();
        document.execCommand('bold');
        scheduleSync();
        return;
      case 'i':
        e.preventDefault();
        document.execCommand('italic');
        scheduleSync();
        return;
      case 'e':
        e.preventDefault();
        toggleInlineCode();
        scheduleSync();
        return;
      case 'v':
        e.preventDefault();
        pasteFromClipboardApi();
        return;
    }
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'x') {
    e.preventDefault();
    document.execCommand('strikeThrough');
    scheduleSync();
    return;
  }
  // Lưới an toàn giữa phiên: nếu block cuối là khối "bẫy caret" (Mermaid/code/
  // bảng/công thức...) mà <p> thoát đã bị xóa hoặc chưa có, ArrowDown sẽ không
  // đi đâu được. Tạo lại <p> cuối rồi để trình duyệt tự đưa caret vào (KHÔNG
  // preventDefault). Nếu đã có <p> cuối thì đây là no-op. renderDocument lo ca
  // lúc mở file; đây lo ca DOM đổi trong lúc gõ (không re-render).
  if (e.key === 'ArrowDown' && !mod && !e.shiftKey && !e.altKey) {
    ensureTrailingParagraph();
  }
  // Tab trong list → thụt/bỏ thụt lề (tạo phân cấp). Trong ô bảng, chỉ thụt lề
  // khi caret ở ĐẦU mục (quy ước Notion/Docs) để không mất chức năng nhảy ô;
  // ngoài bảng thì Tab trong list luôn thụt lề như trước.
  if (e.key === 'Tab') {
    const sel = window.getSelection();
    const anchor = sel?.anchorNode ? closestElement(sel.anchorNode) : null;
    const li = anchor?.closest('li');
    const cell = anchor?.closest('td, th');
    const cellInside = cell && content.contains(cell);
    if (li && content.contains(li) && (!cellInside || caretAtStartOfListItem(li, sel))) {
      e.preventDefault();
      document.execCommand(e.shiftKey ? 'outdent' : 'indent');
      warnIfComplexTableList();
      scheduleSync();
      return;
    }
    if (cellInside) {
      e.preventDefault();
      navigateCells(cell as HTMLTableCellElement, e.shiftKey ? -1 : 1);
      return;
    }
  }
});

// ---------------------------------------------------------------------------
// Lưu vị trí scroll vào webview state (giữ khi tab ẩn/hiện)
// ---------------------------------------------------------------------------

let scrollSaveTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('scroll', saveScrollSoon);

function saveScrollSoon(): void {
  if (scrollSaveTimer !== undefined) {
    clearTimeout(scrollSaveTimer);
  }
  scrollSaveTimer = setTimeout(() => {
    vscode.setState({ scrollTop: window.scrollY });
  }, SCROLL_SAVE_DEBOUNCE_MS);
}

function restoreScroll(): void {
  const state = vscode.getState();
  if (state?.scrollTop) {
    window.scrollTo({ top: state.scrollTop });
  }
}
