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
