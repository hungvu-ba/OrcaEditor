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
