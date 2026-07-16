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
  MERMAID_CHART_CLASS,
  MERMAID_SOURCE_CLASS,
  LINE_NUMBER_ATTR,
  LINE_NUMBER_END_ATTR,
} from './render';
import { hasAncestor } from './dom-portable';

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
function buildMathEditStructure(doc: Document, wrapper: HTMLElement, renderedEl: Element, opts: { toolbar: boolean }): void {
  const isBlock = opts.toolbar;
  const toggle = doc.createElement('button');
  toggle.setAttribute('type', 'button');
  toggle.className = MATH_TOGGLE_CLASS;
  toggle.setAttribute('title', 'Edit formula');
  // contenteditable=false trên chính nút, không chỉ trên toolbar bao ngoài
  // (block): math INLINE gắn toggle thẳng vào wrapper (không có toolbar div
  // bọc ngoài, xem nhánh !isBlock bên dưới) nên nếu thiếu dòng này, text
  // "Edit" của nút kế thừa contenteditable=true từ #content — caret/Enter
  // vẫn lọt vào giữa chữ "Edit" được (bug report mục 11, tái hiện dù đã có
  // popup sửa TeX ở US-4.19, vì đây là caret của TÀI LIỆU chính, không phải
  // caret bên trong ô sửa công thức).
  toggle.setAttribute('contenteditable', 'false');

  if (isBlock) {
    const toolbar = doc.createElement('div');
    toolbar.className = MATH_TOOLBAR_CLASS;
    toolbar.setAttribute('contenteditable', 'false');
    toolbar.appendChild(toggle);
    wrapper.appendChild(toolbar);
  }

  const renderWrap = doc.createElement(isBlock ? 'div' : 'span');
  renderWrap.className = MATH_RENDER_CLASS;
  renderWrap.setAttribute('contenteditable', 'false');
  renderWrap.appendChild(renderedEl);

  wrapper.appendChild(renderWrap);
  if (!isBlock) {
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

    const toolbar = doc.createElement('div');
    toolbar.className = MERMAID_TOOLBAR_CLASS;
    toolbar.setAttribute('contenteditable', 'false');
    const toggle = doc.createElement('button');
    toggle.setAttribute('type', 'button');
    toggle.className = MERMAID_TOGGLE_CLASS;
    toggle.setAttribute('title', 'Toggle between chart and Mermaid source');
    toolbar.appendChild(toggle);

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
