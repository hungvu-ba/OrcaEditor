/** State webview được VS Code giữ lại khi tab ẩn/hiện. setState ghi đè cả object,
 * nên mỗi lần cập nhật một trường phải merge với getState() hiện tại. */
export interface WebviewState {
  scrollTop?: number;
  /** Bề rộng panel mục lục (px) do user kéo — nhớ giữa các lần mở tab. */
  tocWidth?: number;
}

/** Kiểu API webview VS Code cấp cho script (acquireVsCodeApi chỉ được gọi một lần). */
export interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
}
