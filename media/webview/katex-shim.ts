/**
 * Stands in for `katex` inside main.js (esbuild webviewConfig alias), audit
 * L-9 (Performance Low-End — Audit.md): KaTeX itself lives in the lazily
 * loaded math-engine.js. Once that engine is loaded every call forwards to it.
 * Before that, and after a failed load, a call is recorded as a miss and
 * answered with a stand-in that still carries the TeX (the annotation
 * postProcessMathDom reads `data-tex` from) — never `''`, which would drop a
 * pasted formula from the `.md`.
 *
 * Unit / roundtrip / host bundles do not alias `katex`, so they keep the real one.
 */
import { escapeHtml } from './dom-utils';
import { lazyEngineApi, noteEngineMiss } from './lazy-engines';

export const MATH_FALLBACK_CLASS = 'katex-fallback';

interface MathEngineApi {
  renderToString(tex: string, options?: Record<string, unknown>): string;
}

export function renderToString(tex: string, options?: Record<string, unknown>): string {
  const engine = lazyEngineApi<MathEngineApi>('math');
  if (engine) {
    return engine.renderToString(tex, options);
  }
  noteEngineMiss('math');
  const escaped = escapeHtml(tex);
  const standIn =
    `<span class="katex ${MATH_FALLBACK_CLASS}"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics>` +
    `<annotation encoding="application/x-tex">${escaped}</annotation></semantics></math></span>` +
    `<span class="katex-html" aria-hidden="true">${escaped}</span></span>`;
  return options?.displayMode ? `<span class="katex-display">${standIn}</span>` : standIn;
}

// @vscode/markdown-it-katex reads require('katex').default.renderToString.
export default { renderToString };
