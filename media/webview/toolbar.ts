/**
 * Toolbar định dạng chính: format text (bold/italic/heading/list/quote...),
 * chèn bảng/liên kết/ảnh, undo/redo, nút mục lục và nút copy @file reference.
 */
import hljs from 'highlight.js/lib/common';
import {
  addCheckbox,
  closestElement,
  encodeLinkPath,
  escapeAttr,
  escapeHtml,
  findTaskCheckbox,
  isAbsoluteUrl,
  svgIcon,
  type DomHelpers,
} from './dom-utils';
import {
  commitListOp,
  commitListOpDirect,
  computeRetagListRange,
  computeTaskifyListRange,
  computeToList,
  computeToListAroundAtoms,
  computeUnwrapListRange,
} from './list-ops';
import { insertTable } from './table';
import type { PromptController } from './prompt';
import type { TocController } from './toc';
import type { VsCodeApi } from './vscode-api';
import { READING_STYLES, type ReadabilityController } from './readability';
import { attachTooltip, hideTooltip } from './tooltip';
import { READING_PREVIEW_DEBOUNCE_MS } from './constants';

export interface ToolbarContext {
  vscode: VsCodeApi;
  scheduleSync: () => void;
  /** Flush any pending debounced sync NOW — commits prior typing as its own undo unit (main.ts). */
  flushPendingSync: () => void;
  /** Serialize + post an 'edit' immediately, no debounce (no-op when content is unchanged) (main.ts). */
  syncNow: () => void;
  /** Delegate undo/redo to the host TextDocument (single undo stack) — same contract as Ctrl+Z/Y in main.ts. */
  requestUndo: () => void;
  requestRedo: () => void;
  dom: DomHelpers;
  toc: TocController;
  /** Reading Mode / Zen (US-19.1/19.9) — nút toolbar lái controller này. */
  readability: ReadabilityController;
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

/** Icon Reading Mode (US-19.1): quyển sách mở — gợi chế độ đọc. */
const READING_ICON = svgIcon(
  `<path d="M8 4.3C6.4 3.3 4.1 3.1 2.5 3.5v8.1C4.1 11.2 6.4 11.4 8 12.4" ${FMT_STROKE}/>` +
    `<path d="M8 4.3C9.6 3.3 11.9 3.1 13.5 3.5v8.1C11.9 11.2 9.6 11.4 8 12.4" ${FMT_STROKE}/>` +
    `<path d="M8 4.3v8.1" ${FMT_STROKE}/>`
);

/** Icon Zen / Focus (US-19.9): 4 góc khung — gợi tập trung vào cột chữ giữa. */
const ZEN_ICON = svgIcon(
  `<path d="M2.75 5.5v-2.75h2.75M13.25 5.5v-2.75h-2.75M2.75 10.5v2.75h2.75M13.25 10.5v2.75h-2.75" ${FMT_STROKE}/>`
);

/** Clipboard-with-@ icon — copies an @file reference. */
const FILE_MENTION_ICON =
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
  /** Icon Mermaid (US-4.12): 2 khối nối bằng đường gấp khúc, gợi sơ đồ flowchart. */
  mermaid: svgIcon(
    `<rect x="1.5" y="2.5" width="6" height="3.5" rx="1" ${FMT_STROKE}/>` +
      `<rect x="8.5" y="10" width="6" height="3.5" rx="1" ${FMT_STROKE}/>` +
      `<path d="M4.5 6v2.5a1.5 1.5 0 0 0 1.5 1.5h5.5" ${FMT_STROKE}/>`
  ),
  /** Icon eraser (US-4.13): khối tẩy nghiêng + gạch chân "mặt bàn". */
  eraser: svgIcon(
    `<path d="M10.6 2.9L13.1 5.4a1.5 1.5 0 0 1 0 2.1l-5.6 5.6H4.2L2.2 11.1a1.5 1.5 0 0 1 0-2.1l6.3-6.1a1.5 1.5 0 0 1 2.1 0z" ${FMT_STROKE}/>` +
      `<path d="M8.5 5L11 7.5" ${FMT_STROKE}/>` +
      '<path d="M4.2 13.1h9.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>'
  ),
};

/** Icon "..." cho nút mở menu tràn (các nút không đủ chỗ khi toolbar hẹp). */
const MORE_ICON = svgIcon(
  '<circle cx="4" cy="8" r="1.3" fill="currentColor"/>' +
    '<circle cx="8" cy="8" r="1.3" fill="currentColor"/>' +
    '<circle cx="12" cy="8" r="1.3" fill="currentColor"/>'
);

/**
 * Icon "⋮" (kebab DỌC, 3 chấm xếp trên-dưới) cho nút "more options" (US-4.14)
 * — CỐ Ý khác hình với MORE_ICON ("..." NGANG, menu tràn US-4.7) để 2 trigger
 * đọc được là 2 control khác nhau khi cùng hiện trên toolbar hẹp. Thắng 2
 * phương án khác được so sánh trong prototype: gear (⚙, ngụ ý "cấu hình" chứ
 * không phải "hành động") và "..." + label chữ (tốn ~40-50px đúng chỗ đang
 * thiếu chỗ nhất).
 */
const MORE_OPTIONS_ICON = svgIcon(
  '<circle cx="8" cy="3.6" r="1.3" fill="currentColor"/>' +
    '<circle cx="8" cy="8" r="1.3" fill="currentColor"/>' +
    '<circle cx="8" cy="12.4" r="1.3" fill="currentColor"/>'
);

/** Chevron nhỏ cho caret của split-button (Heading/Code block/Math — US-4.9–4.11). */
const CARET_DOWN_ICON = svgIcon(`<path d="M4.5 6.25L8 9.75l3.5-3.5" ${FMT_STROKE}/>`);

/** Một dòng trong dropdown của split-button (vd. các cấp Heading, ngôn ngữ code). */
interface ToolbarDropdownEntry {
  label: string;
  icon?: string;
  /** Nhãn nhỏ đánh dấu lựa chọn phổ biến/mặc định (vd. "Phổ biến"). */
  badge?: string; // EN only (bug report 2026-07-14, mục 7) — vd "Common"
  action: () => void;
  /**
   * Giá trị định danh hàng (vd. id bundle reading style) — gán vào
   * `data-dropdown-value` để đồng bộ dấu chọn "đang áp" (xem syncReadingButtons).
   * Không có → hàng không mang trạng thái chọn (đa số dropdown hành-động-1-lần).
   */
  value?: string;
  /**
   * US-19.18: hover 1 hàng trong dropdown → preview theme lên file hiện tại mà
   * KHÔNG commit; rời hàng (hoặc đóng popover không chọn) → `onHoverCancel` trả
   * lại theme gốc. Chỉ dropdown Reading Mode dùng cặp này; các dropdown khác
   * (Heading, Math...) để trống, addPopoverRow không gắn listener khi thiếu.
   */
  onHoverPreview?: () => void;
  onHoverCancel?: () => void;
  /** Vẽ vạch chia NGAY TRƯỚC hàng này — tách nhóm hàng theo ngữ nghĩa (vd Reading Mode: "Follow VS Code" đứng riêng khỏi 10 bundle bên dưới). */
  separatorBefore?: boolean;
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
   * true if the action only posts a message to the host (Undo/Redo) and
   * mutates nothing locally. Such items must BYPASS invokeAction's
   * flush-before/syncNow-after bracketing: flushing first would strip the
   * pendingText off the undo/redo message into a separate racing 'edit'
   * (losing the atomic single-message contract the host handler relies on),
   * and syncing after could post a stale pre-undo 'edit' right behind the
   * 'undo' whenever serialize() drifts from currentText (e.g. trailing-newline
   * normalization) — re-applying just-undone content and killing the redo stack.
   */
  hostDelegated?: boolean;
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
 * Đồng bộ trạng thái "đang bật" của nút Reading Mode + Zen (US-19.1/19.9/19.18)
 * — gọi từ readability controller mỗi khi state đổi (id nằm trên split-main
 * của Reading Mode, trên chính <button> của Zen). Chỉ gọi sau initToolbar (từ
 * readability controller) nên ctx luôn đã gán.
 */
export function syncReadingButtons(): void {
  const enabled = ctx.readability.isEnabled();
  document.getElementById('reading-toggle')?.classList.toggle('active', enabled);
  document.getElementById('zen-toggle')?.classList.toggle('active', ctx.readability.isZen());
  // Dấu ✓ hàng bundle đang áp (US-19.18) — 'off' khi tắt hẳn, hoặc không hàng
  // nào nếu state hiện tại (vd seed tay qua settings.json) không khớp bundle nào.
  const current = enabled ? (ctx.readability.getStyleId() ?? '') : 'off';
  syncDropdownSelection('reading-toggle', current);
}

/**
 * Đánh dấu `.selected` (dấu ✓) cho hàng đang áp trong dropdown split-button neo
 * theo `triggerId` — hàng có `data-dropdown-value === current`.
 */
function syncDropdownSelection(triggerId: string, current: string): void {
  const popover = document.querySelector(`.toolbar-popover[data-for-id="${triggerId}"]`);
  popover?.querySelectorAll<HTMLElement>('.toolbar-popover-item[data-dropdown-value]').forEach((row) => {
    row.classList.toggle('selected', row.dataset.dropdownValue === current);
  });
}

/** Cấp heading mặc định khi caret không nằm trong heading nào (US-4.9/US-4.16). */
const DEFAULT_HEADING = 'h2';

/**
 * Dropdown của Heading split-button (US-4.9) — Paragraph, H1–H6, H2 đánh dấu
 * "Phổ biến" (mặc định của mặt chính). Mọi lựa chọn đều gọi `formatHeading`
 * (đã hỗ trợ sẵn h1–h6/p, xem `closest('h1, h2, h3, h4, h5, h6, p')`) nên
 * giữ nguyên hành vi toggle-về-`<p>` của US-4.1 cho cả 7 lựa chọn.
 */
const HEADING_DROPDOWN: ToolbarDropdownEntry[] = [
  { label: 'Paragraph', action: () => formatHeading('p') },
  { label: 'Heading 1', action: () => formatHeading('h1') },
  { label: 'Heading 2', badge: 'Common', action: () => formatHeading(DEFAULT_HEADING) },
  { label: 'Heading 3', action: () => formatHeading('h3') },
  { label: 'Heading 4', action: () => formatHeading('h4') },
  { label: 'Heading 5', action: () => formatHeading('h5') },
  { label: 'Heading 6', action: () => formatHeading('h6') },
];

/**
 * Dropdown của Code block split-button (US-4.10) — 9 ngôn ngữ, JavaScript
 * đánh dấu "Phổ biến" (mặc định của mặt chính). "Markdown" bị bỏ khỏi danh
 * sách (bug report 2026-07-13): người dùng đã ở trong Markdown editor nên
 * cần tô sáng cho code lồng trong bên trong, không có nhu cầu gắn
 * `language-markdown` cho chính khối Markdown lồng nhau. Mọi lựa chọn dùng
 * chung `insertCodeBlock(lang)` nên hành vi tách before/`<pre>`/after theo
 * vùng chọn (US-4.4) giữ nguyên cho cả 9 ngôn ngữ, chỉ khác class `language-*`.
 */
const CODE_BLOCK_DROPDOWN: ToolbarDropdownEntry[] = [
  { label: 'Plain text', action: () => insertCodeBlock('plaintext') },
  { label: 'JavaScript', badge: 'Common', action: () => insertCodeBlock('javascript') },
  { label: 'TypeScript', action: () => insertCodeBlock('typescript') },
  { label: 'Python', action: () => insertCodeBlock('python') },
  { label: 'Bash', action: () => insertCodeBlock('bash') },
  { label: 'JSON', action: () => insertCodeBlock('json') },
  { label: 'HTML', action: () => insertCodeBlock('html') },
  { label: 'CSS', action: () => insertCodeBlock('css') },
  { label: 'SQL', action: () => insertCodeBlock('sql') },
];

/**
 * Dropdown của Math split-button (US-4.11) — Inline (mặc định của mặt chính)
 * / Block. Cả hai gọi `ctx.insertMarkdown` (GĐ2) — render qua chính
 * `renderer.render()` rồi post-process KaTeX trên fragment tách biệt, không
 * tự dựng HTML tay — @vscode/markdown-it-katex đã ship (section 2), không
 * cần đổi renderer.
 */
const MATH_FORMULA = 'x^2+y^2=z^2';
const insertInlineMath = () => ctx.insertMarkdown(`$${MATH_FORMULA}$`);
const MATH_DROPDOWN: ToolbarDropdownEntry[] = [
  { label: 'Inline math', badge: 'Common', action: insertInlineMath },
  { label: 'Block math', action: () => ctx.insertMarkdown(`$$${MATH_FORMULA}$$`) },
];

/**
 * Templates Mermaid (US-4.12, mở rộng ở US-4.19/bug report 2026-07-14 mục
 * 10) — trước đó chỉ có 1 flowchart mẫu cố định (Open Question bị defer ở
 * US-4.12), giờ thêm dropdown 4 loại phổ biến, cùng pattern split-button với
 * Heading/Code block/Math. Chèn qua `ctx.insertMarkdown` như cũ —
 * mermaidView.renderAll() (gọi trong insertMarkdownAtCaret, main.ts) tự dựng
 * SVG cho khối vừa chèn, không cần đổi mermaid.ts (mermaid.js tự nhận diện
 * loại diagram từ nội dung nguồn).
 */
const MERMAID_FLOWCHART_TEMPLATE = '```mermaid\ngraph TD; A[Start] --> B{Decision} --> C[End]\n```';
const MERMAID_SEQUENCE_TEMPLATE =
  '```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello Bob, how are you?\n  Bob-->>Alice: I am good, thanks!\n```';
const MERMAID_CLASS_TEMPLATE =
  '```mermaid\nclassDiagram\n  Animal <|-- Dog\n  Animal : +String name\n  Animal : +makeSound()\n```';
const MERMAID_STATE_TEMPLATE =
  '```mermaid\nstateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : start\n  Running --> Idle : stop\n  Running --> [*]\n```';
const insertMermaidFlowchart = () => ctx.insertMarkdown(MERMAID_FLOWCHART_TEMPLATE);
const MERMAID_DROPDOWN: ToolbarDropdownEntry[] = [
  { label: 'Flowchart', badge: 'Common', action: insertMermaidFlowchart },
  { label: 'Sequence diagram', action: () => ctx.insertMarkdown(MERMAID_SEQUENCE_TEMPLATE) },
  { label: 'Class diagram', action: () => ctx.insertMarkdown(MERMAID_CLASS_TEMPLATE) },
  { label: 'State diagram', action: () => ctx.insertMarkdown(MERMAID_STATE_TEMPLATE) },
];

/**
 * Dropdown của Reading Mode split-button (US-19.18, bug 0715 — thay 2 dropdown
 * Reading/Palette độc lập trước đây, 30 tổ hợp reachable) — 10 bundle
 * preset+palette đã kiểm chứng (contrast WCAG tính toán + soi ảnh 25 tổ hợp,
 * xem `READING_STYLES` trong readability.ts và Requirement - 19
 * Readability.md US-19.18) + dòng "Follow VS Code" để tắt hẳn. Hover 1 hàng
 * live-preview theme lên file hiện tại (`previewStyle`) — rời hàng mà không
 * chọn thì `cancelPreview()` trả lại đúng theme đã commit (wiring hover ở
 * addPopoverRow). Chọn hàng qua `setStyle`/`disable` — kéo theo bật/tắt Reading
 * Mode. ctx được gán trong initToolbar trước khi mọi action chạy nên tham
 * chiếu an toàn (cùng pattern MATH_DROPDOWN/MERMAID_DROPDOWN).
 *
 * "Follow VS Code" đứng ĐẦU danh sách (không phải cuối) — đây là hàng "tắt/
 * reset" duy nhất, khác loại với 10 bundle bên dưới (đều là biến thể "bật");
 * đặt lên đầu giúp thao tác phổ biến nhất ("tôi muốn về bình thường") không
 * phải cuộn qua hết 10 hàng mới thấy, và tách riêng bằng 1 vạch chia
 * (`separatorBefore` trên hàng bundle đầu tiên) để không lẫn vào như một lựa
 * chọn "style" thứ 11.
 */
const READING_DROPDOWN: ToolbarDropdownEntry[] = [
  {
    label: 'Follow VS Code (no reading style)',
    value: 'off',
    action: () => ctx.readability.disable(),
    onHoverPreview: () => ctx.readability.previewStyle('off'),
    onHoverCancel: () => ctx.readability.cancelPreview(),
  },
  ...READING_STYLES.map((style, i) => ({
    label: style.label,
    badge: style.id === 'comfortable-sepia' ? 'Default' : undefined,
    value: style.id,
    action: () => ctx.readability.setStyle(style.id),
    onHoverPreview: () => ctx.readability.previewStyle(style.id),
    onHoverCancel: () => ctx.readability.cancelPreview(),
    separatorBefore: i === 0,
  })),
];

// Thứ tự nhóm cuối cùng theo US-4.8: B/I/S → Heading → Clear formatting/Undo/
// Redo → Bullet/Numbered/Task → Blockquote/Table/HR → Link/Image → Inline
// code/Code block/Math/Mermaid → [pinned phải: TOC + more options]. Ở GĐ1 mới
// chỉ dời VỊ TRÍ (Inline code, cụm Undo/Redo) — control cũ giữ nguyên y hệt,
// chưa có Clear formatting/Math/Mermaid/ngôn ngữ code block (để dành GĐ3–8).
const toolbarItems: ToolbarItem[] = [
  { label: 'B', title: 'Bold (⌘B)', action: () => document.execCommand('bold'), id: 'fmt-bold' },
  { label: 'I', title: 'Italic (⌘I)', action: () => document.execCommand('italic'), id: 'fmt-italic' },
  {
    label: 'S',
    title: 'Strikethrough (⌘⇧X)',
    action: () => document.execCommand('strikeThrough'),
    id: 'fmt-strike',
  },
  {
    label: DEFAULT_HEADING.toUpperCase(),
    title: 'Heading (click again on the same level to revert to paragraph)',
    action: () => formatHeading(currentHeadingTag()),
    dropdown: HEADING_DROPDOWN,
    dropdownTitle: 'Choose heading level',
    separatorBefore: true,
    id: 'fmt-heading',
  },
  {
    label: '⌫',
    icon: FMT_ICONS.eraser,
    title: 'Clear formatting',
    action: () => document.execCommand('removeFormat'),
    separatorBefore: true,
  },
  // Undo/redo in this extension is TextDocument-based (one single stack, see
  // main.ts's Ctrl+Z/Y delegation) — the browser's native stack is blind to
  // raw-DOM ops (commitListOpDirect, replaceListItems...), so running
  // execCommand('undo') here would skip those changes and desync the stacks.
  { label: '↶', icon: FMT_ICONS.undo, title: 'Undo (⌘Z)', action: () => ctx.requestUndo(), id: 'fmt-undo', hostDelegated: true },
  { label: '↷', icon: FMT_ICONS.redo, title: 'Redo (⌘⇧Z)', action: () => ctx.requestRedo(), id: 'fmt-redo', hostDelegated: true },
  {
    label: '•',
    icon: FMT_ICONS.ul,
    title: 'Bulleted list',
    action: setBulletList,
    separatorBefore: true,
    id: 'fmt-bullet',
  },
  {
    label: '1.',
    icon: FMT_ICONS.ol,
    title: 'Numbered list',
    action: setNumberedList,
    id: 'fmt-numbered',
  },
  { label: '☑', icon: FMT_ICONS.task, title: 'Task list', action: toggleTaskItem, id: 'fmt-task' },
  {
    label: '❝',
    icon: FMT_ICONS.quote,
    title: 'Blockquote (click again to remove)',
    action: toggleBlockquote,
    separatorBefore: true,
    id: 'fmt-blockquote',
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
  {
    label: '</>',
    title: 'Inline code (⌘E)',
    action: toggleInlineCode,
    separatorBefore: true,
    id: 'fmt-inline-code',
  },
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
    action: insertInlineMath,
    dropdown: MATH_DROPDOWN,
    dropdownTitle: 'Choose math type',
  },
  {
    label: '⎇',
    icon: FMT_ICONS.mermaid,
    title: 'Mermaid diagram (default: flowchart)',
    action: insertMermaidFlowchart,
    dropdown: MERMAID_DROPDOWN,
    dropdownTitle: 'Choose diagram type',
  },
  {
    label: 'Read',
    icon: READING_ICON,
    title: 'Reading Mode (comfortable reading layout)',
    action: () => ctx.readability.toggle(),
    // US-19.18 (bug 0715): dropdown giờ gộp cả preset+palette thành 10 bundle đã
    // kiểm chứng + dòng "Follow VS Code" — không còn split-button "Color" riêng.
    dropdown: READING_DROPDOWN,
    dropdownTitle: 'Choose reading style (hover to preview)',
    id: 'reading-toggle',
    alignRight: true,
  },
  {
    label: 'Focus',
    icon: ZEN_ICON,
    title: 'Focus Mode (hide chrome, center text — Esc to exit)',
    action: () => ctx.readability.toggleZen(),
    id: 'zen-toggle',
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


/**
 * Run any content-mutating toolbar action: flushPendingSync-before + action +
 * (re-focus #content unless the action opens an async prompt) + syncNow-after.
 * Shared by single buttons, a split-button's main face, its dropdown rows, AND
 * overflow-menu rows (US-4.7) when the split-button representative is hidden
 * (only the default action is listed, see ToolbarItem.dropdown doc).
 * Host-delegated items (Undo/Redo) never come through here — see invokeItem.
 */
function invokeAction(action: () => void, opensAsyncPrompt?: boolean): void {
  hideTooltip();
  // Undo chronology (bug 0717): commit typing still waiting on the 250ms sync
  // debounce BEFORE the action mutates the DOM — once mutated, the pending
  // typing and the format change would serialize into ONE 'edit' = ONE
  // TextDocument undo unit, so a single Ctrl/Cmd+Z would revert both at once.
  ctx.flushPendingSync();
  action();
  if (!opensAsyncPrompt) {
    content.focus();
  }
  // Sync immediately (not debounced) so the action is its own undo unit too:
  // typing that follows the click can never coalesce into the same 'edit'.
  ctx.syncNow();
}

function invokeItem(item: ToolbarItem): void {
  if (item.hostDelegated) {
    // Undo/Redo: pendingText rides the undo/redo message itself (one atomic
    // host handler) and no sync may run after it — see ToolbarItem.hostDelegated.
    hideTooltip();
    item.action();
    content.focus();
    return;
  }
  invokeAction(item.action, item.opensAsyncPrompt);
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
  // US-19.18 follow-up ("thực hiện transition từ state đang chọn sang state
  // mới, thay vì revert về state gốc rồi mới chuyển"): revert-to-committed chỉ
  // gắn ở CHÍNH popoverEl, không ở từng hàng. `mouseleave` không bubble và chỉ
  // bắn khi con trỏ rời khỏi TOÀN BỘ popoverEl (kể cả mọi hàng con) — di chuyển
  // giữa 2 hàng liền kề (không có khe hở) không bao giờ kích hoạt event này, vì
  // con trỏ chưa từng thật sự thoát khỏi popoverEl. Nhờ vậy preview của hàng A
  // vẫn còn nguyên trên trang cho tới khi debounce của hàng B chạy xong rồi đè
  // trực tiếp lên — CSS transition tự chuyển thẳng A→B. Chỉ khi rời hẳn cả
  // popover thì mới thật sự revert về state đã commit.
  el.addEventListener('mouseleave', () => {
    activeHoverCancel?.();
    activeHoverCancel = undefined;
  });
  return el;
}

/**
 * Hàng đang preview (nếu có) — cho closePopover() huỷ preview khi popover đóng
 * mà user KHÔNG chọn (Escape/click ra ngoài), tránh kẹt theme preview (US-19.18).
 */
let activeHoverCancel: (() => void) | undefined;

/** Thêm 1 hàng (icon + label + badge tuỳ chọn) vào popover, dùng chung cho menu tràn lẫn dropdown split-button. */
function addPopoverRow(
  popoverEl: HTMLElement,
  icon: string | undefined,
  label: string,
  badge: string | undefined,
  onClick: () => void,
  value?: string,
  onHoverPreview?: () => void,
  onHoverCancel?: () => void
): void {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'toolbar-popover-item';
  if (value !== undefined) {
    row.dataset.dropdownValue = value;
  }
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
  if (onHoverPreview && onHoverCancel) {
    // US-19.18 follow-up (bug report "theme apply quá nhanh gây choáng"): trễ
    // READING_PREVIEW_DEBOUNCE_MS trước khi THẬT SỰ áp preview — rê chuột lướt
    // qua nhiều hàng liên tục (không dừng ở hàng nào) sẽ không kích hoạt lần
    // preview nào cả, chỉ hàng con trỏ dừng đủ lâu mới đổi theme. mouseleave
    // luôn huỷ timer + revert ngay lập tức (không debounce chiều huỷ) nên rời
    // hàng luôn phản hồi tức thì dù preview đã kịp áp hay chưa.
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    row.addEventListener('mouseenter', () => {
      activeHoverCancel = onHoverCancel;
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        onHoverPreview();
      }, READING_PREVIEW_DEBOUNCE_MS);
    });
    row.addEventListener('mouseleave', () => {
      // Không revert ở đây (xem comment ở buildPopover()) — chỉ huỷ debounce
      // của CHÍNH hàng này nếu nó chưa kịp bắn, để rời hàng trước khi preview
      // áp thì không áp preview đó nữa (giữ nguyên preview trước đó, nếu có).
      if (previewTimer !== undefined) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
      }
    });
  }
  popoverEl.appendChild(row);
}

/** Mở popoverEl neo theo triggerBtn (căn phải mép dưới nút) — đóng popover khác đang mở trước. */
/**
 * US-19.18: khoá cứng font-size của mọi `.toolbar-popover-item` trong popover
 * bằng inline style tại thời điểm mở — bắt buộc phải là INLINE trên CHÍNH
 * từng hàng (không phải custom property đặt trên popoverEl) vì rule cỡ chữ
 * (editor.css US-19.6) gate theo SỰ CÓ MẶT của class `body.reading-mode`:
 * `body.reading-mode .toolbar-popover-item { font-size: var(--reading-ui-font-
 * size, 12px); }`. Preview hàng "Follow VS Code" gỡ hẳn `reading-mode` khỏi
 * body → rule này NGỪNG KHỚP hoàn toàn (không phải chỉ đổi giá trị biến), nên
 * chỉ đóng băng custom property không đủ — phải khoá thẳng `font-size` trên
 * từng hàng, thắng bất kể selector nào đang khớp lúc đó. Nếu không, dropdown tự
 * đổi cỡ chữ ngay lúc hover, đẩy hàng dưới khỏi con trỏ (hàng cuối có thể
 * không bao giờ nhận được click — bắt bằng Playwright).
 */
function freezePopoverRowSize(popoverEl: HTMLElement): void {
  const uiFontSize = getComputedStyle(document.body).getPropertyValue('--reading-ui-font-size').trim() || '12px';
  popoverEl.querySelectorAll<HTMLElement>('.toolbar-popover-item').forEach((row) => {
    row.style.fontSize = uiFontSize;
  });
}

function unfreezePopoverRowSize(popoverEl: HTMLElement): void {
  popoverEl.querySelectorAll<HTMLElement>('.toolbar-popover-item').forEach((row) => {
    row.style.removeProperty('font-size');
  });
}

function openPopover(triggerBtn: HTMLElement, popoverEl: HTMLElement): void {
  if (openPopoverEl && openPopoverEl !== popoverEl) {
    closePopover();
  }
  freezePopoverRowSize(popoverEl);
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
    unfreezePopoverRowSize(openPopoverEl);
  }
  openPopoverEl = undefined;
  openPopoverTrigger = undefined;
  // US-19.18: đóng popover khi đang preview (Escape/click ra ngoài, hoặc ngay
  // trước khi chạy action của hàng vừa click — action tự apply() lại ngay sau
  // nên không bị "revert rồi mất" gì cả, chỉ là 1 nhịp render thừa vô hại) →
  // luôn huỷ preview để không kẹt theme tạm trên trang.
  activeHoverCancel?.();
  activeHoverCancel = undefined;
}

function togglePopover(triggerBtn: HTMLElement, popoverEl: HTMLElement): void {
  if (openPopoverEl === popoverEl) {
    closePopover();
  } else {
    openPopover(triggerBtn, popoverEl);
  }
}

/**
 * Đang có popover nào mở không (dropdown split-button, menu tràn, more options).
 * Zen reveal (readability.ts) dựa vào đây để KHÔNG ẩn toolbar khi user đang
 * chọn trong dropdown — chuột rê xuống menu (y > 48) mà toolbar trượt đi thì
 * popover mất neo giữa chừng. Wire qua deps ở main.ts, không import ngược
 * (toolbar.ts đã import từ readability.ts, tránh vòng phụ thuộc).
 */
export function isPopoverOpen(): boolean {
  return openPopoverEl !== undefined;
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

// aria-label + tooltip + mousedown-preventDefault (giữ selection trong #content)
// — bộ dây chung của mọi nút trigger trên toolbar (nút đơn, 2 mặt split-button,
// nút overflow).
function wireTriggerButton(el: HTMLElement, title: string): void {
  el.setAttribute('aria-label', title);
  attachTooltip(el, title);
  el.addEventListener('mousedown', (e) => e.preventDefault());
}

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
  wireTriggerButton(btn, item.title);
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
  if (item.alignRight) {
    wrap.classList.add('toolbar-push-right');
  }

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'split-main';
  // id đi trên MẶT CHÍNH (không phải wrap) — khớp với contract của
  // buildPlainButtonEl (id trên chính <button> hiển thị), để mọi lookup
  // getElementById (vd. updateTocButton, hoặc active-state sync US-4.15 nếu
  // sau này mở rộng sang split-button) tìm đúng phần tử thật sự đổi trạng thái.
  if (item.id) {
    main.id = item.id;
  }
  if (item.icon) {
    main.innerHTML = item.icon;
  } else {
    main.textContent = item.label;
  }
  wireTriggerButton(main, item.title);

  const divider = document.createElement('span');
  divider.className = 'split-divider';

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'split-caret';
  caret.innerHTML = CARET_DOWN_ICON;
  const dropdownTitle = item.dropdownTitle ?? `${item.title} — more options`;
  wireTriggerButton(caret, dropdownTitle);

  const popover = buildPopover('toolbar-split-popover');
  if (item.id) {
    // Neo popover theo id để đồng bộ dấu chọn ngoài buildSplitButtonEl (US-19.10).
    popover.dataset.forId = item.id;
  }
  for (const entry of item.dropdown ?? []) {
    if (entry.separatorBefore) {
      const sep = document.createElement('div');
      sep.className = 'toolbar-popover-sep';
      popover.appendChild(sep);
    }
    addPopoverRow(
      popover,
      entry.icon,
      entry.label,
      entry.badge,
      () => {
        closePopover();
        invokeAction(entry.action, item.opensAsyncPrompt);
      },
      entry.value,
      entry.onHoverPreview,
      entry.onHoverCancel
    );
  }
  main.addEventListener('click', () => invokeItem(item));
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

  // Kebab "more options" (US-4.14) luôn ở CUỐI cùng, ngoài phạm vi
  // collapsibleEntries/toolbarItems — điều kiện "unconditional" khác hẳn
  // width-based overflow của US-4.7 (không bao giờ tự ẩn dù toolbar rộng hay
  // hẹp). Đứng ngay sau nút TOC (item cuối cùng có alignRight), cùng nhóm bị
  // đẩy phải nhờ margin-left: auto của TOC.
  toolbarEl.appendChild(createMoreOptionsButton());

  setupOverflowMenu();
  setupActiveFormattingSync();
}

/** Nút "..." — mở menu chứa các nút định dạng đang không đủ chỗ hiển thị. */
function createMoreButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toolbar-more';
  btn.innerHTML = MORE_ICON;
  btn.style.display = 'none';
  wireTriggerButton(btn, 'More tools');
  btn.addEventListener('click', () => {
    hideTooltip();
    toggleOverflowMenu();
  });
  return btn;
}

/**
 * "⋮" (vertical kebab) button — merges Copy "@file" reference / View raw
 * Markdown source into 1 popover, replacing the 2 always-visible buttons
 * from before (US-4.6/US-4.14). Same underlying action/message
 * (`copyFileMention`/`viewSource`), only the UI changed.
 */
function createMoreOptionsButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.innerHTML = MORE_OPTIONS_ICON;
  wireTriggerButton(btn, 'More options');

  // invokeAction (không phải postMessage trần) để khôi phục focus về #content
  // sau khi chọn — quan trọng nhất khi kích hoạt bằng bàn phím (Tab + Enter):
  // lúc đó mousedown/preventDefault (chặn trình duyệt cướp focus khi bấm
  // chuột) không hề chạy, focus đã nằm sẵn trên hàng popover từ trước khi
  // click, nên PHẢI có content.focus() tường minh — không thì focus kẹt lại
  // trên hàng vừa ẩn (display:none) thay vì quay về editor.
  const popover = buildPopover('toolbar-more-options-menu');
  addPopoverRow(popover, FILE_MENTION_ICON, 'Copy "@file" reference', undefined, () => {
    closePopover();
    invokeAction(() => ctx.vscode.postMessage({ type: 'copyFileMention' }));
  });
  addPopoverRow(popover, RAW_SOURCE_ICON, 'View raw Markdown source', undefined, () => {
    closePopover();
    invokeAction(() => ctx.vscode.postMessage({ type: 'viewSource' }));
  });

  btn.addEventListener('click', () => {
    hideTooltip();
    togglePopover(btn, popover);
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

/**
 * Đo lại bề rộng: hiện tất cả nút định dạng trước, nếu tràn thì ẩn dần từ nút
 * cuối dãy (giữ nguyên nhóm tiện ích đẩy phải luôn hiện) cho tới khi vừa,
 * rồi dựng lại menu tràn từ danh sách vừa ẩn.
 *
 * Đóng bất kỳ popover nào đang mở (không chỉ menu tràn) trước khi tính lại —
 * một dropdown split-button (Heading/Code block/Math) đang mở có thể chính là
 * cái trigger sắp bị ẩn (display:none) ở vòng lặp bên dưới; nếu chỉ đóng
 * riêng menu tràn, popover đó sẽ trôi nổi ở toạ độ cũ, mất neo với trigger.
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
  closePopover();

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
      closePopover();
      invokeItem(entry.item);
    });
  }
}

/**
 * Cấp heading (h1–h6) chứa caret hiện tại, hoặc DEFAULT_HEADING nếu caret
 * không nằm trong heading nào (US-4.16 — nhãn mặt chính của split-button
 * live-sync theo caret, đảo lại quyết định "static label" ban đầu của US-4.9).
 * Dùng chung cho action mặt chính (currentHeadingTag() làm tham số cho
 * formatHeading) VÀ updateHeadingLabel() bên dưới — đảm bảo nút luôn hiển thị
 * đúng cấp mà click vào nó sẽ áp dụng/toggle.
 */
// window.getSelection()'s anchor as its nearest Element (or null) — the opening
// every selection-scoped format helper (heading/blockquote) shares.
function getAnchorElement(): Element | null {
  const sel = window.getSelection();
  return sel?.anchorNode ? closestElement(sel.anchorNode) : null;
}

function currentHeadingTag(): string {
  const anchor = getAnchorElement();
  const heading = anchor?.closest('h1, h2, h3, h4, h5, h6') as HTMLElement | null;
  return heading && content.contains(heading) ? heading.tagName.toLowerCase() : DEFAULT_HEADING;
}

/** Cập nhật nhãn (text) của mặt chính Heading split-button theo `currentHeadingTag()`. */
function updateHeadingLabel(): void {
  const btn = document.getElementById('fmt-heading');
  if (btn) {
    btn.textContent = currentHeadingTag().toUpperCase();
  }
}

/**
 * Đổi block hiện tại thành heading/đoạn văn. Không dùng execCommand
 * formatBlock vì Chrome có bug tạo heading lồng nhau khi bấm lặp lại
 * (h1 trong h1 → font-size 2em × 2em phình dần). Bấm lại cùng cấp
 * heading → trở về đoạn văn (toggle).
 */
function formatHeading(tag: string): void {
  const anchor = getAnchorElement();
  if (!anchor) {
    return;
  }
  if (anchor.closest('td, th')) {
    return; // markdown không có heading trong ô bảng
  }
  const block = anchor.closest('h1, h2, h3, h4, h5, h6, p') as HTMLElement | null;
  if (!block || !content.contains(block) || block === content) {
    // HLR 22 Phase 2 (Bug #7), defense-in-depth for Group HrCaretTrap: when the
    // anchor is the #content root ITSELF — the degenerate "caret in the gap next
    // to an <hr>" selection that main.ts's ensureCaretSpotBeforeHr trap normally
    // prevents — there is no real block to format, and execCommand('formatBlock')
    // here absorbs the adjacent <hr> into a heading. Bail instead. Genuine
    // uncharacterized shapes (caret in a tight <li>, <pre>...) still reach the
    // legacy fallback below: their anchor is inside that element, not #content.
    if (anchor === content) {
      return;
    }
    // HLR 22 Phase 2.6: intentionally KEPT on legacy execCommand — this branch
    // only fires for uncharacterized shapes (caret in a tight <li>, <pre>...,
    // or no resolvable block at all), same deliberate-fallback policy as
    // setBulletList/setNumberedList's unresolvable-range cases (2.3/2.4). The
    // characterized p/heading path below never reaches execCommand
    // (replaceBlockTag, Phase 2.5).
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
  const anchor = getAnchorElement();
  const bq = anchor?.closest('blockquote');
  if (bq && content.contains(bq)) {
    const saved = sel && sel.rangeCount > 0 ? { node: sel.anchorNode, offset: sel.anchorOffset } : null;
    // Remove only the quote LEVEL the caret sits in (the nearest blockquote) plus
    // any quotes nested deeper inside it — its content drops one level up to the
    // enclosing (higher) blockquote, which stays untouched.
    const firstChild: Node | null = bq.firstChild;
    const quotes = [bq, ...Array.from(bq.querySelectorAll('blockquote'))];
    for (const q of quotes.reverse()) {
      const p = q.parentNode;
      while (q.firstChild) {
        p?.insertBefore(q.firstChild, q);
      }
      q.remove();
    }
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
    // HLR 22 Phase 2.6: characterized case (caret in a top-level p/heading) →
    // wrapInBlockquote (direct-Range, canonical <blockquote><p>> shape, same
    // markdown output). Anything else (li/td/pre..., or no resolvable block)
    // keeps the legacy execCommand fallback unchanged, mirroring 2.3/2.4.
    const block = anchor?.closest('p, h1, h2, h3, h4, h5, h6') as HTMLElement | null;
    if (block && block.parentElement === content) {
      ctx.dom.wrapInBlockquote(block);
    } else {
      document.execCommand('formatBlock', false, 'blockquote');
    }
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

/** Đặt lại selection = Range bao trọn từ items[0] đến items cuối. Thao tác đổi
 * kiểu list ngay sau đó ở đường CHÍNH giờ đi qua compute-then-commit primitive
 * (computeRetag/UnwrapListRange → commitListOpDirect, HLR 22 Phase 2.3/2.4) vốn
 * TỰ dựng range từ plan nên KHÔNG đọc selection này; reselection chỉ còn cần cho
 * nhánh fallback execCommand('insert{Un}orderedList') còn giữ (khi plan = null)
 * — execCommand cần selection trải đúng toàn bộ <li> vừa xử lý, không bị thu về
 * caret đơn lẻ mà insertHTML để lại. */
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
 * findListItemsBetween) để caller re-select đúng phạm vi cho nhánh fallback
 * execCommand('insert{Un}orderedList') còn giữ (đổi kiểu list khi primitive trả
 * null) — insertHTML để lại selection collapse về 1 điểm, không đủ để execCommand
 * áp lên toàn bộ targets. Đường chính (computeRetag/UnwrapListRange →
 * commitListOpDirect, HLR 22 Phase 2.3/2.4) tự dựng range nên không cần bước này.
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
  const checkbox = findTaskCheckbox(li);
  // Checkbox's own parent: `li` itself for a tight item, the child <p> for a
  // loose one — the stray-space cleanup below must trim THAT parent's first
  // child, not always li.firstChild (which would miss a loose item's <p>).
  const container = checkbox?.parentElement ?? li;
  checkbox?.remove();
  li.classList.remove('task-list-item');
  // markdown-it-task-lists chỉ cắt "[ ]" (3 ký tự) khỏi text khi render, GIỮ
  // LẠI dấu cách đứng sau — text node trong <li> task luôn bắt đầu bằng " ".
  // Đứng sau checkbox thì vô hình, nhưng bỏ checkbox rồi thì lộ ra thành
  // khoảng trắng thừa đầu dòng → cắt luôn khi gỡ checkbox.
  const first = container.firstChild;
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
 * Build a list from a selection that is NOT yet inside a list, shared by the
 * `!current` branches of `setBulletList`/`setNumberedList`. Two tiers:
 *   1. A clean P/UL/OL span → `computeToList` (tight list; blank <p>s dropped as
 *      spacing).
 *   2. Otherwise the span contains an atom (<hr>/<table>/<pre>/<blockquote>/
 *      heading) → `computeToListAroundAtoms`, which keeps each atom verbatim and
 *      splits the list AROUND it (multi-root plan → `commitListOpDirect`).
 * Never the corruption-prone legacy `execCommand('insert(Un)orderedList')`
 * (bug 0717r3 #5/#11) — the same path `toggleTaskItem` already uses.
 */
function convertSelectionToList(ordered: boolean): void {
  const blocks = resolveTopLevelBlocks();
  if (blocks) {
    commitListOp(computeToList(blocks, ordered), ctx.dom.placeCaretAtOffsets);
    return;
  }
  const run = resolveTopLevelBlockRun();
  if (!run) {
    return;
  }
  const plan = computeToListAroundAtoms(run, ordered);
  if (plan) {
    commitListOpDirect(plan, ctx.dom.placeCaretAtOffsets);
  }
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
    convertSelectionToList(false);
    return;
  }
  const { list, items } = current;
  const hasCheckbox = items.some((item) => item.querySelector(':scope > input[type="checkbox"]'));
  // Tracks whichever <li> set is the LIVE target for the retag/unwrap below --
  // `replaceListItems` detaches the original `items` nodes once it runs, so
  // after checkbox stripping the live set is `inserted`, not `items`.
  let targets = items;
  if (hasCheckbox) {
    const inserted = replaceListItems(items, stripCheckboxFrom);
    syncTaskListClass(list);
    if (list.tagName === 'UL') {
      return; // đã là bullet thường sau khi bỏ checkbox, không cần execCommand
    }
    reselectItems(inserted);
    targets = inserted;
  }
  // Caret/selection already in a list, Bullet clicked: an all-<ul> target
  // range toggles off to plain <p>s (computeUnwrapListRange), an all-<ol>
  // range converts to its own <ul> (computeRetagListRange) -- both split
  // untouched siblings into their own list of the original type instead of
  // splitting the whole list (HLR 22 Phase 2.3). Nested sublist on any target
  // -> null -> unchanged legacy execCommand fallback.
  // commitListOpDirect never lands on the browser's native undo stack, but
  // that's not a regression here: `invokeAction` (the shared toolbar-click
  // wrapper) always calls `ctx.syncNow()` right after the action runs,
  // regardless of which DOM mechanism produced the change, and Ctrl+Z/Y in
  // this extension is delegated entirely to VS Code's own TextDocument undo
  // (never the browser's native stack) -- same reasoning as list-ops.ts's
  // outdent/indent wiring in main.ts.
  const plan = list.tagName === 'UL' ? computeUnwrapListRange(list, targets) : computeRetagListRange(list, targets, false);
  if (plan) {
    commitListOpDirect(plan, ctx.dom.placeCaretAtOffsets);
    return;
  }
  document.execCommand('insertUnorderedList');
  removeStrayEmptyParagraphNear(list);
}

/**
 * Nút numbered (1.): đối xứng với setBulletList (HLR 22 Phase 2.4).
 *   - Chưa ở trong list: dựng list qua convertSelectionToList (computeToList cho
 *     span P/UL/OL "chặt", hoặc computeToListAroundAtoms khi có atom) — không còn
 *     execCommand('insertOrderedList') vốn rò rỉ <p><ol>…</ol></p> / corrupt gần
 *     <hr>/table (xem list-verbs-audit, bug 0717r3 #5).
 *   - Đang trong list: bỏ checkbox trước nếu có (như bullet), rồi <ol> đích →
 *     toggle off về <p> (computeUnwrapListRange), <ul> đích → đổi thành <ol>
 *     (computeRetagListRange). Sublist lồng trong <li> đích → null → fallback
 *     execCommand cũ, không đổi hành vi.
 * commitListOpDirect không nằm trên native undo stack, nhưng không phải hồi
 * quy: invokeAction luôn gọi ctx.syncNow() ngay sau action và Ctrl+Z/Y ở
 * extension này đều uỷ cho TextDocument (xem lý do ở setBulletList).
 */
function setNumberedList(): void {
  const current = getListSelection();
  if (!current) {
    convertSelectionToList(true);
    return;
  }
  const { list, items } = current;
  const hasCheckbox = items.some((item) => item.querySelector(':scope > input[type="checkbox"]'));
  // Tracks the LIVE <li> set for the retag/unwrap below -- replaceListItems
  // detaches the original `items` nodes once it runs (same note as setBulletList).
  let targets = items;
  if (hasCheckbox) {
    const inserted = replaceListItems(items, stripCheckboxFrom);
    syncTaskListClass(list);
    reselectItems(inserted);
    targets = inserted;
  }
  const plan = list.tagName === 'OL' ? computeUnwrapListRange(list, targets) : computeRetagListRange(list, targets, true);
  if (plan) {
    commitListOpDirect(plan, ctx.dom.placeCaretAtOffsets);
    return;
  }
  document.execCommand('insertOrderedList');
  removeStrayEmptyParagraphNear(list);
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
 * Resolve one Range boundary (container + offset) to the top-level child of
 * `content` it sits in. Normally delegates to `topLevelChildContaining`, but
 * also handles Chrome placing the boundary ON `content` itself (Ctrl+A /
 * select-to-edge, where the offset indexes `content`'s children) by clamping to
 * a real child — otherwise those selections would resolve to null and the caller
 * would silently no-op. `isEnd` picks the child just before the end offset.
 */
function boundaryTopLevelChild(container: Node, offset: number, isEnd: boolean): Element | null {
  if (container === content) {
    const kids = content.children;
    if (kids.length === 0) {
      return null;
    }
    const idx = Math.max(0, Math.min(isEnd ? offset - 1 : offset, kids.length - 1));
    return kids[idx];
  }
  return topLevelChildContaining(container);
}

/**
 * Walk the contiguous run of top-level children of `content` spanned by the
 * current selection ([startTop..endTop]). `accept` decides per block whether to
 * keep it in the run (true) or abandon the whole run (false → null). Returns
 * null if there's no selection or a boundary doesn't resolve to a top-level
 * child of `content` (e.g. selection outside `content`). Shared by
 * `resolveTopLevelBlocks` (strict — only characterized/droppable blocks) and
 * `resolveTopLevelBlockRun` (permissive — keep everything incl. atoms).
 */
function resolveSelectionBlockRun(accept: (el: Element) => boolean): Element[] | null {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (!range) {
    return null;
  }
  const startTop = boundaryTopLevelChild(range.startContainer, range.startOffset, false);
  const endTop = boundaryTopLevelChild(range.endContainer, range.endOffset, true);
  if (!startTop || !endTop) {
    return null;
  }
  const blocks: Element[] = [];
  for (let el: Element | null = startTop; el; el = el.nextElementSibling) {
    if (!accept(el)) {
      return null;
    }
    blocks.push(el);
    if (el === endTop) {
      break;
    }
  }
  return blocks;
}

/**
 * Resolve the top-level blocks spanned by the current selection, for the
 * `!current` (not-yet-in-a-list) branches of `setBulletList`/`setNumberedList`/
 * `toggleTaskItem` to feed `computeToList` — the single shared resolver since
 * HLR 22 Phase 2.7 (toggleTaskItem's former inline startTop/endTop walk was
 * consolidated onto it). Returns null if any spanned block is outside the
 * characterized/droppable set (bails to the caller's fallback).
 */
function resolveTopLevelBlocks(): Element[] | null {
  // Strict: computeToList is only characterized for P/UL/OL. Anything else in
  // the span (a content-bearing atom like <table>/<pre>/<blockquote>/heading,
  // OR a separator like <hr>) bails to null, so the caller routes through the
  // atom-aware computeToListAroundAtoms path (which splits the list around atoms
  // and keeps them verbatim) instead — never dropping/mangling them. A blank
  // <p> IS P/UL/OL-listable, so blank-line dropping still happens cleanly here
  // via computeToList (bug 0717 round3 #5, Group ListVerbBlankDrop).
  return resolveSelectionBlockRun((el) => el.tagName === 'P' || el.tagName === 'UL' || el.tagName === 'OL');
}

/**
 * Like `resolveTopLevelBlocks`, but returns the FULL contiguous run of
 * top-level children between the selection's boundaries INCLUDING content-
 * bearing atom blocks (table/pre/blockquote/heading) instead of bailing on
 * them. Feeds `computeToListAroundAtoms`, which splits the list around atoms
 * (and converts headings) rather than corrupting via native execCommand (bug
 * 0717r3 #11). Returns null only if a boundary doesn't resolve to a top-level
 * child of `content`. A boundary inside a table cell resolves (via
 * `topLevelChildContaining`) to the whole <table>, so a partial/in-cell
 * selection yields an all-atom run — computeToListAroundAtoms then no-ops.
 */
function resolveTopLevelBlockRun(): Element[] | null {
  return resolveSelectionBlockRun(() => true);
}

function toggleTaskItem(): void {
  const current = getListSelection();

  if (!current) {
    // Not inside a list yet → build a list for the whole selection first.
    // HLR 22 Phase 2.7: the former inline startTop/endTop walk + hand-built
    // tight-<ul> insertHTML (the per-feature workaround for bug #3's
    // execCommand('insertUnorderedList') multi-<ul>/loose-list splits) is
    // consolidated onto the same resolveTopLevelBlocks + computeToList/
    // commitListOp pair setBulletList already uses — identical tight-<ul>
    // shape, blank-line skipping, and single-insertHTML undo step, one shared
    // implementation instead of two.
    let freshItems: HTMLLIElement[] = [];
    const blocks = resolveTopLevelBlocks();

    if (blocks) {
      // Captured BEFORE the commit — the just-inserted <ul> is then
      // deterministically at this position; read its own children instead of
      // sweeping an unbounded sibling range (bug #10: a stale/unresolved end
      // boundary must never leak into which <li>s get a checkbox).
      const before = blocks[0].previousElementSibling;
      commitListOp(computeToList(blocks, false), ctx.dom.placeCaretAtOffsets);
      const insertedList = before ? before.nextElementSibling : content.firstElementChild;
      if (insertedList) {
        freshItems = Array.from(insertedList.querySelectorAll(':scope > li')) as HTMLLIElement[];
      }
    } else {
      // Uncharacterized shape — the selection spans a content-bearing block
      // outside computeToList's P/UL/OL set (a <table>/<pre>/<blockquote>/
      // heading). Instead of the corruption-prone native
      // execCommand('insertUnorderedList') (bug 0717r3 #11: it merged an
      // unrelated pre-existing <ul> and demoted an intervening heading),
      // build the list ourselves with computeToListAroundAtoms: convertible
      // blocks (incl. headings) become <li>s while each atom block is kept
      // verbatim, so the list splits AROUND it. commitListOpDirect (not
      // commitListOp) because the plan is multi-root — and, like the rest of
      // this module's raw-DOM ops, it lands as one host TextDocument edit, so
      // a single Ctrl+Z reverts only this edit (the entangled-undo half of #11).
      const run = resolveTopLevelBlockRun();
      if (!run) {
        return;
      }
      // Snapshot the boundaries BEFORE the commit — commitListOpDirect creates
      // brand-new nodes, so the fresh list(s) can only be found by position,
      // between the untouched siblings just outside the replaced range.
      const before = run[0].previousElementSibling;
      const after = run[run.length - 1].nextElementSibling;
      const plan = computeToListAroundAtoms(run, false);
      if (!plan) {
        return; // no convertible block (e.g. selection resolved to only a table) → no-op
      }
      commitListOpDirect(plan, ctx.dom.placeCaretAtOffsets);
      const start = before ? before.nextElementSibling : content.firstElementChild;
      for (let el: Element | null = start; el && el !== after; el = el.nextElementSibling) {
        if (el.tagName === 'UL' || el.tagName === 'OL') {
          freshItems.push(...(Array.from(el.querySelectorAll(':scope > li')) as HTMLLIElement[]));
        }
      }
    }

    if (!freshItems.length) {
      return;
    }
    // Newly-created <li>s never already have a checkbox → always "add" for all
    // of them. Calling addCheckbox directly on the real node keeps
    // li.parentElement correct — contains-task-list lands on the right <ul>.
    freshItems.forEach((li) => addCheckbox(li));
    return;
  }

  const { list, items: targets } = current;

  if (targets.length === 1) {
    const existing = findTaskCheckbox(targets[0]);
    if (existing) {
      // Bỏ checkbox thì trả item về ĐOẠN VĂN THƯỜNG (<p>), không để trơ lại
      // thành bullet — cùng chiều toggle-off của nút Bullet/Numbered
      // (setBulletList/setNumberedList dùng chung computeUnwrapListRange, bug
      // ExcelCmd #5). Hàm này tách list quanh target và tự mang lại
      // `contains-task-list` cho các item trước/sau còn là task, nên KHÔNG gỡ
      // class khỏi cả list bằng tay (sẽ mất checkbox marker của các item còn
      // lại); chỉ nhánh fallback (sublist lồng → plan null) mới cần gỡ.
      stripCheckboxFrom(targets[0]);
      const plan = computeUnwrapListRange(list, targets);
      if (plan) {
        commitListOpDirect(plan, ctx.dom.placeCaretAtOffsets);
      } else {
        list.classList.remove('contains-task-list');
        document.execCommand('insertUnorderedList');
        removeStrayEmptyParagraphNear(list);
      }
    } else {
      // <ol> đích → tách item ra <ul class="contains-task-list"> riêng, các item
      // trước/sau giữ nguyên <ol> (giống setBulletList/setNumberedList retag-split
      // cho TC2.3c/2.4c). Nếu addCheckbox tại chỗ, item sẽ thành "2. [ ] Bravo"
      // (vừa số vừa checkbox) và class contains-task-list gắn lên cả <ol> khiến
      // padding-left tụt còn 1.2em (markdown.css) → Alpha/Charlie bị đẩy lệch
      // trái (bug ExcelCmd #3). Sublist lồng trong <li> đích → null → fallback.
      // <ul> đích giữ nguyên addCheckbox tại chỗ: "- [ ] x" trong bullet list là
      // markdown hợp lệ, checkbox độc lập kiểu list (markdown-it-task-lists và
      // turndown không phân biệt <ol>/<ul>).
      const plan = list.tagName === 'OL' ? computeTaskifyListRange(list, targets) : null;
      if (plan) {
        commitListOpDirect(plan, ctx.dom.placeCaretAtOffsets);
      } else {
        addCheckbox(targets[0]);
      }
    }
    return;
  }

  // Nhiều <li> đang được chọn → convert TOÀN BỘ sang cùng chiều (thêm hoặc bỏ
  // checkbox), không chỉ mỗi item chứa anchor. Dùng findTaskCheckbox (nhận cả
  // checkbox nằm trong <p> con của item LOOSE) thay vì query ':scope > input'
  // chỉ bắt item tight — nếu không, chọn nhiều item loose sẽ bị coi là "chưa có
  // checkbox" → nhầm sang nhánh add và toggle-off không làm gì (bug ExcelCmd #5 review).
  const shouldAdd = !targets.every((item) => findTaskCheckbox(item));
  if (!shouldAdd) {
    // Bỏ checkbox cho cả vùng chọn → trả về đoạn văn thường (<p>), tách list
    // quanh dải target — cùng chiều toggle-off của nhánh 1-item ở trên (bug
    // ExcelCmd #5). Gỡ checkbox TRƯỚC để innerHTML dùng dựng <p> không còn thẻ
    // <input> (nếu không, checkbox lọt vào <p> và serialize ra HTML thô). Sublist
    // lồng → plan null → rơi xuống strip tại chỗ bên dưới (giữ hành vi cũ, các
    // target lúc này đã bị gỡ checkbox nên replaceListItems chỉ còn là bullet).
    targets.forEach((li) => stripCheckboxFrom(li));
    const plan = computeUnwrapListRange(list, targets);
    if (plan) {
      commitListOpDirect(plan, ctx.dom.placeCaretAtOffsets);
      return;
    }
  }
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
 *
 * Khi vùng chọn trải dài qua NHIỀU block (vd. chọn từ giữa đoạn này sang giữa
 * đoạn kế tiếp, kể cả khi có đoạn trắng xen giữa) — bug 2026-07-14: trước đây
 * chỉ lấy `block` từ `range.startContainer` rồi `selectNode(block)` khi thay
 * thế, nên các block khác nằm trong vùng chọn (kể cả đoạn trắng ở giữa) không
 * hề bị xoá, trong khi `codeContent` (lấy từ `sel.toString()`) đã chứa toàn bộ
 * text của các block đó → nội dung bị nhân đôi. Fix: tìm thêm `endBlock` từ
 * `range.endContainer`, dùng nó làm điểm kết cho afterRange/afterBlock, và khi
 * thay thế phải chọn từ trước `block` đến sau `endBlock` để xoá hết mọi block
 * nằm giữa (không chỉ riêng `block`).
 */
function insertCodeBlock(lang: string): void {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  const selectedText = sel?.toString() ?? '';
  const codeContent = escapeHtml(selectedText || 'code');
  const langClass = escapeAttr(lang);

  const anchor = range ? closestElement(range.startContainer) : null;
  const block = anchor?.closest('p, h1, h2, h3, h4, h5, h6') as HTMLElement | null;
  const endAnchor = range ? closestElement(range.endContainer) : null;
  const endBlock = endAnchor?.closest('p, h1, h2, h3, h4, h5, h6') as HTMLElement | null;

  if (
    !range ||
    !selectedText ||
    !block ||
    !endBlock ||
    !content.contains(block) ||
    !content.contains(endBlock) ||
    block === content
  ) {
    // Không có vùng chọn hợp lệ trong một đoạn văn/heading (vd. caret rỗng,
    // hoặc đang ở trong list/bảng) — giữ hành vi cũ: chèn code block mẫu
    // ngay tại vị trí caret, không cần tách trước/sau.
    document.execCommand(
      'insertHTML',
      false,
      `<pre><code class="language-${langClass}">${codeContent}</code></pre><p><br></p>`
    );
    highlightNewCodeBlocks();
    return;
  }

  const beforeRange = document.createRange();
  beforeRange.setStart(block, 0);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const beforeHtml = rangeToHtml(beforeRange);

  const afterRange = document.createRange();
  afterRange.setStart(range.endContainer, range.endOffset);
  afterRange.setEnd(endBlock, endBlock.childNodes.length);
  const afterHtml = rangeToHtml(afterRange);

  const tag = block.tagName.toLowerCase();
  const endTag = endBlock.tagName.toLowerCase();
  const beforeBlock = beforeHtml.trim() ? `<${tag}>${beforeHtml}</${tag}>` : '';
  const afterBlock = `<${endTag}>${afterHtml.trim() ? afterHtml : '<br>'}</${endTag}>`;

  const blockRange = document.createRange();
  blockRange.setStartBefore(block);
  blockRange.setEndAfter(endBlock);
  sel?.removeAllRanges();
  sel?.addRange(blockRange);
  document.execCommand(
    'insertHTML',
    false,
    `${beforeBlock}<pre><code class="language-${langClass}">${codeContent}</code></pre>${afterBlock}`
  );
  highlightNewCodeBlocks();
}

/**
 * Bug 2026-07-14: code block mới chèn qua toolbar không có highlight cú pháp
 * (chỉ text trơn) — chỉ sau khi save/đóng/mở lại (đi qua lại pipeline
 * markdown-it + hljs ở render.ts) mới có màu. Áp `hljs.highlightElement`
 * ngay tại chỗ cho các <code class="language-*"> vừa chèn (chưa có class
 * "hljs" đánh dấu đã highlight) để khớp ngay với kết quả render từ nguồn.
 */
function highlightNewCodeBlocks(): void {
  content.querySelectorAll('pre > code[class*="language-"]:not(.hljs)').forEach((el) => {
    hljs.highlightElement(el as HTMLElement);
  });
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
      // The callback runs AFTER invokeAction's flush already happened — edits
      // scheduled while the prompt was open must not coalesce with the insert.
      ctx.flushPendingSync();
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        document.execCommand('createLink', false, url);
      } else {
        // encodeLinkPath CHỈ áp cho path tương đối (không có scheme) — URL
        // tuyệt đối giữ nguyên, encode sẽ phá "://" và query string "?a=1&b=2"
        // (bug đã xác nhận qua test/roundtrip/toolbar-insert.ts: path tương
        // đối có dấu cách không encode làm markdown đổi hình dạng ở lần
        // render→serialize thứ 2, xem insertImage() bên dưới).
        const href = isAbsoluteUrl(url) ? url : encodeLinkPath(url);
        document.execCommand(
          'insertHTML',
          false,
          `<a href="${escapeAttr(href)}">${escapeHtml(displayText ?? url)}</a>`
        );
      }
      // syncNow, not scheduleSync: the prompt callback runs AFTER invokeAction
      // already returned, so its post-action sync bracketed nothing — a
      // debounced sync here would let typing within 250ms coalesce with the
      // inserted link into one undo unit (bug 0717's chronology defect).
      ctx.syncNow();
    },
    { fileSearchQuery: selectedText }
  );
}

function insertImage(): void {
  ctx.promptInput('Image path (relative or URL):', '', (src) => {
    if (!src) {
      return;
    }
    // Same flush-before reason as insertLink()'s callback.
    ctx.flushPendingSync();
    // Cùng lý do với insertLink() ở trên: chỉ encode path tương đối, giữ
    // nguyên URL tuyệt đối — trước đây KHÔNG encode gì cả (khác paste-image.ts
    // insertImageAt, vốn luôn encode vì relPath luôn là path tương đối), khiến
    // path có dấu cách không ổn định qua lần render→serialize thứ 2.
    const href = isAbsoluteUrl(src) ? src : encodeLinkPath(src);
    document.execCommand('insertHTML', false, `<img src="${escapeAttr(href)}" alt="">`);
    // syncNow, not scheduleSync — same undo-chronology reason as insertLink().
    ctx.syncNow();
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

// ---------------------------------------------------------------------------
// Active-state sync theo caret (US-4.15) — Bold/Italic/Strikethrough/Inline
// code/Blockquote/Bullet/Numbered/Task đồng bộ class `.active` (đã ship, xem
// updateTocButton) theo vị trí caret. Code block/Math (US-4.10/4.11) CỐ Ý bị
// loại — split-button của các nút đó luôn hiện nhãn mặc định tĩnh, không
// live-sync theo caret, đây là quyết định riêng, không phải thiếu sót. Heading
// (US-4.9) từng cũng bị loại tương tự, nhưng US-4.16 (2026-07-13) đảo lại
// quyết định đó cho riêng PHẦN NHÃN (xem updateHeadingLabel) — Heading vẫn
// KHÔNG có `.active` background (giữ nguyên phần đó của US-4.9/4.15), chỉ
// text hiển thị (H1..H6) đổi theo caret, một concern tách biệt hoàn toàn với
// vòng lặp ACTIVE_SYNC_IDS bên dưới.
// ---------------------------------------------------------------------------

const ACTIVE_SYNC_IDS = [
  'fmt-bold',
  'fmt-italic',
  'fmt-strike',
  'fmt-inline-code',
  'fmt-blockquote',
  'fmt-bullet',
  'fmt-numbered',
  'fmt-task',
];

function setActive(id: string, active: boolean): void {
  document.getElementById(id)?.classList.toggle('active', active);
}

/**
 * Tính lại + gán `.active` cho 8 nút ở trên. Bullet/Numbered dựa theo
 * `getListSelection()` (US-4.2) — CHỈ theo tag `<ul>`/`<ol>`, không loại trừ
 * item có checkbox: ví dụ cụ thể trong AC US-4.15 xác nhận 1 item đã check
 * nằm trong `<ol>` phải sáng ĐỒNG THỜI cả Numbered lẫn Task (giống Bold+Italic
 * cùng sáng một lúc) — task/list-type là 2 trục độc lập, không loại trừ nhau.
 * Task dùng riêng `<li>` chứa anchor (không phải cả `getListSelection().items`)
 * theo đúng câu chữ AC ("active when the caret's `<li>` has a checkbox").
 */
function recomputeActiveFormatting(): void {
  const sel = window.getSelection();
  const anchor = sel?.anchorNode;
  const focus = sel?.focusNode;
  if (!sel || !anchor || !focus || !content.contains(anchor) || !content.contains(focus)) {
    for (const id of ACTIVE_SYNC_IDS) {
      setActive(id, false);
    }
    return;
  }

  setActive('fmt-bold', document.queryCommandState('bold'));
  setActive('fmt-italic', document.queryCommandState('italic'));
  setActive('fmt-strike', document.queryCommandState('strikeThrough'));

  const anchorEl = closestElement(anchor);
  const inlineCode = anchorEl?.closest('code') ?? null;
  setActive('fmt-inline-code', !!inlineCode && !inlineCode.closest('pre'));

  const bq = anchorEl?.closest('blockquote') ?? null;
  setActive('fmt-blockquote', !!bq && content.contains(bq));

  // Dò trực tiếp <li>/<ul>/<ol> gần nhất qua closest() thay vì gọi
  // getListSelection() (US-4.2) — hàm đó tự dò lại toàn bộ Range + duyệt hết
  // các <li> con của list bằng range.intersectsNode để trả về CẢ danh sách
  // item đang chọn, tốn hơn hẳn mức cần cho việc này (chỉ cần biết li/list
  // của một điểm caret). recomputeActiveFormatting chạy trên mọi
  // selectionchange (mỗi lần di caret) nên tránh phần dò thừa đó.
  const li = anchorEl?.closest('li') ?? null;
  const liInContent = !!li && content.contains(li);
  setActive('fmt-task', liInContent && !!li.querySelector(':scope > input[type="checkbox"]'));

  const list = liInContent ? li.parentElement : null;
  setActive('fmt-bullet', list?.tagName === 'UL');
  setActive('fmt-numbered', list?.tagName === 'OL');
}

let activeSyncRafId: number | undefined;

/**
 * `selectionchange` bắn rất dày (mỗi lần caret di chuyển) — coalesce về một
 * lần tính/khung hình bằng requestAnimationFrame, cùng kỹ thuật đã dùng ở
 * select-highlight.ts, thay vì tính lại trên từng sự kiện thô.
 */
function setupActiveFormattingSync(): void {
  document.addEventListener('selectionchange', () => {
    if (activeSyncRafId !== undefined) {
      return;
    }
    activeSyncRafId = requestAnimationFrame(() => {
      activeSyncRafId = undefined;
      recomputeActiveFormatting();
      updateHeadingLabel();
    });
  });
}
