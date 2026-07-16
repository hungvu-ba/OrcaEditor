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

// --- Lựa chọn văn bản (selection) ---

/** Ngưỡng độ dài tối thiểu (ký tự) để trigger highlight-khi-select (A) và icon tìm xuyên file (B). */
export const MIN_SELECT_LENGTH = 3;

/** Trễ trước khi hiện icon tìm xuyên file sau khi selection đứng yên (cross-file-search.ts). */
export const CROSS_FILE_ICON_DEBOUNCE_MS = 750;

/** Thời gian icon tìm xuyên file tự ẩn sau khi hiện, nếu user không hover/focus vào nó (cross-file-search.ts). */
export const ICON_AUTO_HIDE_MS = 3_000;

/**
 * Cửa sổ "ân hạn" ngay sau khi icon tìm xuyên file vừa hiện — bỏ qua sự kiện 'mouseenter' xảy ra
 * trong khoảng này (cross-file-search.ts). Icon luôn xuất hiện đúng ngay chỗ chuột vừa dừng lại
 * (cuối vùng chọn vừa kéo — xem positionBubble), nên chỉ cần rung tay nhẹ là 'mouseenter' bắn ra
 * ngay sau khi icon hiện, pause timer tự-ẩn 3s VĨNH VIỄN (chỉ resume khi mouseleave, mà chuột chưa
 * hề rời khỏi icon) — đây là nguyên nhân bug "icon không tự ẩn sau 3s" (C4 bug report #1).
 */
export const ICON_HOVER_GRACE_MS = 400;

/**
 * Throttle riêng cho việc dựng lại tick DOM của thước overview bên phải khi select
 * (select-highlight.ts, C1). CSS.highlights.set(...) (paint) rẻ nên KHÔNG bị throttle bởi hằng số
 * này, giữ nguyên tần suất mỗi requestAnimationFrame — chỉ phần dựng tick DOM +
 * getBoundingClientRect() mỗi match (đắt hơn) bị gộp về tối đa 1 lần mỗi khoảng này, kể cả khi
 * 'selectionchange' bắn liên tục lúc kéo chuột.
 */
export const SELECT_OVERVIEW_THROTTLE_MS = 150;

/** Số ký tự ngữ cảnh tối đa mỗi bên (trái/phải) quanh match trong snippet kết quả — cắt bằng "…" để match luôn nằm trong vùng nhìn thấy của popover, không bị `text-overflow: ellipsis` nuốt mất khi dòng gốc quá dài (cross-file-search.ts). */
export const SNIPPET_CONTEXT_CHARS = 40;

/** [US-15.9] Bề rộng popover kết quả tìm kiếm xuyên file — phải khớp `width` của `.cross-file-search-popover` (editor.css), dùng lại trong `positionPopover()` để clamp vị trí (cross-file-search.ts). */
export const CROSS_FILE_POPOVER_WIDTH_PX = 400;

/** [US-15.9] Trần chiều cao tuyệt đối (px) của popover, kết hợp với tỉ lệ viewport — phải khớp `max-height: min(70vh, …)` của `.cross-file-search-popover` (editor.css). */
export const CROSS_FILE_POPOVER_MAX_HEIGHT_CAP_PX = 560;

/** [US-15.9] Tỉ lệ chiều cao viewport dùng làm trần chiều cao popover — phải khớp phần `70vh` trong `max-height: min(70vh, …)` của `.cross-file-search-popover` (editor.css). */
export const CROSS_FILE_POPOVER_MAX_HEIGHT_VH_RATIO = 0.7;

/**
 * Trễ trước khi hover-preview 1 hàng trong dropdown Reading Mode thực sự áp
 * theme lên trang (toolbar.ts, US-19.18 follow-up). Không debounce thì rê
 * chuột lướt qua nhiều hàng liên tục làm cả trang đổi màu/typography tức thì
 * theo từng hàng — gây cảm giác nháy/choáng (bug report). Chỉ hàng con trỏ
 * DỪNG LẠI đủ lâu mới preview; lướt qua thì bỏ qua hẳn (không preview) thay vì
 * xếp hàng — mouseleave luôn huỷ timer + revert ngay lập tức, không debounce.
 */
export const READING_PREVIEW_DEBOUNCE_MS = 120;

// --- Chống trùng lặp xử lý sự kiện ---

/**
 * Cửa sổ chặn trùng (ms) khi lưu ảnh dán từ clipboard (paste-image.ts).
 * Cmd/Ctrl+V bắn 'keydown' (→ fallback Clipboard API) nhưng trong webview lồng
 * nhau của VS Code, 'paste' DOM event kèm đủ clipboardData ảnh vẫn có thể bắn
 * tiếp ngay sau đó — khác với text (hay thiếu clipboardData khi gõ phím tắt),
 * ảnh dường như luôn có mặt ở cả hai nơi, khiến cả hai đường cùng "tìm thấy
 * ảnh" và cùng lưu, tạo 2 file/2 link trùng nhau. Đường nào gọi requestSave
 * trước trong cửa sổ này thắng; đường còn lại coi như đã được xử lý, bỏ qua.
 */
export const PASTE_IMAGE_DEDUPE_MS = 500;
