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
} from './pipeline';

export interface MermaidController {
  /** Dựng lại mọi biểu đồ Mermaid hiện có trong #content — gọi sau mỗi renderDocument. */
  renderAll(): void;
}

let idCounter = 0;

// Cache SVG theo hash nội dung source: nếu một biểu đồ có source không đổi thì
// tái dùng SVG đã dựng, khỏi render lại (mermaid.render khá nặng).
const svgCache = new Map<string, string>();

// Token tăng dần cho mỗi đợt render. Kết quả render async chỉ được ghi vào DOM
// nếu token của nó vẫn là mới nhất — tránh việc một kết quả cũ (đến muộn) ghi
// đè lên đợt render mới hơn.
let renderSeq = 0;

/** Hash chuỗi đơn giản (djb2) — không cần dependency ngoài. */
function hashSource(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export function initMermaid(content: HTMLElement): MermaidController {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDarkTheme() ? 'dark' : 'default',
  });

  // mousedown + preventDefault để không mất selection trong #content, giống các nút toolbar khác.
  content.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest(`.${MERMAID_TOGGLE_CLASS}`)) {
      e.preventDefault();
    }
  });

  content.addEventListener('click', (e) => {
    const toggle = (e.target as HTMLElement).closest(`.${MERMAID_TOGGLE_CLASS}`);
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

  return {
    renderAll(): void {
      const seq = ++renderSeq; // đánh dấu đợt render mới; kết quả cũ sẽ bị coi là stale
      const wrappers = Array.from(content.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}`));
      for (const wrapper of wrappers) {
        void renderDiagram(wrapper, { fallbackToCodeOnError: true, seq });
      }
    },
  };
}

function isDarkTheme(): boolean {
  const cls = document.body.classList;
  return cls.contains('vscode-dark') || cls.contains('vscode-high-contrast');
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

  // Cache hit: source không đổi → tái dùng SVG cũ, khỏi gọi mermaid.render (đồng bộ).
  const key = hashSource(source);
  const cached = svgCache.get(key);
  if (cached !== undefined) {
    chart.innerHTML = cached;
    chart.classList.remove(ERROR_CLASS);
    return;
  }

  const id = `md-mermaid-svg-${++idCounter}`;
  try {
    const { svg } = await mermaid.render(id, source);
    svgCache.set(key, svg); // lưu cache bất kể còn dùng được cho DOM hiện tại hay không
    if (!wrapper.isConnected || seq !== renderSeq) {
      return; // tài liệu đã render lại / có đợt render mới hơn — bỏ kết quả cũ, tránh ghi đè
    }
    chart.innerHTML = svg;
    chart.classList.remove(ERROR_CLASS);
  } catch (err) {
    document.getElementById(id)?.remove(); // dọn sandbox mermaid tự chèn khi parse lỗi
    if (!wrapper.isConnected || seq !== renderSeq) {
      return;
    }
    chart.classList.add(ERROR_CLASS);
    chart.textContent = `Không dựng được biểu đồ Mermaid: ${err instanceof Error ? err.message : String(err)}`;
    if (opts.fallbackToCodeOnError) {
      wrapper.setAttribute('data-mermaid-view', 'code');
    }
  }
}

const ERROR_CLASS = 'md-mermaid-error';
