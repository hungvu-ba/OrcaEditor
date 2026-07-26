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
import {
  FRONT_MATTER_CLASS,
  MATH_BLOCK_CLASS,
  MERMAID_CLASS,
  PLANTUML_CLASS,
  type LineRange,
} from './render';
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

/**
 * Req 23 US-23.1: structural id of the node a comment is anchored to. Same
 * session-only, never-written-to-.md contract as BLOCK_ID_ATTR (it is stripped
 * by turndown.ts's TRANSIENT_ATTRS), but stamped on ANY element a selection can
 * reach — an inline `<strong>`, a `<td>`, a whole `<p>` — not just the
 * top-level blocks BlockEntry tracks.
 */
export const COMMENT_ANCHOR_ATTR = 'data-comment-anchor-id';

let nextCommentAnchorId = 1;

/**
 * Req 23 US-23.1: the id of the element a comment anchors to — reused when the
 * element already carries one (two comments on the same paragraph must resolve
 * to the SAME node), minted fresh otherwise.
 *
 * A clone (paste, line duplication) carries its source's attribute along, which
 * would silently make two locations share one comment's anchor; when the id is
 * not unique in `content` the clone is re-stamped instead of inheriting. Full
 * clone-vs-move discrimination on every edit is US-23.4's job — this is only the
 * mint-time guarantee that the id handed to the host addresses one node.
 */
export function ensureCommentAnchorId(content: HTMLElement, el: HTMLElement): string {
  const existing = el.getAttribute(COMMENT_ANCHOR_ATTR);
  if (existing && commentAnchorsFor(content, existing).length === 1) {
    return existing;
  }
  const id = `comment-anchor-${nextCommentAnchorId++}`;
  el.setAttribute(COMMENT_ANCHOR_ATTR, id);
  return id;
}

/**
 * Every element carrying `anchorId`. `content` ITSELF can be the anchored node
 * (a selection spanning several top-level blocks resolves to it), and
 * querySelectorAll only walks descendants — so it is matched separately or a
 * whole-document anchor would read as "gone".
 */
function commentAnchorsFor(content: HTMLElement, anchorId: string): HTMLElement[] {
  const selector = `[${COMMENT_ANCHOR_ATTR}="${CSS.escape(anchorId)}"]`;
  const found = Array.from(content.querySelectorAll<HTMLElement>(selector));
  return content.matches(selector) ? [content, ...found] : found;
}

/** Req 23 US-23.1: the element carrying `anchorId`, or null once it is gone from the current render. */
export function findCommentAnchor(content: HTMLElement, anchorId: string): HTMLElement | null {
  return commentAnchorsFor(content, anchorId)[0] ?? null;
}

/** The top-level block (direct child of `#content`) containing `el`, or null when `el` is outside `content`. */
function topLevelBlockOf(content: HTMLElement, el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node && node.parentElement !== content) {
    node = node.parentElement;
  }
  return node;
}

/**
 * Req 23 US-23.1: the element a comment on `range` anchors to — the smallest
 * node containing the WHOLE selection (its common ancestor), so a selection
 * crossing a paragraph break or reaching into a table cell/list item anchors to
 * one enclosing node instead of being split or refused. A collapsed range (bare
 * caret) resolves through the same path, landing on its containing node.
 *
 * Null means "no addressable node" — an empty document, a selection outside
 * `#content`, or a block block-map excludes from its structural index (the
 * self-inserted caret-trap `<p>`, which has no `data-line`; see readSrcRange).
 * Callers surface that as a disabled "Add Comment", never as a silent no-op.
 */
export function resolveCommentAnchorNode(content: HTMLElement, range: Range): HTMLElement | null {
  if (!content.firstElementChild) {
    return null;
  }
  const start = range.commonAncestorContainer;
  const el = start.nodeType === Node.ELEMENT_NODE ? (start as HTMLElement) : start.parentElement;
  if (!el || (el !== content && !content.contains(el))) {
    return null;
  }
  if (el !== content) {
    const block = topLevelBlockOf(content, el);
    if (!block || !readSrcRange(block)) {
      return null;
    }
  }
  return el;
}

/**
 * Req 23 US-23.1: 1-based source line the anchored node starts on — the
 * best-effort document coordinate the host needs to give the native
 * `CommentThread` a `vscode.Range`. The STRUCTURAL anchor stays authoritative;
 * this is API compliance only. 0 when the node maps to no source line (a
 * multi-block selection anchored on `#content` itself).
 */
export function commentAnchorLine(content: HTMLElement, el: HTMLElement): number {
  const block = el === content ? content.firstElementChild : topLevelBlockOf(content, el);
  return (block && readSrcRange(block)?.start) ?? 0;
}

function classifyBlockType(el: HTMLElement): string {
  if (el.classList.contains(MERMAID_CLASS)) {
    return 'mermaid';
  }
  if (el.classList.contains(PLANTUML_CLASS)) {
    return 'plantuml';
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
