/**
 * Block Map (HLR mục 18, US-18.1) — chỉ mục có thứ tự các block cấp cao nhất
 * (con trực tiếp của #content), với định danh bền TRONG PHIÊN webview. KHÔNG
 * ghi id vào file .md (design-log mục 7: tránh làm bẩn file/git diff — xem
 * ../../OrcaEditor-Requirements/Requirement - 18 Block-Indexed Architecture.md).
 *
 * Đây là chỉ mục DẪN XUẤT từ DOM + markdown nguồn hiện có, không phải document
 * model: không mô hình hoá rich-text bên trong block, DOM vẫn là sự thật cho
 * nội dung trong block. Mọi feature cần "nhận diện lại block sau khi DOM đổi"
 * (drag-drop, comment...) nên đọc từ đây thay vì tự chế cơ chế khớp cục bộ
 * (bài học gutter.ts trước khi có module này — xem design-log mục 6).
 */
import { FRONT_MATTER_CLASS, MATH_BLOCK_CLASS, MERMAID_CLASS, type LineRange } from './render';
import { readSrcRange } from './block-info';

/** Bản chiếu tra-ngược nhanh trên DOM — mảng BlockEntry trong JS mới là bản chính. */
export const BLOCK_ID_ATTR = 'data-block-id';

export interface BlockEntry {
  /** Định danh bền trong phiên làm việc hiện tại — sinh mới mỗi khi mở webview, không ghi vào file .md. */
  id: string;
  type: string;
  el: HTMLElement;
  srcRange: LineRange;
  /** Lát markdown nguồn của riêng block này, cắt từ `currentText` theo srcRange. */
  mdSlice: string;
}

let nextBlockId = 1;
function freshBlockId(): string {
  return `block-${nextBlockId++}`;
}

function classifyBlockType(el: HTMLElement): string {
  if (el.classList.contains(MERMAID_CLASS)) {
    return 'mermaid';
  }
  if (el.classList.contains(MATH_BLOCK_CLASS)) {
    return 'math';
  }
  if (el.classList.contains(FRONT_MATTER_CLASS)) {
    return 'front-matter';
  }
  switch (el.tagName) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return 'heading';
    case 'UL':
    case 'OL':
      return 'list';
    case 'TABLE':
      return 'table';
    case 'PRE':
      return 'code';
    case 'BLOCKQUOTE':
      return 'blockquote';
    case 'HR':
      return 'hr';
    case 'P':
      return 'paragraph';
    default:
      return el.tagName.toLowerCase();
  }
}

function sliceMarkdown(lines: string[], range: LineRange): string {
  return lines.slice(range.start - 1, range.end).join('\n');
}

/**
 * Dựng lại Block Map — gọi ở cuối renderDocument() (main.ts), sau khi DOM mới
 * đã ổn định (post-process math/mermaid, ensureTrailingParagraph...).
 *
 * Khớp id với `previous` bằng content-hash (so trực tiếp `mdSlice` — ổn định,
 * không phụ thuộc chi tiết render, theo Open Question đã chốt trong spec) +
 * thứ tự xuất hiện: block nội dung không đổi giữ nguyên id, block mới được
 * cấp id mới. Hai block trùng nội dung tráo id là hậu quả CHẤP NHẬN ĐƯỢC (giới
 * hạn ở việc comment phải re-resolve bằng text-quote, không mất dữ liệu).
 */
export function buildBlockMap(content: HTMLElement, markdown: string, previous: BlockEntry[]): BlockEntry[] {
  const lines = markdown.split('\n');
  const idQueueBySlice = new Map<string, string[]>();
  for (const entry of previous) {
    const queue = idQueueBySlice.get(entry.mdSlice);
    if (queue) {
      queue.push(entry.id);
    } else {
      idQueueBySlice.set(entry.mdSlice, [entry.id]);
    }
  }

  const entries: BlockEntry[] = [];
  for (const child of Array.from(content.children) as HTMLElement[]) {
    const srcRange = readSrcRange(child);
    if (!srcRange) {
      // <p> caret-trap tự chèn, không phải block markdown thật — không thuộc Block Map.
      continue;
    }
    const mdSlice = sliceMarkdown(lines, srcRange);
    const queue = idQueueBySlice.get(mdSlice);
    const id = queue?.shift() ?? freshBlockId();
    child.setAttribute(BLOCK_ID_ATTR, id);
    entries.push({ id, type: classifyBlockType(child), el: child, srcRange, mdSlice });
  }
  return entries;
}
