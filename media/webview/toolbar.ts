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
  /** Render markdown thật (renderer.render) rồi chèn tại caret — dùng cho Math (US-4.11)/Mermaid (US-4.12). */
  insertMarkdown: (text: string) => void;
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

/** Icon trang tài liệu góc gấp + dấu </> — mở file .md dạng text thô cạnh bên. */
const RAW_SOURCE_ICON = svgIcon(
  `<path d="M4.25 2.75h5.5l3 3v7a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" ${FMT_STROKE}/>` +
    `<path d="M9.75 2.75v3h3" ${FMT_STROKE}/>` +
    `<path d="M6.4 9.2L5 10.6l1.4 1.4M9.6 9.2L11 10.6l-1.4 1.4" ${FMT_STROKE}/>`
);

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

/** Icon "..." cho nút mở menu tràn (các nút không đủ chỗ khi toolbar hẹp). */
const MORE_ICON = svgIcon(
  '<circle cx="4" cy="8" r="1.3" fill="currentColor"/>' +
    '<circle cx="8" cy="8" r="1.3" fill="currentColor"/>' +
    '<circle cx="12" cy="8" r="1.3" fill="currentColor"/>'
);

/** Chevron nhỏ cho caret của split-button (Heading/Code block/Math — US-4.9–4.11). */
const CARET_DOWN_ICON = svgIcon(`<path d="M4.5 6.25L8 9.75l3.5-3.5" ${FMT_STROKE}/>`);

/** Một dòng trong dropdown của split-button (vd. các cấp Heading, ngôn ngữ code). */
interface ToolbarDropdownEntry {
  label: string;
  icon?: string;
  /** Nhãn nhỏ đánh dấu lựa chọn phổ biến/mặc định (vd. "Phổ biến"). */
  badge?: string;
  action: () => void;
}

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
  /**
   * Có mặt → render thành split-button (mặt chính + caret) thay vì nút đơn
   * (US-4.9/4.10/4.11). `action` vẫn là hành vi mặt chính (mặc định); caret mở
   * popover liệt kê các lựa chọn này. Khi bị ẩn vào menu tràn (US-4.7), chỉ
   * `action` mặc định được liệt kê — dropdown không truy cập được từ đó
   * (accepted simplification, xem Open Questions US-4.9/4.10).
   */
  dropdown?: ToolbarDropdownEntry[];
  /** Tooltip riêng cho nút caret — mặc định "<title> — more options". */
  dropdownTitle?: string;
}

/** Đồng bộ trạng thái "đang bật" của nút mục lục trên toolbar. */
function updateTocButton(): void {
  document.getElementById('toc-toggle')?.classList.toggle('active', ctx.toc.isOpen());
}

/** Gọi từ ngoài (main.ts) sau khi tự mở mục lục theo cấu hình lúc khởi tạo. */
export function syncTocButton(): void {
  updateTocButton();
}

/**
 * Dropdown của Heading split-button (US-4.9) — Paragraph, H1–H6, H2 đánh dấu
 * "Phổ biến" (mặc định của mặt chính). Mọi lựa chọn đều gọi `formatHeading`
 * (đã hỗ trợ sẵn h1–h6/p, xem `closest('h1, h2, h3, h4, h5, h6, p')`) nên
 * giữ nguyên hành vi toggle-về-`<p>` của US-4.1 cho cả 7 lựa chọn.
 */
const HEADING_DROPDOWN: ToolbarDropdownEntry[] = [
  { label: 'Paragraph', action: () => formatHeading('p') },
  { label: 'Heading 1', action: () => formatHeading('h1') },
  { label: 'Heading 2', badge: 'Phổ biến', action: () => formatHeading('h2') },
  { label: 'Heading 3', action: () => formatHeading('h3') },
  { label: 'Heading 4', action: () => formatHeading('h4') },
  { label: 'Heading 5', action: () => formatHeading('h5') },
  { label: 'Heading 6', action: () => formatHeading('h6') },
];

/**
 * Dropdown của Code block split-button (US-4.10) — 10 ngôn ngữ, JavaScript
 * đánh dấu "Phổ biến" (mặc định của mặt chính). Mọi lựa chọn dùng chung
 * `insertCodeBlock(lang)` nên hành vi tách before/`<pre>`/after theo vùng
 * chọn (US-4.4) giữ nguyên cho cả 10 ngôn ngữ, chỉ khác class `language-*`.
 */
const CODE_BLOCK_DROPDOWN: ToolbarDropdownEntry[] = [
  { label: 'Plain text', action: () => insertCodeBlock('plaintext') },
  { label: 'JavaScript', badge: 'Phổ biến', action: () => insertCodeBlock('javascript') },
  { label: 'TypeScript', action: () => insertCodeBlock('typescript') },
  { label: 'Python', action: () => insertCodeBlock('python') },
  { label: 'Bash', action: () => insertCodeBlock('bash') },
  { label: 'JSON', action: () => insertCodeBlock('json') },
  { label: 'HTML', action: () => insertCodeBlock('html') },
  { label: 'CSS', action: () => insertCodeBlock('css') },
  { label: 'SQL', action: () => insertCodeBlock('sql') },
  { label: 'Markdown', action: () => insertCodeBlock('markdown') },
];

/**
 * Dropdown của Math split-button (US-4.11) — Inline (mặc định của mặt chính)
 * / Block. Cả hai gọi `ctx.insertMarkdown` (GĐ2) — render qua chính
 * `renderer.render()` rồi post-process KaTeX trên fragment tách biệt, không
 * tự dựng HTML tay — @vscode/markdown-it-katex đã ship (section 2), không
 * cần đổi renderer.
 */
const MATH_FORMULA = 'x^2+y^2=z^2';
const MATH_DROPDOWN: ToolbarDropdownEntry[] = [
  { label: 'Inline math', badge: 'Phổ biến', action: () => ctx.insertMarkdown(`$${MATH_FORMULA}$`) },
  { label: 'Block math', action: () => ctx.insertMarkdown(`$$${MATH_FORMULA}$$`) },
];

// Thứ tự nhóm cuối cùng theo US-4.8: B/I/S → Heading → Clear formatting/Undo/
// Redo → Bullet/Numbered/Task → Blockquote/Table/HR → Link/Image → Inline
// code/Code block/Math/Mermaid → [pinned phải: TOC + more options]. Ở GĐ1 mới
// chỉ dời VỊ TRÍ (Inline code, cụm Undo/Redo) — control cũ giữ nguyên y hệt,
// chưa có Clear formatting/Math/Mermaid/ngôn ngữ code block (để dành GĐ3–8).
const toolbarItems: ToolbarItem[] = [
  { label: 'B', title: 'Bold (⌘B)', action: () => document.execCommand('bold') },
  { label: 'I', title: 'Italic (⌘I)', action: () => document.execCommand('italic') },
  { label: 'S', title: 'Strikethrough (⌘⇧X)', action: () => document.execCommand('strikeThrough') },
  {
    label: 'H2',
    title: 'Heading (click again on the same level to revert to paragraph)',
    action: () => formatHeading('h2'),
    dropdown: HEADING_DROPDOWN,
    dropdownTitle: 'Choose heading level',
    separatorBefore: true,
  },
  {
    label: '↶',
    icon: FMT_ICONS.undo,
    title: 'Undo (⌘Z)',
    action: () => document.execCommand('undo'),
    separatorBefore: true,
  },
  { label: '↷', icon: FMT_ICONS.redo, title: 'Redo (⌘⇧Z)', action: () => document.execCommand('redo') },
  {
    label: '•',
    icon: FMT_ICONS.ul,
    title: 'Bulleted list',
    action: setBulletList,
    separatorBefore: true,
  },
  { label: '1.', icon: FMT_ICONS.ol, title: 'Numbered list', action: setNumberedList },
  { label: '☑', icon: FMT_ICONS.task, title: 'Task list', action: toggleTaskItem },
  {
    label: '❝',
    icon: FMT_ICONS.quote,
    title: 'Blockquote (click again to remove)',
    action: toggleBlockquote,
    separatorBefore: true,
  },
  { label: '⊞', icon: FMT_ICONS.table, title: 'Insert 3×3 table', action: insertTable },
  {
    label: '—',
    icon: FMT_ICONS.hr,
    title: 'Horizontal rule',
    action: () => document.execCommand('insertHTML', false, '<hr><p><br></p>'),
  },
  {
    label: '🔗',
    icon: FMT_ICONS.link,
    title: 'Insert link',
    action: insertLink,
    separatorBefore: true,
    opensAsyncPrompt: true,
  },
  {
    label: '🖼',
    icon: FMT_ICONS.image,
    title: 'Insert image (path)',
    action: insertImage,
    opensAsyncPrompt: true,
  },
  { label: '</>', title: 'Inline code (⌘E)', action: toggleInlineCode, separatorBefore: true },
  {
    label: '{ }',
    icon: FMT_ICONS.codeBlock,
    title: 'Code block (default: JavaScript)',
    action: () => insertCodeBlock('javascript'),
    dropdown: CODE_BLOCK_DROPDOWN,
    dropdownTitle: 'Choose code language',
  },
  {
    label: '∑',
    title: 'Math (default: inline, KaTeX)',
    action: () => ctx.insertMarkdown(`$${MATH_FORMULA}$`),
    dropdown: MATH_DROPDOWN,
    dropdownTitle: 'Choose math type',
  },
  {
    label: '@',
    icon: CLAUDE_COPY_ICON,
    title: 'Copy "@file" to clipboard for Claude Code chat — auto-opens/focuses the chat input, you just paste (⌘V)',
    action: () => ctx.vscode.postMessage({ type: 'addToClaudeContext' }),
    alignRight: true,
  },
  {
    label: '⟨/⟩',
    icon: RAW_SOURCE_ICON,
    title: 'View raw Markdown source (opens a text editor to the side)',
    action: () => ctx.vscode.postMessage({ type: 'viewSource' }),
  },
  {
    label: '☰',
    icon: TOC_ICON,
    title: 'Show/hide Table of Contents',
    action: () => {
      ctx.toc.toggle();
      updateTocButton();
    },
    id: 'toc-toggle',
  },
];

let tooltipEl: HTMLDivElement | undefined;

/**
 * Tooltip tự vẽ bằng JS thay vì dựa vào title attribute gốc của trình duyệt —
 * title attribute im lặng không hiện được ở một số nút toolbar tuỳ vị trí
 * (nghi do tương tác giữa layout flex-wrap của #toolbar với việc trình duyệt
 * xác định "phần tử đang hover" cho riêng cơ chế tooltip, khác với hit-test
 * click bình thường), nên không thể tin cậy hoàn toàn vào title. Tự quản lý
 * show/hide qua mouseenter/focus và mouseleave/blur đảm bảo hiện thị nhất
 * quán bất kể vị trí nút.
 */
function showTooltip(target: HTMLElement, text: string): void {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'toolbar-tooltip';
    document.body.appendChild(tooltipEl);
  }
  tooltipEl.textContent = text;
  tooltipEl.style.display = 'block';
  const rect = target.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  const left = Math.max(4, Math.min(rect.left + rect.width / 2 - tipRect.width / 2, window.innerWidth - tipRect.width - 4));
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${rect.bottom + 6}px`;
}

function hideTooltip(): void {
  if (tooltipEl) {
    tooltipEl.style.display = 'none';
  }
}

/** Gắn tooltip tự vẽ (mouseenter/focus → hiện, mouseleave/blur → ẩn) cho 1 phần tử. */
function attachTooltip(el: HTMLElement, text: string): void {
  el.addEventListener('mouseenter', () => showTooltip(el, text));
  el.addEventListener('mouseleave', hideTooltip);
  el.addEventListener('focus', () => showTooltip(el, text));
  el.addEventListener('blur', hideTooltip);
}

/**
 * Chạy 1 ToolbarItem: action + (focus lại #content trừ khi tự mở prompt bất
 * đồng bộ) + scheduleSync — logic dùng chung cho nút đơn, mặt chính của
 * split-button, VÀ hàng trong menu tràn (US-4.7) khi đại diện split-button bị
 * ẩn (chỉ action mặc định được liệt kê, xem ToolbarItem.dropdown doc).
 */
function invokeItem(item: ToolbarItem): void {
  hideTooltip();
  item.action();
  if (!item.opensAsyncPrompt) {
    content.focus();
  }
  ctx.scheduleSync();
}

// ---------------------------------------------------------------------------
// Popover dùng chung (GĐ2 hạ tầng) — nền cho menu tràn (US-4.7) và mọi
// dropdown mới (Heading/Code block/Math split-button, "more options" US-4.14).
// Chỉ MỘT popover được mở tại một thời điểm; đóng khi click ra ngoài/Escape.
// ---------------------------------------------------------------------------

let openPopoverEl: HTMLElement | undefined;
let openPopoverTrigger: HTMLElement | undefined;
let popoverGlobalListenersInstalled = false;

function installPopoverGlobalListeners(): void {
  if (popoverGlobalListenersInstalled) {
    return;
  }
  popoverGlobalListenersInstalled = true;
  document.addEventListener('mousedown', (e) => {
    if (!openPopoverEl) {
      return;
    }
    const target = e.target as Node;
    if (openPopoverEl.contains(target) || target === openPopoverTrigger) {
      return;
    }
    closePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePopover();
    }
  });
}

/** Tạo 1 popover ẩn sẵn, gắn vào <body> — style dùng chung `.toolbar-popover`. */
function buildPopover(extraClassName?: string): HTMLDivElement {
  installPopoverGlobalListeners();
  const el = document.createElement('div');
  el.className = extraClassName ? `toolbar-popover ${extraClassName}` : 'toolbar-popover';
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

/** Thêm 1 hàng (icon + label + badge tuỳ chọn) vào popover, dùng chung cho menu tràn lẫn dropdown split-button. */
function addPopoverRow(
  popoverEl: HTMLElement,
  icon: string | undefined,
  label: string,
  badge: string | undefined,
  onClick: () => void
): void {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'toolbar-popover-item';
  if (icon) {
    const iconSpan = document.createElement('span');
    iconSpan.className = 'toolbar-popover-icon';
    iconSpan.innerHTML = icon;
    row.appendChild(iconSpan);
  }
  const labelSpan = document.createElement('span');
  labelSpan.className = 'toolbar-popover-label';
  labelSpan.textContent = label;
  row.appendChild(labelSpan);
  if (badge) {
    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'toolbar-popover-badge';
    badgeSpan.textContent = badge;
    row.appendChild(badgeSpan);
  }
  row.addEventListener('mousedown', (e) => e.preventDefault());
  row.addEventListener('click', onClick);
  popoverEl.appendChild(row);
}

/** Mở popoverEl neo theo triggerBtn (căn phải mép dưới nút) — đóng popover khác đang mở trước. */
function openPopover(triggerBtn: HTMLElement, popoverEl: HTMLElement): void {
  if (openPopoverEl && openPopoverEl !== popoverEl) {
    closePopover();
  }
  popoverEl.style.display = 'flex';
  const rect = triggerBtn.getBoundingClientRect();
  const menuRect = popoverEl.getBoundingClientRect();
  const left = Math.max(4, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 4));
  popoverEl.style.left = `${left}px`;
  popoverEl.style.top = `${rect.bottom + 4}px`;
  openPopoverEl = popoverEl;
  openPopoverTrigger = triggerBtn;
}

function closePopover(): void {
  if (openPopoverEl) {
    openPopoverEl.style.display = 'none';
  }
  openPopoverEl = undefined;
  openPopoverTrigger = undefined;
}

function togglePopover(triggerBtn: HTMLElement, popoverEl: HTMLElement): void {
  if (openPopoverEl === popoverEl) {
    closePopover();
  } else {
    openPopover(triggerBtn, popoverEl);
  }
}

/** Một nút định dạng có thể bị ẩn vào menu tràn (".toolbar-more") khi hẹp chỗ. */
interface CollapsibleEntry {
  item: ToolbarItem;
  /** Phần tử hiện/ẩn — <button> cho nút đơn, <span class="split-btn"> cho split-button. */
  btn: HTMLElement;
  /** Dấu phân cách đứng NGAY TRƯỚC nút này (nếu có) — ẩn/hiện cùng nhau. */
  sep: HTMLSpanElement | null;
}

let toolbarElRef: HTMLElement | undefined;
let moreBtn: HTMLButtonElement | undefined;
let overflowMenu: HTMLDivElement | undefined;
let collapsibleEntries: CollapsibleEntry[] = [];
let overflowResizeObserver: ResizeObserver | undefined;

/** Dựng nút đơn (label/icon text, không dropdown) — trường hợp đa số các ToolbarItem. */
function buildPlainButtonEl(item: ToolbarItem): HTMLButtonElement {
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
  btn.setAttribute('aria-label', item.title);
  attachTooltip(btn, item.title);
  // mousedown + preventDefault để không mất selection trong #content
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => invokeItem(item));
  return btn;
}

/**
 * Dựng split-button (mặt chính + vạch chia + caret nhỏ) — US-4.9/4.10/4.11.
 * Mặt chính chạy `item.action` (hành vi mặc định); caret mở popover liệt kê
 * `item.dropdown`. Port cấu trúc từ prototype HTML đã duyệt, chỉ đổi biến CSS
 * `--vs-*` sang biến VS Code thật (xem `.split-*` trong editor.css).
 */
function buildSplitButtonEl(item: ToolbarItem): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'split-btn';

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'split-main';
  if (item.icon) {
    main.innerHTML = item.icon;
  } else {
    main.textContent = item.label;
  }
  main.setAttribute('aria-label', item.title);
  attachTooltip(main, item.title);
  main.addEventListener('mousedown', (e) => e.preventDefault());
  main.addEventListener('click', () => invokeItem(item));

  const divider = document.createElement('span');
  divider.className = 'split-divider';

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'split-caret';
  caret.innerHTML = CARET_DOWN_ICON;
  const dropdownTitle = item.dropdownTitle ?? `${item.title} — more options`;
  caret.setAttribute('aria-label', dropdownTitle);
  attachTooltip(caret, dropdownTitle);
  caret.addEventListener('mousedown', (e) => e.preventDefault());

  const popover = buildPopover('toolbar-split-popover');
  for (const entry of item.dropdown ?? []) {
    addPopoverRow(popover, entry.icon, entry.label, entry.badge, () => {
      closePopover();
      hideTooltip();
      entry.action();
      if (!item.opensAsyncPrompt) {
        content.focus();
      }
      ctx.scheduleSync();
    });
  }
  caret.addEventListener('click', () => {
    hideTooltip();
    togglePopover(caret, popover);
  });

  wrap.appendChild(main);
  wrap.appendChild(divider);
  wrap.appendChild(caret);
  return wrap;
}

export function initToolbar(contentEl: HTMLElement, toolbarEl: HTMLElement, context: ToolbarContext): void {
  content = contentEl;
  ctx = context;
  toolbarElRef = toolbarEl;
  collapsibleEntries = [];
  let moreBtnInserted = false;
  // alignRight chỉ đánh dấu nút ĐẦU nhóm tiện ích ("và mọi nút sau nó" — xem
  // định nghĩa ToolbarItem.alignRight) — mọi item kể từ đó trở đi (raw source,
  // mục lục...) cũng thuộc nhóm luôn-hiện dù không tự có cờ này.
  let inPinnedGroup = false;

  for (const item of toolbarItems) {
    if (item.alignRight) {
      inPinnedGroup = true;
    }
    // Chèn nút "..." ngay trước nhóm tiện ích đẩy phải (@ / raw source / mục
    // lục) — nhóm này luôn hiện, chỉ các nút định dạng phía trước mới rút vào
    // menu tràn khi hẹp chỗ.
    if (!moreBtnInserted && inPinnedGroup) {
      moreBtn = createMoreButton();
      toolbarEl.appendChild(moreBtn);
      moreBtnInserted = true;
    }

    let sep: HTMLSpanElement | null = null;
    if (item.separatorBefore) {
      sep = document.createElement('span');
      sep.className = 'toolbar-sep';
      toolbarEl.appendChild(sep);
    }
    const el = item.dropdown ? buildSplitButtonEl(item) : buildPlainButtonEl(item);
    toolbarEl.appendChild(el);

    if (!inPinnedGroup) {
      collapsibleEntries.push({ item, btn: el, sep });
    }
  }

  if (!moreBtnInserted) {
    moreBtn = createMoreButton();
    toolbarEl.appendChild(moreBtn);
  }

  setupOverflowMenu();
}

/** Nút "..." — mở menu chứa các nút định dạng đang không đủ chỗ hiển thị. */
function createMoreButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toolbar-more';
  btn.innerHTML = MORE_ICON;
  btn.style.display = 'none';
  btn.setAttribute('aria-label', 'More tools');
  attachTooltip(btn, 'More tools');
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    hideTooltip();
    toggleOverflowMenu();
  });
  return btn;
}

/**
 * Dựng menu tràn (dropdown, dùng hạ tầng popover chung ở trên) + theo dõi bề
 * rộng toolbar bằng ResizeObserver. Toolbar chuyển sang flex-wrap: nowrap (xem
 * editor.css) — khi không đủ chỗ, các nút định dạng cuối dãy được ẩn dần và
 * gom lại trong menu này thay vì bị đẩy lệch xuống dòng 2.
 */
function setupOverflowMenu(): void {
  if (!overflowMenu) {
    overflowMenu = buildPopover('toolbar-overflow-menu');
  }

  overflowResizeObserver?.disconnect();
  overflowResizeObserver = new ResizeObserver(() => recalcOverflow());
  if (toolbarElRef) {
    overflowResizeObserver.observe(toolbarElRef);
  }
  recalcOverflow();
}

function toggleOverflowMenu(): void {
  if (!overflowMenu || !moreBtn) {
    return;
  }
  togglePopover(moreBtn, overflowMenu);
}

/** Đóng menu tràn CHỈ khi nó đang là popover đang mở — không đụng popover khác (vd. dropdown split-button). */
function closeOverflowMenu(): void {
  if (overflowMenu && openPopoverEl === overflowMenu) {
    closePopover();
  }
}

/**
 * Đo lại bề rộng: hiện tất cả nút định dạng trước, nếu tràn thì ẩn dần từ nút
 * cuối dãy (giữ nguyên nhóm tiện ích đẩy phải luôn hiện) cho tới khi vừa,
 * rồi dựng lại menu tràn từ danh sách vừa ẩn.
 */
function recalcOverflow(): void {
  if (!toolbarElRef || !moreBtn) {
    return;
  }
  const toolbarEl = toolbarElRef;

  for (const entry of collapsibleEntries) {
    entry.btn.style.display = '';
    if (entry.sep) {
      entry.sep.style.display = '';
    }
  }
  moreBtn.style.display = 'none';
  closeOverflowMenu();

  if (toolbarEl.scrollWidth <= toolbarEl.clientWidth) {
    rebuildOverflowMenu([]);
    return;
  }

  moreBtn.style.display = '';
  const hidden: CollapsibleEntry[] = [];
  for (let i = collapsibleEntries.length - 1; i >= 0; i--) {
    if (toolbarEl.scrollWidth <= toolbarEl.clientWidth) {
      break;
    }
    const entry = collapsibleEntries[i];
    entry.btn.style.display = 'none';
    if (entry.sep) {
      entry.sep.style.display = 'none';
    }
    hidden.unshift(entry);
  }
  rebuildOverflowMenu(hidden);
}

/**
 * Dựng lại menu tràn từ danh sách nút đang bị ẩn. Với split-button (US-4.9/
 * 4.10/4.11), chỉ liệt kê `item.action` mặc định — dropdown riêng của nó
 * không truy cập được từ menu tràn (accepted simplification, xem
 * ToolbarItem.dropdown doc) — nên dùng thẳng `invokeItem` thay vì `.click()`
 * delegation cũ (vốn giả định `entry.btn` luôn là 1 <button> đơn, không đúng
 * nữa với split-button là <span> bọc 2 nút con).
 */
function rebuildOverflowMenu(hidden: CollapsibleEntry[]): void {
  if (!overflowMenu) {
    return;
  }
  overflowMenu.innerHTML = '';
  for (const entry of hidden) {
    addPopoverRow(overflowMenu, entry.item.icon, entry.item.title, undefined, () => {
      closeOverflowMenu();
      invokeItem(entry.item);
    });
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

/**
 * Lấy mọi <li> đang giao với vùng chọn hiện tại cùng <ul>/<ol> cha — null nếu
 * selection chưa nằm trong list nào (dùng chung cho toggleTaskItem/
 * setBulletList/setNumberedList để convert đúng TOÀN BỘ dòng đang chọn, không
 * chỉ dòng chứa anchor).
 */
function getListSelection(): { list: HTMLElement; items: HTMLLIElement[] } | null {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (!range) {
    return null;
  }
  const startEl = closestElement(range.startContainer);
  let li = startEl?.closest('li') ?? null;
  if (!li && startEl && (startEl.tagName === 'UL' || startEl.tagName === 'OL')) {
    // Chrome có thể normalize mép range về CHÍNH <ul>/<ol> (container là
    // list, offset là chỉ số phần tử con) thay vì text bên trong <li> —
    // nhất là ngay sau một execCommand vừa mutate DOM.
    const child = startEl.children.item(range.startOffset);
    if (child?.tagName === 'LI') {
      li = child as HTMLLIElement;
    }
  }
  if (!li) {
    return null;
  }
  const list = li.parentElement as HTMLElement;
  const items = Array.from(list.children).filter((c): c is HTMLLIElement => c.tagName === 'LI');
  const targets = items.filter((item) => range.intersectsNode(item));
  return { list, items: targets.length ? targets : [li] };
}

/** Dò các <li> nằm giữa 2 mép ngoài `before`/`after` (chốt lại TRƯỚC khi
 * mutate) — insertHTML tạo node MỚI nên không thể dò lại qua reference <li>
 * cũ, chỉ có thể dò qua vị trí tương đối với 2 sibling ngoài vùng bị thay. */
function findListItemsBetween(parent: Element, before: Element | null, after: Element | null): HTMLLIElement[] {
  const result: HTMLLIElement[] = [];
  for (
    let node: Element | null = before ? before.nextElementSibling : parent.firstElementChild;
    node && node !== after;
    node = node.nextElementSibling
  ) {
    if (node.tagName === 'LI') {
      result.push(node as HTMLLIElement);
    }
  }
  return result;
}

/** Đặt lại selection = Range bao trọn từ items[0] đến items cuối — đảm bảo
 * execCommand gọi NGAY SAU đó (vd. đổi <ol>↔<ul>) áp lên đúng toàn bộ các
 * <li> vừa xử lý, không bị thu hẹp về caret đơn lẻ mà insertHTML để lại. */
function reselectItems(items: HTMLLIElement[]): void {
  if (items.length === 0) {
    return;
  }
  const range = document.createRange();
  range.setStartBefore(items[0]);
  range.setEndAfter(items[items.length - 1]);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Dọn <p></p> rỗng trơ lại sát cạnh `list` — Chrome đôi khi để lại mảnh này
 * khi execCommand tách/đổi kiểu list giữa chừng (list-split). An toàn vì
 * phần tử này không có nội dung nên không mất gì khi undo sau đó (cùng cách
 * removeStrayEmptyParagraphAfter xử lý ở input-rules.ts). */
function removeStrayEmptyParagraphNear(list: Element | null): void {
  if (!list) {
    return;
  }
  for (const sibling of [list.previousElementSibling, list.nextElementSibling]) {
    if (
      sibling &&
      sibling.tagName === 'P' &&
      (sibling.textContent ?? '').trim() === '' &&
      !sibling.querySelector('img, input, video, audio, iframe, picture')
    ) {
      sibling.remove();
    }
  }
}

/**
 * Thay thế các <li> đã chọn bằng bản clone đã áp `mutate`, dùng
 * execCommand('insertHTML') thay vì thao tác DOM trần (createElement/remove
 * trực tiếp) — thao tác DOM trần không được trình duyệt ghi vào lịch sử
 * undo/redo gốc, cùng lý do đã sửa ở replaceBlockTag (dom-utils.ts) và
 * convertBlockToListItem (input-rules.ts). Trả về các <li> MỚI vừa chèn (xem
 * findListItemsBetween) để caller re-select đúng phạm vi nếu cần thao tác
 * execCommand tiếp theo — insertHTML để lại selection collapse về 1 điểm,
 * không đủ để execCommand sau đó áp lên toàn bộ targets.
 */
function replaceListItems(items: HTMLLIElement[], mutate: (clone: HTMLLIElement) => void): HTMLLIElement[] {
  const parent = items[0].parentElement;
  const before = items[0].previousElementSibling;
  const after = items[items.length - 1].nextElementSibling;

  const html = items
    .map((item) => {
      const clone = item.cloneNode(true) as HTMLLIElement;
      mutate(clone);
      return clone.outerHTML;
    })
    .join('');
  const replaceRange = document.createRange();
  replaceRange.setStartBefore(items[0]);
  replaceRange.setEndAfter(items[items.length - 1]);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(replaceRange);
  document.execCommand('insertHTML', false, html);

  return parent ? findListItemsBetween(parent, before, after) : [];
}

function stripCheckboxFrom(li: HTMLLIElement): void {
  li.querySelector(':scope > input[type="checkbox"]')?.remove();
  li.classList.remove('task-list-item');
  // markdown-it-task-lists chỉ cắt "[ ]" (3 ký tự) khỏi text khi render, GIỮ
  // LẠI dấu cách đứng sau — text node trong <li> task luôn bắt đầu bằng " ".
  // Đứng sau checkbox thì vô hình, nhưng bỏ checkbox rồi thì lộ ra thành
  // khoảng trắng thừa đầu dòng → cắt luôn khi gỡ checkbox.
  const first = li.firstChild;
  if (first?.nodeType === Node.TEXT_NODE && first.textContent) {
    first.textContent = first.textContent.replace(/^\s+/, '');
    if (first.textContent === '') {
      first.remove();
    }
  }
}

function syncTaskListClass(list: HTMLElement): void {
  const hasCheckbox = Array.from(list.children).some(
    (c) => c.tagName === 'LI' && c.querySelector(':scope > input[type="checkbox"]')
  );
  list.classList.toggle('contains-task-list', hasCheckbox);
}

/**
 * Nút bullet (•): nếu vùng chọn đang ở task list, bỏ checkbox trước khi đổi
 * kiểu — execCommand không phân biệt được <ul> thường với <ul> task-list
 * (cùng thẻ), nên gọi thẳng insertUnorderedList trên task list sẽ TOGGLE OFF
 * (unwrap về đoạn văn) thay vì chuyển thành bullet thường.
 */
function setBulletList(): void {
  const current = getListSelection();
  if (!current) {
    document.execCommand('insertUnorderedList');
    return;
  }
  const { list, items } = current;
  const hasCheckbox = items.some((item) => item.querySelector(':scope > input[type="checkbox"]'));
  if (hasCheckbox) {
    const inserted = replaceListItems(items, stripCheckboxFrom);
    syncTaskListClass(list);
    if (list.tagName === 'UL') {
      return; // đã là bullet thường sau khi bỏ checkbox, không cần execCommand
    }
    reselectItems(inserted);
  }
  document.execCommand('insertUnorderedList');
  removeStrayEmptyParagraphNear(list);
}

/**
 * Nút numbered (1.): tương tự setBulletList — bỏ checkbox trước nếu có, để
 * execCommand('insertOrderedList') chuyển đúng <ul>→<ol> thay vì phó mặc cho
 * trình duyệt xử lý <li> còn lẫn checkbox trong danh sách số.
 */
function setNumberedList(): void {
  const current = getListSelection();
  if (current) {
    const hasCheckbox = current.items.some((item) => item.querySelector(':scope > input[type="checkbox"]'));
    if (hasCheckbox) {
      const inserted = replaceListItems(current.items, stripCheckboxFrom);
      syncTaskListClass(current.list);
      reselectItems(inserted);
    }
  }
  document.execCommand('insertOrderedList');
  if (current) {
    removeStrayEmptyParagraphNear(current.list);
  }
}

/** Phần tử con TRỰC TIẾP của #content chứa `node` — dò bằng parentElement (không phải
 * closestElement, vốn chỉ đi 1 cấp) để tới đúng cấp top-level dù `node` lồng sâu bao nhiêu. */
function topLevelChildContaining(node: Node): Element | null {
  let el: Element | null = closestElement(node);
  while (el && el.parentElement !== content) {
    el = el.parentElement;
  }
  return el;
}

/**
 * Mọi <li> nằm giữa 2 mép ngoài `before`/`after` (chốt lại TRƯỚC khi mutate DOM — cùng kỹ thuật
 * findListItemsBetween ở trên), quét qua BẤT KỲ <ul>/<ol> con trực tiếp nào của #content trong
 * khoảng đó — không chỉ một list duy nhất.
 *
 * Lý do cần: execCommand('insertUnorderedList') trên vùng chọn trải nhiều đoạn văn RỜI (có dòng
 * trống thật giữa các đoạn — không liền mạch) có thể TÁCH thành NHIỀU <ul> độc lập thay vì gộp
 * chung một list (hành vi thật của Chrome, đã quan sát qua repro thủ công — xem C4 bug report #5:
 * "tạo todo từ nhiều dòng text bị thừa 1 dấu chấm ở dòng đầu"). getListSelection() chỉ dò được MỘT
 * <ul> (qua range.startContainer) nên khi Chrome tách nhiều <ul>, các <li> ở <ul> còn lại không
 * được gắn class contains-task-list — CSS ẩn marker mặc định (`list-style-type: none`) không áp
 * dụng, bullet "•" của trình duyệt lộ ra cạnh checkbox.
 */
function findAllListItemsBetween(before: Element | null, after: Element | null): HTMLLIElement[] {
  const items: HTMLLIElement[] = [];
  for (
    let node: Element | null = before ? before.nextElementSibling : content.firstElementChild;
    node && node !== after;
    node = node.nextElementSibling
  ) {
    if (node.tagName === 'LI') {
      items.push(node as HTMLLIElement);
    } else if (node.tagName === 'UL' || node.tagName === 'OL') {
      node.querySelectorAll(':scope > li').forEach((li) => items.push(li as HTMLLIElement));
    }
  }
  return items;
}

function toggleTaskItem(): void {
  const current = getListSelection();

  if (!current) {
    // Chưa ở trong list → tạo list cho cả vùng chọn trước. Chốt mép ngoài
    // TRƯỚC khi mutate DOM (xem findAllListItemsBetween) — SAU đó không thể tin
    // getListSelection() dò lại đủ mọi <li> vừa tạo.
    const sel = window.getSelection();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const startTop = range ? topLevelChildContaining(range.startContainer) : null;
    const endTop = range ? topLevelChildContaining(range.endContainer) : null;
    const before = startTop?.previousElementSibling ?? null;
    const after = endTop?.nextElementSibling ?? null;

    if (startTop && endTop) {
      // Đường chính (bug #3): TỰ dựng MỘT <ul> "tight" (nội dung nằm thẳng trong
      // <li>, không bọc <p>) từ mọi block top-level trong vùng chọn rồi chèn một
      // lần bằng insertHTML — KHÔNG dùng execCommand('insertUnorderedList') vì
      // Chrome hay tách vùng chọn nhiều đoạn văn rời thành NHIỀU <ul> và/hoặc
      // giữ <p> con làm list "loose". Hệ quả (đã quan sát ở bug report #3): item
      // đầu bị tách ra <ul> riêng → lộ bullet "•" thừa cạnh checkbox, và turndown
      // serialize item loose kèm một dòng trắng thừa. Một <ul> tight duy nhất
      // triệt tiêu cả hai. insertHTML (thay vì thao tác DOM trần) để Ctrl/Cmd+Z
      // hoàn tác gọn một bước (cùng lý do convertBlockToListItem/input-rules.ts).
      const itemsHtml: string[] = [];
      for (let el: Element | null = startTop; el; el = el.nextElementSibling) {
        if (el.tagName === 'UL' || el.tagName === 'OL') {
          el.querySelectorAll(':scope > li').forEach((li) =>
            itemsHtml.push(li.innerHTML.trim() ? li.innerHTML : '<br>')
          );
        } else {
          itemsHtml.push(el.innerHTML.trim() ? el.innerHTML : '<br>');
        }
        if (el === endTop) {
          break;
        }
      }
      if (itemsHtml.length) {
        const html = `<ul>${itemsHtml.map((h) => `<li>${h}</li>`).join('')}</ul>`;
        const replaceRange = document.createRange();
        replaceRange.setStartBefore(startTop);
        replaceRange.setEndAfter(endTop);
        sel?.removeAllRanges();
        sel?.addRange(replaceRange);
        document.execCommand('insertHTML', false, html);
      }
    } else {
      // Không xác định được ranh giới block (hiếm — vd không có selection) →
      // lùi về hành vi execCommand cũ.
      document.execCommand('insertUnorderedList');
    }

    const freshItems = findAllListItemsBetween(before, after);
    if (!freshItems.length) {
      return;
    }
    // <li> mới tạo chắc chắn chưa có checkbox → luôn "add" cho TOÀN BỘ. Gọi
    // addCheckbox trực tiếp trên node THẬT nên li.parentElement luôn đúng —
    // contains-task-list được gắn cho đúng <ul> chứa từng <li>.
    freshItems.forEach((li) => addCheckbox(li));
    return;
  }

  const { list, items: targets } = current;

  if (targets.length === 1) {
    const existing = targets[0].querySelector(':scope > input[type="checkbox"]');
    if (existing) {
      stripCheckboxFrom(targets[0]);
      list.classList.remove('contains-task-list');
      if (list.tagName === 'UL' && list.children.length === 1) {
        // <ul> chỉ tạo riêng cho item này (do nhánh !current ở trên) → bỏ
        // checkbox lần 2 phải về lại đoạn văn thường, không được để trơ lại
        // thành bullet.
        document.execCommand('insertUnorderedList');
        removeStrayEmptyParagraphNear(list);
      }
    } else {
      // Checkbox độc lập với kiểu list (bullet/numbered) — markdown-it-task-
      // lists và turndown đều không phân biệt <ol>/<ul>, nên KHÔNG ép đổi
      // sang <ul>: giữ nguyên số thứ tự nếu list đang là <ol> (xem CSS riêng
      // cho ol.contains-task-list/ul.contains-task-list ở markdown.css).
      addCheckbox(targets[0]);
    }
    return;
  }

  // Nhiều <li> đang được chọn → convert TOÀN BỘ sang cùng chiều (thêm hoặc bỏ
  // checkbox), không chỉ mỗi item chứa anchor.
  const shouldAdd = !targets.every((item) => item.querySelector(':scope > input[type="checkbox"]'));
  replaceListItems(targets, (clone) => {
    const existing = clone.querySelector(':scope > input[type="checkbox"]');
    if (shouldAdd) {
      if (!existing) {
        addCheckbox(clone);
      }
    } else if (existing) {
      stripCheckboxFrom(clone);
    }
  });
  syncTaskListClass(list);
}

/** Lấy HTML (giữ định dạng inline) trong một Range dưới dạng chuỗi. */
function rangeToHtml(range: Range): string {
  const div = document.createElement('div');
  div.appendChild(range.cloneContents());
  return div.innerHTML;
}

/**
 * Chèn code block, gắn `language-{lang}` (US-4.10 — trước đây luôn cố định
 * `language-plaintext`, xem US-4.4). Nếu đang chọn một đoạn text ở giữa câu
 * (trong cùng một đoạn văn/heading), tách phần trước/sau vùng chọn ra thành
 * block riêng rồi mới chèn <pre> xen giữa — nếu không tách trước, insertHTML
 * một block-level element (<pre>) giữa nội dung inline sẽ phó mặc cho trình
 * duyệt tự tách đoạn, thứ tự trước/sau không được đảm bảo.
 */
function insertCodeBlock(lang: string): void {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  const selectedText = sel?.toString() ?? '';
  const codeContent = escapeHtml(selectedText || 'code');
  const langClass = escapeAttr(lang);

  const anchor = range ? closestElement(range.startContainer) : null;
  const block = anchor?.closest('p, h1, h2, h3, h4, h5, h6') as HTMLElement | null;

  if (!range || !selectedText || !block || !content.contains(block) || block === content) {
    // Không có vùng chọn hợp lệ trong một đoạn văn/heading (vd. caret rỗng,
    // hoặc đang ở trong list/bảng) — giữ hành vi cũ: chèn code block mẫu
    // ngay tại vị trí caret, không cần tách trước/sau.
    document.execCommand(
      'insertHTML',
      false,
      `<pre><code class="language-${langClass}">${codeContent}</code></pre><p><br></p>`
    );
    return;
  }

  const beforeRange = document.createRange();
  beforeRange.setStart(block, 0);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const beforeHtml = rangeToHtml(beforeRange);

  const afterRange = document.createRange();
  afterRange.setStart(range.endContainer, range.endOffset);
  afterRange.setEnd(block, block.childNodes.length);
  const afterHtml = rangeToHtml(afterRange);

  const tag = block.tagName.toLowerCase();
  const beforeBlock = beforeHtml.trim() ? `<${tag}>${beforeHtml}</${tag}>` : '';
  const afterBlock = `<${tag}>${afterHtml.trim() ? afterHtml : '<br>'}</${tag}>`;

  const blockRange = document.createRange();
  blockRange.selectNode(block);
  sel?.removeAllRanges();
  sel?.addRange(blockRange);
  document.execCommand(
    'insertHTML',
    false,
    `${beforeBlock}<pre><code class="language-${langClass}">${codeContent}</code></pre>${afterBlock}`
  );
}

function insertLink(): void {
  const selectedText = window.getSelection()?.toString().trim() ?? '';
  ctx.promptInput(
    'Link URL:',
    'https://… or type a file name in the project',
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
  ctx.promptInput('Image path (relative or URL):', '', (src) => {
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
