/**
 * Dựng biểu đồ Mermaid cho các khung .md-mermaid (đã được postProcessMermaidDom
 * trong pipeline.ts bọc quanh khối ```mermaid```) và xử lý nút chuyển đổi
 * "biểu đồ ⇄ mã nguồn". Chỉ chạy trong webview — cần DOM trình duyệt thật để
 * mermaid dựng SVG (khác với phần bọc cấu trúc DOM ở pipeline.ts, chạy được
 * cả trên Node cho round-trip test).
 *
 * An toàn: securityLevel 'strict' (mặc định của mermaid) — sanitize nhãn HTML,
 * không cho diagram tự chèn script/click handler. Nội dung .md render ra từ
 * file người dùng có thể không đáng tin (mở từ đâu đó), nên không nới lỏng.
 */
import mermaid from 'mermaid';
import { MERMAID_CLASS, MERMAID_CHART_CLASS, MERMAID_SOURCE_CLASS } from './pipeline';
import { openLightbox } from './lightbox';
import { MERMAID_FRAME, hashSource, initDiagramFrameToolbar, isDarkBackground } from './diagram-frame';

export interface MermaidController {
  /** Dựng lại mọi biểu đồ Mermaid hiện có trong #content — gọi sau mỗi renderDocument. */
  renderAll(): void;
  /**
   * bug_General #7 / matrix G2: reading palette just changed → if the
   * theme+color signature (--rp-*) changed (background flipped light↔dark, or
   * same brightness but a different-colored palette), re-render every
   * diagram with the new theme/colors. No-op when the signature is unchanged
   * (cache is still valid) — cheap, avoids a flash when only preset/typography changed.
   */
  refreshTheme(): void;
}

let idCounter = 0;

// Cache SVG theo hash nội dung source: nếu một biểu đồ có source không đổi thì
// tái dùng SVG đã dựng, khỏi render lại (mermaid.render khá nặng).
const svgCache = new Map<string, string>();

// Token tăng dần cho mỗi đợt render. Kết quả render async chỉ được ghi vào DOM
// nếu token của nó vẫn là mới nhất — tránh việc một kết quả cũ (đến muộn) ghi
// đè lên đợt render mới hơn.
let renderSeq = 0;

// Theme+color signature (resolved --rp-*) of the last mermaid.initialize call.
// mermaid.initialize is global, so only call it again when the signature
// changes (bug_General #7, matrix G2): theme flips light↔dark, OR same
// brightness but a different-colored palette (e.g. sepia → paper). undefined = not yet init'd.
let lastColorSignature: string | undefined;

/**
 * Read the resolved --rp-* color tokens (matrix G2) — the diagram's color
 * source is the READING MODE, not the VS Code theme, same as isDarkBackground() above.
 */
function readPaletteColors(): { bg: string; fg: string; border: string; accent: string; elevBg: string } {
  const style = getComputedStyle(document.body);
  return {
    bg: style.getPropertyValue('--rp-bg').trim(),
    fg: style.getPropertyValue('--rp-fg').trim(),
    border: style.getPropertyValue('--rp-border').trim(),
    accent: style.getPropertyValue('--rp-accent').trim(),
    elevBg: style.getPropertyValue('--rp-elev-bg').trim(),
  };
}

/** Unique signature for the current theme + --rp-* color set — used as the cache/comparison key. */
function computeColorSignature(): {
  theme: 'default' | 'dark';
  colors: ReturnType<typeof readPaletteColors>;
  signature: string;
} {
  const theme: 'default' | 'dark' = isDarkBackground() ? 'dark' : 'default';
  const colors = readPaletteColors();
  const signature = `${theme}|${colors.bg}|${colors.fg}|${colors.border}|${colors.accent}|${colors.elevBg}`;
  return { theme, colors, signature };
}

/**
 * Ensure mermaid is using the theme + themeVariables that match the current
 * --rp-*; re-init when they change (theme flips light↔dark OR same brightness
 * but a different-colored palette — e.g. sepia → paper). Returns the current
 * color signature, used as the cache key.
 */
function ensureTheme(): string {
  const { theme, colors, signature } = computeColorSignature();
  if (signature !== lastColorSignature) {
    // getComputedStyle can hand back "" when a --rp-* chain bottoms out on an
    // unset host variable (e.g. --vscode-editor-background missing outside a
    // real VS Code webview) — mermaid.render throws on an empty color string,
    // so only override themeVariables it actually resolved to a real value;
    // otherwise let mermaid keep its own theme default for that slot.
    const themeVariables: Record<string, string> = {};
    if (colors.bg) themeVariables.background = colors.bg;
    if (colors.elevBg) themeVariables.primaryColor = colors.elevBg;
    if (colors.border) themeVariables.primaryBorderColor = colors.border;
    if (colors.accent) themeVariables.lineColor = colors.accent;
    if (colors.fg) themeVariables.textColor = colors.fg;
    if (colors.border) themeVariables.nodeBorder = colors.border;
    if (colors.elevBg) themeVariables.clusterBkg = colors.elevBg;

    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, themeVariables });
    lastColorSignature = signature;
  }
  return signature;
}

export function initMermaid(content: HTMLElement): MermaidController {
  // Theme được set khi render đầu tiên (ensureTheme, theo nền hiệu dụng lúc đó)
  // thay vì cứng ở đây — nền có thể do reading palette quyết định (bug_General #7).

  initDiagramFrameToolbar(content, MERMAID_FRAME, {
    // Zoom button: open the diagram in the fullscreen lightbox (bug_General #6).
    onZoom: (chart) => openLightbox({ kind: 'svg', svg: chart.innerHTML }),
    // Mã nguồn có thể vừa được sửa ở view code — dựng lại theo nội dung mới nhất.
    onShowChart(wrapper) {
      void renderDiagram(wrapper);
    },
  });

  function renderAll(): void {
    const seq = ++renderSeq; // đánh dấu đợt render mới; kết quả cũ sẽ bị coi là stale
    const wrappers = Array.from(content.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}`));
    for (const wrapper of wrappers) {
      void renderDiagram(wrapper, { fallbackToCodeOnError: true, seq });
    }
  }

  return {
    renderAll,
    refreshTheme(): void {
      // Only re-render when the --rp-* color signature actually changed (theme
      // flips light↔dark OR same brightness but a different-colored palette) —
      // otherwise the cached SVG (keyed by signature) is still correct, skip touching the DOM.
      if (computeColorSignature().signature !== lastColorSignature) {
        renderAll();
      }
    },
  };
}

async function renderDiagram(
  wrapper: HTMLElement,
  opts: { fallbackToCodeOnError?: boolean; seq?: number } = {},
): Promise<void> {
  const chart = wrapper.querySelector(`.${MERMAID_CHART_CLASS}`) as HTMLElement | null;
  const code = wrapper.querySelector(`.${MERMAID_SOURCE_CLASS} code`) as HTMLElement | null;
  const source = code?.textContent ?? '';
  if (!chart || !source.trim()) {
    return;
  }
  // Toggle thủ công (đổi view sang chart) không đi qua renderAll — cấp token mới
  // để nó trở thành đợt mới nhất và các kết quả cũ đang chờ bị coi là stale.
  const seq = opts.seq ?? ++renderSeq;

  // Ensure theme + --rp-* colors match the effective background and key the
  // cache by color signature (bug_General #7, matrix G2): same source but a
  // different theme/palette must be 2 different SVGs.
  const colorSignature = ensureTheme();

  // Cache hit: source + color signature unchanged → reuse the existing SVG instead of re-calling mermaid.render.
  const key = `${colorSignature}:${hashSource(source)}`;
  const cached = svgCache.get(key);
  if (cached !== undefined) {
    chart.innerHTML = cached;
    chart.classList.remove(ERROR_CLASS);
    return;
  }

  const id = `md-mermaid-svg-${++idCounter}`;
  try {
    const { svg } = await mermaid.render(id, source);
    if (!wrapper.isConnected || seq !== renderSeq) {
      return; // tài liệu đã render lại / có đợt render mới hơn — bỏ kết quả cũ, tránh ghi đè
    }
    // Only cache the SVG after passing the seq guard (bug_General #7 review):
    // theme/colors are a GLOBAL mermaid variable, and render is async. Caching
    // before the guard could let a stale pass (already pre-empted by a newer
    // pass with different colors) store an SVG under the wrong
    // `signature:hash` key → a later cache hit would then return the wrong colors.
    // A pass that clears the guard is guaranteed the newest, so its SVG matches its key's signature.
    svgCache.set(key, svg);
    chart.innerHTML = svg;
    chart.classList.remove(ERROR_CLASS);
  } catch (err) {
    document.getElementById(id)?.remove(); // dọn sandbox mermaid tự chèn khi parse lỗi
    if (!wrapper.isConnected || seq !== renderSeq) {
      return;
    }
    chart.classList.add(ERROR_CLASS);
    chart.textContent = `Failed to render Mermaid diagram: ${err instanceof Error ? err.message : String(err)}`;
    if (opts.fallbackToCodeOnError) {
      wrapper.setAttribute('data-mermaid-view', 'code');
    }
  }
}

const ERROR_CLASS = 'md-mermaid-error';
