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
import { initSelectHighlight } from './select-highlight';
import { initCrossFileSearch } from './cross-file-search';
import { initToc } from './toc';
import { initMermaid } from './mermaid';
import { initMathEdit } from './math-edit';
import { initLineGutter } from './gutter';
import { buildBlockMap, type BlockEntry } from './block-map';
import { initDragDrop } from './drag-drop';
import { closestElement, createDomHelpers, scrollBehavior } from './dom-utils';
import { initPrompt } from './prompt';
import { initPasteImage } from './paste-image';
import { initReadability } from './readability';
import { initImageZoom } from './image-zoom';
import { initToolbar, syncTocButton, syncReadingButtons, toggleInlineCode, isPopoverOpen } from './toolbar';
import { initTable, navigateCells, warnIfComplexTableList, fitTableColumns } from './table';
import { initStickyTableHeader } from './table-sticky-header';
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
// C1: Feature A tự tắt hẳn (không paint, không build overview strip) khi Ctrl+F đang mở —
// truyền accessor isOpen() của search thay vì cả controller để giữ phụ thuộc tối thiểu.
const selectHighlight = initSelectHighlight(content, () => search.isOpen());
const crossFileSearch = initCrossFileSearch(content, vscode);
const toc = initToc(content, vscode);
const mermaidView = initMermaid(content);
initMathEdit(content);
const lineGutter = initLineGutter(content, gutterEl, () => renderer);
let lineNumbersEnabled = false;
const dom = createDomHelpers(content);
// US-17.3: block reorder engine — needs lineGutter (refresh after a move) and
// scheduleSync (declared below; safe to reference here, function declarations hoist).
const dragDrop = initDragDrop(content, { scheduleSync, dom, lineGutter });
const prompt = initPrompt(vscode, dom);
const pasteImage = initPasteImage(vscode, { scheduleSync, dom });
const table = initTable(content, toolbarEl, { scheduleSync, dom });
// US-19.14: header cột "dính" dưới toolbar khi cuộn bảng dài (đọc tên cột liên tục).
const stickyTableHeader = initStickyTableHeader(content, toolbarEl);
// Reading Mode (US-19.x) — controller lái CSS class/var. State per-tab, session-
// only (bug 0715 mục 4): sống trong webview instance này, KHÔNG persist về host.
const readability = initReadability({
  content,
  syncButtons: syncReadingButtons,
  // US-19.11 (bug 0715 mục 3): palette là theme GLOBAL — báo host ghi config +
  // đồng bộ mọi tab .md. Reading Mode/Zen vẫn per-tab (không gửi lên host).
  onPaletteChange: (palette) => vscode.postMessage({ type: 'setReadingPalette', palette }),
  // Zen reveal không được ẩn toolbar khi đang mở dropdown (xem ReadabilityDeps).
  isPopoverOpen,
});
initImageZoom(content);
initToolbar(content, toolbarEl, {
  vscode,
  scheduleSync,
  dom,
  toc,
  readability,
  promptInput: prompt.promptInput,
  insertMarkdown: insertMarkdownAtCaret,
});
initInputRules(content, { scheduleSync, dom });

/**
 * Đồng bộ chiều cao toolbar (sticky, top:0) vào CSS var `--toolbar-height` để
 * `scroll-padding-top` (editor.css) chừa đúng khoảng đó: mọi scrollIntoView
 * (block:'start') khi nhảy heading/anchor/reveal-source-line dừng NGAY DƯỚI
 * toolbar thay vì để heading trốn sau toolbar (bug 0715: heading đầu file bị
 * toolbar che, không cuộn lên xem được vì đã chạm đỉnh trang). Dùng
 * ResizeObserver vì toolbar cao/thấp đổi theo font/độ rộng tab.
 */
function syncToolbarHeightVar(): void {
  const h = toolbarEl.offsetHeight;
  document.documentElement.style.setProperty('--toolbar-height', `${h}px`);
}
new ResizeObserver(syncToolbarHeightVar).observe(toolbarEl);
syncToolbarHeightVar();

/** Markdown hiện tại mà webview đã biết (đã render hoặc đã gửi lên). */
let currentText = '';
let syncTimer: ReturnType<typeof setTimeout> | undefined;
/** Block Map (HLR mục 18, US-18.1) — chỉ mục block cấp cao nhất, dựng lại ở cuối mỗi renderDocument(). */
let blockMap: BlockEntry[] = [];

// ---------------------------------------------------------------------------
// Khởi tạo
// ---------------------------------------------------------------------------

document.execCommand('defaultParagraphSeparator', false, 'p');

/**
 * Tab (webview) hẹp hơn nửa màn hình vật lý → không đủ chỗ cho panel mục lục
 * cố định bên phải mà không đè lên nội dung. So window.innerWidth (bề rộng
 * tab) với screen.width (màn hình) chứ không phải bề rộng #content, vì mục
 * đích là phát hiện tab đang bị chia đôi/thu nhỏ, không phải nội dung dài hay
 * ngắn.
 */
function isNarrowViewport(): boolean {
  return window.innerWidth < window.screen.width / 2;
}

/**
 * Có nên tự mở panel mục lục lúc khởi tạo không? Ngoài cờ config + viewport đủ
 * rộng, còn yêu cầu tài liệu có ÍT NHẤT 1 heading — file mới/rỗng hoặc không có
 * heading thì TOC luôn trống ("No headings yet"), tự bật lên chỉ tổ chiếm chỗ
 * (bug report 2026-07-15 mục 6). Người dùng vẫn bật tay bằng nút toolbar được.
 */
function shouldAutoOpenToc(flag: boolean | undefined): boolean {
  return (
    flag !== false &&
    !toc.isOpen() &&
    !isNarrowViewport() &&
    content.querySelector('h1, h2, h3, h4, h5, h6') !== null
  );
}

/**
 * Cờ autoOpenToc lần gần nhất đã biết. `configUpdate` được host phát cho MỌI
 * thay đổi setting (kể cả bật Reading/Focus mode) — nếu cứ thế gọi lại
 * shouldAutoOpenToc thì mỗi lần bấm nút đó TOC lại nhảy ra. Chỉ auto-open khi cờ
 * này THỰC SỰ đổi (hoặc lần init đầu), không phải mỗi lần config đổi bất kỳ.
 */
let lastAutoOpenToc: boolean | undefined;

window.addEventListener('message', (event) => {
  const msg = event.data as HostToWebview;
  switch (msg.type) {
    case 'init': {
      const cfg: Partial<InitConfig> = msg.config ?? { breaks: false, linkify: true };
      renderer = new MarkdownRenderer({ breaks: !!cfg.breaks, linkify: !!cfg.linkify });
      applyPreviewFontSettings(cfg);
      lineNumbersEnabled = cfg.showLineNumbers !== false;
      document.body.classList.toggle('md-line-numbers', lineNumbersEnabled);
      crossFileSearch.setDefaultScope(cfg.crossFileSearchScope ?? 'markdown');
      if (cfg.readability) {
        readability.applyFromHost(cfg.readability);
      }
      renderDocument(msg.text ?? '');
      // C6: nếu panel này vừa được mở từ 1 kết quả tìm xuyên file, ưu tiên
      // scroll tới đúng vị trí match đó thay vì khôi phục scrollTop cũ đã
      // lưu — chỉ fallback về restoreScroll() cho luồng mở file bình thường.
      if (msg.reveal) {
        lineGutter.scrollToSourceLine(msg.reveal.line + 1, msg.reveal.character, msg.reveal.length, msg.reveal.matchText);
      } else {
        restoreScroll();
      }
      if (shouldAutoOpenToc(cfg.autoOpenToc)) {
        toc.toggle();
        syncTocButton();
      }
      lastAutoOpenToc = cfg.autoOpenToc;
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
    case 'pasteImageResult': {
      pasteImage.notifyResult(msg.requestId, msg.relativePath, msg.error);
      break;
    }
    case 'crossFileSearch:result': {
      crossFileSearch.notifyResult(msg.requestId, msg.groups, msg.truncated, msg.usedFallback);
      break;
    }
    case 'scrollToPosition': {
      // C6b: file .md đã có panel mở sẵn — host gửi thẳng message này thay vì
      // qua 'init' vì resolveCustomTextEditor không chạy lại trong trường hợp này.
      lineGutter.scrollToSourceLine(msg.line + 1, msg.character, msg.length, msg.matchText);
      break;
    }
    case 'configUpdate': {
      // Reading Mode/preset/zen KHÔNG áp qua configUpdate: state per-tab,
      // session-only (bug 0715 mục 4). NGOẠI LỆ: palette là theme GLOBAL
      // (US-19.11, bug 0715 mục 3) → luôn đồng bộ theo host cho mọi tab .md.
      readability.applyPaletteFromHost(msg.palette);
      lineNumbersEnabled = msg.showLineNumbers !== false;
      document.body.classList.toggle('md-line-numbers', lineNumbersEnabled);
      if (lineNumbersEnabled) {
        lineGutter.refreshFromDom();
      }
      // Chỉ auto-open khi cờ autoOpenToc đổi (vd. user vừa bật setting đó) —
      // KHÔNG bật lại TOC khi configUpdate đến vì đổi Reading/Focus/thứ khác.
      if (msg.autoOpenToc !== lastAutoOpenToc && shouldAutoOpenToc(msg.autoOpenToc)) {
        toc.toggle();
        syncTocButton();
      }
      lastAutoOpenToc = msg.autoOpenToc;
      break;
    }
  }
});

postToHost({ type: 'ready' });

// Tab bị thu hẹp xuống dưới nửa màn hình (vd. chia đôi split editor) → tự ẩn
// mục lục để không choán chỗ nội dung. Chỉ tự ẩn đúng lúc CHUYỂN từ rộng sang
// hẹp — nếu user tự bật lại panel trong lúc tab vẫn đang hẹp, không tự đóng
// lại lần nữa (tôn trọng lựa chọn thủ công của họ) cho tới lần hẹp tiếp theo.
let wasNarrowViewport = isNarrowViewport();
window.addEventListener('resize', () => {
  const narrow = isNarrowViewport();
  if (narrow && !wasNarrowViewport && toc.isOpen()) {
    toc.toggle();
    syncTocButton();
  }
  wasNarrowViewport = narrow;
});

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
  // Co từng cột bảng vừa dựng về vừa nội dung (cột ngắn không bị ép rộng bằng
  // sàn 14ch của cột dài nhất) — phải chạy TRƯỚC stickyTableHeader.refresh() vì
  // clone header đo bề rộng cột từ DOM tại thời điểm gọi.
  content.querySelectorAll('table').forEach((t) => fitTableColumns(t as HTMLTableElement));
  blockMap = buildBlockMap(content, markdown, blockMap);
  // US-19.15: dò ngôn ngữ tài liệu (Việt/khác) để preset Academic Paper chọn font
  // đúng — chạy sau khi #content đã dựng lại nội dung mới.
  readability.refreshContentLanguage();
  window.scrollTo({ top: scrollTop });
  saveScrollSoon();
  // Nội dung vừa dựng lại — range highlight cũ đã hỏng, tìm lại nếu đang mở.
  search.refresh();
  // Selection cũ (nếu có) đã mất ý nghĩa sau khi DOM đổi — dọn highlight.
  selectHighlight.refresh();
  // Vị trí icon/selection cũ không còn hợp lệ sau khi DOM đổi — ẩn icon/đóng popover.
  crossFileSearch.refresh();
  // Heading có thể đã đổi — dựng lại mục lục nếu panel đang mở.
  toc.refresh();
  // Bảng vừa dựng lại — bỏ cache header dính cũ, tính lại theo DOM mới.
  stickyTableHeader.refresh();
  // US-17.3: drop any in-flight drag / hover handle referencing now-stale nodes.
  dragDrop.refresh();
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

/**
 * Khối "atom" toàn phần: mọi vùng nhìn thấy đều contenteditable=false, nên
 * KHÔNG có vị trí caret nào bên trong lẫn "ngay sau" nó nếu phần tử kế tiếp
 * cũng là một khối bẫy caret (hoặc không có phần tử kế tiếp — trường hợp con
 * cuối của blockquote/li, nơi ensureTrailingParagraph không với tới).
 */
const ATOM_BLOCK_SELECTOR = '.md-mermaid, .md-math-block';

/**
 * Đảm bảo SAU MỖI khối Mermaid/math block đều có chỗ đặt caret: nếu phần tử
 * kế tiếp không phải block gõ được (hoặc không tồn tại) thì chèn một <p> rỗng
 * ngay sau. Cùng lý do an-toàn-serialize với ensureTrailingParagraph: <p> rỗng
 * bị rule 'emptyParagraph' của turndown bỏ khi lưu nên không đổi Markdown.
 */
function ensureCaretSpotAfterAtomBlocks(): void {
  for (const atom of Array.from(content.querySelectorAll(ATOM_BLOCK_SELECTOR))) {
    const next = atom.nextElementSibling;
    if (!next || next.matches(TRAILING_TRAP_SELECTOR)) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      atom.parentNode?.insertBefore(p, atom.nextSibling);
    }
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
  // Gõ trong ô bảng có thể đổi bề rộng cột (auto-layout co/giãn theo nội dung) —
  // clone header dính (nếu đang hiện) cache bề rộng cột cũ, không tự nhận ra
  // thay đổi này (chỉ dựng lại khi ĐỔI bảng, xem table-sticky-header.ts), gây
  // lệch cột với header thật. Refresh để lần update() kế tiếp dựng lại clone.
  if ((e.target as Element | null)?.closest?.('table')) {
    stickyTableHeader.refresh();
  }
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
function selectionAsMarkdown(): string | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return null;
  }
  const wrapper = document.createElement('div');
  wrapper.appendChild(sel.getRangeAt(0).cloneContents());
  prepareDomForSerialize(wrapper, document);
  const md = normalizeMarkdown(turndown.turndown(wrapper));
  return md.trim() ? md : null;
}

function copySelectionAsMarkdown(e: ClipboardEvent): boolean {
  const md = selectionAsMarkdown();
  if (md === null) {
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

/**
 * Fallback cho Cmd/Ctrl+X (giống pasteFromClipboardApi cho Cmd/Ctrl+V): iframe
 * webview lồng nhau của VS Code custom editor không phải lúc nào cũng bắn sự
 * kiện 'cut' kèm clipboardData khi phím tắt được gõ — khi đó handler 'cut' ở
 * trên không chạy nên Cmd+X không cắt được gì. Dùng thẳng async Clipboard API
 * (VS Code cấp quyền cho webview) để ghi Markdown của vùng chọn vào clipboard,
 * rồi xoá vùng chọn. Trả về false nếu không có gì để cắt (để không preventDefault
 * thừa). Ghi clipboard là async nhưng `md` đã chốt trước khi xoá nên không race.
 */
function cutSelectionViaClipboardApi(): boolean {
  const md = selectionAsMarkdown();
  if (md === null) {
    return false;
  }
  navigator.clipboard.writeText(md).catch(() => {
    /* Không có quyền clipboard-write — handler 'cut' event ở trên lo trường hợp còn lại. */
  });
  document.execCommand('delete');
  scheduleSync();
  return true;
}

// Paste: chỉ lấy text/plain (tránh dán HTML bừa từ ngoài vào làm hỏng cấu
// trúc), rồi render lại bằng chính markdown-it của app. Nếu chèn thẳng làm
// text thô, cú pháp Markdown copy từ file .md khác (**bold**, # heading,
// `code`, [link](...)...) sẽ nằm lại như text thường; khi serialize ngược về
// Markdown, turndown sẽ escape các ký tự đó (\*\*bold\*\*...) để giữ nguyên ý
// "đây là text thường" — kết quả là toàn bộ format bị chèn thêm dấu \ và vỡ.
content.addEventListener('paste', (e) => {
  e.preventDefault();
  if (pasteImage.handlePasteEvent(e)) {
    return;
  }
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
  void pasteImage.tryPasteImageFromClipboardApi().then((handledImage) => {
    if (handledImage) {
      return;
    }
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
 * Chèn markdown tại vị trí caret hiện tại — dùng cho toolbar (Math US-4.11,
 * Mermaid US-4.12), khác "dán" chỉ ở tên gọi/ngữ cảnh gọi: text luôn là một
 * mảnh nhỏ tự sinh (vd. `$x^2$`, fence ```mermaid```), nên tái dùng nguyên
 * pipeline renderPasteHtml → insertHTML → mermaidView.renderAll() của
 * insertPastedMarkdown, cộng thêm một bước riêng cho khối atom (Mermaid /
 * math block): chèn kèm <p> rỗng ngay sau khối để caret có chỗ đứng gõ tiếp
 * (cùng pattern với nút HR/Code block/Table — insertHTML đặt caret vào block
 * cuối của chuỗi chèn), rồi rà lại TẤT CẢ khối atom trong tài liệu — chèn
 * ngay cạnh một khối Mermaid có sẵn sẽ làm hai khối dính nhau, không còn chỗ
 * click caret vào giữa.
 */
function insertMarkdownAtCaret(text: string): void {
  const html = renderPasteHtml(text);
  if (!html) {
    document.execCommand('insertText', false, text);
    return;
  }
  const probe = document.createElement('div');
  probe.innerHTML = html;
  const endsWithAtom = probe.lastElementChild?.matches(ATOM_BLOCK_SELECTOR) ?? false;
  document.execCommand('insertHTML', false, endsWithAtom ? `${html}<p><br></p>` : html);
  if (endsWithAtom) {
    ensureCaretSpotAfterAtomBlocks();
  }
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
    // KHÔNG preventDefault: click mặc định đã tự toggle target.checked. Nếu
    // preventDefault (như trước đây), spec bắt buộc browser revert lại
    // .checked về giá trị trước click sau khi dispatch xong — attribute thì
    // đã set nhưng property bị revert nên checkbox không đổi trạng thái hiển
    // thị/tương tác được (đúng lỗi user báo). Ở đây chỉ đồng bộ attribute
    // theo property đã được browser toggle sẵn.
    if (target.checked) {
      target.setAttribute('checked', 'checked');
    } else {
      target.removeAttribute('checked');
    }
    scheduleSync();
    return;
  }
  // Click vào ảnh: trình duyệt mặc định "chọn ảnh như object" (không có vị
  // trí caret bên trong ảnh) khiến người dùng không Enter xuống dòng được
  // ngay sau ảnh. Đặt caret ngay bên phải ảnh thay vào đó. Bỏ qua khi giữ
  // Cmd/Ctrl để click ảnh nằm trong link vẫn mở link như bình thường (nhánh anchor bên dưới).
  const img = target.closest('img');
  if (img && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    dom.placeCaretAfter(img);
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
      h.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Phím tắt định dạng
// ---------------------------------------------------------------------------

/**
 * US-19.7 (keyboard nav): nhảy giữa các heading bằng phím — Alt+Shift+↓ tới
 * heading kế, Alt+Shift+↑ về heading trước. Chọn combo Alt+Shift+Arrow để
 * không đè điều hướng theo từ/khối sẵn có của contentEditable. Neo theo caret
 * nếu nằm trong #content, ngược lại theo mép trên khung nhìn.
 */
function jumpHeading(dir: 1 | -1): void {
  const headings = Array.from(content.querySelectorAll('h1, h2, h3, h4, h5, h6')) as HTMLElement[];
  if (headings.length === 0) {
    return;
  }
  const sel = window.getSelection();
  const anchor = sel?.anchorNode ? closestElement(sel.anchorNode) : null;
  const currentHeading = anchor?.closest('h1, h2, h3, h4, h5, h6') as HTMLElement | null;
  let idx: number;
  if (currentHeading && content.contains(currentHeading)) {
    idx = headings.indexOf(currentHeading) + dir;
  } else {
    // Không có caret trong heading → chọn theo vị trí cuộn (mép trên khung nhìn).
    const guard = (document.getElementById('toolbar')?.offsetHeight ?? 0) + 8;
    if (dir === 1) {
      idx = headings.findIndex((h) => h.getBoundingClientRect().top > guard + 1);
    } else {
      idx = -1;
      for (let i = headings.length - 1; i >= 0; i--) {
        if (headings[i].getBoundingClientRect().top < guard - 1) {
          idx = i;
          break;
        }
      }
    }
  }
  if (idx < 0 || idx >= headings.length) {
    return;
  }
  const target = headings[idx];
  target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

content.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  // US-19.7: Alt+Shift+↑/↓ nhảy giữa heading (không cần Ctrl/Cmd).
  if (e.altKey && e.shiftKey && !mod && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    jumpHeading(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
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
      case 'x':
        // Chỉ chặn mặc định khi thực sự có vùng chọn để cắt; nếu không, để trình
        // duyệt xử lý bình thường (con trỏ rỗng — không có gì để cắt).
        if (cutSelectionViaClipboardApi()) {
          e.preventDefault();
        }
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
    // merge: đừng xoá tocWidth (do toc.ts ghi) khi chỉ cập nhật scrollTop.
    vscode.setState({ ...vscode.getState(), scrollTop: window.scrollY });
  }, SCROLL_SAVE_DEBOUNCE_MS);
}

function restoreScroll(): void {
  const state = vscode.getState();
  if (state?.scrollTop) {
    window.scrollTo({ top: state.scrollTop });
  }
}
