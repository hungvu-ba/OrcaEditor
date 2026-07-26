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

/** Trễ trước khi quét lại broken-reference marker sau khi tài liệu render lại (broken-ref.ts, Req 20 US-20.9). */
export const BROKEN_REF_RECOMPUTE_DEBOUNCE_MS = 400;

/**
 * Ân hạn trước khi ẩn tooltip broken-reference khi chuột rời anchor (broken-ref.ts).
 * Cho phép chuột băng qua khe hở anchor↔tooltip để bấm "Search again →" mà popup
 * không biến mất; hủy nếu chuột vào tooltip hoặc quay lại anchor.
 */
export const BROKEN_REF_TOOLTIP_HIDE_GRACE_MS = 140;

/** Trễ giữa các phím gõ vào ô tìm "Search again" trước khi hỏi host tìm file lại (quick-correct.ts). */
export const QUICK_CORRECT_SEARCH_DEBOUNCE_MS = 200;

// --- Req 23 US-23.4: comment anchor re-resolution ---

/**
 * Delay before re-running the four anchor-resolution tiers after the document
 * re-renders (comment-resolve.ts). US-23.4 AC5 asks for "when the change
 * settles", explicitly not once per keystroke.
 */
export const ANCHOR_REEVAL_DEBOUNCE_MS = 250;

/**
 * Similarity score (0-1) at which tier 2 accepts a candidate (US-23.4, PO
 * decision 2026-07-26). A starting default, meant to be tuned from real usage.
 */
export const ANCHOR_SIMILARITY_THRESHOLD = 0.8;

/** Below this many characters the recorded text counts as "short" and must match more strictly (US-23.4). */
export const ANCHOR_SHORT_TEXT_LEN = 15;

/**
 * Upper bound on the strings tier 2's O(n·m) edit distance actually compares.
 * A whole-document anchor records the entire file, and the scan runs per
 * candidate per thread on every settled change; prose stops being any more
 * discriminating long before this cut.
 */
export const ANCHOR_MAX_COMPARE_CHARS = 512;

/**
 * Threshold for short text: a few characters coincidentally resemble unrelated
 * short strings elsewhere in the document, so a near-identical hit is required.
 */
export const ANCHOR_SHORT_TEXT_THRESHOLD = 0.95;

/**
 * Current anchor-resolution state of a node (`exact` | `approximate` |
 * `floating`). US-23.2 reads it to draw the pin/highlight, and it is how AC3's
 * "visibly marked as approximate" exists in the DOM. Session-only, stripped
 * before serialize by turndown.ts's TRANSIENT_ATTRS.
 */
export const COMMENT_ANCHOR_STATE_ATTR = 'data-comment-anchor-state';

/**
 * Marks the anchored node while the create composer is open, so it is obvious
 * what the comment attaches to. Shared with turndown.ts rather than kept local
 * to comment-menu.ts: a class written into `#content` survives the raw-HTML
 * serialization path unless that path is told to strip it, and a comment action
 * that reaches the `.md` is exactly the undo-stack slot US-23.6 forbids.
 */
export const COMMENT_ANCHOR_ACTIVE_CLASS = 'comment-anchor-active';

// --- Req 23 US-23.4 AC4: "Unresolved location" panel ---

/** Pointer travel before a mousedown on a card becomes a drag rather than a click. */
export const COMMENT_PANEL_DRAG_THRESHOLD_PX = 4;

/** How many ranked candidates the Re-attach… picker offers under "Suggested". */
export const COMMENT_PANEL_REATTACH_SUGGESTIONS = 3;

/** Characters of recorded/candidate text a one-line snippet keeps before eliding. */
export const COMMENT_PANEL_SNIPPET_CHARS = 60;

// --- Req 23 US-23.2: gutter pins, thread popover, inline highlight overlay ---

/**
 * CSS Custom Highlight API registration name for the comment-anchor overlay —
 * a 4th independent name alongside search.ts's 'search-match'/'search-current'
 * and select-highlight.ts's 'select-match', so an active comment highlight and
 * an active search-match highlight render as visually distinct, non-overriding
 * layers (design handoff: "one overlay technique, two independent registrations").
 */
export const COMMENT_HIGHLIGHT_NAME = 'comment-anchor';

/**
 * Gutter pins on lines within this many BLANK lines of each other collapse
 * into one "+N" cluster marker (design handoff: "Ln 7/9/11 sit inside the
 * cluster window"). A blank-line gap of 1 (i.e. consecutive or one blank line
 * apart) still clusters; two or more blank lines apart does not.
 */
export const COMMENT_GUTTER_CLUSTER_BLANK_GAP = 1;

/** DOM class for one gutter pin (single thread or resolved-muted). */
export const COMMENT_PIN_CLASS = 'comment-gutter-pin';
/** DOM class for a collapsed "+N" cluster pin. */
export const COMMENT_PIN_CLUSTER_CLASS = 'comment-gutter-pin-cluster';
/** DOM class for the thread popover, mounted on `document.body` (comment-panel.ts convention). */
export const COMMENT_POPOVER_CLASS = 'comment-popover';
/** DOM class for the popover's reply `<textarea>` — native field undo, not the document's (US-23.6 AC2). */
export const COMMENT_REPLY_INPUT_CLASS = 'comment-popover-reply-input';
/** DOM class for a delete-confirmation dialog, mounted on `document.body`. */
export const COMMENT_DELETE_CONFIRM_CLASS = 'comment-delete-confirm';
