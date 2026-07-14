/**
 * Render Markdown → HTML: markdown-it với cấu hình giống VS Code Markdown Preview
 * (html:true, linkify theo setting, typographer:false, breaks theo setting,
 * CommonMark + bảng GFM + gạch ngang + task list + KaTeX + front-matter).
 *
 * File này chạy được cả trong webview (browser) lẫn Node (round-trip test).
 */
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import frontMatterPlugin from 'markdown-it-front-matter';
import katexPlugin from '@vscode/markdown-it-katex';
import hljs from 'highlight.js/lib/common';
// escapeHtml/escapeAttr là hàm thuần chuỗi (không đụng global DOM ở top-level
// của dom-utils.ts) nên import được ở đây mà vẫn giữ code chạy trên Node
// cho round-trip test. Gộp về một nguồn, tránh trùng bản private (finding C-new).
import { escapeHtml, escapeAttr } from './dom-utils';

export interface PipelineConfig {
  breaks: boolean;
  linkify: boolean;
}

export interface RenderResult {
  html: string;
  /** Nội dung front-matter thô (không gồm dấu ---), nếu có. */
  frontMatter: string | undefined;
}

export const FRONT_MATTER_CLASS = 'md-front-matter';
export const MATH_INLINE_CLASS = 'md-math-inline';
export const MATH_BLOCK_CLASS = 'md-math-block';
/** Toolbar chỉ có ở Math BLOCK (đủ chỗ cho 1 hàng riêng, giống Mermaid) — Math INLINE dùng nút "Edit" nhỏ nằm ngay trong dòng, xem MATH_TOGGLE_CLASS. */
export const MATH_TOOLBAR_CLASS = 'md-math-toolbar';
/** Nút mở popup sửa TeX (US-4.19, bug report 2026-07-14 — thay cho toggle inline render⇄source của US-4.18). */
export const MATH_TOGGLE_CLASS = 'md-math-toggle';
/** Khung chứa công thức KaTeX đã dựng — contenteditable=false, luôn hiển thị (không còn view "source" ẩn/hiện, xem math-edit.ts). */
export const MATH_RENDER_CLASS = 'md-math-render';
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
        // Gắn cho block cấp cao nhất (đoạn/heading/list/bảng...) VÀ cho từng
        // list_item ở mọi độ sâu — để gutter đánh số riêng cho MỖI dòng bullet
        // thay vì chỉ dòng đầu của cả danh sách (một <ul>/<ol> là MỘT block cấp
        // cao nhất, nếu chỉ dựa vào nó thì cả list chỉ có một số ở dòng đầu).
        const isTopLevelBlock = token.level === 0 && token.nesting !== -1 && !token.hidden;
        if ((isTopLevelBlock || token.type === 'list_item_open') && token.map) {
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
      const [start0] = this.capturedFrontMatterRange ?? [0, 0];
      html = renderFrontMatterBlock(frontMatter, start0 + 1) + html;
    }
    return { html, frontMatter };
  }

  /** Range (1-based, bao gồm) của từng khối ```math``` trong lần render() gần nhất, theo đúng thứ tự xuất hiện. */
  public getLastMathBlockRanges(): LineRange[] {
    return this.capturedMathBlockRanges.map(([start0, end0]) => ({ start: start0 + 1, end: end0 }));
  }

  /**
   * Lấy range dòng nguồn (1-based, bao gồm) của từng phần tử ĐƯỢC ĐÁNH SỐ trong
   * gutter, theo đúng thứ tự tài liệu — KHÔNG sinh lại HTML. Dùng để cập nhật
   * gutter số dòng sau mỗi lần gõ (debounce) mà không phải re-render toàn bộ
   * #content (tránh mất caret/undo). Front-matter (nếu có) luôn là phần tử đầu.
   *
   * Với danh sách cấp cao nhất (<ul>/<ol>), đánh số theo TỪNG list_item (mọi độ
   * sâu) thay vì cả khối — khớp đúng với cách gutter.ts liệt kê phần tử (mỗi
   * <li> một số), nếu không cả list chỉ hiện một số ở dòng đầu.
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
    let insideTopLevelList = false;
    for (const token of tokens as unknown as BlockToken[]) {
      const isListContainer = token.type === 'bullet_list_open' || token.type === 'ordered_list_open';
      const isListContainerClose = token.type === 'bullet_list_close' || token.type === 'ordered_list_close';
      if (token.level === 0 && isListContainer) {
        insideTopLevelList = true;
        continue;
      }
      if (token.level === 0 && isListContainerClose) {
        insideTopLevelList = false;
        continue;
      }
      if (insideTopLevelList) {
        if (token.type === 'list_item_open' && token.map) {
          ranges.push({ start: token.map[0] + 1, end: token.map[1] });
        }
        continue;
      }
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
