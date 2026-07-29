/**
 * Serialize: HTML (DOM) → Markdown — turndown + turndown-plugin-gfm với các rule
 * tùy chỉnh để round-trip ổn định (fence có ngôn ngữ, ~~strikethrough~~, bảng có
 * căn lề, task list, math, front-matter, bare URL từ linkify, <br> trong ô bảng).
 *
 * File này chạy được cả trong webview (browser) lẫn Node (round-trip test).
 */
import TurndownService from 'turndown';
import { tables, taskListItems } from 'turndown-plugin-gfm';
import {
  CAPTION_CLASS,
  FRONT_MATTER_CLASS,
  MATH_INLINE_CLASS,
  MATH_BLOCK_CLASS,
  MERMAID_CLASS,
  PLANTUML_CLASS,
  AUTOLINK_PATH_ATTR,
  EMPTY_LINK_ATTR,
} from './render';
import { hasAncestor, getAncestor } from './dom-portable';
import { hasUrlScheme } from '../../src/shared/link-scheme';
import { DiagramFrameSpec, MERMAID_FRAME, PLANTUML_FRAME } from './diagram-frame';
import { tableNeedsHtmlSerialization } from './dom-serialize-prep';
import {
  HEADING_STYLE_ATTR,
  BULLET_STYLE_ATTR,
  CODE_STYLE_ATTR,
  EM_STYLE_ATTR,
  STRONG_STYLE_ATTR,
  HR_STYLE_ATTR,
  TABLE_SEP_STYLE_ATTR,
} from './block-style';
import { COMMENT_ANCHOR_ATTR } from './block-map';
import {
  COMMENT_ANCHOR_ACTIVE_CLASS,
  COMMENT_ANCHOR_STATE_ATTR,
  DD_HOVER_OUTLINE_CLASS,
  DD_HOVER_OUTLINE_CELL_CLASS,
  DD_SOURCE_MUTED_CLASS,
  DD_DROP_TARGET_CELL_CLASS,
  MD_TABLE_FIT_CLASS,
  MD_CODE_WRAPPED_CLASS,
  ENTITY_REF_CLASS,
  ENTITY_REVEAL_FLASH_CLASS,
  BROKEN_REF_CLASS,
  MD_CHROME_MARKER_ATTR,
} from './constants';

export function createTurndown(): TurndownService {
  // Orca convention (Template/markdown-syntax-guide.md, decided 2026-07-17):
  // '*' bullets and backslash hard breaks — see US-18.4b. Named so
  // blankReplacement's zero-child <li> branch (no access to `options` there)
  // can share the same fallback as 'listItemWithBulletStyle' below.
  const BULLET_MARKER = '*';
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: BULLET_MARKER,
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    br: '\\',
    // Thẻ không nhận diện được → giữ nguyên outerHTML thay vì bóc mất thẻ
    // (div, custom element...). Riêng SPAN là rác contentEditable → chỉ lấy nội dung.
    defaultReplacement: (content, node) => {
      const el = node as HTMLElement;
      if (el.nodeName === 'SPAN') {
        return content;
      }
      return outerHtmlFallback(el, content);
    },
    // Thẻ trong keep() cũng phải né dòng trống bên trong (cắt html_block).
    keepReplacement: (content, node) => outerHtmlFallback(node as HTMLElement, content),
    // Node "rỗng" (turndown coi là blank và bỏ qua rule thường, kể cả rule tự
    // thêm qua addRule — xem forNode trong turndown core: isBlank luôn được xét
    // TRƯỚC rule lookup):
    //  - placeholder HTML comment phải được giữ lại
    //  - ô bảng rỗng vẫn phải emit "|" để không vỡ cột
    //  - <li> rỗng hoàn toàn (0 con — markdown-it tự dựng lại từ 1 dòng bullet
    //    trống khi re-parse) phải emit đúng prefix bullet/số của nó, không phải
    //    default "\n\n" chung cho mọi block rỗng — nếu không, turndown MẤT hẳn
    //    mục này khi nối với các <li> anh em (vỡ round-trip, không chỉ vỡ hiển
    //    thị). Mục rỗng có <br> placeholder (Enter tạo mục mới chưa gõ gì) thì
    //    KHÔNG rơi vào nhánh này — <br> là void element nên turndown coi <li>
    //    đó "not blank", đã có rule riêng 'strayTrailingBr' xử lý.
    blankReplacement: (_content, node) => {
      const el = node as HTMLElement;
      if (el.getAttribute?.('data-md-comment') != null) {
        return commentReplacement(el);
      }
      if (el.nodeName === 'TD' || el.nodeName === 'TH') {
        return cellPrefix(el) + ' |';
      }
      if (el.nodeName === 'LI') {
        return emptyListItemPrefix(el, BULLET_MARKER);
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
    replacement: (_content, node) => `\n\n${safeOuterHtml(node as HTMLElement)}\n\n`,
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

  // --- US-18.5: table separator (border) row honoring its ORIGINAL spacing
  //     (`|---|---|`, no inner spaces) when the table is stamped 'compact'
  //     from mdSlice; supersedes turndown-plugin-gfm's tableRow rule, whose
  //     cell() helper unconditionally pads every border cell — the actual
  //     cause of untouched tables getting rewritten. Content cells
  //     (tableCellPipeEscape above) are untouched; no mark → unchanged padded
  //     output (Golden Rule). ---
  td.addRule('tableRowBorderStyle', {
    filter: 'tr',
    replacement: (content, node) => {
      const tr = node as HTMLElement;
      let borderCells = '';
      if (isHeadingRow(tr)) {
        const table = getAncestor(tr, (el) => el.nodeName === 'TABLE');
        const compact = table?.getAttribute(TABLE_SEP_STYLE_ATTR) === 'compact';
        const alignMap: Record<string, string> = { left: ':--', right: '--:', center: ':-:' };
        for (let i = 0; i < tr.childNodes.length; i++) {
          const cellEl = tr.childNodes[i] as HTMLElement;
          let border = '---';
          const align = (cellEl.getAttribute?.('align') || '').toLowerCase();
          if (align) {
            border = alignMap[align] ?? border;
          }
          borderCells += compact
            ? (i === 0 ? '|' : '') + border + '|'
            : (i === 0 ? '| ' : ' ') + border + ' |';
        }
      }
      return '\n' + content + (borderCells ? '\n' + borderCells : '');
    },
  });

  // --- heading: escape a trailing '#' (markdown-it strips an ATX closing
  //     sequence). If the block is marked to keep its original Setext form
  //     (US-18.4a: data-md-heading-style, stamped by serialize() from mdSlice)
  //     and it is H1/H2 → re-emit as Setext instead of ATX, reusing the ORIGINAL
  //     underline length (attribute value) so an untouched heading isn't
  //     rewritten; the underline CHAR is re-derived from the current level so a
  //     since-changed level can't emit the wrong Setext level. H3+ is always ATX
  //     (Setext has only 2 levels). Empty text can't form a Setext heading, so it
  //     also falls through to ATX. No mark → unchanged ATX path (Golden Rule:
  //     canonical files serialize byte-identical). ---
  td.addRule('atxHeadingEscapeTrailingHash', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node) => {
      const level = Number(node.nodeName.charAt(1)) || 1;
      const text = content.replace(/\n+/g, ' ').trim();
      const mark = (node as HTMLElement).getAttribute?.(HEADING_STYLE_ATTR);
      if (mark != null && text && (level === 1 || level === 2)) {
        const len = Math.max(parseInt(mark, 10) || text.length, 1);
        const underline = (level === 1 ? '=' : '-').repeat(len);
        return `\n\n${text}\n${underline}\n\n`;
      }
      const atx = text.replace(/(\s)(#+)$/, (_m, sp: string, hashes: string) => `${sp}\\${hashes}`);
      return `\n\n${'#'.repeat(level)} ${atx}\n\n`;
    },
  });

  // --- <img> HTML thô có attribute ngoài src/alt/title → giữ nguyên HTML ---
  //     US-23.21 AC3: một attribute/class sẽ bị safeOuterHtml strip sạch
  //     (TRANSIENT_ATTRS, hoặc `class` chỉ toàn token TRANSIENT_CLASSES) không
  //     được tính là "extra" — nếu không thì kết quả đã stripped-về-không vẫn
  //     đi đường raw HTML thay vì rule ảnh mặc định (![]()).
  td.addRule('htmlImgWithAttrs', {
    filter: (node) => {
      if (node.nodeName !== 'IMG') {
        return false;
      }
      const attrs = (node as Element).attributes;
      for (let i = 0; i < attrs.length; i++) {
        const name = attrs[i].name;
        if (['src', 'alt', 'title'].includes(name)) {
          continue;
        }
        if (TRANSIENT_ATTRS.includes(name)) {
          continue;
        }
        if (name === 'class') {
          // .every() on an empty array is vacuously true, so a present-but-empty
          // class="" (no real tokens) discounts the same as an all-transient one —
          // both leave nothing for stripTransientClasses to strip.
          const tokens = attrs[i].value.trim().split(/\s+/).filter(Boolean);
          if (tokens.every((t) => TRANSIENT_CLASSES.includes(t))) {
            continue;
          }
        }
        return true;
      }
      return false;
    },
    // safeOuterHtml, not raw outerHTML: this is the third raw-HTML emitter, and
    // an editor-session attribute/class landing on the <img> would otherwise be
    // written into the `.md` here while the other two strip it (US-23.6).
    replacement: (_content, node) =>
      typeof (node as HTMLElement).outerHTML === 'string' ? safeOuterHtml(node as HTMLElement) : '',
  });

  // --- strikethrough: markdown-it chỉ parse ~~ (2 dấu) ---
  td.addRule('strikethroughDouble', {
    filter: ['del', 's', 'strike' as keyof HTMLElementTagNameMap],
    replacement: (content) => (content ? `~~${content}~~` : ''),
  });

  // --- fenced code giữ ngôn ngữ, bỏ span highlight, chọn fence đủ dài.
  //     US-18.4b: blocks stamped data-md-code-style (from mdSlice) re-emit their
  //     ORIGINAL style — 'indented' → 4-space body, no fence/language;
  //     'fence-tilde' → ~~~ fence (grown on conflict) keeping the language.
  //     No mark → unchanged backtick output (Golden Rule). ---
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
      const codeStyle = el.getAttribute(CODE_STYLE_ATTR);
      if (codeStyle === 'indented' || codeStyle === 'indented-tab') {
        // Indented syntax can't represent a whitespace-only body (the block
        // would vanish on reparse) and can't directly follow a list (it would
        // reparse as the list's continuation) — those two shapes fall through
        // to the fenced path instead, sacrificing style to keep the content.
        const prev = el.previousElementSibling;
        const afterList = prev != null && (prev.nodeName === 'UL' || prev.nodeName === 'OL');
        if (text.trim() && !afterList) {
          const indent = codeStyle === 'indented-tab' ? '\t' : '    ';
          const body = text
            .split('\n')
            .map((line) => (line ? indent + line : line))
            .join('\n');
          return `\n\n${body}\n\n`;
        }
      }
      const fence = pickFence(text, codeStyle === 'fence-tilde' ? '~' : '`');
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });

  // --- US-18.4b: list item honoring the block's ORIGINAL bullet marker.
  //     Replicates turndown's base listItem emission exactly (marker + 3 spaces,
  //     `N.` + 2 spaces, continuation indent = prefix width) but reads the
  //     marker from the nearest ancestor stamped with data-md-bullet-style (the
  //     top-level list block — nested <li> inherit it), falling back to the
  //     global bulletListMarker. No mark → byte-identical to the base rule. ---
  td.addRule('listItemWithBulletStyle', {
    filter: 'li',
    replacement: (content, node, options) => {
      const block = getAncestor(node, (el) => el.hasAttribute(BULLET_STYLE_ATTR));
      const marker = block?.getAttribute(BULLET_STYLE_ATTR) ?? options.bulletListMarker;
      let prefix = marker + '   ';
      const parent = node.parentNode as HTMLElement | null;
      if (parent && parent.nodeName === 'OL') {
        const start = parent.getAttribute('start');
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = (start ? Number(start) + index : index + 1) + '.  ';
      }
      const isParagraph = /\n$/.test(content);
      content = content.replace(/^\n+/, '').replace(/\n+$/, '') + (isParagraph ? '\n' : '');
      content = content.replace(/\n/gm, '\n' + ' '.repeat(prefix.length));
      return prefix + content + (node.nextSibling ? '\n' : '');
    },
  });

  // --- US-18.4b: em/strong honoring the block's ORIGINAL delimiter (`_x_` /
  //     `__x__`), read from the nearest ancestor stamped by serialize() from
  //     mdSlice; no mark → global emDelimiter/strongDelimiter (Golden Rule).
  //     CommonMark doesn't parse `_` adjacent to a word character (`_th_ing`),
  //     so an intraword occurrence falls back to the `*` form — parseable
  //     output beats delimiter fidelity there. ---
  const delimiterReplacement =
    (attr: string, globalDelimiter: '*' | '**') =>
    (content: string, node: Node): string => {
      if (!content.trim()) {
        return '';
      }
      const block = getAncestor(node, (el) => el.hasAttribute(attr));
      const delimiter = block?.getAttribute(attr) ?? globalDelimiter;
      return delimiter.startsWith('_') && isIntrawordEmphasis(node)
        ? globalDelimiter + content + globalDelimiter
        : delimiter + content + delimiter;
    };
  td.addRule('emphasisWithStyle', {
    filter: ['em', 'i'],
    replacement: delimiterReplacement(EM_STYLE_ATTR, '*'),
  });
  td.addRule('strongWithStyle', {
    filter: ['strong', 'b'],
    replacement: delimiterReplacement(STRONG_STYLE_ATTR, '**'),
  });

  // --- US-18.4b: HR honoring its ORIGINAL raw line (`***`, `___`, `- - -`...),
  //     stamped verbatim on the <hr> itself; no mark → global '---'. ---
  td.addRule('hrWithStyle', {
    filter: 'hr',
    replacement: (_content, node, options) => {
      const raw = (node as HTMLElement).getAttribute(HR_STYLE_ATTR);
      return `\n\n${raw ?? options.hr}\n\n`;
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

  // --- Residual <br> that would otherwise serialize to a stray "\" under this
  //     branch's `br: '\\'` convention (US-18.4b hard-break marker). A <br> is
  //     "residual" when it is the LAST meaningful node inside an <li>/<p>/
  //     <blockquote> -- no following sibling carries visible content (only other
  //     <br>s, whitespace text, or empty/void-less elements follow) -- so it
  //     carries no real hard break and only exists
  //     as contentEditable/execCommand leftover: an Enter-created empty list
  //     item, Enter/Backspace residue, or the indent/outdent / list-unwrap /
  //     blockquote-toggle native fallbacks. Dropping it lets the parent emit a
  //     clean empty bullet / paragraph / "> " line instead of "\" (the default
  //     'br' rule would turn it into a hard break, which 'listItem' then indents
  //     and appends an extra "\n" to when a sibling follows -> "-     \n    \n").
  //     A GENUINE mid-content hard break (foo<br>bar) is untouched: "bar" follows
  //     the <br>, so it is not trailing and the default 'br' rule still runs.
  //     One rule covers all three parents: <li> (bug 0717 / round2 #1 empty item,
  //     round3 #2/#6), <p> (round3 #6) and <blockquote> (round3 #8). Note: an
  //     empty <li>/<p> still passes turndown's isBlank() as non-blank because a
  //     <br> is a void element, so 'listItem'/paragraph rules run normally and
  //     compute the correct prefix from the now-empty content -- do NOT add a
  //     prefix here (that would double-prefix). Zero-child <li> is a separate
  //     path (turndown's isBlank short-circuits to blankReplacement's LI branch).
  td.addRule('strayTrailingBr', {
    filter: (node) => {
      if (node.nodeName !== 'BR') {
        return false;
      }
      const parent = node.parentElement;
      if (!parent || !/^(LI|P|BLOCKQUOTE)$/.test(parent.nodeName)) {
        return false;
      }
      // Trailing when NO following sibling carries visible content: skip other
      // <br>s and any node whose textContent is blank AND holds no visible void
      // (img/input/media/hr) -- covers whitespace text, empty inline cruft like
      // <span></span>, and empty elements. Any real text or visible void after
      // the <br> means it is a genuine hard break -> keep it (default 'br' rule).
      for (let sib = node.nextSibling; sib; sib = sib.nextSibling) {
        if (sib.nodeName === 'BR') {
          continue;
        }
        if ((sib.textContent ?? '').trim() !== '') {
          return false;
        }
        if ((sib as Element).querySelector?.('img, input, video, audio, iframe, picture, hr')) {
          return false;
        }
      }
      return true;
    },
    replacement: () => '',
  });

  // --- HTML comment (đã được prepareDomForSerialize đổi thành placeholder) ---
  td.addRule('mdComment', {
    filter: (node) => (node as HTMLElement).hasAttribute?.('data-md-comment') ?? false,
    replacement: (_content, node) => commentReplacement(node as HTMLElement),
  });

  // --- display-only auto-link path: <a data-autolink-path> created by
  // postProcessRelativePathLinks (text = file name, href = encoded path).
  // Emit the ORIGINAL raw path run through td.escape() — the SAME escaping the
  // plain-text serializer applies — so serialize-with-feature is byte-identical
  // to serialize-without-feature (display-only must not alter the .md). Custom
  // rules are checked before the built-in inlineLink; this rule's data-attr
  // filter is disjoint from bareUrl (text = file name ≠ href), so it is the one
  // that fires for these anchors.
  td.addRule('autolinkPath', {
    filter: (node) =>
      node.nodeName === 'A' && ((node as HTMLElement).hasAttribute?.(AUTOLINK_PATH_ATTR) ?? false),
    replacement: (_content, node) => td.escape((node as HTMLElement).getAttribute(AUTOLINK_PATH_ATTR) ?? ''),
  });

  // --- display-only auto-link path in an inline code span: <code data-autolink-path>
  // shows only the file name but must serialize back to the ORIGINAL `full-path`
  // code span (inline-code content is literal — no escaping) so the .md is unchanged.
  td.addRule('autolinkCodePath', {
    filter: (node) =>
      node.nodeName === 'CODE' && ((node as HTMLElement).hasAttribute?.(AUTOLINK_PATH_ATTR) ?? false),
    replacement: (_content, node) => '`' + ((node as HTMLElement).getAttribute(AUTOLINK_PATH_ATTR) ?? '') + '`',
  });

  // --- display-only empty link: <a data-empty-link> shows the decoded target
  // file name (postProcessEmptyLinks — bug_General #15) but must serialize back
  // to the ORIGINAL empty-text link `[](href)`, dropping the display text, so the
  // .md is unchanged. href is the raw attribute (already URL-encoded); emitted as-is
  // like the built-in inlineLink rule → byte-identical to the untouched .md.
  td.addRule('emptyLink', {
    filter: (node) =>
      node.nodeName === 'A' && ((node as HTMLElement).hasAttribute?.(EMPTY_LINK_ATTR) ?? false),
    replacement: (_content, node) => `[](${(node as HTMLElement).getAttribute(EMPTY_LINK_ATTR) ?? ''})`,
  });

  // --- href/src containing a literal backslash (Windows UNC "\\server\share\x.md"
  // or drive path "C:\dir\x.md", hand-typed in the .md) — X-7 round-trip fix.
  // turndown's default escapeLinkDestination leaves `\` untouched; CommonMark
  // then collapses every `\\` pair back to 1 char on re-parse, so the href
  // "decays" a little more on every open (X-7 root cause B, independent of the
  // %5C bug from normalizeLink above). escapeLinkDestinationBackslash re-escapes
  // each maximal run of k backslashes to the minimal reproducing form (2k-1 raw
  // chars) so re-parsing recovers exactly k backslashes; a run touching the very
  // end of the string is padded by one extra `\` (even 2k) so its trailing
  // single backslash can't combine with the `)`/`>` that follows and accidentally
  // escape it. Applies to both <a href> and plain <img src> (markdown-it's
  // normalizeLink, disabled above, covers both tags the same way) — other rules
  // with their own attr-based filter (autolinkPath/emptyLink/htmlImgWithAttrs)
  // are excluded explicitly so they don't collide.
  function escapeLinkDestinationBackslash(destination: string): string {
    let escaped = destination.replace(/\\+/g, (run) => '\\\\'.repeat(run.length - 1) + '\\');
    const trailingRun = /\\+$/.exec(escaped);
    if (trailingRun && trailingRun[0].length % 2 === 1) {
      escaped += '\\';
    }
    const bracketEscaped = escaped.replace(/([<>()])/g, '\\$1');
    return bracketEscaped.includes(' ') ? `<${bracketEscaped}>` : bracketEscaped;
  }
  td.addRule('linkHrefBackslashEscape', {
    filter: (node) => {
      if (node.nodeName !== 'A') {
        return false;
      }
      const el = node as HTMLElement;
      if (el.hasAttribute(AUTOLINK_PATH_ATTR) || el.hasAttribute(EMPTY_LINK_ATTR)) {
        return false;
      }
      return (el.getAttribute('href') ?? '').includes('\\');
    },
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const href = escapeLinkDestinationBackslash(el.getAttribute('href') ?? '');
      const rawTitle = el.getAttribute('title') ?? '';
      const titlePart = rawTitle ? ` "${rawTitle.replace(/"/g, '\\"')}"` : '';
      return `[${content}](${href}${titlePart})`;
    },
  });
  td.addRule('imgSrcBackslashEscape', {
    filter: (node) => {
      if (node.nodeName !== 'IMG') {
        return false;
      }
      const el = node as HTMLElement;
      if (!(el.getAttribute('src') ?? '').includes('\\')) {
        return false;
      }
      const attrs = el.attributes;
      for (let i = 0; i < attrs.length; i++) {
        if (!['src', 'alt', 'title'].includes(attrs[i].name)) {
          return false; // extra attrs (e.g. width) → htmlImgWithAttrs handles it instead
        }
      }
      return true;
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const alt = td.escape(el.getAttribute('alt') ?? '');
      const src = escapeLinkDestinationBackslash(el.getAttribute('src') ?? '');
      const rawTitle = el.getAttribute('title') ?? '';
      const titlePart = rawTitle ? ` "${rawTitle.replace(/"/g, '\\"')}"` : '';
      return src ? `![${alt}](${src}${titlePart})` : '';
    },
  });

  // --- linkify/autolink: <a> có text trùng href → giữ dạng URL trần ---
  td.addRule('bareUrl', {
    filter: (node) => {
      if (node.nodeName !== 'A') {
        return false;
      }
      // An empty-text link `[](url)` carries display text that postProcessEmptyLinks
      // INJECTED (the decoded file name) — it must serialize via the `emptyLink`
      // rule, never as a bare URL. Before X-19's decodeURIComponent fix this was
      // masked (decodeURI left `%26` etc. encoded, so the injected text rarely
      // equalled the href); now it can match, so exclude stamped empty links.
      if ((node as HTMLElement).hasAttribute?.(EMPTY_LINK_ATTR) ?? false) {
        return false;
      }
      const href = (node as HTMLElement).getAttribute('href') ?? '';
      const text = node.textContent ?? '';
      if (!href) {
        return false;
      }
      // linkify (fuzzyLink:false) only ever auto-links scheme-based text (http(s)://,
      // mailto:...) — never a bare relative/local-filesystem path. So an <a> whose
      // href is NOT a real URL scheme (relative path, or a Windows drive path like
      // `C:\…` — hasUrlScheme excludes those, see X-7) can only be an intentional
      // link (typed `[x](x)` or an `@`-mention insert to a same-folder file) and
      // must always keep its `[]()` syntax.
      if (!hasUrlScheme(href)) {
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
    replacement: (_content, node) => diagramFence(node as HTMLElement, MERMAID_FRAME),
  });

  // US-2.8: PlantUML frame → back to its ```plantuml fence, same contract.
  td.addRule('plantumlDiagram', {
    filter: (node) => (node as HTMLElement).classList?.contains(PLANTUML_CLASS) ?? false,
    replacement: (_content, node) => diagramFence(node as HTMLElement, PLANTUML_FRAME),
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
      // US-23.21 AC1: route through cloneAndStrip like every other raw-HTML
      // emitter — this rule used to read live el.innerHTML unstripped.
      const inner = collapseBlankLines(cloneAndStrip(el).innerHTML ?? '');
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
  //
  // firstQualifyingCheckbox walks `li`'s children in document order (NOT a
  // `:scope`-based querySelector — domino, the DOM turndown runs on for
  // round-trip tests, silently returns no match for `:scope` selectors) and
  // returns the first checkbox that matches the same tight/loose shapes
  // `filter` below accepts. Used by `replacement` to dedupe a corrupted <li>
  // with more than one checkbox (bug #10 follow-up: a tight-child checkbox
  // and a loose-nested-in-<p> checkbox have different parentNode values, so
  // a same-parent-only sibling scan would miss that they belong to the same
  // <li> and let both serialize).
  const firstQualifyingCheckbox = (li: Node): Node | null => {
    for (let child = li.firstChild; child; child = child.nextSibling) {
      if (child.nodeName === 'INPUT' && (child as HTMLInputElement).getAttribute('type') === 'checkbox') {
        return child;
      }
      if (child.nodeName === 'P') {
        for (let grandchild = child.firstChild; grandchild; grandchild = grandchild.nextSibling) {
          if (grandchild.nodeName === 'INPUT' && (grandchild as HTMLInputElement).getAttribute('type') === 'checkbox') {
            return grandchild;
          }
        }
      }
    }
    return null;
  };

  td.addRule('taskCheckbox', {
    // NOTE: filter must claim EVERY qualifying checkbox (not just the first),
    // otherwise a skipped node falls through to turndown-plugin-gfm's own
    // taskListItems rule (td.use(taskListItems) above), which has no
    // duplicate-checkbox guard and would re-emit a second token anyway. The
    // "only one token per <li>" guard therefore lives in `replacement` below.
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
      const parent = el.parentNode;
      // Defense-in-depth against pre-existing corruption (bug #10, widened for
      // the tight/loose follow-up): a stray stacked checkbox on the same <li>
      // must not emit a second token — only the FIRST qualifying checkbox
      // found in that <li> counts.
      const li = parent && (parent.nodeName === 'LI' ? parent : parent.parentNode);
      if (li && firstQualifyingCheckbox(li) !== node) {
        return '';
      }
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

/**
 * Editor-session metadata that must never leak into `.md` through raw-HTML
 * serialization paths (complex tables, kept/unknown tags): Block Map ids,
 * gutter line numbers, Req 23 comment-anchor ids, and the US-18.4 per-block
 * style attributes — all stamped on live DOM or the serialize clone, none of
 * them document content.
 */
const TRANSIENT_ATTRS = [
  'data-block-id',
  'data-line',
  'data-line-end',
  COMMENT_ANCHOR_ATTR,
  COMMENT_ANCHOR_STATE_ATTR,
  HEADING_STYLE_ATTR,
  BULLET_STYLE_ATTR,
  CODE_STYLE_ATTR,
  EM_STYLE_ATTR,
  STRONG_STYLE_ATTR,
  HR_STYLE_ATTR,
  TABLE_SEP_STYLE_ATTR,
];

/**
 * Same idea as TRANSIENT_ATTRS, for CLASSES — which the attribute loop cannot
 * reach, since it can only delete `class` wholesale. Req 23 US-23.6: a comment
 * action must never occupy a slot in the document's undo stack, so the marker
 * comment-menu.ts puts on the anchored node while the composer is open must not
 * survive into `.md` if a sync happens to serialize that node through a
 * raw-HTML path. Every future comment class belongs here too (see the same
 * warning at comment-panel.ts's drop-overlay).
 *
 * US-23.21 AC2/AC4/AC6: every other presentation class stamped on live
 * `#content` nodes registers here too, one exported constant per owning
 * feature (Req 21's entity-ref marker, Req 20's cross-reference nav flash,
 * Req 17's drag-drop hover/mute states, Req 04's code-wrap marker, and
 * `md-table-fit`, folded in from `stripTablePresentation`'s own former rival
 * strip list so there is exactly one place a class is registered).
 *
 * US-23.21 AC5: every name below is a RESERVED name — a user-authored class
 * in hand-written HTML that happens to collide with one of these is removed
 * exactly like the editor-stamped one, since by the time this list runs there
 * is no way to tell them apart (`postProcessEntityRefs` re-stamps `md-entity-ref`
 * on every render, so a user's own `class="md-entity-ref"` is indistinguishable
 * from the editor's). A class NOT in this list, whatever its name, always
 * survives serialization untouched.
 *
 * US-23.22: forgetting to add a name here is a test failure, not a silent leak
 * — `test/transient-class-scan.ts` (driven from `test/unit.ts`) scans every
 * class stamped in `media/webview/*.ts` and fails on any name that is neither
 * registered below nor listed in that file's `OUTSIDE_CONTENT_CLASSES`. Adding
 * a name here also requires an exported constant in `constants.ts` and a strip
 * case in `test/roundtrip/style-preservation.ts`.
 *
 * Exported because the list also answers "can this class change the `.md`?" for
 * a second caller: main.ts's P-7 dirty tracker skips a `class` mutation whose
 * only difference is tokens from here (Performance Audit P-7 deferred item 3).
 */
export const TRANSIENT_CLASSES = [
  COMMENT_ANCHOR_ACTIVE_CLASS,
  ENTITY_REF_CLASS,
  ENTITY_REVEAL_FLASH_CLASS,
  DD_HOVER_OUTLINE_CLASS,
  DD_HOVER_OUTLINE_CELL_CLASS,
  DD_DROP_TARGET_CELL_CLASS,
  DD_SOURCE_MUTED_CLASS,
  BROKEN_REF_CLASS,
  MD_CODE_WRAPPED_CLASS,
  MD_TABLE_FIT_CLASS,
];

/**
 * Clones `el`, restores every editor-only wrapper to its `.md` source form and
 * strips every TRANSIENT_ATTRS/TRANSIENT_CLASSES token, the table-fit
 * presentation and any editor-injected UI chrome — shared by every raw-HTML
 * emitter (US-23.21 AC1/AC1b) so a strip fix lands once instead of per call
 * site. Operates on the clone only; the live #content DOM is never touched.
 */
function cloneAndStrip(el: HTMLElement): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  restoreWrapperSourceForms(copy);
  for (const attr of TRANSIENT_ATTRS) {
    copy.removeAttribute(attr);
    for (const child of Array.from(copy.querySelectorAll(`[${attr}]`))) {
      child.removeAttribute(attr);
    }
  }
  stripTransientClasses(copy);
  stripTablePresentation(copy);
  stripInjectedChrome(copy);
  return copy;
}

/**
 * Editor-only WRAPPERS: DOM the post-process passes build around a piece of
 * markdown source, which therefore has a source form to be restored to. Each is
 * owned by a turndown RULE on the normal path (`mathBlock`/`mathInline`/
 * `mermaidDiagram`/`plantumlDiagram`, and turndown's SPAN default for
 * `.md-caption`); `restoreWrapperSourceForms` is the raw-HTML path's equivalent.
 */
const WRAPPER_SELECTOR = [
  CAPTION_CLASS,
  MATH_INLINE_CLASS,
  MATH_BLOCK_CLASS,
  MERMAID_CLASS,
  PLANTUML_CLASS,
]
  .map((cls) => `.${cls}`)
  .join(', ');

/**
 * Replaces every editor-only wrapper in the clone with the `.md` source form it
 * was built from, BEFORE the clone is serialized as raw HTML.
 *
 * On the normal path a turndown RULE does this, but a rule never runs inside
 * `complexTableAsHtml` / `outerHtmlFallback` / `alignedBlock` — those emit the
 * DOM verbatim. Without this, a `caption::NS_ID` badge or a formula inside a
 * table that needs HTML serialization wrote the wrapper, its `md-*` classes,
 * its `contenteditable="false"` and (for math) the entire rendered KaTeX
 * subtree straight into the user's file (US-23.22 deferred item 1, measured
 * 2026-07-28). Registering the class names would not have helped: the wrapper
 * ELEMENT is what has to go, not just its class attribute. It also removes
 * `.md-math-render` and the diagram `md-*-error` chart container by ownership —
 * both carry `contenteditable="false"` with no `MD_CHROME_MARKER_ATTR`, so
 * `stripInjectedChrome` never reached them and must not be widened to the bare
 * attribute (see its doc comment).
 *
 * `querySelector` returns document order, so the first match is always the
 * OUTERMOST wrapper and any nested one goes with it — that is what makes the
 * loop terminate: every pass replaces one matching element with a replacement
 * that never matches. `copy` itself is never a wrapper: turndown consults the
 * dedicated rules before `keepReplacement`/`defaultReplacement`, and
 * `.md-caption` is a SPAN, which `defaultReplacement` unwraps to its content.
 */
function restoreWrapperSourceForms(copy: HTMLElement): void {
  const doc = copy.ownerDocument;
  if (!doc) {
    return;
  }
  for (let wrapper = copy.querySelector(WRAPPER_SELECTOR); wrapper; wrapper = copy.querySelector(WRAPPER_SELECTOR)) {
    const parent = wrapper.parentNode;
    if (!parent) {
      return; // detached mid-walk — nothing left to replace it in.
    }
    parent.replaceChild(wrapperSourceForm(wrapper, doc), wrapper);
  }
}

/**
 * The `.md` source form `wrapper` was built from — see WRAPPER_SELECTOR.
 *
 * Everything here must survive turndown's own whitespace collapse, because the
 * emitted HTML is re-parsed and re-serialized on the NEXT save: a newline in a
 * plain text node comes back as a space, so a source form that needs newlines
 * would churn the user's bytes on every pass. `<pre>` is the one element that
 * collapse leaves alone, so anything whose newlines are load-bearing is carried
 * in one: a diagram's source `<pre>` ELEMENT (which the next render also re-wraps
 * into a working frame) instead of fence text, and a `%`-commented multi-line
 * formula. Every other formula folds to the one-line `$…$` / `$$…$$` spelling,
 * where whitespace is insignificant.
 */
function wrapperSourceForm(wrapper: Element, doc: Document): Node {
  const cl = wrapper.classList;
  if (cl.contains(CAPTION_CLASS)) {
    // fillCaptionBadge deliberately keeps textContent === the literal
    // `caption::NS_ID` token, split across hidden-prefix/ns/id child spans
    // purely for display (dom-postprocess.ts).
    return doc.createTextNode(wrapper.textContent ?? '');
  }
  if (cl.contains(MATH_INLINE_CLASS) || cl.contains(MATH_BLOCK_CLASS)) {
    const delimiter = cl.contains(MATH_BLOCK_CLASS) ? '$$' : '$';
    const tex = (wrapper.getAttribute('data-tex') ?? '').trim();
    if (!tex) {
      // Nothing to write. A bare `$$`/`$` would be an unterminated math opener
      // the day this cell stops needing HTML serialization.
      return doc.createTextNode('');
    }
    // A `%` comments to end of line in TeX, so folding a MULTI-LINE formula onto
    // one line moves everything after the comment INTO it and deletes it: `a %
    // first term\n+ b` folded to `$$a % first term + b$$` loses `+ b` from the
    // user's file, unrecoverably (measured 2026-07-28, US-23.22 review). Only
    // that combination needs the `<pre>` carrier — folding preserves meaning for
    // every other formula, and a `<pre>` would break an inline one out of its
    // sentence. Chained appendChild: domino has no ParentNode.append.
    if (tex.includes('%') && tex.includes('\n')) {
      const carrier = doc.createElement('pre');
      carrier.appendChild(doc.createTextNode(`${delimiter}\n${tex}\n${delimiter}`));
      return carrier;
    }
    return doc.createTextNode(`${delimiter}${tex.replace(/\s+/g, ' ')}${delimiter}`);
  }
  const spec = cl.contains(MERMAID_CLASS) ? MERMAID_FRAME : PLANTUML_FRAME;
  const source = wrapper.querySelector(`.${spec.sourceClass}`);
  if (!source) {
    // Never happens for a frame postProcessDiagramDom built, and with no source
    // <pre> there is nothing to preserve — only the rendered chart, which is
    // presentation. Emits NOTHING, not a fence: `diagramSource` reads the source
    // <pre> too, so it could only ever produce an EMPTY fence here, and a fence
    // in a text node is exactly what this function must not write (its newlines
    // would collapse on the next save).
    return doc.createTextNode('');
  }
  source.parentNode?.removeChild(source);
  source.classList.remove(spec.sourceClass);
  // Also the frame class, for the hand-authored `<pre class="md-mermaid
  // md-mermaid-source">` shape: without this the restored element still matches
  // WRAPPER_SELECTOR, re-enters the loop, finds no source and is dropped.
  // Two calls, not `remove(a, b)` — domino's DOMTokenList is the narrow one.
  source.classList.remove(spec.wrapperClass);
  if (source.getAttribute('class') === '') {
    source.removeAttribute('class');
  }
  return source;
}

/**
 * Removes every editor-injected UI control from the clone — the code-block
 * header (language label, Copy/Wrap buttons) and the diagram/math toolbar
 * toggles, all stamped with `MD_CHROME_MARKER_ATTR` in `dom-postprocess.ts`.
 * Ownership-based (any marked descendant is chrome), not an enumerated
 * TRANSIENT_CLASSES entry, so a future injected control is covered by
 * stamping the one shared marker rather than a per-control registration.
 * Matches the marker, not the bare `contenteditable="false"` attribute those
 * controls also carry: that attribute alone is not ownership — a user's own
 * `<span contenteditable="false">` holds real content, and Req 21's
 * `.md-caption` badge carried the attribute for the same reason before
 * `restoreWrapperSourceForms` started restoring it by source form. A blanket
 * match would delete both (US-23.21 AC1b, caught in review 2026-07-28).
 */
function stripInjectedChrome(copy: HTMLElement): void {
  for (const chrome of Array.from(copy.querySelectorAll(`[${MD_CHROME_MARKER_ATTR}]`))) {
    chrome.remove();
  }
}

function safeOuterHtml(el: HTMLElement): string {
  return collapseBlankLines(cloneAndStrip(el).outerHTML);
}

/**
 * Removes every TRANSIENT_CLASSES token from the clone, self and descendants.
 * Walks `[class]` and tests `classList` rather than querying `.${token}`: a
 * token interpolated into a selector must be a valid CSS identifier, and a
 * future entry that isn't one would throw `SyntaxError` in the middle of
 * serialize — silently stopping the document from syncing at all.
 */
function stripTransientClasses(copy: HTMLElement): void {
  const carriers: HTMLElement[] = copy.hasAttribute('class') ? [copy] : [];
  for (const found of Array.from(copy.querySelectorAll('[class]'))) {
    carriers.push(found as HTMLElement);
  }
  for (const carrier of carriers) {
    for (const token of TRANSIENT_CLASSES) {
      carrier.classList.remove(token);
    }
    // A node whose ONLY class was the marker would otherwise serialize as
    // `class=""` — still a change to the `.md`, which is the whole point.
    if (carrier.getAttribute('class') === '') {
      carrier.removeAttribute('class');
    }
  }
}

/**
 * US-19.25: gỡ mọi tàn dư TRÌNH BÀY bề rộng cột (do fitTableColumns/fit-mode ghi
 * inline: `min-width`/`width`/`max-width`/`box-sizing` trên ô + `width` trên
 * <table>) khỏi bản clone TRƯỚC khi serialize raw-HTML. `md-table-fit` class đã
 * chuyển sang TRANSIENT_CLASSES chung (US-23.21 AC4, không strip riêng ở đây
 * nữa). Không thì một bảng đã fit lúc còn đơn giản, sau bị sửa thành phức tạp
 * (vd lồng list trong ô) sẽ đi đường raw-HTML và rò các style này vào `.md`.
 * Chỉ gỡ các thuộc tính bề rộng — GIỮ `text-align` (căn cột US-6.3 vẫn cần).
 */
function stripTablePresentation(copy: HTMLElement): void {
  const tables = copy.tagName === 'TABLE' ? [copy] : [];
  for (const t of Array.from(copy.querySelectorAll('table'))) {
    tables.push(t as HTMLElement);
  }
  for (const t of tables) {
    t.style.removeProperty('width');
    if (t.getAttribute('style') === '') {
      t.removeAttribute('style');
    }
  }
  for (const cell of Array.from(copy.querySelectorAll('th, td'))) {
    const c = cell as HTMLElement;
    c.style.removeProperty('min-width');
    c.style.removeProperty('width');
    c.style.removeProperty('max-width');
    c.style.removeProperty('box-sizing');
    if (c.getAttribute('style') === '') {
      c.removeAttribute('style');
    }
  }
}

/**
 * True when the emphasis node touches a word character on either side
 * (`th<em>i</em>ng`): `_`-delimited output would not reparse as emphasis there.
 */
function isIntrawordEmphasis(node: Node): boolean {
  const before = node.previousSibling?.textContent ?? '';
  const after = node.nextSibling?.textContent ?? '';
  const wordChar = /[\p{L}\p{N}_]/u;
  return (
    (before !== '' && wordChar.test(before.slice(-1))) ||
    (after !== '' && wordChar.test(after.charAt(0)))
  );
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

/**
 * Prefix markdown ("-   " hoặc "1.  ") cho một <li> RỖNG (không có content thật
 * để turndown tự tính content/prefix qua rule 'listItem' mặc định) — dùng chung
 * bởi blankReplacement (li 0 con) và rule 'strayTrailingBr' (li chỉ có <br>).
 * Công thức numbering khớp CHÍNH XÁC turndown's default 'listItem' rule (start
 * attribute + vị trí trong danh sách con của cha) để mục rỗng đánh số đúng như
 * mọi mục khác trong cùng <ol>.
 */
function emptyListItemPrefix(li: HTMLElement, defaultMarker: string): string {
  const parent = li.parentElement;
  let prefix: string;
  if (parent && parent.nodeName === 'OL') {
    const start = parent.getAttribute('start');
    const index = Array.prototype.indexOf.call(parent.children, li);
    prefix = `${start ? Number(start) + index : index + 1}.  `;
  } else {
    // US-18.4b: honor the block's original bullet marker here too, same lookup
    // as 'listItemWithBulletStyle' — this branch bypasses that rule entirely
    // (turndown's isBlank check routes zero-child <li> straight to
    // blankReplacement), so without this it always fell back to '-'.
    const block = getAncestor(li, (el) => el.hasAttribute(BULLET_STYLE_ATTR));
    const marker = block?.getAttribute(BULLET_STYLE_ATTR) ?? defaultMarker;
    prefix = marker + '   ';
  }
  return prefix + (li.nextSibling ? '\n' : '');
}

/** '| ' cho ô đầu hàng, ' ' cho các ô sau — giống turndown-plugin-gfm. */
function cellPrefix(cell: HTMLElement): string {
  const parent = cell.parentNode;
  if (!parent) {
    return '| ';
  }
  return Array.prototype.indexOf.call(parent.childNodes, cell) === 0 ? '| ' : ' ';
}

/**
 * A <tr> is the heading row when its parent is a THEAD, or it's the first
 * child of the TABLE/first TBODY and every cell is a TH — mirrors
 * turndown-plugin-gfm's isHeadingRow exactly, needed here because that
 * plugin's own tableRow rule is superseded by 'tableRowBorderStyle' above.
 */
function isHeadingRow(tr: HTMLElement): boolean {
  const parent = tr.parentNode as HTMLElement | null;
  if (!parent) {
    return false;
  }
  if (parent.nodeName === 'THEAD') {
    return true;
  }
  const isFirstTbody =
    parent.nodeName === 'TBODY' &&
    (!parent.previousElementSibling ||
      (parent.previousElementSibling.nodeName === 'THEAD' &&
        /^\s*$/.test(parent.previousElementSibling.textContent ?? '')));
  if (parent.firstChild !== tr || (parent.nodeName !== 'TABLE' && !isFirstTbody)) {
    return false;
  }
  return Array.prototype.every.call(tr.childNodes, (n: Node) => (n as Element).nodeName === 'TH');
}

function blockLike(el: HTMLElement): boolean {
  return /^(ADDRESS|ARTICLE|ASIDE|AUDIO|BLOCKQUOTE|BODY|CANVAS|CENTER|DD|DETAILS|DIR|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|FRAMESET|H[1-6]|HEADER|HGROUP|HR|HTML|IFRAME|ISINDEX|LI|MAIN|MENU|NAV|NOFRAMES|NOSCRIPT|OL|OUTPUT|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL|VIDEO)$/.test(
    el.nodeName
  );
}

// X-19: inverse of encodeLinkPath (dom-utils.ts), which encodes each `/`-segment
// with encodeURIComponent. decodeURI (the old impl) leaves `; / ? : @ & = + $ , #`
// encoded by spec, so `Tài liệu R&D.md` stays `…R%26D.md` and never equals the
// bare-link text → serialized as `[](…)` instead of bare. Decode segment-wise
// with decodeURIComponent to match the encode; try/catch keeps a lone `%` safe.
function decodeSafe(s: string): string {
  try {
    return s
      .split('/')
      .map((seg) => decodeURIComponent(seg))
      .join('/');
  } catch {
    return s;
  }
}

// Unrecognized tag → keep its outerHTML (never bleed inner blank lines that
// would cut an html_block); non-string outerHTML → fall back to plain content.
// Shared by defaultReplacement/keepReplacement; the former adds its own SPAN guard.
function outerHtmlFallback(el: HTMLElement, content: string): string {
  if (typeof el.outerHTML !== 'string') {
    return content;
  }
  return blockLike(el) ? `\n\n${safeOuterHtml(el)}\n\n` : safeOuterHtml(el);
}

/**
 * Serialize one diagram frame (Mermaid / PlantUML) back to its fenced block.
 * Reads the source `<pre>` only — the toolbar and the rendered SVG in the chart
 * container are presentation, never part of the `.md`.
 */
function diagramFence(node: HTMLElement, spec: DiagramFrameSpec): string {
  return `\n\n${diagramSource(node, spec)}\n\n`;
}

/** The frame's fenced block on its own — also the raw-HTML path's source form. */
function diagramSource(node: HTMLElement, spec: DiagramFrameSpec): string {
  const code = node.querySelector(`.${spec.sourceClass} code`);
  const text = (code?.textContent ?? '').replace(/\n$/, '');
  const fence = pickFence(text);
  return `${fence}${spec.language}\n${text}\n${fence}`;
}

// Pick a code fence long enough that `text` cannot close it early.
function pickFence(text: string, fenceChar: '`' | '~' = '`'): string {
  let fence = fenceChar.repeat(3);
  if (fenceChar === '~') {
    // Only a line-start tilde run can close a fence — mid-line `~~~` is
    // harmless and must not grow the fence (byte churn on untouched blocks).
    for (const run of text.match(/^ {0,3}~{3,}\s*$/gm) ?? []) {
      const needed = run.trim().length + 1;
      if (needed > fence.length) {
        fence = fenceChar.repeat(needed);
      }
    }
  } else {
    while (text.includes(fence)) {
      fence += fenceChar;
    }
  }
  return fence;
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
