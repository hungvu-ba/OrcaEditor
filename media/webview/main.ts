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
  prepareDomForSerialize,
  type PipelineConfig,
} from './pipeline';
import { initSearch } from './search';
import { initToc } from './toc';
import { closestElement, createDomHelpers } from './dom-utils';
import { initPrompt } from './prompt';
import { initToolbar, toggleInlineCode } from './toolbar';
import { initTable, navigateCells, warnIfComplexTableList } from './table';
import { initInputRules, caretAtStartOfListItem } from './input-rules';
import type { VsCodeApi } from './vscode-api';

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const content = document.getElementById('content') as HTMLDivElement;
const toolbarEl = document.getElementById('toolbar') as HTMLDivElement;

let renderer: MarkdownRenderer | undefined;
const turndown = createTurndown();
const search = initSearch(content);
const toc = initToc(content);
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
const SYNC_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Khởi tạo
// ---------------------------------------------------------------------------

document.execCommand('defaultParagraphSeparator', false, 'p');

/** Kết quả tìm file cho popup chèn link — do prompt.ts đăng ký khi đang mở. */
interface FileSuggestion {
  path: string;
  name: string;
  dir: string;
}

window.addEventListener('message', (event) => {
  const msg = event.data as {
    type: string;
    text?: string;
    config?: PipelineConfig & Record<string, unknown>;
    requestId?: number;
    files?: FileSuggestion[];
  };
  switch (msg.type) {
    case 'init': {
      const cfg = msg.config ?? { breaks: false, linkify: true };
      renderer = new MarkdownRenderer({ breaks: !!cfg.breaks, linkify: !!cfg.linkify });
      applyPreviewFontSettings(cfg);
      renderDocument(msg.text ?? '');
      restoreScroll();
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

vscode.postMessage({ type: 'ready' });

function applyPreviewFontSettings(cfg: Record<string, unknown>): void {
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
  postProcessMathDom(content, document);
  ensureEditablePlaceholder();
  table.hideTableToolbar();
  window.scrollTo({ top: scrollTop });
  saveScrollSoon();
  // Nội dung vừa dựng lại — range highlight cũ đã hỏng, tìm lại nếu đang mở.
  search.refresh();
  // Heading có thể đã đổi — dựng lại mục lục nếu panel đang mở.
  toc.refresh();
}

/** contentEditable cần ít nhất một block để đặt caret. */
function ensureEditablePlaceholder(): void {
  if (!content.firstElementChild) {
    content.innerHTML = '<p><br></p>';
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
  const markdown = serialize();
  if (markdown === currentText) {
    return;
  }
  currentText = markdown;
  vscode.postMessage({ type: 'edit', text: markdown });
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

content.addEventListener('input', () => {
  fixOrphanNestedListItems();
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

// Paste: chèn plain text (tránh dán HTML bừa từ ngoài vào làm hỏng cấu trúc).
content.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (text) {
    document.execCommand('insertText', false, text);
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
        document.execCommand('insertText', false, text);
      }
    })
    .catch(() => {
      /* Không có quyền clipboard-read — bỏ qua, đã có handler 'paste' ở trên lo trường hợp còn lại. */
    });
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
  vscode.postMessage({ type: 'openLink', href });
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
  }, 200);
}

function restoreScroll(): void {
  const state = vscode.getState();
  if (state?.scrollTop) {
    window.scrollTo({ top: state.scrollTop });
  }
}
