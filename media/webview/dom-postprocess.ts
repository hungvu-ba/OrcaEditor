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
  LINE_NUMBER_ATTR,
  LINE_NUMBER_END_ATTR,
  AUTOLINK_PATH_ATTR,
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
    return !!cl && (cl.contains(MATH_INLINE_CLASS) || cl.contains(MATH_BLOCK_CLASS) || cl.contains(MERMAID_CLASS));
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
