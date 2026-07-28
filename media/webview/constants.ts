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
 * Req 23 US-23.11 AC3: the drift check's OWN retention bands, deliberately
 * independent of tier 2's relocation thresholds above.
 *
 * Retention is one-directional — how much of the recorded snapshot is still
 * present — so text typed into the paragraph after the comment was written never
 * lowers it. Drift should be suggested well before relocation would fail, hence
 * a band far stricter than tier 2's 0.8.
 *
 * The pair is a hysteresis band, not a single line: drift is entered below
 * ENTER and only left again at or above EXIT, so a retention hovering at the
 * boundary cannot flicker the strip on and off across single keystrokes.
 */
export const DRIFT_RETENTION_ENTER = 0.9;
export const DRIFT_RETENTION_EXIT = 0.95;

/**
 * The same band for short recorded text (below `ANCHOR_SHORT_TEXT_LEN`), where
 * tier 2's stricter 0.95 would be backwards: one character edited in a ten-
 * character heading is not the "text may have changed" case the strip exists
 * for, while half a short heading rewritten is.
 */
export const DRIFT_SHORT_RETENTION_ENTER = 0.6;
export const DRIFT_SHORT_RETENTION_EXIT = 0.75;

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

// --- Req 24 US-23.8: launch-load resolve pass (AC1, AC6, AC7) ---

/**
 * A `syncAll` reload seeding more new threads than this runs the chunked load
 * pass (`ANCHOR_RESOLVE_CHUNK_SIZE` per tick) instead of one synchronous
 * sweep, so a heavily-commented file's first paint is never blocked. Below
 * it, resolution stays the existing single-pass behavior other call sites
 * (a fresh `register`, the debounced `refresh`) already rely on.
 */
export const ANCHOR_LOAD_BATCH_THRESHOLD = 30;

/** Threads resolved per tick once the chunked load pass (above) is running. */
export const ANCHOR_RESOLVE_CHUNK_SIZE = 25;

/**
 * Req 24 US-23.8 AC3(i): how long `comment-popover.ts` waits for a reply's
 * `replyResult` before giving up and releasing the in-flight guard (host busy,
 * panel disposed, message dropped). Same bound the create path's sibling guard
 * (US-23.10 AC6, not yet built) is meant to use — a default, not a proven
 * constant.
 */
export const COMMENT_REPLY_RESULT_TIMEOUT_MS = 10_000;

/**
 * Req 24 US-23.12 AC2: how long the Comment tab waits for a
 * `copyCommentsAsMarkdownResult`/reply before releasing the in-flight guard
 * (host busy, panel disposed, message dropped). Same shape as the constant
 * above.
 */
export const COMMENT_COPY_MARKDOWN_TIMEOUT_MS = 10_000;

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
 * Req 24 US-23.8 AC2: a SEPARATE registration for a non-exact (tier 3
 * `approximate`) anchor's wash — the Custom Highlight API styles one whole
 * registration at a time, so telling exact and approximate apart needs its
 * own name, not a class on the (non-existent) highlighted element. A
 * `floating` anchor has no live carrier at all (tier 4: `carrier` is
 * `undefined`), so it was never in the highlighted set on either name —
 * unchanged by this story, not a gap it needs to close.
 */
export const COMMENT_HIGHLIGHT_NONEXACT_NAME = 'comment-anchor-nonexact';

/**
 * Req 24 US-23.8 AC5: independent registrations for the single thread whose
 * popover is currently open — driven solely by that fact, never by the "Show
 * Comments" toggle or the thread's status, so they never share a `Highlight`
 * object with the toggle-gated exact/non-exact buckets above. Split into an
 * exact/non-exact pair, same as the toggle buckets, so AC2's "never silently
 * indistinguishable from an exact anchor" still holds for the active thread
 * even with the toggle off (where the toggle buckets draw nothing at all).
 * Named distinctly from the unrelated `.comment-anchor-active` DOM class
 * (the composer's "anchor stays lit while composing" style, editor.css) —
 * same neighbourhood, different mechanism (Highlight registration vs. class).
 */
export const COMMENT_HIGHLIGHT_ACTIVE_NAME = 'comment-anchor-open';
export const COMMENT_HIGHLIGHT_ACTIVE_NONEXACT_NAME = 'comment-anchor-open-nonexact';

/** DOM class for one gutter pin (single thread or resolved-muted). */
export const COMMENT_PIN_CLASS = 'comment-gutter-pin';
/** DOM class for a collapsed "+N" cluster pin. */
export const COMMENT_PIN_CLUSTER_CLASS = 'comment-gutter-pin-cluster';
/**
 * Req 24 US-23.8 AC2: marks a pin (or a cluster whose threads are ALL
 * non-exact) whose anchor resolved at tier 3/4 (`approximate`/`floating`),
 * paired with an icon/label in CSS — never colour alone.
 */
export const COMMENT_PIN_NONEXACT_CLASS = 'comment-gutter-pin-nonexact';
/** DOM class for the thread popover, mounted on `document.body` (comment-panel.ts convention). */
export const COMMENT_POPOVER_CLASS = 'comment-popover';
/** DOM class for the popover's reply `<textarea>` — native field undo, not the document's (US-23.6 AC2). */
export const COMMENT_REPLY_INPUT_CLASS = 'comment-popover-reply-input';
/** DOM class for a delete-confirmation dialog, mounted on `document.body`. */
export const COMMENT_DELETE_CONFIRM_CLASS = 'comment-delete-confirm';
/** DOM class for the popover's edit `<textarea>` (US-23.14) — native field undo, same convention as `COMMENT_REPLY_INPUT_CLASS`. */
export const COMMENT_EDIT_INPUT_CLASS = 'comment-popover-edit-input';
/** DOM class for the create composer's `<textarea>`, mounted on `document.body` (US-23.1). */
export const COMMENT_COMPOSER_INPUT_CLASS = 'comment-composer-input';
/** DOM class for the create composer's card, mounted on `document.body` (US-23.1). */
export const COMMENT_COMPOSER_CLASS = 'comment-composer';
/** DOM class for the re-attach picker's filter `<input>`, mounted inside the picker (US-23.4 AC4). */
export const COMMENT_REATTACH_FILTER_CLASS = 'comment-reattach-filter';
/** DOM class for the re-attach picker's card (US-23.4 AC4). */
export const COMMENT_REATTACH_PICKER_CLASS = 'comment-reattach-picker';

// --- Req 23 US-23.7: shared right-dock tab container (media/webview/right-dock.ts) ---

/** DOM class for the 32px strip that owns the dock's top edge. */
export const RIGHT_DOCK_STRIP_CLASS = 'right-dock-tabs';
/** DOM class for the `role="tablist"` inside the strip — the `⋯` button is its sibling, not its child. */
export const RIGHT_DOCK_TABLIST_CLASS = 'right-dock-tablist';
/** DOM class for one tab header. */
export const RIGHT_DOCK_TAB_CLASS = 'right-dock-tab';
/** DOM class for the header's text, kept a separate node so the badge can sit beside it. */
export const RIGHT_DOCK_TAB_LABEL_CLASS = 'right-dock-tab-label';
/** DOM class for a tab header's count badge (US-23.9) — present only while the count is non-empty. */
export const RIGHT_DOCK_TAB_BADGE_CLASS = 'right-dock-tab-badge';
/**
 * DOM class stamped on every registered tab body. Its paired
 * `.right-dock-tabpanel[hidden]` rule is what makes the dock's `hidden` toggle
 * stick — a tab body carrying its own author `display` needs its own paired rule
 * at matching specificity too (see `#toc-tabpanel[hidden]` in editor.css).
 */
export const RIGHT_DOCK_TABPANEL_CLASS = 'right-dock-tabpanel';
/** DOM class for the `⋯` overflow button at the strip's right end. */
export const RIGHT_DOCK_MENU_BTN_CLASS = 'right-dock-menu-btn';
/** DOM class for the overflow menu, mounted on `document.body` (comment-popover.ts convention). */
export const RIGHT_DOCK_MENU_CLASS = 'right-dock-menu';
/** DOM class for one selectable row in the overflow menu — the arrow-traversal unit. */
export const RIGHT_DOCK_MENU_ITEM_CLASS = 'right-dock-menu-item';

// --- Req 23 US-23.3: two-step resolve (Open -> Resolved -> Closed) ---

/** DOM class for the popover's Resolve/Close/Reopen action bar. */
export const COMMENT_ACTION_BAR_CLASS = 'comment-popover-actions';
/**
 * DOM class for AC2's passive drift strip. Purely derived from the live anchor —
 * no dismiss control, so it must never carry any persisted/one-shot state.
 */
export const COMMENT_DRIFT_STRIP_CLASS = 'comment-popover-drift';
/** DOM class for AC3's anchor-lost dialog, mounted on `document.body` behind its own scrim. */
export const COMMENT_ANCHOR_LOST_CLASS = 'comment-anchor-lost';

// --- Req 24 US-23.21: presentation classes registered in turndown.ts's TRANSIENT_CLASSES ---

/** DOM class flashed briefly on a cross-reference target after `navigateReferenceEntry` scrolls to it (Req 20 US-20.5). */
export const REF_NAV_FLASH_CLASS = 'ref-nav-flash';
/** DOM class for the drop-target outline drawn during drag-drop (Req 17). */
export const DD_HOVER_OUTLINE_CLASS = 'dd-hover-outline';
/** DOM class for the drop-target outline drawn on a table cell during drag-drop (Req 17). */
export const DD_HOVER_OUTLINE_CELL_CLASS = 'dd-hover-outline-cell';
/** DOM class muting the drag source while a drag is in flight (Req 17). */
export const DD_SOURCE_MUTED_CLASS = 'dd-source-muted';
/** DOM class marking a table fit to its column widths by `fitTableColumns` (US-19.25). */
export const MD_TABLE_FIT_CLASS = 'md-table-fit';
/**
 * State class on a code-block `<pre>` whose lines are word-wrapped (default ON,
 * Req 04). Removing it → horizontal scroll.
 *
 * Declared here rather than beside its `md-code-*` siblings in `render.ts`
 * (US-23.22 AC2): it is a REGISTERED transient class, and the registration
 * check requires every registered name to resolve to this one file.
 */
export const MD_CODE_WRAPPED_CLASS = 'md-code-wrapped';
/**
 * Req 20 US-20.9: stamped on a broken file/heading link's `<a>` inside
 * `#content` — see `.broken-ref` (editor.css) for the marker treatment.
 * Registered as transient (US-23.22): the marker is derived state recomputed
 * from the live document after every render, never authored in the `.md`.
 */
export const BROKEN_REF_CLASS = 'broken-ref';
/**
 * Req 21: transient highlight flashed on a revealed caption badge inside
 * `#content` for `ENTITY_REVEAL_FLASH_MS` (gutter.ts) — the same one-shot,
 * timeout-removed shape as `REF_NAV_FLASH_CLASS` above, registered for the same
 * reason (US-23.22).
 */
export const ENTITY_REVEAL_FLASH_CLASS = 'entity-reveal-flash';
/**
 * Req 17: drop-target highlight drawn on the table cell under the pointer while
 * an EXTERNAL file drag is in flight (external-drop.ts) — a live `#content`
 * cell, the same surface as `DD_HOVER_OUTLINE_CELL_CLASS` above (US-23.22).
 */
export const DD_DROP_TARGET_CELL_CLASS = 'dd-drop-target-cell';

/**
 * Req 21 US-21.3: stamped on an `<a>` whose href resolves to an entity
 * declaration (postProcessEntityRefs in dom-postprocess.ts) — a REFERENCE to an
 * entity, not its declaration site. bug_General Mention Declare #2 (PO decision
 * 2026-07-22): a reference renders as a NORMAL hyperlink (no pill), so this
 * class carries no base style — it is only a JS/selector hook (entity-scope
 * hover + `.` drill, broken-ref detection) and the anchor for the broken-state
 * rule in markdown.css.
 *
 * Declared here rather than in `render.ts`, for the same US-23.22 AC2 reason as
 * `MD_CODE_WRAPPED_CLASS` above.
 */
export const ENTITY_REF_CLASS = 'md-entity-ref';

/**
 * Positive ownership marker `turndown.ts`'s `stripInjectedChrome` matches on to
 * remove editor-injected UI controls (code-block header/Copy/Wrap, diagram/math
 * toolbars and toggles) from the raw-HTML serialize clone (US-23.21 AC1b).
 * Stamped in `dom-postprocess.ts` alongside `contenteditable="false"` — the bare
 * attribute alone is not a safe match: a user's own
 * `<span contenteditable="false">` holds real content, which a blanket
 * `[contenteditable="false"]` selector would silently delete on that same
 * raw-HTML path (pinned by a case in `test/roundtrip/style-preservation.ts`).
 * Req 21's `.md-caption` badge was this counter-example until US-23.22 gave it
 * its own source-form restoration, which now runs before `stripInjectedChrome`.
 */
export const MD_CHROME_MARKER_ATTR = 'data-md-chrome';

// --- Req 24 US-23.18 AC2: the comment-field registry the undo/redo guard resolves against ---

/**
 * Every comment surface an undo/redo chord must die inside, as CSS selectors.
 *
 * US-23.18 AC2 requires the guard to cover these **by construction, not by
 * enumeration at the call site**: `comment-undo-guard.ts` resolves a keystroke's
 * target through this one list, and the webview spec enumerates the live DOM
 * against it, so a comment surface added later is covered by one entry here
 * rather than by remembering to touch the guard.
 *
 * All of these mount on `document.body`, **outside `#content`** — which is why
 * `main.ts`'s `ownsNativeUndo` cannot see them: that guard only ever runs from
 * `#content`'s own keydown listener, so a chord pressed in one of these
 * surfaces never reaches it (AC1).
 *
 * **Containers, never the leaf text controls.** Listing the `<textarea>`s alone
 * looks tighter and is wrong: the guard resolves with `closest()`, so focus on
 * any *other* control in the same surface would miss and let the chord through
 * to the document. The composer's own Submit button is the proof — US-23.18 AC7
 * keeps it `aria-disabled` rather than `disabled` precisely so it stays
 * focusable, so Tab-then-undo is a reachable route, not a hypothetical one. The
 * two dialogs carry no text field at all and are listed for the same reason
 * (AC8): they are modal, focus lives on their card, and the chord must not reach
 * the document underneath the scrim. `comment-undo-guard.ts` decides separately
 * whether the specific target owns a native history worth reissuing.
 *
 * Declared last in this file: the array dereferences the class constants above,
 * so it must be evaluated after them — a `const` is in its temporal dead zone
 * until its own declaration runs, and a forward reference here would throw at
 * module load, not at first use.
 */
export const COMMENT_FIELD_SELECTORS: readonly string[] = [
  `.${COMMENT_COMPOSER_CLASS}`,
  `.${COMMENT_POPOVER_CLASS}`,
  `.${COMMENT_REATTACH_PICKER_CLASS}`,
  `.${COMMENT_DELETE_CONFIRM_CLASS}`,
  `.${COMMENT_ANCHOR_LOST_CLASS}`,
];
