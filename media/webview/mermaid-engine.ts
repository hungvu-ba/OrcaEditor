/**
 * Standalone bundle entry for the Mermaid rendering engine (mermaid + its deps:
 * @mermaid-js/parser, cytoscape, cytoscape-fcose, dagre-d3-es, roughjs...).
 *
 * Why its own bundle instead of an import in main.ts: minified, this subtree is
 * ~2.8 MB — about 65% of what dist/webview/main.js used to weigh. Bundling it
 * there made every .md preview pay that download/parse cost even with zero
 * ```mermaid blocks in the document. It is built to
 * dist/webview/mermaid-engine.js and injected as a <script> tag by mermaid.ts,
 * the first time a ```mermaid block actually needs rendering — same pattern as
 * plantuml-engine.ts for @plantuml/core.
 *
 * Security: mermaid's default `securityLevel: 'strict'` (set in mermaid.ts's
 * initialize call) sanitizes label HTML, so no CSP relaxation is needed here —
 * it runs under the webview's existing `script-src 'nonce-...'`.
 */
import mermaid from 'mermaid';

export const initialize = mermaid.initialize.bind(mermaid);
export const render = mermaid.render.bind(mermaid);
