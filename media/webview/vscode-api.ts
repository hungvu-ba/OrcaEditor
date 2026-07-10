/** Kiểu API webview VS Code cấp cho script (acquireVsCodeApi chỉ được gọi một lần). */
export interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): { scrollTop?: number } | undefined;
  setState(state: unknown): void;
}
