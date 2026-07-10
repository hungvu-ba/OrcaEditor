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
      const wrappers = Array.from(content.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}`));
      for (const wrapper of wrappers) {
        void renderDiagram(wrapper, { fallbackToCodeOnError: true });
      }
    },
  };
}

function isDarkTheme(): boolean {
  const cls = document.body.classList;
  return cls.contains('vscode-dark') || cls.contains('vscode-high-contrast');
}

async function renderDiagram(wrapper: HTMLElement, opts: { fallbackToCodeOnError?: boolean } = {}): Promise<void> {
  const chart = wrapper.querySelector(`.${MERMAID_CHART_CLASS}`) as HTMLElement | null;
  const code = wrapper.querySelector(`.${MERMAID_SOURCE_CLASS} code`) as HTMLElement | null;
  const source = code?.textContent ?? '';
  if (!chart || !source.trim()) {
    return;
  }
  const id = `md-mermaid-svg-${++idCounter}`;
  try {
    const { svg } = await mermaid.render(id, source);
    if (!wrapper.isConnected) {
      return; // tài liệu đã render lại trong lúc chờ — bỏ kết quả cũ, tránh ghi đè DOM mới
    }
    chart.innerHTML = svg;
    chart.classList.remove(ERROR_CLASS);
  } catch (err) {
    document.getElementById(id)?.remove(); // dọn sandbox mermaid tự chèn khi parse lỗi
    if (!wrapper.isConnected) {
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
