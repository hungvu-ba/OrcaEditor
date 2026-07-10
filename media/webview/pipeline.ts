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
 *
 * Nội dung đã được tách theo trách nhiệm thành các module cùng thư mục
 * (finding C1); pipeline.ts giữ vai trò barrel re-export để mọi consumer
 * (main.ts, mermaid.ts, table.ts, gutter.ts, test/roundtrip.ts) tiếp tục
 * import từ './pipeline' mà không phải đổi đường dẫn:
 *  - render.ts             — MarkdownRenderer, cấu hình markdown-it, hằng số, kiểu.
 *  - dom-postprocess.ts     — postProcessMathDom, postProcessMermaidDom, extractTex.
 *  - dom-serialize-prep.ts  — prepareDomForSerialize & bộ chuẩn hóa DOM, fillSequenceColumn.
 *  - turndown.ts            — createTurndown + rule, normalizeMarkdown.
 *  - dom-portable.ts        — hasAncestor/getAncestor dùng chung.
 */
export * from './render';
export * from './dom-postprocess';
export * from './dom-serialize-prep';
export * from './turndown';
