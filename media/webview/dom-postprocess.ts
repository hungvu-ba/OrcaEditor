/**
 * Hậu xử lý DOM sau khi render (chạy trên element đã gắn innerHTML):
 * bọc công thức KaTeX thành atom không chỉnh sửa được (lưu nguồn TeX) và bọc
 * khối ```mermaid``` thành khung có nút chuyển đổi biểu đồ ⇄ mã nguồn.
 *
 * Chỉ tạo cấu trúc DOM nên chạy được cả trên Node/domino cho round-trip test.
 */
import {
  LineRange,
  MATH_INLINE_CLASS,
  MATH_BLOCK_CLASS,
  MATH_TOOLBAR_CLASS,
  MATH_TOGGLE_CLASS,
  MATH_RENDER_CLASS,
  MERMAID_CLASS,
  MERMAID_TOOLBAR_CLASS,
  MERMAID_TOGGLE_CLASS,
  MERMAID_ZOOM_CLASS,
  MERMAID_CHART_CLASS,
  MERMAID_SOURCE_CLASS,
  MD_CODE_HEADER_CLASS,
  MD_CODE_LANG_CLASS,
  MD_CODE_COPY_CLASS,
  MD_CODE_WRAP_CLASS,
  MD_CODE_WRAPPED_CLASS,
  LINE_NUMBER_ATTR,
  LINE_NUMBER_END_ATTR,
  AUTOLINK_PATH_ATTR,
  EMPTY_LINK_ATTR,
  CAPTION_CLASS,
  CAPTION_PREFIX_CLASS,
  CAPTION_NS_CLASS,
  CAPTION_ID_CLASS,
  ENTITY_REF_CLASS,
} from './render';
import { hasAncestor } from './dom-portable';
import { encodeLinkPath } from './dom-utils';

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
    buildMathEditStructure(doc, wrapper, el, { toolbar: true });
  });
  const inlines = Array.from(root.querySelectorAll('.katex')).filter(
    (el) =>
      !hasAncestor(el, (a) => a.classList?.contains(MATH_BLOCK_CLASS) ?? false) &&
      !(el.classList?.contains('katex-display') ?? false)
  );
  for (const el of inlines) {
    if (hasAncestor(el, (a) => a.classList?.contains(MATH_INLINE_CLASS) ?? false)) {
      continue;
    }
    const tex = extractTex(el);
    const wrapper = doc.createElement('span');
    wrapper.className = MATH_INLINE_CLASS;
    wrapper.setAttribute('data-tex', tex);
    el.parentNode?.replaceChild(wrapper, el);
    buildMathEditStructure(doc, wrapper, el, { toolbar: false });
  }
}

/**
 * Dựng cấu trúc render + nút "Edit" bên trong `wrapper` (US-4.19, bug report
 * 2026-07-14 — thay cho toggle inline render⇄source của US-4.18: bug report
 * đó yêu cầu popup sửa TeX không đè lên công thức đang sửa + hướng dẫn ký tự,
 * nên không còn state "source" hiện tại chỗ cũ nữa — `.md-math-render`
 * (contenteditable=false, chứa `el` đã dựng KaTeX) luôn hiển thị, click nút
 * `.md-math-toggle` mở popup riêng (`media/webview/math-edit.ts`) thay vì lật
 * view tại chỗ. Mermaid (`postProcessMermaidDom` bên dưới) không đổi — vẫn
 * giữ nguyên toggle render⇄source tại chỗ vì có đủ chỗ hiển thị mã nguồn.
 *
 * Math BLOCK có toolbar riêng (đủ chỗ cho 1 hàng, giống Mermaid); Math INLINE
 * không có chỗ cho toolbar nên nút "Edit" nằm ngay trong dòng, ngay sau công
 * thức đã dựng (`toolbar: false`).
 */
// Toolbar `<div>` holding a single toggle `<button>` — the shared skeleton of
// the Math BLOCK toolbar and the Mermaid toolbar. Caller appends the returned
// toolbar where it wants (Math INLINE builds its own bare toggle instead, with
// no toolbar). Chained appendChild only — runs under domino for round-trip tests.
function createToolbarToggle(
  doc: Document,
  opts: { toolbarClass: string; toggleClass: string; title: string; toggleContentEditableFalse?: boolean }
): HTMLElement {
  const toggle = doc.createElement('button');
  toggle.setAttribute('type', 'button');
  toggle.className = opts.toggleClass;
  toggle.setAttribute('title', opts.title);
  if (opts.toggleContentEditableFalse) {
    toggle.setAttribute('contenteditable', 'false');
  }
  const toolbar = doc.createElement('div');
  toolbar.className = opts.toolbarClass;
  toolbar.setAttribute('contenteditable', 'false');
  toolbar.appendChild(toggle);
  return toolbar;
}

function buildMathEditStructure(doc: Document, wrapper: HTMLElement, renderedEl: Element, opts: { toolbar: boolean }): void {
  const isBlock = opts.toolbar;

  if (isBlock) {
    wrapper.appendChild(
      createToolbarToggle(doc, {
        toolbarClass: MATH_TOOLBAR_CLASS,
        toggleClass: MATH_TOGGLE_CLASS,
        title: 'Edit formula',
        toggleContentEditableFalse: true,
      })
    );
  }

  const renderWrap = doc.createElement(isBlock ? 'div' : 'span');
  renderWrap.className = MATH_RENDER_CLASS;
  renderWrap.setAttribute('contenteditable', 'false');
  renderWrap.appendChild(renderedEl);

  wrapper.appendChild(renderWrap);
  if (!isBlock) {
    // Math INLINE: bare toggle straight in the wrapper (no toolbar div). The
    // contenteditable=false on the button itself is essential here — without it
    // the "Edit" text inherits contenteditable=true from #content, so the
    // document caret/Enter can land inside the word "Edit" (bug report item 11,
    // recurs even with the US-4.19 TeX popup because this is the MAIN document
    // caret, not the formula-editor caret).
    const toggle = doc.createElement('button');
    toggle.setAttribute('type', 'button');
    toggle.className = MATH_TOGGLE_CLASS;
    toggle.setAttribute('title', 'Edit formula');
    toggle.setAttribute('contenteditable', 'false');
    wrapper.appendChild(toggle);
  }
}

export function extractTex(katexEl: Element): string {
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

    const toolbar = createToolbarToggle(doc, {
      toolbarClass: MERMAID_TOOLBAR_CLASS,
      toggleClass: MERMAID_TOGGLE_CLASS,
      title: 'Toggle between chart and Mermaid source',
    });

    // "Zoom" button opens the diagram in the fullscreen lightbox (bug_General #6).
    // Shown only in chart view (hidden via CSS when data-mermaid-view='code').
    // Domino has no ParentNode.append → use appendChild.
    const zoom = doc.createElement('button');
    zoom.setAttribute('type', 'button');
    zoom.className = MERMAID_ZOOM_CLASS;
    zoom.setAttribute('contenteditable', 'false');
    zoom.setAttribute('title', 'Zoom diagram');
    toolbar.appendChild(zoom);

    const chart = doc.createElement('div');
    chart.className = MERMAID_CHART_CLASS;
    chart.setAttribute('contenteditable', 'false');
    chart.textContent = 'Rendering Mermaid chart…';

    pre.classList.add(MERMAID_SOURCE_CLASS);
    pre.parentElement.replaceChild(wrapper, pre);
    wrapper.appendChild(toolbar);
    wrapper.appendChild(chart);
    wrapper.appendChild(pre);
  }
}

/**
 * code→display name for the code-block header label. Covers the insert-dropdown
 * languages (toolbar.ts CODE_BLOCK_DROPDOWN) + common aliases; an unknown token
 * falls back to its capitalized form, and a fence with no language → "Code".
 */
const CODE_LANG_DISPLAY: Record<string, string> = {
  javascript: 'JavaScript',
  js: 'JavaScript',
  typescript: 'TypeScript',
  ts: 'TypeScript',
  python: 'Python',
  py: 'Python',
  bash: 'Bash',
  sh: 'Bash',
  shell: 'Bash',
  json: 'JSON',
  html: 'HTML',
  xml: 'XML',
  css: 'CSS',
  sql: 'SQL',
  plaintext: 'Text',
  text: 'Text',
  txt: 'Text',
};

/** Read the `language-*` class off a <code> (same convention as turndown.ts). */
export function codeLangFromClass(code: Element): string | null {
  const cls = Array.from(code.classList).find((c) => c.startsWith('language-'));
  return cls ? cls.slice('language-'.length) : null;
}

export function codeLangDisplayName(lang: string | null): string {
  if (!lang) {
    return 'Code';
  }
  return CODE_LANG_DISPLAY[lang.toLowerCase()] ?? lang.charAt(0).toUpperCase() + lang.slice(1);
}

/**
 * Inject a persistent header bar (language label + "Copy" button) as the first
 * child INSIDE each fenced <pre>, before its <code> (Document Blocks item 8).
 * Placing it inside <pre> and outside <code> means gutter (top-level
 * content.children unchanged), drag-drop (top-level child stays <pre>), and
 * turndown serialize (fencedCodeWithLang reads only <code>) all keep working
 * with zero change. Header is contenteditable=false so the caret can't enter it.
 *
 * Skips mermaid/math source blocks (their <pre> lives inside a wrapper) and is
 * idempotent (skips a <pre> that already has a header). Must run AFTER
 * postProcessMermaidDom so mermaid's <pre> is already re-homed and skippable.
 *
 * DOM-only (createElement/insertBefore/appendChild — NO .append/innerHTML) so it
 * runs under Node/domino for round-trip tests too.
 */
export function postProcessCodeHeaders(root: ParentNode & Node, doc: Document): void {
  const codes = Array.from(root.querySelectorAll('pre > code'));
  for (const code of codes) {
    const pre = code.parentElement;
    if (!pre) {
      continue;
    }
    // Skip mermaid/math source (their <pre> was moved inside a wrapper).
    if (
      hasAncestor(code, (el) => {
        const cl = el.classList;
        return !!cl && (cl.contains(MERMAID_CLASS) || cl.contains(MATH_BLOCK_CLASS));
      })
    ) {
      continue;
    }
    // Idempotent: don't double-inject on a re-processed fragment.
    const prev = code.previousElementSibling;
    if (prev && prev.classList.contains(MD_CODE_HEADER_CLASS)) {
      continue;
    }

    const header = doc.createElement('div');
    header.className = MD_CODE_HEADER_CLASS;
    header.setAttribute('contenteditable', 'false');

    const label = doc.createElement('span');
    label.className = MD_CODE_LANG_CLASS;
    // US-4.28: the language label doubles as the in-place language switcher —
    // clicking it opens the same dropdown as the toolbar's code-block button
    // (wired via a delegated listener in main.ts). Marked as a button affordance;
    // stays inside the contenteditable=false header so it never places the caret.
    label.setAttribute('role', 'button');
    label.setAttribute('aria-haspopup', 'true');
    label.setAttribute('title', 'Change language');
    label.textContent = codeLangDisplayName(codeLangFromClass(code));

    // Wrap toggle — every fenced block is word-wrapped by default (MD_CODE_WRAPPED_CLASS
    // on the <pre>), the button flips it to horizontal scroll. UI-only state, never
    // serialized (turndown reads only <code>). Delegated click listener lives in main.ts.
    const wrapBtn = doc.createElement('button');
    wrapBtn.setAttribute('type', 'button');
    wrapBtn.className = MD_CODE_WRAP_CLASS;
    wrapBtn.setAttribute('contenteditable', 'false');
    wrapBtn.setAttribute('aria-pressed', 'true');
    wrapBtn.setAttribute('title', 'Toggle word wrap');
    wrapBtn.textContent = 'Wrap';
    pre.classList.add(MD_CODE_WRAPPED_CLASS);

    const copyBtn = doc.createElement('button');
    copyBtn.setAttribute('type', 'button');
    copyBtn.className = MD_CODE_COPY_CLASS;
    copyBtn.setAttribute('contenteditable', 'false');
    copyBtn.textContent = 'Copy';

    header.appendChild(label);
    header.appendChild(wrapBtn);
    header.appendChild(copyBtn);
    pre.insertBefore(header, code);
  }
}

/**
 * Wrap a bare relative file path written as plain text (e.g.
 * "../OrcaEditor-Requirements/Requirement - 20 Trigger-based Quick Actions.md")
 * in an <a> that DISPLAYS the file name (with extension); href = encoded path.
 * This is a DISPLAY-only transform: the original path string is kept verbatim in
 * AUTOLINK_PATH_ATTR so turndown serializes it back unchanged (see the
 * autolinkPath rule) → the .md file is not modified. Clicks are handled by the
 * existing <a> handler in main.ts (Cmd/Ctrl+Click → openLink; the host blocks
 * unsafe schemes + path traversal).
 *
 * Runs under Node/domino (round-trip tests): builds DOM with createElement/
 * insertBefore/removeChild only (NO .append/innerHTML — avoids the domino trap
 * and blocks HTML injection from paths with special characters).
 */
// Qualifying path: MUST start with "./" or "../" (one or more), then optional
// directory segments, then a file name ending in ".<ext>" (1–8 alnum, one or more
// extension segments so "archive.tar.gz" is kept whole) at a whitespace/closing-
// punctuation/end boundary. Requiring the ./|../ prefix keeps prose slash-idioms
// ("and/or logic.md"), dates ("12/25/2024.txt") and ratios ("1/2.5") from being
// linkified (bug #5 review — chosen over broad matching). The left boundary also
// accepts a leading opener ( [ { ' " so "(../foo.md)" links without swallowing "(".
// Directory segments exclude whitespace (the "/" delimiter is excluded from the
// class → no ambiguous splitting = ReDoS-safe); only the file-name segment allows
// spaces. Hard bounds {1,40}/{0,40}/{1,200} cap worst-case work on pathological input.
// safe-regex flags the nested quantifiers, but those hard bounds make the worst case
// a bounded polynomial, not exponential — the "redos" test (< 500ms on 5000 segments)
// in test/roundtrip/autolink-path.ts guards this.
const RELATIVE_PATH_RE =
  // eslint-disable-next-line security/detect-unsafe-regex
  /(?:^|(?<=[\s([{'"]))((?:\.\.?\/){1,40}(?:[^\s/<>"|]+\/){0,40}[^/<>"|\n]{1,200}?\.[A-Za-z0-9]{1,8}(?:\.[A-Za-z0-9]{1,8})*)(?=$|[\s)\]}.,;!?'"])/g;

/** true when the text node is inside a region that must NOT be linkified (existing link/code/atom). */
function inSkippedContext(node: Node): boolean {
  return hasAncestor(node, (el) => {
    const tag = el.nodeName;
    if (tag === 'A' || tag === 'CODE' || tag === 'PRE') {
      return true;
    }
    const cl = el.classList;
    return (
      !!cl &&
      (cl.contains(MATH_INLINE_CLASS) || cl.contains(MATH_BLOCK_CLASS) || cl.contains(MERMAID_CLASS) || cl.contains(CAPTION_CLASS))
    );
  });
}

function collectTextNodes(node: Node, out: Text[]): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3) {
      out.push(child as Text);
    } else if (child.nodeType === 1) {
      collectTextNodes(child, out);
    }
  }
}

export function postProcessRelativePathLinks(root: ParentNode & Node, doc: Document): void {
  const textNodes: Text[] = [];
  collectTextNodes(root, textNodes);
  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? '';
    if (!text.includes('/') || inSkippedContext(textNode)) {
      continue;
    }
    RELATIVE_PATH_RE.lastIndex = 0;
    let match = RELATIVE_PATH_RE.exec(text);
    if (!match) {
      continue;
    }
    const parent = textNode.parentNode;
    if (!parent) {
      continue;
    }
    // Replace the text node with an interleaved sequence: [text, <a>, text, <a>, ..., trailing text].
    let cursor = 0;
    do {
      const raw = match[1];
      const start = match.index + match[0].length - raw.length;
      if (start > cursor) {
        parent.insertBefore(doc.createTextNode(text.slice(cursor, start)), textNode);
      }
      const anchor = doc.createElement('a');
      anchor.setAttribute('href', encodeLinkPath(raw));
      anchor.setAttribute(AUTOLINK_PATH_ATTR, raw);
      anchor.textContent = raw.slice(raw.lastIndexOf('/') + 1);
      parent.insertBefore(anchor, textNode);
      cursor = start + raw.length;
      match = RELATIVE_PATH_RE.exec(text);
    } while (match);
    if (cursor < text.length) {
      parent.insertBefore(doc.createTextNode(text.slice(cursor)), textNode);
    }
    parent.removeChild(textNode);
  }
  markCodeSpanPathLinks(root);
}

/**
 * Inline code spans whose ENTIRE content is a single qualifying path (e.g.
 * `../OrcaEditor-Requirements/Requirement - 20 ....md` written in backticks) are
 * common for cross-references. Turn them into a link: stamp AUTOLINK_PATH_ATTR on
 * the <code> (the full path) and show only the file name (the click handler in
 * main.ts opens it; CSS gives it a link colour). The full path is preserved in the
 * attribute, and turndown's autolinkCodePath rule serializes the <code> back to
 * `<full-path>` from it → the .md is unchanged. A whole-span match only: partial
 * paths inside code are left alone (splitting a code span would corrupt both its
 * meaning and its round-trip). Fenced code (<pre>) and code already inside an <a>
 * are excluded.
 */
function markCodeSpanPathLinks(root: ParentNode & Node): void {
  const codes = Array.from(root.querySelectorAll('code'));
  for (const code of codes) {
    if (hasAncestor(code, (el) => el.nodeName === 'PRE' || el.nodeName === 'A')) {
      continue;
    }
    const raw = (code.textContent ?? '').trim();
    if (!raw.includes('/')) {
      continue;
    }
    RELATIVE_PATH_RE.lastIndex = 0;
    const match = RELATIVE_PATH_RE.exec(raw);
    if (match && match[1] === raw) {
      code.setAttribute(AUTOLINK_PATH_ATTR, raw);
      code.textContent = raw.slice(raw.lastIndexOf('/') + 1);
    }
  }
}

/** Matches `caption::` + a non-whitespace token — mirrors entity-index.ts's CAPTION_RE. */
const CAPTION_TOKEN_RE = /caption::(\S+)/g;
/** Leading Unicode-letter run of a caption token = its namespace — mirrors entity-index.ts's NAMESPACE_RE. */
const CAPTION_NAMESPACE_RE = /^\p{L}+/u;

/**
 * True when `token` is a validly-shaped `namespace+id` entity token — same
 * rule as entity-index.ts's parseEntities: namespace = the MAXIMAL leading
 * Unicode-letter run, id = whatever remains (invalid/rejected if empty, e.g.
 * an all-letters word like "readme" has no id half). Shared by
 * postProcessCaptions (below) and postProcessEntityRefs so both apply the
 * EXACT same validity rule, not two independently-drifting regexes.
 */
function isValidEntityToken(token: string): boolean {
  const nsMatch = CAPTION_NAMESPACE_RE.exec(token);
  return !!nsMatch && nsMatch[0].length < token.length;
}

/** True for any href with a URL scheme (`http:`, `https:`, `mailto:`, ...) — mirrors broken-ref.ts's hasUrlScheme (never an entity reference). */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Req 21 US-21.1 (bug_General Mention Declare #5/#6/#7): (re)build a
 * CAPTION_CLASS badge's inner structure from a validated `NS_ID` token (NO
 * `caption::` prefix — `token` is the m[1] half, e.g. `UC1`). Three child spans:
 *  - PREFIX: the literal `caption::` (kept in `textContent`, hidden via CSS) so
 *    `badge.textContent` stays exactly `caption::NS_ID` and turndown round-trips
 *    byte-identical.
 *  - NS: the leading Unicode-letter run (the namespace).
 *  - ID: the remaining value; the visible gap before it is CSS margin, never a
 *    space character.
 * Clears any existing children first, so caption-edit.ts can reuse it to rewrite
 * a badge in place after a value edit. Domino trap: appendChild, never append.
 */
export function fillCaptionBadge(badge: Element, token: string, doc: Document): void {
  while (badge.firstChild) {
    badge.removeChild(badge.firstChild);
  }
  const nsMatch = CAPTION_NAMESPACE_RE.exec(token);
  const namespace = nsMatch ? nsMatch[0] : '';
  const id = token.slice(namespace.length);
  const prefix = doc.createElement('span');
  prefix.className = CAPTION_PREFIX_CLASS;
  prefix.appendChild(doc.createTextNode('caption::'));
  const nsEl = doc.createElement('span');
  nsEl.className = CAPTION_NS_CLASS;
  nsEl.appendChild(doc.createTextNode(namespace));
  const idEl = doc.createElement('span');
  idEl.className = CAPTION_ID_CLASS;
  idEl.appendChild(doc.createTextNode(id));
  badge.appendChild(prefix);
  badge.appendChild(nsEl);
  badge.appendChild(idEl);
}

/**
 * Req 21 US-21.1: wrap every valid `caption::NS_ID` entity-declaration token
 * (namespace = leading Unicode-letter run, non-empty id remainder — same
 * validity rule as entity-index.ts's parseEntities, so a malformed token, e.g.
 * `caption::` with no letters or an empty id half, is left as plain text) into
 * a `.md-caption` solid-pill badge; its text split into hidden-prefix + ns + id
 * child spans by fillCaptionBadge, whose concatenated textContent stays the
 * literal token so turndown's default (no dedicated rule needed) serializes it
 * back byte-identical. Idempotent: `inSkippedContext` already skips text nested
 * inside an existing `.md-caption` (see its CAPTION_CLASS check above), so
 * calling this again on already-processed DOM (e.g. right after a live insert,
 * for instant pill feedback) never double-wraps.
 */
export function postProcessCaptions(root: ParentNode & Node, doc: Document): void {
  const textNodes: Text[] = [];
  collectTextNodes(root, textNodes);
  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? '';
    if (!text.includes('caption::') || inSkippedContext(textNode)) {
      continue;
    }
    const parent = textNode.parentNode;
    if (!parent) {
      continue;
    }
    CAPTION_TOKEN_RE.lastIndex = 0;
    const matches: Array<{ start: number; end: number; token: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = CAPTION_TOKEN_RE.exec(text)) !== null) {
      const token = m[1];
      if (!isValidEntityToken(token)) {
        continue; // no namespace letters, or empty id half — not a valid declaration.
      }
      matches.push({ start: m.index, end: m.index + m[0].length, token });
    }
    if (matches.length === 0) {
      continue;
    }
    let cursor = 0;
    for (const { start, end, token } of matches) {
      if (start > cursor) {
        parent.insertBefore(doc.createTextNode(text.slice(cursor, start)), textNode);
      }
      const badge = doc.createElement('span');
      badge.className = CAPTION_CLASS;
      // Non-editable atom (bug #6/#7): stops inline editing of the token and
      // stops Enter from splitting the badge / carrying its class onto the next
      // line. The click-to-edit popover (caption-edit.ts) is the edit path.
      badge.setAttribute('contenteditable', 'false');
      // Split display: hidden `caption::` + `NS value` (bug #5). textContent
      // stays `caption::NS_ID` for byte-identical round-trip.
      fillCaptionBadge(badge, token, doc);
      parent.insertBefore(badge, textNode);
      cursor = end;
    }
    if (cursor < text.length) {
      parent.insertBefore(doc.createTextNode(text.slice(cursor)), textNode);
    }
    parent.removeChild(textNode);
  }
}

/**
 * Req 21 US-21.3: mark every `<a>` that is an entity REFERENCE (not a
 * declaration) with ENTITY_REF_CLASS, so editor.css can paint it as the muted
 * pill variant of CAPTION_CLASS's solid badge. Detection is a structural
 * heuristic — no host round trip, no dependency on whether the target
 * actually exists (that is a separate, not-yet-built broken-reference concern
 * for entity refs): an entity reference is ALWAYS inserted (trigger-at.ts /
 * entity-scope.ts) as `[FULLID](path#FULLID)` — display text exactly equal to
 * the href's `#fragment`, and that fragment shaped like a valid entity token.
 * A class-only change (no DOM structure added inside the `<a>`) so turndown's
 * default `<a>` serialization is completely unaffected, same discipline as
 * BROKEN_REF_CLASS in broken-ref.ts.
 */
export function postProcessEntityRefs(root: ParentNode & Node): void {
  const anchors = Array.from((root as Element).querySelectorAll('a[href]')) as HTMLAnchorElement[];
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') ?? '';
    const hashIdx = href.indexOf('#');
    if (hashIdx === -1) {
      continue;
    }
    const fragment = href.slice(hashIdx + 1);
    const text = (anchor.textContent ?? '').trim();
    if (fragment && text === fragment && isValidEntityToken(fragment) && !URL_SCHEME_RE.test(href)) {
      anchor.classList.add(ENTITY_REF_CLASS);
    } else {
      anchor.classList.remove(ENTITY_REF_CLASS);
    }
  }
}

/** Decoded, display-friendly file name for an empty link's href (segment after the last `/`, percent-decoded; falls back to the raw href on a malformed sequence). */
function emptyLinkDisplayText(href: string): string {
  const name = href.slice(href.lastIndexOf('/') + 1) || href;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * An empty-text link `[](url)` renders as an empty `<a>` — in a list it shows as
 * a blank bullet the user can't see or click (bug_General #15). Fill any such
 * anchor with the decoded target file name as DISPLAY text and stamp
 * EMPTY_LINK_ATTR with the ORIGINAL href so turndown's `emptyLink` rule
 * serializes it back to `[](href)` unchanged (display-only, byte-faithful).
 *
 * Skips anchors that already carry content: any element child (e.g. an image
 * link `[![alt](img)](url)`) or non-blank text. Runs under Node/domino for the
 * round-trip test — sets textContent only (no `.append`/innerHTML).
 */
export function postProcessEmptyLinks(root: ParentNode & Node): void {
  const anchors = Array.from((root as Element).querySelectorAll('a[href]')) as HTMLAnchorElement[];
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') ?? '';
    if (!href || anchor.children.length > 0 || (anchor.textContent ?? '').trim() !== '') {
      continue;
    }
    anchor.setAttribute(EMPTY_LINK_ATTR, href);
    anchor.textContent = emptyLinkDisplayText(href);
  }
}
