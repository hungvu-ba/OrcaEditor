/**
 * Standalone bundle entry for the front-matter engine (js-yaml + smol-toml).
 *
 * Why its own bundle instead of an import in main.ts: the two parsers are
 * ~54 KB of dist/webview/main.js that only a document opening with a front
 * matter block needs (audit L-9, Performance Low-End — Audit.md). It is built
 * to dist/webview/front-matter-engine.js and injected as a <script> tag by
 * lazy-engines.ts the first time front matter needs parsing — same pattern as
 * mermaid-engine.ts.
 *
 * Security: runs under the webview's existing `script-src 'nonce-...'`, reusing
 * the page's scriptNonce; no CSP relaxation is needed.
 */
export { load } from 'js-yaml';
export { parse } from 'smol-toml';
