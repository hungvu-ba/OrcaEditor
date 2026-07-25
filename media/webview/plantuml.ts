/**
 * US-2.8: dựng biểu đồ PlantUML cho các khung .md-plantuml (đã được
 * postProcessPlantumlDom trong pipeline.ts bọc quanh khối ```plantuml```) và xử
 * lý nút "biểu đồ ⇄ mã nguồn" + "zoom". Chỉ chạy trong webview.
 *
 * Khác Mermaid ở hai điểm, phần còn lại dùng chung qua diagram-frame.ts:
 *
 * 1. Engine nạp LƯỜI. @plantuml/core nặng ~8.5 MB nên nó nằm ở bundle riêng
 *    (dist/webview/plantuml-engine.js) và chỉ được chèn <script> khi tài liệu
 *    thực sự có khối plantuml đầu tiên cần dựng — file .md không có biểu đồ nào
 *    không phải trả giá gì. Script cần nonce của trang mới qua được CSP, nên
 *    host gửi kèm `plantumlEngineUri` + `scriptNonce` trong message 'init'.
 * 2. API là callback (`renderToString(lines, onSuccess, onError)`), không phải
 *    Promise — bọc lại thành Promise ngay dưới đây để phần điều phối
 *    (cache + chống kết quả đến muộn) giống hệt mermaid.ts.
 *
 * Bảo mật: engine dựng hình hoàn toàn cục bộ, không gọi mạng — nội dung biểu đồ
 * không rời khỏi máy. Nó có dùng WebAssembly (Viz.js = Graphviz qua Emscripten,
 * .wasm nhúng sẵn dạng base64), nên CSP có `'wasm-unsafe-eval'` (xem provider.ts).
 */
import { PLANTUML_CLASS } from './pipeline';
import { openLightbox } from './lightbox';
import {
  PLANTUML_FRAME,
  hashSource,
  initDiagramFrameToolbar,
  isDarkBackground,
  readDiagramFrame,
} from './diagram-frame';

export interface PlantumlController {
  /** Dựng lại mọi biểu đồ PlantUML hiện có trong #content — gọi sau mỗi renderDocument. */
  renderAll(): void;
  /**
   * Nền sáng/tối vừa đổi (theme VS Code hoặc reading palette) → dựng lại để
   * biểu đồ khớp nền mới. No-op nếu nền hiệu dụng không đổi: cache (đánh khoá
   * kèm cờ dark) vẫn đúng, khỏi đụng vào DOM.
   */
  refreshTheme(): void;
}

/** Hình dạng global do dist/webview/plantuml-engine.js công bố khi nạp xong. */
interface PlantumlEngine {
  renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void
  ): void;
}

const ERROR_CLASS = 'md-plantuml-error';

// Cache SVG theo (cờ nền) + hash nội dung source — cùng một source nhưng nền
// sáng/tối khác nhau là 2 SVG khác nhau.
const svgCache = new Map<string, string>();

// Token tăng dần cho mỗi đợt render. Kết quả async chỉ được ghi vào DOM nếu
// token của nó vẫn là mới nhất — tránh kết quả cũ đến muộn ghi đè đợt mới hơn.
let renderSeq = 0;

// Cờ nền của lần dựng gần nhất, để refreshTheme biết có cần dựng lại không.
let lastDark: boolean | undefined;

let engineConfig: { engineUri: string; scriptNonce: string } | undefined;

/**
 * Nạp engine đúng MỘT lần cho cả phiên webview. Trả về cùng một Promise cho mọi
 * lời gọi sau đó — kể cả khi đang nạp dở, nhiều biểu đồ cùng lúc vẫn chỉ chèn 1
 * thẻ <script>. Nếu nạp hỏng, Promise reject và lần gọi sau sẽ thử lại từ đầu
 * (xoá biến nhớ) thay vì kẹt vĩnh viễn ở trạng thái hỏng.
 */
let enginePromise: Promise<PlantumlEngine> | undefined;

function loadEngine(): Promise<PlantumlEngine> {
  if (enginePromise) {
    return enginePromise;
  }
  enginePromise = new Promise<PlantumlEngine>((resolve, reject) => {
    if (!engineConfig) {
      reject(new Error('PlantUML engine location was not provided by the host'));
      return;
    }
    const existing = (window as unknown as { OrcaPlantumlEngine?: PlantumlEngine }).OrcaPlantumlEngine;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement('script');
    script.src = engineConfig.engineUri;
    // CSP: script-src chỉ nhận script mang đúng nonce của trang.
    script.nonce = engineConfig.scriptNonce;
    script.addEventListener('load', () => {
      const engine = (window as unknown as { OrcaPlantumlEngine?: PlantumlEngine }).OrcaPlantumlEngine;
      if (engine) {
        resolve(engine);
      } else {
        reject(new Error('PlantUML engine loaded but exposed no renderer'));
      }
    });
    script.addEventListener('error', () => reject(new Error('Failed to load the PlantUML engine')));
    document.head.appendChild(script);
  });
  enginePromise.catch(() => {
    enginePromise = undefined; // cho phép thử lại ở lần render sau
  });
  return enginePromise;
}

// Engine PlantUML (TeaVM) dựng ĐƠN LUỒNG: gọi renderToString khi một lần dựng
// trước chưa xong sẽ giẫm chân nhau — chỉ callback của lời gọi cuối cùng chạy,
// các lời gọi kia treo vĩnh viễn. renderAll bắn tất cả biểu đồ cùng lúc, nên
// phải XẾP HÀNG: mỗi lần dựng chờ lần trước kết thúc rồi mới gọi engine.
let renderChain: Promise<unknown> = Promise.resolve();

/** Bọc API callback của engine thành Promise, nối vào hàng đợi dựng đơn luồng. */
function renderSvg(engine: PlantumlEngine, source: string): Promise<string> {
  const run = renderChain.then(
    () =>
      new Promise<string>((resolve, reject) => {
        engine.renderToString(
          source.split(/\r\n|\r|\n/),
          (svg) => resolve(svg),
          (message) => reject(new Error(message))
        );
      })
  );
  // Nuốt lỗi ở nhánh giữ chuỗi (không phải nhánh trả về): một lần dựng lỗi vẫn
  // để lần kế tiếp trong hàng đợi chạy, thay vì kẹt cả chuỗi.
  renderChain = run.catch(() => undefined);
  return run;
}

export function initPlantuml(content: HTMLElement): PlantumlController {
  initDiagramFrameToolbar(content, PLANTUML_FRAME, {
    // canvas:'light' — engine dựng nét đen trên nền trong suốt, cần nền sáng để
    // đọc được trên lớp phủ tối của lightbox (xem CSS #md-lightbox-stage).
    onZoom: (chart) => openLightbox({ kind: 'svg', svg: chart.innerHTML, canvas: 'light' }),
    onShowChart(wrapper) {
      // Mã nguồn có thể vừa được sửa ở view code — dựng lại theo nội dung mới nhất.
      void renderDiagram(wrapper);
    },
  });

  function renderAll(): void {
    const wrappers = Array.from(content.querySelectorAll<HTMLElement>(`.${PLANTUML_CLASS}`));
    if (wrappers.length === 0) {
      return; // không có biểu đồ nào → không đụng tới engine, đúng tinh thần lazy-load
    }
    const seq = ++renderSeq;
    for (const wrapper of wrappers) {
      void renderDiagram(wrapper, { fallbackToCodeOnError: true, seq });
    }
  }

  return {
    renderAll,
    refreshTheme(): void {
      if (isDarkBackground() !== lastDark) {
        renderAll();
      }
    },
  };
}

/** Nhận cấu hình engine từ message 'init' của host (xem provider.ts, InitConfig). */
export function setPlantumlEngineConfig(config: { engineUri: string; scriptNonce: string }): void {
  engineConfig = config;
}

async function renderDiagram(
  wrapper: HTMLElement,
  opts: { fallbackToCodeOnError?: boolean; seq?: number } = {}
): Promise<void> {
  const frame = readDiagramFrame(wrapper, PLANTUML_FRAME);
  if (!frame) {
    return;
  }
  const { chart, source } = frame;
  // Toggle thủ công (đổi view sang chart) không đi qua renderAll — cấp token mới
  // để nó trở thành đợt mới nhất và các kết quả cũ đang chờ bị coi là stale.
  const seq = opts.seq ?? ++renderSeq;

  const dark = isDarkBackground();
  lastDark = dark;
  const key = `${dark ? 'dark' : 'light'}:${hashSource(source)}`;
  const cached = svgCache.get(key);
  if (cached !== undefined) {
    chart.innerHTML = cached;
    chart.classList.remove(ERROR_CLASS);
    return;
  }

  try {
    const engine = await loadEngine();
    const svg = await renderSvg(engine, source);
    if (!wrapper.isConnected || seq !== renderSeq) {
      return; // tài liệu đã render lại / có đợt mới hơn — bỏ kết quả cũ
    }
    // Chỉ cache SAU khi qua được cửa seq (giống mermaid.ts): một đợt đã bị đợt
    // mới hơn chiếm chỗ có thể đang mang cờ nền cũ, cache nó sẽ trả sai màu về sau.
    svgCache.set(key, svg);
    chart.innerHTML = svg;
    chart.classList.remove(ERROR_CLASS);
  } catch (err) {
    if (!wrapper.isConnected || seq !== renderSeq) {
      return;
    }
    chart.classList.add(ERROR_CLASS);
    chart.textContent = `Failed to render PlantUML diagram: ${err instanceof Error ? err.message : String(err)}`;
    if (opts.fallbackToCodeOnError) {
      wrapper.setAttribute(PLANTUML_FRAME.viewAttr, 'code');
    }
  }
}
