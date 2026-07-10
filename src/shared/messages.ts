/**
 * C3: Hợp đồng type dùng chung cho kênh postMessage giữa extension host
 * (src/provider.ts, bundle Node) và webview (media/webview, bundle browser).
 *
 * Đây là NGUỒN SỰ THẬT DUY NHẤT về hình dạng message hai chiều. Cả hai đầu
 * `import type` từ file này (chỉ là type, esbuild xoá hết lúc bundle nên không
 * kéo code Node vào bundle browser và ngược lại). Đổi tên/field một đầu mà quên
 * đầu kia → compiler báo lỗi thay vì lệch âm thầm.
 */

/** Một gợi ý file trả về cho popup chèn link (kết quả searchWorkspaceFiles). */
export interface FileSuggestion {
  path: string;
  name: string;
  dir: string;
}

/**
 * Cấu hình render gửi kèm message `init`. Field & kiểu lấy đúng từ
 * provider.ts (case 'ready' → postMessage 'init').
 */
export interface InitConfig {
  breaks: boolean;
  linkify: boolean;
  wordWrap: boolean;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  autoOpenToc: boolean;
  showLineNumbers: boolean;
}

/** Message webview → host (discriminated theo `type`). */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'openLink'; href: string }
  | { type: 'searchFiles'; query: string; requestId: number }
  | { type: 'addToClaudeContext' }
  | { type: 'viewSource' };

/** Message host → webview (discriminated theo `type`). */
export type HostToWebview =
  | { type: 'init'; text: string; config: InitConfig }
  | { type: 'update'; text: string }
  | { type: 'fileSearchResult'; requestId: number; files: FileSuggestion[] };
