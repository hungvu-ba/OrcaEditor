/**
 * Standalone bundle entry for the math engine (KaTeX).
 *
 * Why its own bundle instead of an import in main.ts: KaTeX is ~270 KB of
 * dist/webview/main.js that only a document holding `$...$` needs (audit L-9,
 * Performance Low-End — Audit.md). It is built to dist/webview/math-engine.js
 * (esbuild aliases `katex` to katex.mjs, the same build main.js uses) and
 * injected as a <script> tag by lazy-engines.ts the first time a formula needs
 * rendering — same pattern as mermaid-engine.ts.
 *
 * Security: runs under the webview's existing `script-src 'nonce-...'`, reusing
 * the page's scriptNonce; no CSP relaxation is needed.
 */
export { renderToString } from 'katex';
