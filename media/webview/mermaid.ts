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
import {
  MERMAID_CLASS,
  MERMAID_CHART_CLASS,
  MERMAID_SOURCE_CLASS,
  MERMAID_TOGGLE_CLASS,
  MERMAID_ZOOM_CLASS,
} from './pipeline';
import { openLightbox } from './lightbox';

export interface MermaidController {
  /** Dựng lại mọi biểu đồ Mermaid hiện có trong #content — gọi sau mỗi renderDocument. */
  renderAll(): void;
  /**
   * bug_General #7: reading palette vừa đổi → nếu nền hiệu dụng lật sáng↔tối thì
   * dựng lại mọi biểu đồ theo theme mới (default/dark). No-op khi độ sáng nền
   * không đổi (cache theo theme vẫn hợp lệ) — rẻ, tránh nháy khi chỉ đổi
   * preset/typography.
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

// Theme (default/dark) đã initialize lần gần nhất. mermaid.initialize là global
// nên chỉ gọi lại khi theme đổi (bug_General #7). undefined = chưa init.
let lastTheme: 'default' | 'dark' | undefined;

/**
 * bug_General #7: nền hiệu dụng của biểu đồ là do READING PALETTE quyết định
 * (nếu đang bật), KHÔNG chỉ theme VS Code. Chỉ palette `dark` là nền tối; mọi
 * palette khác (light/sepia/paper/highContrast) là nền sáng. Không có palette
 * (followTheme) → rơi về theme VS Code như cũ.
 */
function isDarkBackground(): boolean {
  const cls = document.body.classList;
  if (cls.contains('reading-palette-dark')) {
    return true;
  }
  for (const c of cls) {
    if (c.startsWith('reading-palette-')) {
      return false; // palette sáng bất kỳ (chỉ `dark` mới tối, đã bắt ở trên)
    }
  }
  return cls.contains('vscode-dark') || cls.contains('vscode-high-contrast');
}

/** Đảm bảo mermaid đang dùng theme khớp nền hiệu dụng; re-init khi đổi. Trả theme hiện dùng. */
function ensureTheme(): 'default' | 'dark' {
  const theme: 'default' | 'dark' = isDarkBackground() ? 'dark' : 'default';
  if (theme !== lastTheme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
    lastTheme = theme;
  }
  return theme;
}

/** Hash chuỗi đơn giản (djb2) — không cần dependency ngoài. */
function hashSource(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export function initMermaid(content: HTMLElement): MermaidController {
  // Theme được set khi render đầu tiên (ensureTheme, theo nền hiệu dụng lúc đó)
  // thay vì cứng ở đây — nền có thể do reading palette quyết định (bug_General #7).

  // mousedown + preventDefault để không mất selection trong #content, giống các nút toolbar khác.
  content.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest(`.${MERMAID_TOGGLE_CLASS}, .${MERMAID_ZOOM_CLASS}`)) {
      e.preventDefault();
    }
  });

  content.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Zoom button: open the diagram in the fullscreen lightbox (bug_General #6).
    const zoom = target.closest(`.${MERMAID_ZOOM_CLASS}`);
    if (zoom) {
      const wrapper = zoom.closest(`.${MERMAID_CLASS}`) as HTMLElement | null;
      const chart = wrapper?.querySelector(`.${MERMAID_CHART_CLASS}`) as HTMLElement | null;
      const svg = chart?.querySelector('svg');
      if (svg) {
        openLightbox({ kind: 'svg', svg: chart!.innerHTML });
      }
      return;
    }

    const toggle = target.closest(`.${MERMAID_TOGGLE_CLASS}`);
    if (!toggle) {
      return;
    }
    const wrapper = toggle.closest(`.${MERMAID_CLASS}`) as HTMLElement | null;
    if (!wrapper) {
      return;
    }
    const next = wrapper.getAttribute('data-mermaid-view') === 'chart' ? 'code' : 'chart';
    wrapper.setAttribute('data-mermaid-view', next);
    if (next === 'chart') {
      // Mã nguồn có thể vừa được sửa ở view code — dựng lại theo nội dung mới nhất.
      void renderDiagram(wrapper);
    }
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
      // Chỉ dựng lại khi độ sáng nền thực sự lật — nếu không, SVG trong cache
      // (khoá theo theme) vẫn đúng, khỏi đụng DOM.
      const theme: 'default' | 'dark' = isDarkBackground() ? 'dark' : 'default';
      if (theme !== lastTheme) {
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

  // Đảm bảo theme khớp nền hiệu dụng và khoá cache theo theme (bug_General #7):
  // cùng source nhưng khác theme phải là 2 SVG khác nhau.
  const theme = ensureTheme();

  // Cache hit: source + theme không đổi → tái dùng SVG cũ, khỏi gọi mermaid.render.
  const key = `${theme}:${hashSource(source)}`;
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
    // Chỉ cache SVG sau khi thắng seq guard (bug_General #7 review): theme là 1
    // biến GLOBAL của mermaid, mà render bất đồng bộ. Nếu cache trước guard, một
    // đợt cũ (đã bị đợt mới có theme khác chen ngang) có thể lưu SVG lệch theme
    // dưới khoá `theme:hash` của nó → lần sau cache hit trả về biểu đồ sai theme.
    // Đợt đã qua guard chắc chắn là mới nhất nên SVG khớp theme của khoá.
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
