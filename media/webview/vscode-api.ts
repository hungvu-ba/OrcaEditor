/** State webview được VS Code giữ lại khi tab ẩn/hiện. setState ghi đè cả object,
 * nên mỗi lần cập nhật một trường phải merge với getState() hiện tại. */
export interface WebviewState {
  scrollTop?: number;
  /** Bề rộng panel mục lục (px) do user kéo — nhớ giữa các lần mở tab. */
  tocWidth?: number;
  /** US-10.6: heading-level filter slider (1=H1, 2=H1–H2, 3=H1–H2–H3) — per-tab, nhớ giữa các lần mở tab. */
  tocMaxLevel?: 1 | 2 | 3;
}

/** Kiểu API webview VS Code cấp cho script (acquireVsCodeApi chỉ được gọi một lần). */
export interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
}
