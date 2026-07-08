/**
 * Toolbar định dạng chính: format text (bold/italic/heading/list/quote...),
 * chèn bảng/liên kết/ảnh, undo/redo, nút mục lục và nút copy @file cho Claude.
 */
import { addCheckbox, closestElement, escapeAttr, escapeHtml, svgIcon, type DomHelpers } from './dom-utils';
import { insertTable } from './table';
import type { PromptController } from './prompt';
import type { TocController } from './toc';
import type { VsCodeApi } from './vscode-api';

export interface ToolbarContext {
  vscode: VsCodeApi;
  scheduleSync: () => void;
  dom: DomHelpers;
  toc: TocController;
  promptInput: PromptController['promptInput'];
}

let content: HTMLElement;
let ctx: ToolbarContext;

/** Stroke chung cho icon nút định dạng — cùng nét với icon của table toolbar. */
const FMT_STROKE =
  'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"';

/** Icon mục lục: khung có vách ngăn bên phải — gợi đúng panel dock bên phải. */
const TOC_ICON = svgIcon(
  `<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" ${FMT_STROKE}/>` +
    `<path d="M9.75 2.75v10.5" ${FMT_STROKE}/>` +
    '<path d="M3.75 6.25h3.5M3.75 8.75h3.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" fill="none" opacity="0.55"/>'
);

/** Icon clipboard có ký tự @ — copy @file cho chat Claude Code. */
const CLAUDE_COPY_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<rect x="3" y="2.75" width="10" height="12" rx="1.25" stroke="currentColor" stroke-width="1.2" fill="none"/>' +
  '<path d="M5.75 2.75V2a1 1 0 0 1 1-1h2.5a1 1 0 0 1 1 1v.75" stroke="currentColor" stroke-width="1.2" fill="none"/>' +
  '<text x="8" y="11.75" text-anchor="middle" font-size="8" font-weight="bold" fill="currentColor">@</text>' +
  '</svg>';

/**
 * Icon SVG đơn sắc cho các nút cấu trúc / chèn (đồng bộ nét với table toolbar).
 * Các nút chữ (B, I, S, </>, H1–H3, ¶) giữ nguyên vì đã là quy ước quen thuộc.
 */
const FMT_ICONS = {
  ul: svgIcon(
    '<circle cx="2.4" cy="4" r="1.1" fill="currentColor"/>' +
      '<circle cx="2.4" cy="8" r="1.1" fill="currentColor"/>' +
      '<circle cx="2.4" cy="12" r="1.1" fill="currentColor"/>' +
      `<path d="M5.5 4h8.5M5.5 8h8.5M5.5 12h8.5" ${FMT_STROKE}/>`
  ),
  ol: svgIcon(
    `<path d="M6 4h8M6 8h8M6 12h8" ${FMT_STROKE}/>` +
      '<text x="0.9" y="5.7" font-size="5" font-weight="700" fill="currentColor">1</text>' +
      '<text x="0.9" y="9.7" font-size="5" font-weight="700" fill="currentColor">2</text>' +
      '<text x="0.9" y="13.7" font-size="5" font-weight="700" fill="currentColor">3</text>'
  ),
  task: svgIcon(
    `<rect x="1.5" y="2.25" width="5" height="5" rx="1.2" ${FMT_STROKE}/>` +
      `<path d="M2.7 4.8l1.15 1.1 1.95-2.2" ${FMT_STROKE}/>` +
      `<rect x="1.5" y="8.75" width="5" height="5" rx="1.2" ${FMT_STROKE}/>` +
      `<path d="M8.75 4.75h5.25M8.75 11.25h5.25" ${FMT_STROKE}/>`
  ),
  quote: svgIcon(
    '<rect x="2" y="3" width="2.25" height="10" rx="1" fill="currentColor"/>' +
      `<path d="M6.75 5h7.25M6.75 8h7.25M6.75 11h4.75" ${FMT_STROKE}/>`
  ),
  codeBlock: svgIcon(
    `<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" ${FMT_STROKE}/>` +
      `<path d="M6.4 6L4.6 8l1.8 2M9.6 6l1.8 2-1.8 2" ${FMT_STROKE}/>`
  ),
  table: svgIcon(
    `<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" ${FMT_STROKE}/>` +
      `<path d="M1.75 6.25h12.5M1.75 9.75h12.5M6.5 2.75v10.5" ${FMT_STROKE}/>`
  ),
  hr: svgIcon(
    `<path d="M2 8h12" ${FMT_STROKE}/>` +
      '<path d="M4 4.75h8M4 11.25h8" stroke="currentColor" stroke-width="1" stroke-linecap="round" fill="none" opacity="0.4"/>'
  ),
  link: svgIcon(
    `<path d="M6.5 9.5l3-3" ${FMT_STROKE}/>` +
      `<path d="M8 5.6l0.8-0.8a2.55 2.55 0 0 1 3.6 3.6L11.5 9.1" ${FMT_STROKE}/>` +
      `<path d="M8 10.4l-0.8 0.8a2.55 2.55 0 0 1-3.6-3.6L4.5 6.9" ${FMT_STROKE}/>`
  ),
  image: svgIcon(
    `<rect x="1.75" y="3" width="12.5" height="10" rx="1.75" ${FMT_STROKE}/>` +
      '<circle cx="5.4" cy="6.4" r="1.25" fill="currentColor"/>' +
      `<path d="M2.5 12.25l3.25-3.25 2.25 2.25 2.5-2.5 3 3" ${FMT_STROKE}/>`
  ),
  undo: svgIcon(
    `<path d="M5.75 6.5H10a3.5 3.5 0 1 1 0 7H6.5" ${FMT_STROKE}/>` +
      `<path d="M7.75 4.25L5.25 6.75l2.5 2.5" ${FMT_STROKE}/>`
  ),
  redo: svgIcon(
    `<path d="M10.25 6.5H6a3.5 3.5 0 1 0 0 7h3.5" ${FMT_STROKE}/>` +
      `<path d="M8.25 4.25l2.5 2.5-2.5 2.5" ${FMT_STROKE}/>`
  ),
};

interface ToolbarItem {
  label: string;
  /** SVG markup — nếu có thì dùng thay label text. */
  icon?: string;
  title: string;
  action: () => void;
  separatorBefore?: boolean;
  /** id gán cho <button> — dùng để đồng bộ trạng thái nút (vd. nút mục lục). */
  id?: string;
  /** Đẩy nút (và mọi nút sau nó) sang mép phải toolbar — nhóm tiện ích. */
  alignRight?: boolean;
  /**
   * true nếu action tự mở popup nhập liệu bất đồng bộ (chèn liên kết/ảnh).
   * Popup tự focus vào ô nhập và tự restore selection khi đóng (xem prompt.ts) —
   * nếu vẫn để click handler gọi content.focus() ngay, nó sẽ cướp focus khỏi ô
   * nhập trong lúc selection đang rỗng, khiến caret nhảy về đầu file.
   */
  opensAsyncPrompt?: boolean;
}

/** Đồng bộ trạng thái "đang bật" của nút mục lục trên toolbar. */
function updateTocButton(): void {
  document.getElementById('toc-toggle')?.classList.toggle('active', ctx.toc.isOpen());
}

const toolbarItems: ToolbarItem[] = [
  { label: 'B', title: 'Đậm (⌘B)', action: () => document.execCommand('bold') },
  { label: 'I', title: 'Nghiêng (⌘I)', action: () => document.execCommand('italic') },
  { label: 'S', title: 'Gạch ngang (⌘⇧X)', action: () => document.execCommand('strikeThrough') },
  { label: '</>', title: 'Inline code (⌘E)', action: toggleInlineCode },
  { label: 'H1', title: 'Tiêu đề 1', action: () => formatHeading('h1'), separatorBefore: true },
  { label: 'H2', title: 'Tiêu đề 2', action: () => formatHeading('h2') },
  { label: 'H3', title: 'Tiêu đề 3', action: () => formatHeading('h3') },
  { label: '¶', title: 'Đoạn văn thường', action: () => formatHeading('p') },
  {
    label: '•',
    icon: FMT_ICONS.ul,
    title: 'Danh sách chấm',
    action: () => document.execCommand('insertUnorderedList'),
    separatorBefore: true,
  },
  { label: '1.', icon: FMT_ICONS.ol, title: 'Danh sách số', action: () => document.execCommand('insertOrderedList') },
  { label: '☑', icon: FMT_ICONS.task, title: 'Task list', action: toggleTaskItem },
  {
    label: '❝',
    icon: FMT_ICONS.quote,
    title: 'Trích dẫn (bấm lại để bỏ)',
    action: toggleBlockquote,
    separatorBefore: true,
  },
  { label: '{ }', icon: FMT_ICONS.codeBlock, title: 'Khối code', action: insertCodeBlock },
  { label: '⊞', icon: FMT_ICONS.table, title: 'Chèn bảng 3×3', action: insertTable },
  {
    label: '—',
    icon: FMT_ICONS.hr,
    title: 'Đường kẻ ngang',
    action: () => document.execCommand('insertHTML', false, '<hr><p><br></p>'),
  },
  {
    label: '🔗',
    icon: FMT_ICONS.link,
    title: 'Chèn liên kết',
    action: insertLink,
    separatorBefore: true,
    opensAsyncPrompt: true,
  },
  {
    label: '🖼',
    icon: FMT_ICONS.image,
    title: 'Chèn ảnh (đường dẫn)',
    action: insertImage,
    opensAsyncPrompt: true,
  },
  { label: '↶', icon: FMT_ICONS.undo, title: 'Hoàn tác (⌘Z)', action: () => document.execCommand('undo'), separatorBefore: true },
  { label: '↷', icon: FMT_ICONS.redo, title: 'Làm lại (⌘⇧Z)', action: () => document.execCommand('redo') },
  {
    label: '@',
    icon: CLAUDE_COPY_ICON,
    title: 'Copy "@file" vào clipboard cho chat Claude Code — tự mở/focus ô chat, bạn chỉ cần dán (⌘V)',
    action: () => ctx.vscode.postMessage({ type: 'addToClaudeContext' }),
    alignRight: true,
  },
  {
    label: '☰',
    icon: TOC_ICON,
    title: 'Hiện/ẩn mục lục (Table of Contents)',
    action: () => {
      ctx.toc.toggle();
      updateTocButton();
    },
    id: 'toc-toggle',
  },
];

export function initToolbar(contentEl: HTMLElement, toolbarEl: HTMLElement, context: ToolbarContext): void {
  content = contentEl;
  ctx = context;

  for (const item of toolbarItems) {
    if (item.separatorBefore) {
      const sep = document.createElement('span');
      sep.className = 'toolbar-sep';
      toolbarEl.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    if (item.id) {
      btn.id = item.id;
    }
    if (item.alignRight) {
      btn.classList.add('toolbar-push-right');
    }
    if (item.icon) {
      btn.innerHTML = item.icon;
    } else {
      btn.textContent = item.label;
    }
    btn.title = item.title;
    // mousedown + preventDefault để không mất selection trong #content
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      item.action();
      // Action mở popup bất đồng bộ (chèn liên kết/ảnh) tự lo focus + restore
      // selection khi đóng — focus lại content ngay ở đây sẽ cướp focus khỏi
      // ô nhập của popup và làm caret nhảy về đầu file.
      if (!item.opensAsyncPrompt) {
        content.focus();
      }
      ctx.scheduleSync();
    });
    toolbarEl.appendChild(btn);
  }
}

/**
 * Đổi block hiện tại thành heading/đoạn văn. Không dùng execCommand
 * formatBlock vì Chrome có bug tạo heading lồng nhau khi bấm lặp lại
 * (h1 trong h1 → font-size 2em × 2em phình dần). Bấm lại cùng cấp
 * heading → trở về đoạn văn (toggle).
 */
function formatHeading(tag: string): void {
  const sel = window.getSelection();
  const anchor = sel?.anchorNode ? closestElement(sel.anchorNode) : null;
  if (!anchor) {
    return;
  }
  if (anchor.closest('td, th')) {
    return; // markdown không có heading trong ô bảng
  }
  const block = anchor.closest('h1, h2, h3, h4, h5, h6, p') as HTMLElement | null;
  if (!block || !content.contains(block) || block === content) {
    document.execCommand('formatBlock', false, tag);
    ctx.scheduleSync();
    return;
  }
  const target = tag.toUpperCase();
  if (block.tagName === target) {
    if (target !== 'P') {
      ctx.dom.replaceBlockTag(block, 'p');
    }
  } else {
    ctx.dom.replaceBlockTag(block, tag);
  }
  ctx.scheduleSync();
}

/** Toggle blockquote — formatBlock lặp lại sẽ lồng quote, nên tự xử lý. */
function toggleBlockquote(): void {
  const sel = window.getSelection();
  const anchor = sel?.anchorNode ? closestElement(sel.anchorNode) : null;
  const bq = anchor?.closest('blockquote');
  if (bq && content.contains(bq)) {
    const saved = sel && sel.rangeCount > 0 ? { node: sel.anchorNode, offset: sel.anchorOffset } : null;
    const parent = bq.parentNode;
    const firstChild: Node | null = bq.firstChild;
    while (bq.firstChild) {
      parent?.insertBefore(bq.firstChild, bq);
    }
    bq.remove();
    if (saved?.node && saved.node.isConnected) {
      const range = document.createRange();
      try {
        range.setStart(saved.node, saved.offset);
      } catch {
        if (firstChild instanceof Element) {
          range.selectNodeContents(firstChild);
        }
      }
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
      content.focus();
    }
  } else {
    document.execCommand('formatBlock', false, 'blockquote');
  }
  ctx.scheduleSync();
}

function toggleTaskItem(): void {
  const sel = window.getSelection();
  const li = sel?.anchorNode ? closestElement(sel.anchorNode)?.closest('li') : null;
  if (!li) {
    // Chưa ở trong list → tạo list trước rồi thêm checkbox
    document.execCommand('insertUnorderedList');
    const sel2 = window.getSelection();
    const li2 = sel2?.anchorNode ? closestElement(sel2.anchorNode)?.closest('li') : null;
    if (li2) {
      addCheckbox(li2);
    }
    return;
  }
  const existing = li.querySelector(':scope > input[type="checkbox"]');
  if (existing) {
    existing.remove();
    li.classList.remove('task-list-item');
    li.parentElement?.classList.remove('contains-task-list');
  } else {
    addCheckbox(li);
  }
}

function insertCodeBlock(): void {
  const selectedText = window.getSelection()?.toString() ?? '';
  const content = selectedText ? escapeHtml(selectedText) : 'code';
  document.execCommand(
    'insertHTML',
    false,
    `<pre><code class="language-plaintext">${content}</code></pre><p><br></p>`
  );
}

function insertLink(): void {
  const selectedText = window.getSelection()?.toString().trim() ?? '';
  ctx.promptInput(
    'URL liên kết:',
    'https://… hoặc gõ tên file trong dự án',
    (url, displayText) => {
      if (!url) {
        return;
      }
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        document.execCommand('createLink', false, url);
      } else {
        document.execCommand(
          'insertHTML',
          false,
          `<a href="${escapeAttr(url)}">${escapeHtml(displayText ?? url)}</a>`
        );
      }
      ctx.scheduleSync();
    },
    { fileSearchQuery: selectedText }
  );
}

function insertImage(): void {
  ctx.promptInput('Đường dẫn ảnh (tương đối hoặc URL):', '', (src) => {
    if (!src) {
      return;
    }
    document.execCommand('insertHTML', false, `<img src="${escapeAttr(src)}" alt="">`);
    ctx.scheduleSync();
  });
}

export function toggleInlineCode(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return;
  }
  const range = sel.getRangeAt(0);
  const existing = closestElement(range.startContainer)?.closest('code');
  if (existing && !existing.closest('pre')) {
    // Bỏ inline code: thay <code> bằng text con
    const parent = existing.parentNode;
    if (parent) {
      while (existing.firstChild) {
        parent.insertBefore(existing.firstChild, existing);
      }
      parent.removeChild(existing);
    }
    return;
  }
  if (range.collapsed) {
    return;
  }
  const code = document.createElement('code');
  try {
    range.surroundContents(code);
  } catch {
    // Vùng chọn cắt ngang nhiều node — bọc bằng cách extract
    const frag = range.extractContents();
    code.appendChild(frag);
    range.insertNode(code);
  }
  sel.removeAllRanges();
}
