import type { WebviewToHost } from '../../src/shared/messages';

/** State webview được VS Code giữ lại khi tab ẩn/hiện. setState ghi đè cả object,
 * nên mỗi lần cập nhật một trường phải merge với getState() hiện tại. */
export interface WebviewState {
  scrollTop?: number;
  /** Bề rộng panel mục lục (px) do user kéo — nhớ giữa các lần mở tab. */
  tocWidth?: number;
  /** US-10.6: heading-level filter slider (1=H1, 2=H1–H2, 3=H1–H2–H3) — per-tab, nhớ giữa các lần mở tab. */
  tocMaxLevel?: 1 | 2 | 3;
  /** US-23.7: id of the selected right-dock tab — same scope as tocWidth (per webview panel). */
  rightDockTab?: string;
}

/** Kiểu API webview VS Code cấp cho script (acquireVsCodeApi chỉ được gọi một lần). */
export interface VsCodeApi {
  /**
   * Typed as the real contract, not `unknown`: most modules call this directly
   * rather than through a `postToHost` wrapper, and while the parameter was
   * `unknown` none of those call sites were checked against `WebviewToHost` at
   * all — a message could be posted with a `type` the union never declared and
   * `tsc` would say nothing. This is the compiler half of the routing guard in
   * `test/unit.ts` (which covers the other half: a declared, posted type with no
   * `case` in provider.ts, something no type can express).
   */
  postMessage(msg: WebviewToHost): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
}
