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
import { readOwnSrcRange, readSrcRange } from './block-info';

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
  // An empty id means "this thread has no live anchor yet" — what `syncAll`
  // seeds for every thread arriving in a host snapshot — not "the id ''".
  // Without this guard `[data-comment-anchor-id=""]` matches any node one of
  // them already stamped, so on a reload the second thread's tier-1 lookup
  // "finds" the first thread's node and the whole file collapses onto one line.
  if (anchorId === '') {
    return [];
  }
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
 * Source range of the nearest node at or above `el` that carries one — its own
 * first, then its closest such ancestor, ending at the top-level block.
 *
 * US-23.4: the node's OWN line when it carries one — list items do, and a list
 * is a single top-level block, so falling straight through to the block would
 * report every item in a 6-line list as the list's first line and make
 * US-23.4's line tie-breaker pick the wrong bullet. The intermediate ancestors
 * matter for the same reason: a LOOSE list item wraps its content in a `<p>`
 * that carries no `data-line`, so an anchor inside one has to climb to the
 * `<li>` — jumping straight to the block collapsed every comment in the list
 * onto the list's first line (one gutter pin, one line in the Comment tab).
 *
 * Every step but the last reads the node's OWN attributes (`readOwnSrcRange`):
 * `readSrcRange`'s descendant fallback would let an intermediate container hand
 * back a line from INSIDE itself — a nested `<blockquote>` reporting the line of
 * a bullet below its quoted paragraph. Only the top-level block keeps the
 * fallback, which is where it is needed (a fence's attrs sit on its `<code>`).
 */
function nearestSrcRange(content: HTMLElement, el: HTMLElement): LineRange | null {
  if (el === content) {
    const first = content.firstElementChild;
    return (first && readSrcRange(first)) ?? null;
  }
  if (!content.contains(el)) {
    // Outside the document (a carrier detached by a re-render): "no source
    // line", the same answer the top-level-block lookup used to give.
    return null;
  }
  let node: HTMLElement | null = el;
  while (node && node !== content) {
    const parent = node.parentElement;
    const own = parent === content ? readSrcRange(node) : readOwnSrcRange(node);
    if (own) {
      return own;
    }
    node = parent;
  }
  return null;
}

/**
 * Req 23 US-23.1: 1-based source line the anchored node starts on — the
 * best-effort document coordinate the host needs to give the native
 * `CommentThread` a `vscode.Range`. The STRUCTURAL anchor stays authoritative;
 * this is API compliance only. 0 when the node maps to no source line (a
 * multi-block selection anchored on `#content` itself).
 */
export function commentAnchorLine(content: HTMLElement, el: HTMLElement): number {
  return nearestSrcRange(content, el)?.start ?? 0;
}

/**
 * Req 24 US-23.12 AC4: same node resolution as `commentAnchorLine` above, but
 * returns the full `[start, end]` range instead of `start` alone — the
 * exported Markdown's `Ln <a>-<b>` needs the anchored node's whole extent, not
 * just where it begins. `null` for the same "no source line" case
 * `commentAnchorLine` reports as `0` (a multi-block selection anchored on
 * `#content` itself).
 */
export function commentAnchorLineRange(content: HTMLElement, el: HTMLElement): LineRange | null {
  return nearestSrcRange(content, el);
}

/**
 * Req 23 US-23.4 AC6: after a render, make every comment-anchor id address ONE
 * node again.
 *
 * A clone-producing edit (paste — including a paste from another file and any
 * id-bearing node inside the pasted subtree — line duplication, multi-cursor
 * duplication) copies the attribute along with the markup, so two locations
 * would silently share one comment's anchor. The FIRST occurrence in document
 * order keeps the id and every later one is re-minted: a node that was merely
 * moved (cut+paste, drag-reorder) is still the only carrier of its id and so
 * keeps it, which is exactly the move-vs-clone distinction AC6 asks for.
 *
 * Runs before resolution so tier 1 never matches a clone.
 */
export function dedupeCommentAnchors(content: HTMLElement, keep: ReadonlySet<HTMLElement> = new Set()): void {
  const carriers = [content, ...Array.from(content.querySelectorAll<HTMLElement>(`[${COMMENT_ANCHOR_ATTR}]`))];
  const byId = new Map<string, HTMLElement[]>();
  for (const el of carriers) {
    const id = el.getAttribute(COMMENT_ANCHOR_ATTR);
    if (!id) {
      continue;
    }
    const group = byId.get(id);
    if (group) {
      group.push(el);
    } else {
      byId.set(id, [el]);
    }
  }
  for (const group of byId.values()) {
    if (group.length === 1) {
      continue;
    }
    // Document order alone would hand the id to a copy pasted ABOVE its source.
    // `keep` carries the node each live thread actually resolved to last pass,
    // which identifies the original whenever the clone appeared without a
    // re-render (exactly the paste case); order is only the fallback.
    const original = group.find((el) => keep.has(el)) ?? group[0];
    for (const el of group) {
      if (el !== original) {
        el.setAttribute(COMMENT_ANCHOR_ATTR, `comment-anchor-${nextCommentAnchorId++}`);
      }
    }
  }
}

/**
 * Node kinds a floated comment can be matched to or re-attached to (US-23.4
 * AC2/AC3/AC4). Table cells are included because US-23.1 anchors a selection
 * inside one to the cell itself; an inline anchor (a `<strong>`, a link) has no
 * candidate of its own and degrades to its enclosing block, marked approximate.
 */
const ANCHOR_CANDIDATE_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, tr, td, th, blockquote, pre';

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/** A block whose inner DOM is generated/read-only rather than edited prose. */
function isAtomBlock(el: HTMLElement): boolean {
  return (
    el.classList.contains(MERMAID_CLASS) ||
    el.classList.contains(PLANTUML_CLASS) ||
    el.classList.contains(MATH_BLOCK_CLASS) ||
    el.classList.contains(FRONT_MATTER_CLASS)
  );
}

/** How many elements deep below `#content` a node sits (`#content` itself is 0). */
function depthWithin(content: HTMLElement, el: HTMLElement): number {
  let depth = 0;
  let node: HTMLElement | null = el;
  while (node && node !== content) {
    depth++;
    node = node.parentElement;
  }
  return depth;
}

/** Req 23 US-23.4: one node tier 2/3 can consider, described by what the match needs. */
export interface AnchorCandidateNode {
  el: HTMLElement;
  /** Whole text content of the node — the same shape `recordedText` was captured in. */
  text: string;
  /** 1-based source line: the node's own when it carries one (list items do), else its block's. */
  line: number;
  /** 1-based last source line the node covers — tier 3 asks which node still spans a lost location. */
  lineEnd: number;
  /** Text of the nearest heading above the node, '' when there is none. */
  heading: string;
  /**
   * Nesting depth below `#content`. A container and a lone child (a blockquote
   * and its only paragraph) have identical text AND identical source lines, so
   * depth is the only thing that can separate them — the innermost is the more
   * specific answer.
   */
  depth: number;
}

/**
 * Req 23 US-23.4: every anchorable node in the current render, in document
 * order, with the two tie-breakers (line, nearest heading) already resolved.
 *
 * Nodes whose top-level block has no source line are skipped — the self-inserted
 * caret-trap `<p>` is not document content and must never win a match.
 */
export function anchorCandidates(content: HTMLElement): AnchorCandidateNode[] {
  const candidates: AnchorCandidateNode[] = [];
  let heading = '';
  // `#content` itself is anchorable (US-23.1: a selection spanning several
  // blocks resolves to it), so it has to be offered back as a candidate or such
  // a comment could never re-match its own recorded text.
  const first = readSrcRange(content.firstElementChild ?? content);
  const last = readSrcRange(content.lastElementChild ?? content);
  if (first) {
    candidates.push({
      el: content,
      text: content.textContent ?? '',
      line: first.start,
      lineEnd: last?.end ?? first.end,
      heading: '',
      depth: 0,
    });
  }
  for (const block of Array.from(content.children) as HTMLElement[]) {
    const srcRange = readSrcRange(block);
    if (!srcRange) {
      continue;
    }
    if (HEADING_TAGS.has(block.tagName)) {
      heading = (block.textContent ?? '').trim();
    }
    // An atom block (diagram, math, front matter) is offered as ONE candidate and
    // never descended into: its inner DOM is regenerated asynchronously
    // (mermaidView/plantumlView renderAll) or is read-only, so a thread parked on
    // a node inside it would be silently destroyed on the next render.
    const nodes = isAtomBlock(block)
      ? [block]
      : block.matches(ANCHOR_CANDIDATE_SELECTOR)
        ? [block, ...Array.from(block.querySelectorAll<HTMLElement>(ANCHOR_CANDIDATE_SELECTOR))]
        : Array.from(block.querySelectorAll<HTMLElement>(ANCHOR_CANDIDATE_SELECTOR));
    for (const el of nodes) {
      // Same climb `commentAnchorLine` uses — a candidate's line and a recorded
      // line are compared against each other by tier 2/3, so the two must not
      // resolve the same node differently. The climb always reaches `block`
      // (skipped above when it has no range), so `?? srcRange` is the non-null
      // floor rather than a case that fires.
      const ownRange = nearestSrcRange(content, el) ?? srcRange;
      candidates.push({
        el,
        text: el.textContent ?? '',
        line: ownRange.start,
        lineEnd: ownRange.end,
        heading,
        depth: depthWithin(content, el),
      });
    }
  }
  return candidates;
}

/**
 * Req 23 US-23.4: text of the nearest heading at or above `el`, recorded with a
 * comment so tier 2 can tell two structurally identical nodes in different
 * sections apart. '' when nothing precedes it.
 */
export function nearestHeadingBefore(content: HTMLElement, el: HTMLElement): string {
  const block = el === content ? null : topLevelBlockOf(content, el);
  if (!block) {
    // A whole-document anchor (or a node outside any block) sits under no
    // heading. Walking on would return the LAST heading in the file — a
    // tie-breaker pointing at a section far below the comment.
    return '';
  }
  let heading = '';
  for (const child of Array.from(content.children) as HTMLElement[]) {
    // A heading is its own nearest heading — the same rule anchorCandidates
    // applies, so a recorded value and a candidate value stay comparable. The
    // same "skip blocks with no source range" filter is applied for the same
    // reason: a heading anchorCandidates cannot see must not be recorded here.
    if (HEADING_TAGS.has(child.tagName) && readSrcRange(child)) {
      heading = (child.textContent ?? '').trim();
    }
    if (child === block) {
      break;
    }
  }
  return heading;
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
