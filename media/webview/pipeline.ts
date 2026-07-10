/**
 * Pipeline hai chiều Markdown ⇄ HTML.
 *
 * - Render: markdown-it với cấu hình giống VS Code Markdown Preview
 *   (html:true, linkify theo setting, typographer:false, breaks theo setting,
 *   CommonMark + bảng GFM + gạch ngang + task list + KaTeX + front-matter).
 * - Serialize: turndown + turndown-plugin-gfm với các rule tùy chỉnh để
 *   round-trip ổn định (fence có ngôn ngữ, ~~strikethrough~~, bảng có căn
 *   lề, task list, math, front-matter, bare URL từ linkify, <br> trong ô bảng).
 *
 * File này chạy được cả trong webview (browser) lẫn Node (round-trip test).
 */
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import frontMatterPlugin from 'markdown-it-front-matter';
import katexPlugin from '@vscode/markdown-it-katex';
import TurndownService from 'turndown';
import { tables, taskListItems } from 'turndown-plugin-gfm';
import hljs from 'highlight.js/lib/common';

export interface PipelineConfig {
  breaks: boolean;
  linkify: boolean;
}

export interface RenderResult {
  html: string;
  /** Nội dung front-matter thô (không gồm dấu ---), nếu có. */
  frontMatter: string | undefined;
}

const FRONT_MATTER_CLASS = 'md-front-matter';
const MATH_INLINE_CLASS = 'md-math-inline';
export const MATH_BLOCK_CLASS = 'md-math-block';
export const MERMAID_CLASS = 'md-mermaid';
export const MERMAID_TOOLBAR_CLASS = 'md-mermaid-toolbar';
export const MERMAID_TOGGLE_CLASS = 'md-mermaid-toggle';
export const MERMAID_CHART_CLASS = 'md-mermaid-chart';
export const MERMAID_SOURCE_CLASS = 'md-mermaid-source';
/** Attribute gắn lên mỗi block cấp cao nhất, giá trị = số dòng bắt đầu (1-based) trong Markdown gốc. */
export const LINE_NUMBER_ATTR = 'data-line';
/** Attribute gắn kèm data-line, giá trị = số dòng kết thúc (1-based, bao gồm) của block trong Markdown gốc. */
export const LINE_NUMBER_END_ATTR = 'data-line-end';

/** [dòng bắt đầu, dòng kết thúc] (1-based, bao gồm) của một block trong Markdown gốc. */
export interface LineRange {
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Render: Markdown → HTML
// ---------------------------------------------------------------------------

export class MarkdownRenderer {
  private readonly md: MarkdownIt;
  private capturedFrontMatter: string | undefined;
  private capturedFrontMatterRange: [number, number] | undefined;
  /**
   * math_block có renderer riêng (@vscode/markdown-it-katex) không dùng
   * renderToken/renderAttrs nên attrSet không lộ ra HTML (giống fence trước
   * khi phát hiện fence lại đặt attr lên <code> — math_block thì KHÔNG đặt gì
   * cả). Ghi lại range theo đúng thứ tự token để hàm gọi render() gắn tay
   * data-line/data-line-end lên wrapper .md-math-block trong postProcessMathDom.
   */
  private capturedMathBlockRanges: Array<[number, number]> = [];

  constructor(config: PipelineConfig) {
    this.md = new MarkdownIt({
      html: true,
      linkify: config.linkify,
      breaks: config.breaks,
      typographer: false,
      highlight: (code, lang) => {
        const normalized = normalizeHighlightLang(lang);
        if (normalized && hljs.getLanguage(normalized)) {
          try {
            return hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value;
          } catch {
            /* fall through */
          }
        }
        return ''; // để markdown-it tự escape
      },
    });

    this.md.use(taskLists, { enabled: true, label: false });
    this.md.use(frontMatterPlugin, (fm: string) => {
      this.capturedFrontMatter = fm;
    });
    const katex = (katexPlugin as unknown as { default?: unknown }).default ?? katexPlugin;
    this.md.use(katex as (md: MarkdownIt) => void);

    // Giống VS Code (markdownEngine.ts): không linkify domain trần kiểu "google.com",
    // chỉ URL có scheme hoặc www. — tránh round-trip biến text thành link.
    this.md.linkify.set({ fuzzyLink: false });

    addAlignAttrToTables(this.md);
    fixRenderInlineAsText(this.md);

    // Gắn data-line/data-line-end lên mỗi token block cấp cao nhất — renderToken
    // mặc định của markdown-it xuất mọi attr của token ra thẻ mở nên hầu hết
    // block (heading/paragraph/list/table/hr/blockquote...) không cần override
    // rule render riêng. Ngoại lệ: fence đặt attr lên <code> bên trong <pre>
    // (renderer riêng của markdown-it) — gutter.ts tự dò thêm cấp con để bù;
    // math_block dùng renderer riêng bỏ hẳn attr — bù bằng capturedMathBlockRanges.
    this.md.core.ruler.push('attach_line_numbers', (state) => {
      for (const token of state.tokens as unknown as BlockToken[]) {
        if (token.type === 'front_matter' && token.map) {
          this.capturedFrontMatterRange = token.map;
          continue;
        }
        if (token.type === 'math_block' && token.map) {
          this.capturedMathBlockRanges.push(token.map);
        }
        if (token.level === 0 && token.nesting !== -1 && token.map && !token.hidden) {
          token.attrSet(LINE_NUMBER_ATTR, String(token.map[0] + 1));
          token.attrSet(LINE_NUMBER_END_ATTR, String(token.map[1]));
        }
      }
    });
  }

  /** Render markdown → HTML (kèm block front-matter nếu có). */
  public render(markdown: string): RenderResult {
    this.capturedFrontMatter = undefined;
    this.capturedFrontMatterRange = undefined;
    this.capturedMathBlockRanges = [];
    let html = this.md.render(markdown);
    const frontMatter = this.capturedFrontMatter;
    if (frontMatter !== undefined) {
      const [start0, end0] = this.capturedFrontMatterRange ?? [0, 0];
      html = renderFrontMatterBlock(frontMatter, start0 + 1) + html;
    }
    return { html, frontMatter };
  }

  /** Range (1-based, bao gồm) của từng khối ```math``` trong lần render() gần nhất, theo đúng thứ tự xuất hiện. */
  public getLastMathBlockRanges(): LineRange[] {
    return this.capturedMathBlockRanges.map(([start0, end0]) => ({ start: start0 + 1, end: end0 }));
  }

  /**
   * Chỉ lấy range dòng nguồn (1-based, bao gồm) của từng block cấp cao nhất,
   * theo đúng thứ tự render — KHÔNG sinh lại HTML. Dùng để cập nhật gutter số
   * dòng sau mỗi lần gõ (debounce) mà không phải re-render toàn bộ #content
   * (tránh mất caret/undo). Front-matter (nếu có) luôn là block đầu tiên.
   */
  public computeTopLevelLineRanges(markdown: string): LineRange[] {
    this.capturedFrontMatter = undefined;
    this.capturedFrontMatterRange = undefined;
    this.capturedMathBlockRanges = [];
    const tokens = this.md.parse(markdown, {});
    const ranges: LineRange[] = [];
    if (this.capturedFrontMatter !== undefined) {
      const [start0, end0] = this.capturedFrontMatterRange ?? [0, 0];
      ranges.push({ start: start0 + 1, end: end0 });
    }
    for (const token of tokens as unknown as BlockToken[]) {
      if (token.level === 0 && token.nesting !== -1 && token.map && !token.hidden) {
        ranges.push({ start: token.map[0] + 1, end: token.map[1] });
      }
    }
    return ranges;
  }
}

/**
 * markdown-it emit style="text-align:..." cho ô bảng; turndown-plugin-gfm đọc
 * thuộc tính align — thêm align để round-trip giữ được căn lề cột.
 */
interface TokenLike {
  attrGet(name: string): string | null;
  attrSet(name: string, value: string): void;
}

function addAlignAttrToTables(md: MarkdownIt): void {
  const applyAlign = (tokens: TokenLike[], idx: number) => {
    const token = tokens[idx];
    const style = token.attrGet('style');
    const m = style ? /text-align:\s*(left|center|right)/.exec(style) : null;
    if (m && !token.attrGet('align')) {
      token.attrSet('align', m[1]);
    }
  };
  for (const rule of ['th_open', 'td_open'] as const) {
    md.renderer.rules[rule] = (tokens, idx, options, _env, self) => {
      applyAlign(tokens as unknown as TokenLike[], idx);
      return self.renderToken(tokens, idx, options);
    };
  }
}

/** Chuẩn hóa tên ngôn ngữ như VS Code markdownEngine.ts (normalizeHighlightLang). */
function normalizeHighlightLang(lang: string | undefined): string {
  switch (lang && lang.toLowerCase()) {
    case 'shell':
      return 'sh';
    case 'py3':
      return 'python';
    case 'tsx':
    case 'typescriptreact':
      return 'jsx';
    case 'json5':
    case 'jsonc':
      return 'json';
    case 'c#':
    case 'csharp':
      return 'cs';
    default:
      return lang ?? '';
  }
}

/**
 * markdown-it 14 renderInlineAsText (dùng cho alt của ảnh) bỏ sót token
 * text_special (ký tự escape như \[ \* \_) → alt bị mất ký tự sau round-trip.
 */
function fixRenderInlineAsText(md: MarkdownIt): void {
  type InlineToken = { type: string; content: string; children?: InlineToken[] | null };
  const renderer = md.renderer as unknown as {
    renderInlineAsText(tokens: InlineToken[] | null, options: unknown, env: unknown): string;
  };
  renderer.renderInlineAsText = function renderInlineAsText(tokens, options, env): string {
    let result = '';
    for (const token of tokens ?? []) {
      switch (token.type) {
        case 'text':
        case 'text_special':
          result += token.content;
          break;
        case 'image':
          result += renderInlineAsText.call(this, token.children ?? null, options, env);
          break;
        case 'html_inline':
        case 'html_block':
          result += token.content;
          break;
        case 'softbreak':
        case 'hardbreak':
          result += '\n';
          break;
      }
    }
    return result;
  };
}

/**
 * Token cấp block, đủ thông tin để gắn số dòng nguồn (xem rule 'attach_line_numbers'
 * trong constructor của MarkdownRenderer — cần truy cập `this` để ghi lại range
 * của front-matter/math_block nên không tách thành hàm đứng riêng được).
 */
interface BlockToken extends TokenLike {
  type: string;
  level: number;
  map: [number, number] | null;
  nesting: number;
  hidden: boolean;
}

function renderFrontMatterBlock(raw: string, line: number): string {
  return (
    `<div class="${FRONT_MATTER_CLASS}" ${LINE_NUMBER_ATTR}="${line}" contenteditable="false" data-raw="${escapeAttr(raw)}">` +
    `<div class="md-front-matter-label">front matter</div>` +
    `<pre>${escapeHtml(raw)}</pre>` +
    `</div>\n`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Hậu xử lý DOM sau khi render (chạy trên element đã gắn innerHTML):
// bọc công thức KaTeX thành atom không chỉnh sửa được, lưu nguồn TeX.
// ---------------------------------------------------------------------------

/**
 * @param mathBlockRanges range dòng nguồn (1-based, bao gồm) của từng khối
 * ```math``` trong tài liệu, ĐÚNG THEO THỨ TỰ xuất hiện (xem
 * MarkdownRenderer.getLastMathBlockRanges — renderer riêng của katex-plugin
 * cho math_block bỏ qua attrSet nên không tự lộ ra HTML như các block khác).
 * Khớp theo thứ tự với `.katex-display` tìm được trong DOM; nếu số lượng lệch
 * nhau (hiếm — ví dụ có math lồng trong khối HTML thô) thì bỏ qua, không gắn
 * số dòng cho khối nào cả thay vì gắn sai.
 */
export function postProcessMathDom(
  root: ParentNode & Node,
  doc: Document,
  mathBlockRanges: LineRange[] = []
): void {
  // @vscode/markdown-it-katex: inline → <span class="katex">, block → <span class="katex-display"> (trong <p>)
  const displays = Array.from(root.querySelectorAll('.katex-display'));
  const ranges = mathBlockRanges.length === displays.length ? mathBlockRanges : [];
  displays.forEach((el, i) => {
    const tex = extractTex(el);
    const wrapper = doc.createElement('div');
    wrapper.className = MATH_BLOCK_CLASS;
    wrapper.setAttribute('contenteditable', 'false');
    wrapper.setAttribute('data-tex', tex);
    const range = ranges[i];
    if (range) {
      wrapper.setAttribute(LINE_NUMBER_ATTR, String(range.start));
      wrapper.setAttribute(LINE_NUMBER_END_ATTR, String(range.end));
    }
    const parent = el.parentElement;
    // Nếu span.katex-display là con duy nhất của <p>, thay cả <p> để tránh <p> rỗng.
    if (parent && parent.tagName === 'P' && parent.childNodes.length === 1 && parent.parentNode) {
      parent.parentNode.replaceChild(wrapper, parent);
    } else if (parent) {
      parent.replaceChild(wrapper, el);
    }
    wrapper.appendChild(el);
  });
  const inlines = Array.from(root.querySelectorAll('.katex')).filter(
    (el) =>
      !hasAncestor(el, (a) => a.classList?.contains(MATH_BLOCK_CLASS) ?? false) &&
      !(el.classList?.contains('katex-display') ?? false)
  );
  for (const el of inlines) {
    if (el.parentElement?.classList.contains(MATH_INLINE_CLASS)) {
      continue;
    }
    const tex = extractTex(el);
    const wrapper = doc.createElement('span');
    wrapper.className = MATH_INLINE_CLASS;
    wrapper.setAttribute('contenteditable', 'false');
    wrapper.setAttribute('data-tex', tex);
    el.parentNode?.replaceChild(wrapper, el);
    wrapper.appendChild(el);
  }
}

function extractTex(katexEl: Element): string {
  const annotation = katexEl.querySelector('annotation[encoding="application/x-tex"]');
  return annotation?.textContent ?? '';
}

/**
 * Bọc mỗi khối ```mermaid``` (```<pre><code class="language-mermaid">```, do
 * markdown-it render như một code block bình thường) thành khung có nút
 * chuyển đổi "biểu đồ ⇄ mã nguồn". Chỉ tạo cấu trúc DOM (chạy được cả trên
 * Node/domino cho round-trip test) — việc gọi thư viện mermaid để dựng SVG
 * thực sự nằm ở media/webview/mermaid.ts (chỉ chạy trong webview, cần DOM
 * trình duyệt thật).
 */
export function postProcessMermaidDom(root: ParentNode & Node, doc: Document): void {
  const blocks = Array.from(root.querySelectorAll('pre > code.language-mermaid'));
  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre?.parentElement) {
      continue;
    }
    const wrapper = doc.createElement('div');
    wrapper.className = MERMAID_CLASS;
    wrapper.setAttribute('data-mermaid-view', 'chart');

    const toolbar = doc.createElement('div');
    toolbar.className = MERMAID_TOOLBAR_CLASS;
    toolbar.setAttribute('contenteditable', 'false');
    const toggle = doc.createElement('button');
    toggle.setAttribute('type', 'button');
    toggle.className = MERMAID_TOGGLE_CLASS;
    toggle.setAttribute('title', 'Chuyển đổi giữa biểu đồ và mã Mermaid');
    toolbar.appendChild(toggle);

    const chart = doc.createElement('div');
    chart.className = MERMAID_CHART_CLASS;
    chart.setAttribute('contenteditable', 'false');
    chart.textContent = 'Đang dựng biểu đồ Mermaid…';

    pre.classList.add(MERMAID_SOURCE_CLASS);
    pre.parentElement.replaceChild(wrapper, pre);
    wrapper.appendChild(toolbar);
    wrapper.appendChild(chart);
    wrapper.appendChild(pre);
  }
}

/**
 * Chuẩn bị DOM trước khi serialize:
 *  - HTML comment → placeholder element (turndown bỏ qua comment node),
 *    rule 'mdComment' sẽ chuyển ngược thành <!-- ... -->.
 *  - List phẳng trong ô bảng "đơn giản" → các dòng "- x" nối bằng <br> để giữ
 *    bảng ở dạng pipe (Markdown thuần). Bảng có list phân cấp được để nguyên và
 *    serialize cả khối dưới dạng HTML (xem rule complexTableAsHtml).
 *  - NBSP do contentEditable chèn → space thường (trừ trong pre/code),
 *    gộp luôn chuỗi space liên tiếp trong cùng text node.
 */
export function prepareDomForSerialize(root: Element, doc: Document): void {
  const comments: Comment[] = [];
  collectComments(root, comments);
  for (const comment of comments) {
    const span = doc.createElement('span');
    span.setAttribute('data-md-comment', comment.data);
    // Nội dung giả để turndown không coi placeholder là node rỗng
    // (node rỗng làm mất khoảng trắng liền kề); rule mdComment bỏ qua content.
    span.textContent = 'x';
    comment.parentNode?.replaceChild(span, comment);
  }
  normalizeListDom(root);
  flattenSimpleTableCellLists(root, doc);
  normalizeNbsp(root);
}

/**
 * execCommand('indent' | 'outdent') của Chromium sinh cấu trúc list KHÔNG hợp lệ
 * (trình duyệt vẫn render đúng theo số tầng ul/ol, nhưng turndown và bộ phát hiện
 * "list phân cấp" đọc sai):
 *  - indent:  <ul><li>x</li><ul>…</ul></ul>   (danh sách nằm ngay trong danh sách)
 *  - outdent: <ul><li>a<li>b</li></li></ul>   (li nằm ngay trong li)
 * Cùng một lỗi (thuật toán merge/split list của Chromium) còn lộ ra khi XOÁ hoặc
 * CẮT (Cmd/Ctrl+X) một vùng chọn đè lên ranh giới giữa text của một mục và danh
 * sách con lồng ngay trong mục đó: Chrome tách nhầm danh sách con ra một <li>
 * riêng đứng SAU <li> chứa text — nhìn giống hệt bullet con "nhảy" xuống dòng
 * dưới — xem findOrphanNestedListPair. execCommand('undo') sau đó cũng không tự
 * sửa được vì lịch sử undo chỉ phát lại đúng các bước biến đổi DOM đã sai ngay
 * từ bước xoá gốc, không hiểu ngữ nghĩa "list phân cấp" để phục hồi đúng cây.
 * Chuẩn hóa về cây lồng nhau hợp lệ, khớp đúng mức thụt lề người dùng nhìn thấy,
 * trước khi phát hiện độ phức tạp và flatten.
 */
function normalizeListDom(root: Element): void {
  const isList = (n: Node | null): boolean => !!n && (n.nodeName === 'UL' || n.nodeName === 'OL');
  let guard = 0;
  for (;;) {
    let changed = false;

    // Rule A: <li> chứa trực tiếp <li> → tách <li> con (và mọi node sau nó) ra
    // thành anh em ngay sau <li> cha (giữ nguyên thứ tự).
    for (const outer of Array.from(root.querySelectorAll('li'))) {
      const parent = outer.parentNode;
      if (!parent) {
        continue;
      }
      const boundary = Array.from(outer.childNodes).find((c) => c.nodeName === 'LI');
      if (!boundary) {
        continue;
      }
      const moved: Node[] = [];
      for (let n: Node | null = boundary; n; n = n.nextSibling) {
        moved.push(n);
      }
      const ref = outer.nextSibling;
      for (const n of moved) {
        parent.insertBefore(n, ref);
      }
      changed = true;
    }

    // Rule B: danh sách nằm ngay trong danh sách → đưa vào <li> liền trước (mục
    // mà nó thuộc về); nếu không có thì bọc trong một <li> mới.
    for (const list of Array.from(root.querySelectorAll('ul, ol'))) {
      if (!isList(list.parentNode)) {
        continue;
      }
      const prev = list.previousElementSibling;
      if (prev && prev.nodeName === 'LI') {
        prev.appendChild(list);
      } else {
        const li = root.ownerDocument?.createElement('li');
        if (li && list.parentNode) {
          list.parentNode.insertBefore(li, list);
          li.appendChild(list);
        }
      }
      changed = true;
    }

    // Rule C: <li> chỉ chứa DUY NHẤT một danh sách con (không text/nội dung nào
    // khác) đứng ngay sau một <li> khác → danh sách con này thực ra thuộc về
    // <li> liền trước — gộp vào đó rồi bỏ <li> rỗng vừa tách ra (xem chú thích
    // ở đầu hàm).
    for (;;) {
      const pair = findOrphanNestedListPair(root);
      if (!pair) {
        break;
      }
      pair.prev.appendChild(pair.nested);
      pair.wrapper.remove();
      changed = true;
    }

    if (!changed || ++guard > 50) {
      break;
    }
  }
}

/**
 * Tìm một cặp (li liền trước, li chỉ chứa duy nhất một danh sách con) cần gộp —
 * dấu hiệu của lỗi Chromium tả ở normalizeListDom. Dùng chung cho cả chuẩn hóa
 * trên bản sao lúc serialize (normalizeListDom, thao tác DOM trần) lẫn sửa trực
 * tiếp trên DOM đang chỉnh sửa còn sống (main.ts, phải qua execCommand để không
 * phá lịch sử undo/redo gốc).
 */
export function findOrphanNestedListPair(
  root: Element
): { prev: Element; wrapper: Element; nested: Element } | null {
  for (const wrapper of Array.from(root.querySelectorAll('li'))) {
    const meaningful = Array.from(wrapper.childNodes).filter(
      (n) => !(n.nodeType === 3 /* TEXT_NODE */ && !(n.textContent ?? '').trim())
    );
    if (meaningful.length !== 1) {
      continue;
    }
    const nested = meaningful[0];
    if (nested.nodeName !== 'UL' && nested.nodeName !== 'OL') {
      continue;
    }
    const prev = wrapper.previousElementSibling;
    if (!prev || prev.nodeName !== 'LI') {
      continue;
    }
    return { prev, wrapper, nested: nested as Element };
  }
  return null;
}

/**
 * Cú pháp bảng GFM (pipe) mỗi ô nằm trên một dòng nên không biểu diễn được
 * list block. Chiến lược:
 *  - Ưu tiên giữ bảng ở dạng pipe.
 *  - Ô chỉ có list phẳng 1 cấp (hoặc xuống dòng) → chuyển thành các dòng
 *    "- x" / "1. x" nối bằng <br>: vẫn là bảng Markdown thuần, round-trip được.
 *  - Ô có list phân cấp (li lồng li) → bảng đó không thể là Markdown thuần;
 *    bỏ qua ở đây để rule complexTableAsHtml giữ nguyên cả bảng dưới dạng HTML.
 */
function flattenSimpleTableCellLists(root: Element, doc: Document): void {
  const tables = Array.from(root.querySelectorAll('table'));
  for (const table of tables) {
    if (tableNeedsHtmlSerialization(table)) {
      continue; // bảng phức tạp — giữ nguyên list để serialize dạng HTML
    }
    const lists = Array.from(table.querySelectorAll('td ul, td ol, th ul, th ol'));
    for (const list of lists) {
      flattenListToBrLines(list, doc);
    }
  }
}

/** Bảng cần serialize dạng HTML khi có ô chứa list phân cấp (li lồng trong li). */
function tableNeedsHtmlSerialization(table: Element): boolean {
  return table.querySelector('td li li, th li li') != null;
}

/**
 * Thay <ul>/<ol> phẳng bằng chuỗi inline "- a<br>- b" (giữ nguyên định dạng
 * inline như **đậm**, *nghiêng*, link trong từng mục). Với <ol> giữ số bắt đầu.
 */
function flattenListToBrLines(list: Element, doc: Document): void {
  const ordered = list.nodeName === 'OL';
  const startAttr = parseInt(list.getAttribute('start') ?? '1', 10);
  const start = Number.isFinite(startAttr) ? startAttr : 1;
  const items = Array.from(list.children).filter((c) => c.nodeName === 'LI');
  const frag = doc.createDocumentFragment();
  items.forEach((li, i) => {
    if (frag.childNodes.length > 0) {
      frag.appendChild(doc.createElement('br'));
    }
    frag.appendChild(doc.createTextNode(ordered ? `${start + i}. ` : '- '));
    // Loose list: nội dung mục bị bọc trong <p> — lấy nội dung trong <p> để
    // không sinh block (block sẽ bị ép thành khoảng trắng, mất dòng).
    const source =
      li.children.length === 1 && li.firstElementChild?.nodeName === 'P'
        ? (li.firstElementChild as Element)
        : li;
    while (source.firstChild) {
      frag.appendChild(source.firstChild);
    }
  });
  // Ngăn cách với nội dung liền trước/sau trong cùng ô bằng <br>.
  if (list.previousSibling && list.previousSibling.nodeName !== 'BR') {
    frag.insertBefore(doc.createElement('br'), frag.firstChild);
  }
  if (list.nextSibling && list.nextSibling.nodeName !== 'BR') {
    frag.appendChild(doc.createElement('br'));
  }
  list.parentNode?.replaceChild(frag, list);
}

function normalizeNbsp(node: Node): void {
  if (node.nodeType === 1) {
    const name = (node as Element).nodeName;
    if (name === 'PRE' || name === 'CODE') {
      return;
    }
  }
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      const text = child.nodeValue ?? '';
      if (text.includes('\u00A0')) {
        child.nodeValue = text.replace(/\u00A0/g, ' ').replace(/ {2,}/g, ' ');
      }
    } else {
      normalizeNbsp(child);
    }
  }
}

function collectComments(node: Node, out: Comment[]): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 8 /* COMMENT_NODE */) {
      out.push(child as Comment);
    } else {
      collectComments(child, out);
    }
  }
}

/**
 * Nếu cột đầu tiên của bảng là cột số thứ tự (mọi ô cột đầu ở tbody đều là số
 * nguyên) thì đánh số lại liên tục cả cột — dòng mới chèn vào (newRow, các ô
 * đang trống) sẽ nhận đúng số kế tiếp, các dòng phía sau tự dồn số. Giữ nguyên
 * số bắt đầu (1, 0 hay 5... tùy bảng). Dùng chung cho nút toolbar lẫn phím Tab
 * (mọi đường tạo dòng đều đi qua đây). Viết bằng DOM API portable để test được
 * trên Node (domino).
 */
export function fillSequenceColumn(table: Element, newRow: Element): boolean {
  const tbody = table.querySelector('tbody');
  if (!tbody) {
    return false;
  }
  const rows = Array.from(tbody.children).filter((el) => el.tagName === 'TR');
  const firstCellOf = (r: Element): Element | undefined =>
    Array.from(r.children).find((el) => el.tagName === 'TD' || el.tagName === 'TH');
  const others = rows.filter((r) => r !== newRow);
  if (others.length === 0) {
    return false;
  }
  const values = others.map((r) => (firstCellOf(r)?.textContent ?? '').trim());
  if (!values.every((v) => /^\d+$/.test(v))) {
    return false;
  }
  // Số bắt đầu = số hiện tại của dòng đầu tiên (đã validate là số nguyên)
  let n = parseInt(values[0], 10);
  for (const r of rows) {
    const c = firstCellOf(r);
    if (!c) {
      continue;
    }
    const text = String(n);
    if ((c.textContent ?? '').trim() !== text) {
      c.textContent = text;
    }
    n++;
  }
  return true;
}

/** Thay cho Element.closest — domino (DOM của turndown trên Node) không chắc hỗ trợ. */
function hasAncestor(node: Node, predicate: (el: Element) => boolean): boolean {
  return getAncestor(node, predicate) !== null;
}

function getAncestor(node: Node, predicate: (el: Element) => boolean): Element | null {
  let cur: Node | null = node.parentNode;
  while (cur) {
    if (cur.nodeType === 1 && predicate(cur as Element)) {
      return cur as Element;
    }
    cur = cur.parentNode;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Serialize: HTML (DOM) → Markdown
// ---------------------------------------------------------------------------

export function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    br: '  ',
    // Thẻ không nhận diện được → giữ nguyên outerHTML thay vì bóc mất thẻ
    // (div, custom element...). Riêng SPAN là rác contentEditable → chỉ lấy nội dung.
    defaultReplacement: (content, node) => {
      const el = node as HTMLElement;
      if (el.nodeName === 'SPAN' || typeof el.outerHTML !== 'string') {
        return content;
      }
      return blockLike(el) ? `\n\n${safeOuterHtml(el)}\n\n` : safeOuterHtml(el);
    },
    // Thẻ trong keep() cũng phải né dòng trống bên trong (cắt html_block).
    keepReplacement: (content, node) => {
      const el = node as HTMLElement;
      if (typeof el.outerHTML !== 'string') {
        return content;
      }
      return blockLike(el) ? `\n\n${safeOuterHtml(el)}\n\n` : safeOuterHtml(el);
    },
    // Node "rỗng" (turndown coi là blank và bỏ qua rule thường):
    //  - placeholder HTML comment phải được giữ lại
    //  - ô bảng rỗng vẫn phải emit "|" để không vỡ cột
    blankReplacement: (_content, node) => {
      const el = node as HTMLElement;
      if (el.getAttribute?.('data-md-comment') != null) {
        return commentReplacement(el);
      }
      if (el.nodeName === 'TD' || el.nodeName === 'TH') {
        return cellPrefix(el) + ' |';
      }
      return (node as { isBlock?: boolean }).isBlock ? '\n\n' : '';
    },
  });

  td.use(tables);
  td.use(taskListItems);

  // --- Bảng có ô chứa list phân cấp → không biểu diễn được bằng pipe Markdown;
  //     giữ nguyên cả bảng dưới dạng HTML (markdown-it html:true render lại
  //     đúng, GitHub/VS Code preview cũng hỗ trợ). addRule dùng unshift nên rule
  //     này được xét TRƯỚC rule 'table' của turndown-plugin-gfm. ---
  td.addRule('complexTableAsHtml', {
    filter: (node) =>
      node.nodeName === 'TABLE' && tableNeedsHtmlSerialization(node as unknown as Element),
    replacement: (_content, node) => `\n\n${collapseBlankLines((node as HTMLElement).outerHTML)}\n\n`,
  });

  // Escape thêm ký tự turndown bỏ sót (với html:true các chuỗi này sẽ bị
  // parse lại thành HTML/entity thật nếu không escape):
  //  - '<' trước chữ cái, '/', '!' hoặc '?' → \<  (tránh thành thẻ HTML)
  //  - '&' của một entity hợp lệ → &amp;          (tránh bị decode)
  const tdWithEscape = td as unknown as { escape(s: string): string };
  const originalEscape = tdWithEscape.escape.bind(td);
  tdWithEscape.escape = (s: string) =>
    originalEscape(s)
      .replace(/&(?=[a-zA-Z][a-zA-Z0-9]{1,31};|#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};)/g, '&amp;')
      .replace(/<(?=[a-zA-Z/!?])/g, '\\<');

  // Giữ nguyên các thẻ HTML thường gặp trong markdown (html:true).
  td.keep([
    'kbd', 'sup', 'sub', 'mark', 'ins', 'abbr', 'cite', 'q', 'small', 'big', 'u',
    'details', 'summary', 'video', 'audio', 'source', 'iframe', 'picture',
    'figure', 'figcaption', 'center', 'font', 'dl', 'dt', 'dd',
  ] as never);

  // --- Ô bảng: escape dấu | trong nội dung (plugin gfm không escape → vỡ cột) ---
  td.addRule('tableCellPipeEscape', {
    filter: ['th', 'td'],
    replacement: (content, node) => {
      const safe = content.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
      return cellPrefix(node as HTMLElement) + safe + ' |';
    },
  });

  // --- heading: escape dấu # cuối (markdown-it strip closing sequence của ATX) ---
  td.addRule('atxHeadingEscapeTrailingHash', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node) => {
      const level = Number(node.nodeName.charAt(1)) || 1;
      let text = content.replace(/\n+/g, ' ').trim();
      text = text.replace(/(\s)(#+)$/, (_m, sp: string, hashes: string) => `${sp}\\${hashes}`);
      return `\n\n${'#'.repeat(level)} ${text}\n\n`;
    },
  });

  // --- <img> HTML thô có attribute ngoài src/alt/title → giữ nguyên HTML ---
  td.addRule('htmlImgWithAttrs', {
    filter: (node) => {
      if (node.nodeName !== 'IMG') {
        return false;
      }
      const attrs = (node as Element).attributes;
      for (let i = 0; i < attrs.length; i++) {
        if (!['src', 'alt', 'title'].includes(attrs[i].name)) {
          return true;
        }
      }
      return false;
    },
    replacement: (_content, node) => (node as HTMLElement).outerHTML ?? '',
  });

  // --- strikethrough: markdown-it chỉ parse ~~ (2 dấu) ---
  td.addRule('strikethroughDouble', {
    filter: ['del', 's', 'strike' as keyof HTMLElementTagNameMap],
    replacement: (content) => (content ? `~~${content}~~` : ''),
  });

  // --- fenced code giữ ngôn ngữ, bỏ span highlight, chọn fence đủ dài ---
  td.addRule('fencedCodeWithLang', {
    filter: (node) => node.nodeName === 'PRE' && !!node.querySelector('code'),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const code = el.querySelector('code');
      if (!code) {
        return '';
      }
      const langClass = Array.from(code.classList ?? []).find((c) => c.startsWith('language-'));
      const lang = langClass ? langClass.slice('language-'.length) : '';
      const text = (code.textContent ?? '').replace(/\n$/, '');
      let fence = '```';
      while (text.includes(fence)) {
        fence += '`';
      }
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });

  // --- <br> bên trong ô bảng phải giữ dạng <br> để không phá bảng ---
  // Riêng ô "rỗng" chỉ chứa <br> (placeholder caret do thao tác thêm dòng/cột
  // tạo ra) → bỏ hẳn, để ô serialize thành ô trống sạch.
  td.addRule('brInTableCell', {
    filter: (node) =>
      node.nodeName === 'BR' && hasAncestor(node, (el) => el.nodeName === 'TD' || el.nodeName === 'TH'),
    replacement: (_content, node) => {
      const cell = getAncestor(node, (el) => el.nodeName === 'TD' || el.nodeName === 'TH');
      if (cell && (cell.textContent ?? '').trim() === '') {
        return '';
      }
      return '<br>';
    },
  });

  // --- HTML comment (đã được prepareDomForSerialize đổi thành placeholder) ---
  td.addRule('mdComment', {
    filter: (node) => (node as HTMLElement).hasAttribute?.('data-md-comment') ?? false,
    replacement: (_content, node) => commentReplacement(node as HTMLElement),
  });

  // --- linkify/autolink: <a> có text trùng href → giữ dạng URL trần ---
  td.addRule('bareUrl', {
    filter: (node) => {
      if (node.nodeName !== 'A') {
        return false;
      }
      const href = (node as HTMLElement).getAttribute('href') ?? '';
      const text = node.textContent ?? '';
      if (!href) {
        return false;
      }
      return href === text || href === `mailto:${text}` || decodeSafe(href) === text;
    },
    replacement: (_content, node) => {
      const text = node.textContent ?? '';
      // linkify sẽ parse lại y hệt; nếu là autolink dạng <...> vẫn tương đương.
      return text;
    },
  });

  // --- math atoms ---
  td.addRule('mathBlock', {
    filter: (node) => (node as HTMLElement).classList?.contains(MATH_BLOCK_CLASS) ?? false,
    replacement: (_content, node) => {
      const tex = ((node as HTMLElement).getAttribute('data-tex') ?? '').trim();
      return `\n\n$$\n${tex}\n$$\n\n`;
    },
  });
  td.addRule('mathInline', {
    filter: (node) => (node as HTMLElement).classList?.contains(MATH_INLINE_CLASS) ?? false,
    replacement: (_content, node) => {
      const tex = (node as HTMLElement).getAttribute('data-tex') ?? '';
      return `$${tex}$`;
    },
  });

  // --- mermaid: bỏ qua toolbar + biểu đồ SVG đã dựng, chỉ serialize mã nguồn
  //     trong .md-mermaid-source (giữ nguyên logic fence với fencedCodeWithLang) ---
  td.addRule('mermaidDiagram', {
    filter: (node) => (node as HTMLElement).classList?.contains(MERMAID_CLASS) ?? false,
    replacement: (_content, node) => {
      const code = (node as HTMLElement).querySelector(`.${MERMAID_SOURCE_CLASS} code`);
      const text = (code?.textContent ?? '').replace(/\n$/, '');
      let fence = '```';
      while (text.includes(fence)) {
        fence += '`';
      }
      return `\n\n${fence}mermaid\n${text}\n${fence}\n\n`;
    },
  });

  // --- front matter ---
  td.addRule('frontMatter', {
    filter: (node) => (node as HTMLElement).classList?.contains(FRONT_MATTER_CLASS) ?? false,
    replacement: (_content, node) => {
      const raw = (node as HTMLElement).getAttribute('data-raw') ?? '';
      return `---\n${raw}\n---\n\n`;
    },
  });

  // --- Block có căn lề (align hoặc style text-align) → giữ dạng HTML với
  //     thuộc tính align, kiểu <p align="center"> quen thuộc của GitHub.
  //     Căn trái là mặc định nên không cần giữ. ---
  td.addRule('alignedBlock', {
    filter: (node) => {
      const el = node as HTMLElement;
      if (!/^(P|H[1-6])$/.test(el.nodeName)) {
        return false;
      }
      const align = getBlockAlign(el);
      return align === 'center' || align === 'right' || align === 'justify';
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const align = getBlockAlign(el);
      const tag = el.nodeName.toLowerCase();
      const inner = collapseBlankLines(el.innerHTML ?? '');
      return `\n\n<${tag} align="${align}">${inner}</${tag}>\n\n`;
    },
  });

  // --- <p> rỗng do contentEditable tạo (chỉ chứa <br>) → bỏ ---
  td.addRule('emptyParagraph', {
    filter: (node) => {
      if (node.nodeName !== 'P') {
        return false;
      }
      const el = node as HTMLElement;
      if ((el.textContent ?? '').trim() !== '') {
        return false;
      }
      // p chỉ chứa <br> hoặc trống hoàn toàn, và không chứa ảnh/input/media
      return !el.querySelector('img, input, video, audio, iframe, picture');
    },
    replacement: () => '',
  });

  // --- checkbox task list: đọc thuộc tính checked đã được đồng bộ ---
  // Nằm trực tiếp trong <li> (tight list) hoặc trong <p> đầu của <li> (loose list).
  td.addRule('taskCheckbox', {
    filter: (node) => {
      if (node.nodeName !== 'INPUT' || (node as HTMLInputElement).getAttribute('type') !== 'checkbox') {
        return false;
      }
      const parent = node.parentNode;
      if (!parent) {
        return false;
      }
      return (
        parent.nodeName === 'LI' ||
        (parent.nodeName === 'P' && parent.parentNode?.nodeName === 'LI')
      );
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const checked = el.hasAttribute('checked') || (el as HTMLInputElement).checked;
      return (checked ? '[x]' : '[ ]') + ' ';
    },
  });

  return td;
}

function commentReplacement(el: HTMLElement): string {
  const raw = el.getAttribute('data-md-comment') ?? '';
  const html = `<!--${raw}-->`;
  const parentName = el.parentElement?.nodeName;
  const standalone = !parentName || parentName === 'BODY' || parentName === 'DIV';
  return standalone ? `\n\n${html}\n\n` : html;
}

/**
 * Dòng trống bên trong HTML thô sẽ cắt html_block của markdown-it làm phần
 * sau bị parse thành markdown thường → thay bằng '\n&#10;' (render đúng
 * thành newline nên hiển thị không đổi).
 */
function collapseBlankLines(html: string): string {
  return html.replace(/\n[ \t]*\n/g, '\n&#10;');
}

function safeOuterHtml(el: HTMLElement): string {
  return collapseBlankLines(el.outerHTML);
}

/** Căn lề của block: ưu tiên thuộc tính align, sau đó style text-align. */
function getBlockAlign(el: HTMLElement): string {
  const attr = (el.getAttribute('align') ?? '').toLowerCase();
  if (attr) {
    return attr;
  }
  const style = el.getAttribute('style') ?? '';
  const m = /text-align\s*:\s*(left|center|right|justify)/i.exec(style);
  return m ? m[1].toLowerCase() : '';
}

/** '| ' cho ô đầu hàng, ' ' cho các ô sau — giống turndown-plugin-gfm. */
function cellPrefix(cell: HTMLElement): string {
  const parent = cell.parentNode;
  if (!parent) {
    return '| ';
  }
  const kids = parent.childNodes;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i] === cell) {
      return i === 0 ? '| ' : ' ';
    }
  }
  return ' ';
}

function blockLike(el: HTMLElement): boolean {
  return /^(ADDRESS|ARTICLE|ASIDE|AUDIO|BLOCKQUOTE|BODY|CANVAS|CENTER|DD|DETAILS|DIR|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|FRAMESET|H[1-6]|HEADER|HGROUP|HR|HTML|IFRAME|ISINDEX|LI|MAIN|MENU|NAV|NOFRAMES|NOSCRIPT|OL|OUTPUT|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL|VIDEO)$/.test(
    el.nodeName
  );
}

function decodeSafe(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** Chuẩn hóa markdown sau serialize: gộp dòng trống thừa, đảm bảo newline cuối. */
export function normalizeMarkdown(markdown: string): string {
  let text = markdown.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/^\n+/, '');
  text = text.replace(/\n*$/, '\n');
  if (text === '\n') {
    return '';
  }
  return text;
}
