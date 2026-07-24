/**
 * Standalone bundle entry for the PlantUML rendering engine (@plantuml/core,
 * PlantUML compiled to JavaScript with TeaVM — MIT, no server, no Java).
 *
 * Why its own bundle instead of an import in main.ts: the engine is ~8.5 MB of
 * JavaScript. Bundling it into dist/webview/main.js would make every .md preview
 * pay that download/parse cost even when the document contains no diagram at all.
 * It is built to dist/webview/plantuml-engine.js and injected as a <script> tag
 * by plantuml.ts, the first time a ```plantuml block actually needs rendering.
 *
 * Security: the engine uses no eval/new Function, no WebAssembly and no Worker,
 * so it runs under the webview's existing CSP (script-src 'nonce-...') with no
 * relaxation. Rendering is fully local — no diagram source ever leaves the machine.
 */
import * as vizGlobal from '@plantuml/core/viz-global.js';
import { renderToString as coreRenderToString } from '@plantuml/core/plantuml.js';

/**
 * plantuml.js reaches the Graphviz layout engine through a BARE `Viz` global,
 * never an import — so that global has to exist before the first render.
 *
 * viz-global.js is a UMD. Because @plantuml/core declares "type": "module",
 * esbuild resolves it as ESM, where `exports`/`module`/`define` are all absent,
 * so the UMD falls through to its browser-global branch and assigns
 * `globalThis.Viz` itself. Do NOT overwrite it in that case: the module
 * namespace of an ESM-resolved UMD is empty, and assigning it unconditionally
 * clobbers the working global with `{}` (rendering then dies on
 * `Viz.instance is not a function`). The fallback below only covers the other
 * resolution mode, where the UMD would publish through the namespace instead.
 */
const globals = globalThis as unknown as Record<string, unknown>;
if (!globals.Viz) {
  const vizNamespace = vizGlobal as unknown as { default?: unknown };
  globals.Viz = vizNamespace.default ?? vizGlobal;
}

export { coreRenderToString as renderToString };
