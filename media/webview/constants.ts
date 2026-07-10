/**
 * Hằng số thời gian (ms) dùng chung cho webview (finding C9): debounce cho
 * chỉnh sửa nội dung / gõ vào ô nhập, trễ lưu trạng thái, và thời lượng tự ẩn
 * của các thành phần UI tạm thời. Gom về một chỗ để dễ chỉnh và tránh magic
 * number rải rác giữa các module.
 *
 * Lưu ý: đây là bundle của webview (esbuild gói riêng); KHÔNG import từ đây vào
 * src/provider.ts (Node, bundle khác).
 */

// --- Debounce phản ứng khi nội dung tài liệu thay đổi ---

/** Trễ trước khi serialize DOM → gửi 'edit' về host (main.ts). */
export const SYNC_DEBOUNCE_MS = 250;

/** Trễ trước khi dựng lại mục lục sau khi nội dung đổi (toc.ts). */
export const REBUILD_DEBOUNCE_MS = 250;

/** Trễ trước khi chạy lại tìm kiếm sau khi nội dung đổi (search.ts). */
export const REFRESH_DEBOUNCE_MS = 200;

// --- Debounce cho thao tác gõ vào ô nhập ---

/** Trễ giữa các phím gõ vào ô tìm kiếm trước khi chạy tìm (search.ts). */
export const INPUT_DEBOUNCE_MS = 120;

/** Trễ giữa các phím gõ vào ô @file trước khi hỏi host tìm file (prompt.ts). */
export const FILE_SEARCH_DEBOUNCE_MS = 200;

// --- Trễ lưu trạng thái ---

/** Trễ trước khi lưu vị trí cuộn vào webview state (main.ts). */
export const SCROLL_SAVE_DEBOUNCE_MS = 200;

// --- Thời lượng tự ẩn của UI tạm thời ---

/** Thời gian hiện thanh công cụ bảng trước khi tự ẩn (table.ts). */
export const TABLE_TOOLBAR_HIDE_MS = 3_000;

/** Thời gian hiện toast trước khi tự ẩn (dom-utils.ts). */
export const TOAST_DURATION_MS = 6_000;
