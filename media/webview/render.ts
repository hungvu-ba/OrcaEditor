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
import { buildFrontMatterFields, buildFrontMatterHtml, parseFrontMatterFields, parseTomlFrontMatterFields, type FrontMatterFormat } from './front-matter';

export interface PipelineConfig {
  breaks: boolean;
  linkify: boolean;
}

export interface RenderResult {
  html: string;
  /**
   * The captured front-matter source, if any. Delimiters are EXCLUDED for the
   * fenced formats (`---`, `+++`) but INCLUDED for JSON, which has no fence and
   * whose block is the braces themselves (US-2.11) — so this is the block's own
   * text, not a uniformly fence-stripped body.
   */
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
export const MERMAID_ZOOM_CLASS = 'md-mermaid-zoom';
export const MERMAID_CHART_CLASS = 'md-mermaid-chart';
export const MERMAID_SOURCE_CLASS = 'md-mermaid-source';
/** US-2.8: PlantUML diagram frame — same chart⇄source structure as Mermaid above, rendered by a different engine. */
export const PLANTUML_CLASS = 'md-plantuml';
export const PLANTUML_TOOLBAR_CLASS = 'md-plantuml-toolbar';
export const PLANTUML_TOGGLE_CLASS = 'md-plantuml-toggle';
export const PLANTUML_ZOOM_CLASS = 'md-plantuml-zoom';
export const PLANTUML_CHART_CLASS = 'md-plantuml-chart';
export const PLANTUML_SOURCE_CLASS = 'md-plantuml-source';
/** Per-code-block header bar (language label + Copy) injected inside <pre>, before <code> (Document Blocks item 8). */
export const MD_CODE_HEADER_CLASS = 'md-code-header';
/** Language-name label inside the code-block header. */
export const MD_CODE_LANG_CLASS = 'md-code-lang';
/** "Copy" button inside the code-block header — targeted by the delegated click listener in main.ts. */
export const MD_CODE_COPY_CLASS = 'md-code-copy';
/** "Wrap" toggle button inside the code-block header — targeted by the delegated click listener in main.ts. */
export const MD_CODE_WRAP_CLASS = 'md-code-wrap';
/** Attribute gắn lên mỗi block cấp cao nhất, giá trị = số dòng bắt đầu (1-based) trong Markdown gốc. */
export const LINE_NUMBER_ATTR = 'data-line';
/** Attribute gắn kèm data-line, giá trị = số dòng kết thúc (1-based, bao gồm) của block trong Markdown gốc. */
export const LINE_NUMBER_END_ATTR = 'data-line-end';

/**
 * Attribute on the <a> created by postProcessRelativePathLinks (displays a bare
 * relative file path as a link). Value = the exact original path string from the
 * .md; turndown uses it to serialize back to the bare path → the .md is unchanged
 * (display-only).
 */
export const AUTOLINK_PATH_ATTR = 'data-autolink-path';

/**
 * Attribute on an `<a>` produced from an empty-text link `[](url)` — markdown-it
 * renders such a link as an empty anchor, so in a list it shows as a blank bullet
 * (bug_General #15). postProcessEmptyLinks fills the anchor with the decoded
 * target file name as DISPLAY text and stores the ORIGINAL href here; turndown's
 * `emptyLink` rule serializes back to `[](href)` from it → the .md is unchanged
 * (display-only, byte-faithful — same discipline as AUTOLINK_PATH_ATTR).
 */
export const EMPTY_LINK_ATTR = 'data-empty-link';

/**
 * Req 21 US-21.1: solid-pill badge wrapping a literal `caption::NS_ID` entity
 * declaration (postProcessCaptions in dom-postprocess.ts). Styled ONLY via
 * --rp-entity-accent (Reading Mode owns the entity accent — Teal base, T0.4;
 * no swatch picker in v1).
 */
export const CAPTION_CLASS = 'md-caption';

/**
 * Req 21 US-21.1 (bug_General Mention Declare #5): child spans inside a
 * CAPTION_CLASS badge. The badge's text is split so the internal `caption::`
 * prefix can be hidden (PREFIX) while the namespace (NS) and value/id (ID) show
 * as `NS value` — WITHOUT changing `badge.textContent` (still `caption::NS_ID`),
 * so turndown round-trips byte-identical. The visible gap between NS and ID is
 * CSS margin on ID, never a real space character.
 */
export const CAPTION_PREFIX_CLASS = 'md-caption-prefix';
export const CAPTION_NS_CLASS = 'md-caption-ns';
export const CAPTION_ID_CLASS = 'md-caption-id';

/** [dòng bắt đầu, dòng kết thúc] (1-based, bao gồm) của một block trong Markdown gốc. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * UTF-8 BOM — a Windows-authored file can carry one before the opening `{` of
 * JSON front matter (US-2.11). Written as an escape, never as the literal
 * character: a raw U+FEFF in source is invisible, and any tool that strips it
 * would silently turn this into `''`, which `startsWith` matches on every
 * document.
 *
 * Defensive in practice — VS Code keeps the BOM in the document's encoding
 * rather than in `getText()`, so the webview should never see one. If it ever
 * does, the BOM is dropped from the captured block and is NOT re-emitted on
 * save; this branch does not promise BOM preservation.
 */
const BOM = '\uFEFF';

/**
 * Index of the `}` closing the object that opens at `start`, or -1 when the
 * text ends with braces still open or inside an unterminated string literal.
 *
 * Braces count ONLY outside strings, and inside a string a backslash always
 * consumes the next character — so `"a\\"` ends at its own closing quote (the
 * escaped backslash does not escape it) and a `{` or `}` written inside a
 * string value never miscounts.
 */
function matchingBraceEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Render: Markdown → HTML
// ---------------------------------------------------------------------------

export class MarkdownRenderer {
  private readonly md: MarkdownIt;
  private capturedFrontMatter: string | undefined;
  private capturedFrontMatterRange: [number, number] | undefined;
  /** Which delimiter produced the captured block — picks the parser in renderFrontMatterBlock and the fence turndown re-emits (US-2.10). */
  private capturedFrontMatterFormat: FrontMatterFormat = 'yaml';
  /**
   * The object `captureJsonFrontMatter` already parsed (US-2.11). Kept rather
   * than re-parsed downstream: the pre-scan has to run `JSON.parse` anyway to
   * decide whether the block is front matter at all, and a second parse in
   * `front-matter.ts` would need a catch branch for a failure that, by
   * construction, cannot happen — dead code the JSON path has no invalid state
   * to route to.
   */
  private capturedJsonValue: unknown;
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

    // Same as VS Code (markdownEngine.ts): disable markdown-it's default
    // normalizeLink — it percent-encodes characters "invalid in a URL" (including
    // `\`, e.g. a UNC href "\\server\share" gets encoded to "%5Cserver%5Cshare"),
    // which makes turndown re-serialize different bytes than the source → the
    // file gets marked dirty even though nothing was edited (X-7 UNC round-trip).
    this.md.normalizeLink = (link) => link;

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

  /** Xoá state "capture" (front-matter + math-block ranges) trước mỗi lần render()/computeTopLevelBlockRanges() — các rule markdown-it ghi lại vào đây trong lúc chạy. */
  private resetCaptureState(): void {
    this.capturedFrontMatter = undefined;
    this.capturedFrontMatterRange = undefined;
    this.capturedFrontMatterFormat = 'yaml';
    this.capturedJsonValue = undefined;
    this.capturedMathBlockRanges = [];
  }

  /**
   * US-2.10: TOML front matter (`+++` fences). markdown-it-front-matter only
   * knows `---` and there is no npm equivalent for `+++`, so this is a pre-scan
   * run BEFORE markdown-it sees the text — and it must be called from BOTH
   * render() and computeTopLevelBlockRanges(), or the debounced gutter refresh
   * would keep parsing raw `+++` text and desync block numbering on every
   * keystroke.
   *
   * Returns the markdown to hand to markdown-it: the matched region replaced by
   * the SAME number of blank lines, so every downstream data-line stays aligned
   * with the real source. Captures nothing (and returns the input untouched)
   * unless the very first line is a `+++` fence with a matching closing fence
   * later on — deliberately NOT markdown-it-front-matter's autoclose-at-EOF,
   * which on an in-progress file would read the whole document as metadata and
   * then write a closing fence the user never typed.
   */
  private captureTomlFrontMatter(markdown: string): string {
    const lines = markdown.split('\n');
    const isFence = (line: string | undefined): boolean => /^\+{3}[ \t]*$/.test((line ?? '').replace(/\r$/, ''));
    if (!isFence(lines[0])) {
      return markdown;
    }
    const close = lines.findIndex((line, i) => i > 0 && isFence(line));
    if (close === -1) {
      return markdown;
    }
    // Drop each line's trailing CR, exactly as markdown-it's own `normalize`
    // rule does before `markdown-it-front-matter` sees a `---` block. Without
    // it a CRLF document's captured text ends in a bare CR, which `escapeAttr`
    // does not encode and the HTML parser folds to a newline on read — so the
    // very first save would write a blank line into the block that the author
    // never typed.
    this.capturedFrontMatter = lines
      .slice(1, close)
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .join('\n');
    // Same [start0, endExclusive0] shape markdown-it's own token.map carries for
    // YAML, so both consumers below read it unchanged.
    this.capturedFrontMatterRange = [0, close + 1];
    this.capturedFrontMatterFormat = 'toml';
    return [...lines.slice(0, close + 1).map(() => ''), ...lines.slice(close + 1)].join('\n');
  }

  /**
   * US-2.11: JSON front matter — a leading `{...}` with no delimiter at all.
   * Same pre-scan architecture as `captureTomlFrontMatter` and the same
   * both-entry-points requirement, but with a far stricter recognition rule:
   * a fence-less `{` carries no marker of intent, and a `{`-leading paragraph
   * is ordinary content, so anything less than valid JSON followed by a blank
   * line stays exactly the text it is today.
   *
   * `scanJson === false` is the paste path (AC14): a pasted snippet that
   * happens to start with `{` must not become a front-matter card in the
   * middle of the document.
   */
  private captureJsonFrontMatter(markdown: string, scanJson: boolean): string {
    // Detection order is YAML → TOML → bare `{`, first match wins. A captured
    // block already means line 1 was a fence, never a brace, but the guard is
    // written out rather than left implied by the earlier scans' shape.
    if (!scanJson || this.capturedFrontMatter !== undefined) {
      return markdown;
    }
    const start = markdown.startsWith(BOM) ? BOM.length : 0;
    // No leading whitespace and no leading blank line: the very first character
    // after an optional BOM must be the brace itself.
    if (markdown[start] !== '{') {
      return markdown;
    }
    const close = matchingBraceEnd(markdown, start);
    if (close === -1) {
      return markdown; // EOD with braces still open, or inside an unterminated string.
    }
    // Drop CRs for the same reason the TOML scan does: `escapeAttr` does not
    // encode `\r`, so what survives the `data-raw` round trip is the LF form
    // anyway, and the host reconciles back to the document's own EOL.
    //
    // A LONE `\r` is deleted rather than folded to `\n`. VS Code does not treat
    // it as a line separator, but the HTML parser folds a bare CR to a newline
    // when reading the attribute back — so folding it here too would make the
    // block grow a line the author never typed on the very first save. It
    // cannot be significant content either: JSON forbids a raw control
    // character inside a string, so outside one it is only whitespace.
    const raw = markdown
      .slice(start, close + 1)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '');
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return markdown; // Not front matter at all -- a `{`-leading paragraph must never be misdetected.
    }
    const lineEnd = markdown.indexOf('\n', close);
    // The closing brace must be the last non-whitespace character on its line...
    const trailer = lineEnd === -1 ? markdown.slice(close + 1) : markdown.slice(close + 1, lineEnd);
    if (!/^[ \t]*\r?$/.test(trailer)) {
      return markdown;
    }
    // ...and what follows must be end-of-document or at least one blank line —
    // a whitespace-only line terminated by `\n` or `\r\n`, so a CRLF document
    // behaves identically. The `|$` alternative makes end-of-document tolerate
    // trailing spaces/tabs exactly as the trailer check above already does; the
    // two boundaries are one line apart and would otherwise disagree about the
    // same whitespace.
    const rest = lineEnd === -1 ? '' : markdown.slice(lineEnd + 1);
    if (!/^[ \t]*(\r?\n|$)/.test(rest)) {
      return markdown;
    }
    this.capturedFrontMatter = raw;
    this.capturedJsonValue = value;
    // Same [start0, endExclusive0] shape the YAML token.map and the TOML scan
    // carry, so both consumers below read it unchanged.
    const blockLineCount = markdown.slice(0, lineEnd === -1 ? markdown.length : lineEnd).split('\n').length;
    this.capturedFrontMatterRange = [0, blockLineCount];
    this.capturedFrontMatterFormat = 'json';
    // The region becomes the SAME number of blank lines, or the block would
    // render twice — once as the prepended card, once as an ordinary paragraph
    // — and every downstream data-line would shift.
    return '\n'.repeat(blockLineCount - 1) + (lineEnd === -1 ? '' : markdown.slice(lineEnd));
  }

  /** Run the pre-scans that must happen BEFORE markdown-it, in detection order (TOML, then JSON), returning the markdown with any matched region replaced by blank lines. */
  private capturePreScannedFrontMatter(markdown: string, scanJson: boolean): string {
    return this.captureJsonFrontMatter(this.captureTomlFrontMatter(markdown), scanJson);
  }

  /**
   * Render markdown → HTML (kèm block front-matter nếu có).
   *
   * `scanJson` is false only on the paste/insert path (US-2.11 AC14) — every
   * whole-document render leaves it at its default.
   */
  public render(markdown: string, scanJson = true): RenderResult {
    this.resetCaptureState();
    let html = this.md.render(this.capturePreScannedFrontMatter(markdown, scanJson));
    const frontMatter = this.capturedFrontMatter;
    if (frontMatter !== undefined) {
      const [start0] = this.capturedFrontMatterRange ?? [0, 0];
      html = renderFrontMatterBlock(frontMatter, start0 + 1, this.capturedFrontMatterFormat, this.capturedJsonValue) + html;
    }
    return { html, frontMatter };
  }

  /** Range (1-based, bao gồm) của từng khối ```math``` trong lần render() gần nhất, theo đúng thứ tự xuất hiện. */
  public getLastMathBlockRanges(): LineRange[] {
    return this.capturedMathBlockRanges.map(([start0, end0]) => ({ start: start0 + 1, end: end0 }));
  }

  /**
   * Lấy range dòng nguồn (1-based, bao gồm) của từng block CẤP CAO NHẤT theo
   * đúng thứ tự tài liệu — KHÔNG sinh lại HTML. Dùng để cập nhật gutter số
   * dòng sau mỗi lần gõ (debounce) mà không phải re-render toàn bộ #content
   * (tránh mất caret/undo). Front-matter (nếu có) luôn là phần tử đầu.
   *
   * Danh sách cấp cao nhất (<ul>/<ol>) trả về kèm `itemRanges` — range của
   * TỪNG list_item (mọi độ sâu) — để gutter.ts đánh số riêng từng bullet thay
   * vì chỉ một số ở dòng đầu cả khối; đây cũng là ranh giới gutter dùng để thu
   * hẹp "bail-out" xuống đúng khối list bị lệch số lượng item, thay vì bỏ cả
   * tài liệu (xem refreshFromMarkdown trong gutter.ts).
   */
  public computeTopLevelBlockRanges(markdown: string): TopLevelBlockRange[] {
    this.resetCaptureState();
    const tokens = this.md.parse(this.capturePreScannedFrontMatter(markdown, true), {});
    const groups: TopLevelBlockRange[] = [];
    if (this.capturedFrontMatter !== undefined) {
      const [start0, end0] = this.capturedFrontMatterRange ?? [0, 0];
      groups.push({ range: { start: start0 + 1, end: end0 } });
    }
    let currentList: TopLevelBlockRange | undefined;
    for (const token of tokens as unknown as BlockToken[]) {
      const isListContainer = token.type === 'bullet_list_open' || token.type === 'ordered_list_open';
      const isListContainerClose = token.type === 'bullet_list_close' || token.type === 'ordered_list_close';
      if (token.level === 0 && isListContainer) {
        currentList = token.map ? { range: { start: token.map[0] + 1, end: token.map[1] }, itemRanges: [] } : undefined;
        if (currentList) {
          groups.push(currentList);
        }
        continue;
      }
      if (token.level === 0 && isListContainerClose) {
        currentList = undefined;
        continue;
      }
      if (currentList) {
        if (token.type === 'list_item_open' && token.map) {
          currentList.itemRanges?.push({ start: token.map[0] + 1, end: token.map[1] });
        }
        continue;
      }
      if (token.level === 0 && token.nesting !== -1 && token.map && !token.hidden) {
        groups.push({ range: { start: token.map[0] + 1, end: token.map[1] } });
      }
    }
    return groups;
  }
}

/** Range dòng nguồn của MỘT block cấp cao nhất; `itemRanges` chỉ có khi block là <ul>/<ol>. */
export interface TopLevelBlockRange {
  range: LineRange;
  itemRanges?: LineRange[];
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
      const token = (tokens as unknown as TokenLike[])[idx];
      applyAlign(tokens as unknown as TokenLike[], idx);
      // US-19.7 (accessibility): mọi <th> của bảng GFM là header CỘT → scope="col".
      // Display-only: turndown chuyển bảng về pipe syntax nên scope bị strip khi
      // ghi lại `.md` (xem test/roundtrip/accessibility.ts), không rò tag.
      if (rule === 'th_open' && !token.attrGet('scope')) {
        token.attrSet('scope', 'col');
      }
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

/** US-2.7 redesign: card-building logic lives in front-matter.ts (mirrors Mermaid/PlantUML's shared frame logic in diagram-frame.ts) — this stays a thin delegation so the `*_CLASS` constants above keep living here per existing convention. The format picks the parser; everything downstream of it is format-agnostic (US-2.10). */
function renderFrontMatterBlock(raw: string, line: number, format: FrontMatterFormat, jsonValue: unknown): string {
  const parsed =
    format === 'json'
      ? // Already parsed by the pre-scan, which had to succeed for the block to
        // be front matter at all — so JSON feeds US-2.9's parser-agnostic
        // adapter directly and has no invalid state of its own.
        buildFrontMatterFields(jsonValue)
      : format === 'toml'
        ? parseTomlFrontMatterFields(raw)
        : parseFrontMatterFields(raw);
  return buildFrontMatterHtml(raw, line, parsed, format);
}
