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
  FRONT_MATTER_CLASS,
  MATH_INLINE_CLASS,
  MATH_BLOCK_CLASS,
  MERMAID_CLASS,
  MERMAID_SOURCE_CLASS,
} from './render';
import { hasAncestor, getAncestor } from './dom-portable';
import { tableNeedsHtmlSerialization } from './dom-serialize-prep';
import {
  HEADING_STYLE_ATTR,
  BULLET_STYLE_ATTR,
  CODE_STYLE_ATTR,
  EM_STYLE_ATTR,
  STRONG_STYLE_ATTR,
  HR_STYLE_ATTR,
} from './block-style';

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
      const fence = pickFence(text);
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
 * gutter line numbers, and the US-18.4 per-block style attributes — all
 * stamped on live DOM or the serialize clone, none of them document content.
 */
const TRANSIENT_ATTRS = [
  'data-block-id',
  'data-line',
  'data-line-end',
  HEADING_STYLE_ATTR,
  BULLET_STYLE_ATTR,
  CODE_STYLE_ATTR,
  EM_STYLE_ATTR,
  STRONG_STYLE_ATTR,
  HR_STYLE_ATTR,
];

function safeOuterHtml(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const attr of TRANSIENT_ATTRS) {
    copy.removeAttribute(attr);
    for (const child of Array.from(copy.querySelectorAll(`[${attr}]`))) {
      child.removeAttribute(attr);
    }
  }
  return collapseBlankLines(copy.outerHTML);
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

// Unrecognized tag → keep its outerHTML (never bleed inner blank lines that
// would cut an html_block); non-string outerHTML → fall back to plain content.
// Shared by defaultReplacement/keepReplacement; the former adds its own SPAN guard.
function outerHtmlFallback(el: HTMLElement, content: string): string {
  if (typeof el.outerHTML !== 'string') {
    return content;
  }
  return blockLike(el) ? `\n\n${safeOuterHtml(el)}\n\n` : safeOuterHtml(el);
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
