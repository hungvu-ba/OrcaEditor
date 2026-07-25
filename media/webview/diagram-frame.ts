/**
 * Shared vocabulary and helpers for "fenced code block rendered by an external
 * engine" frames — Mermaid (US-2.6) and PlantUML (US-2.8). Both wrap their fence
 * in the same chart⇄source structure, so the class names, the DOM wrapping
 * (dom-postprocess.ts) and the toolbar wiring live here once instead of being
 * copied per engine. Only the render call itself differs, and that stays in
 * mermaid.ts / plantuml.ts.
 *
 * Domino-safe: the spec constants and hashSource are pure, so dom-postprocess.ts
 * can import this module under Node for round-trip tests. The two functions that
 * touch browser globals are only ever CALLED from the webview-only controllers.
 */
import {
  MERMAID_CLASS,
  MERMAID_TOOLBAR_CLASS,
  MERMAID_TOGGLE_CLASS,
  MERMAID_ZOOM_CLASS,
  MERMAID_CHART_CLASS,
  MERMAID_SOURCE_CLASS,
  PLANTUML_CLASS,
  PLANTUML_TOOLBAR_CLASS,
  PLANTUML_TOGGLE_CLASS,
  PLANTUML_ZOOM_CLASS,
  PLANTUML_CHART_CLASS,
  PLANTUML_SOURCE_CLASS,
} from './render';

/** Everything that differs between one diagram engine's frame and another's. */
export interface DiagramFrameSpec {
  /** Fence info string, i.e. the `language-<x>` class markdown-it emits. */
  language: string;
  /** Human-readable engine name, used in button titles and the placeholder text. */
  label: string;
  /** Attribute holding the current view: 'chart' | 'code'. */
  viewAttr: string;
  wrapperClass: string;
  toolbarClass: string;
  toggleClass: string;
  zoomClass: string;
  chartClass: string;
  sourceClass: string;
}

export const MERMAID_FRAME: DiagramFrameSpec = {
  language: 'mermaid',
  label: 'Mermaid',
  viewAttr: 'data-mermaid-view',
  wrapperClass: MERMAID_CLASS,
  toolbarClass: MERMAID_TOOLBAR_CLASS,
  toggleClass: MERMAID_TOGGLE_CLASS,
  zoomClass: MERMAID_ZOOM_CLASS,
  chartClass: MERMAID_CHART_CLASS,
  sourceClass: MERMAID_SOURCE_CLASS,
};

export const PLANTUML_FRAME: DiagramFrameSpec = {
  language: 'plantuml',
  label: 'PlantUML',
  viewAttr: 'data-plantuml-view',
  wrapperClass: PLANTUML_CLASS,
  toolbarClass: PLANTUML_TOOLBAR_CLASS,
  toggleClass: PLANTUML_TOGGLE_CLASS,
  zoomClass: PLANTUML_ZOOM_CLASS,
  chartClass: PLANTUML_CHART_CLASS,
  sourceClass: PLANTUML_SOURCE_CLASS,
};

/** Hash chuỗi đơn giản (djb2) — không cần dependency ngoài. */
export function hashSource(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/**
 * bug_General #7: nền hiệu dụng của biểu đồ là do READING MODE quyết định (nếu
 * đang bật), KHÔNG chỉ theme VS Code. US-19.24: các mode màu (sepia/paper) đều
 * là nền SÁNG — không còn dark reading mode. Không có mode màu (standard/reading
 * off) → rơi về theme VS Code như cũ.
 */
export function isDarkBackground(): boolean {
  const cls = document.body.classList;
  for (const c of cls) {
    if (c.startsWith('reading-mode-')) {
      return false; // mọi reading mode màu (sepia/paper) là nền sáng
    }
  }
  return cls.contains('vscode-dark') || cls.contains('vscode-high-contrast');
}

/**
 * Chart container + current source text of one frame, or null when there is
 * nothing to render (no container, or an empty/whitespace-only source).
 */
export function readDiagramFrame(
  wrapper: HTMLElement,
  spec: DiagramFrameSpec
): { chart: HTMLElement; source: string } | null {
  const chart = wrapper.querySelector(`.${spec.chartClass}`) as HTMLElement | null;
  const code = wrapper.querySelector(`.${spec.sourceClass} code`) as HTMLElement | null;
  const source = code?.textContent ?? '';
  if (!chart || !source.trim()) {
    return null;
  }
  return { chart, source };
}

/**
 * Delegated toolbar wiring for one diagram engine's frames: the zoom button and
 * the chart⇄source toggle. `onZoom` receives the chart container and only fires
 * once it actually holds a rendered SVG — there is nothing to enlarge before
 * that. `onShowChart` fires only when the toggle lands back on 'chart', because
 * the source may have been hand-edited in code view and has to be re-rendered
 * from whatever it now says.
 */
export function initDiagramFrameToolbar(
  content: HTMLElement,
  spec: DiagramFrameSpec,
  handlers: { onZoom: (chart: HTMLElement) => void; onShowChart: (wrapper: HTMLElement) => void }
): void {
  // mousedown + preventDefault để không mất selection trong #content, giống các nút toolbar khác.
  content.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest(`.${spec.toggleClass}, .${spec.zoomClass}`)) {
      e.preventDefault();
    }
  });

  content.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const zoom = target.closest(`.${spec.zoomClass}`);
    if (zoom) {
      const wrapper = zoom.closest(`.${spec.wrapperClass}`) as HTMLElement | null;
      const chart = wrapper?.querySelector(`.${spec.chartClass}`) as HTMLElement | null;
      if (chart?.querySelector('svg')) {
        handlers.onZoom(chart);
      }
      return;
    }

    const toggle = target.closest(`.${spec.toggleClass}`);
    if (!toggle) {
      return;
    }
    const wrapper = toggle.closest(`.${spec.wrapperClass}`) as HTMLElement | null;
    if (!wrapper) {
      return;
    }
    const next = wrapper.getAttribute(spec.viewAttr) === 'chart' ? 'code' : 'chart';
    wrapper.setAttribute(spec.viewAttr, next);
    if (next === 'chart') {
      handlers.onShowChart(wrapper);
    }
  });
}
