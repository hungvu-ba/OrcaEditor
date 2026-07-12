/**
 * Highlight tự động mọi chỗ khác trong tài liệu trùng với văn bản đang được
 * bôi đen (Feature A — "Highlight trong file hiện tại").
 *
 *  - Không cần thao tác gì thêm: theo dõi 'selectionchange' toàn cục, khi vùng
 *    chọn bên trong #content ổn định và đủ dài (>= MIN_SELECT_LENGTH ký tự,
 *    không tính khoảng trắng/dấu câu thuần) thì tô mọi lần xuất hiện KHÁC của
 *    cùng đoạn text đó bằng CSS Custom Highlight API.
 *  - Dùng tên highlight riêng ('select-match', khác 'search-match'/
 *    'search-current' của search.ts) để không xung đột khi hộp Ctrl+F đang mở
 *    cùng lúc — hai CSS.highlights là hai entry độc lập, hiển thị chồng nhau
 *    được (đã style trong editor.css).
 *  - Không có UI điều hướng prev/next cho tính năng này — nằm ngoài phạm vi
 *    theo yêu cầu; đó là việc của search.ts.
 *  - C1: thêm thước overview riêng (#select-overview, dùng chung hàm dựng tick
 *    với search.ts qua match-utils.ts) — CHỈ báo trực quan, không click-to-jump.
 *    Khi Ctrl+F (#search-box) đang mở, tắt hẳn cả highlight lẫn overview strip
 *    (không tính toán gì) — tránh 2 lớp highlight/2 thước chồng nhau.
 */

import { MIN_SELECT_LENGTH, SELECT_OVERVIEW_THROTTLE_MS } from './constants';
import {
  buildOverviewTicks,
  collectHaystack,
  createViewportBand,
  findMatches,
  updateViewportBand,
  type Haystack,
} from './match-utils';

export interface SelectHighlightController {
  /** Gọi lại khi nội dung tài liệu vừa render lại (content đổi) — dọn highlight + strip cũ vì Range có thể đã hỏng. */
  refresh(): void;
}

/** Tên highlight đăng ký với CSS.highlights — khớp với ::highlight() trong editor.css. */
const SELECT_HL = 'select-match';

/** Ký tự khoảng trắng hoặc dấu câu (Unicode) — dùng để loại khỏi phần đếm ngưỡng độ dài. */
const WHITESPACE_OR_PUNCT_RE = /[\s\p{P}]/gu;

/**
 * Cap cứng số tick overview dựng mỗi lần rebuild (an toàn hiệu năng — xem C1/constants.ts
 * SELECT_OVERVIEW_THROTTLE_MS). Throttle chỉ giảm TẦN SUẤT rebuild, không giới hạn kích thước 1
 * lần rebuild; nếu 1 truy vấn có hàng nghìn match, mỗi lần rebuild (dù đã throttle) vẫn có thể
 * giật nếu không cap. buildOverviewTicks tự log console.warn khi bị cắt bớt (không silent-cap).
 */
const SELECT_OVERVIEW_MAX_TICKS = 500;

/**
 * @param content #content — vùng nội dung WYSIWYG.
 * @param isSearchOpen Trả về true khi hộp Ctrl+F (#search-box, search.ts) đang mở — Feature A tắt
 *   hẳn (không paint, không build strip, không tính toán) trong lúc đó (C1, quyết định #2).
 */
export function initSelectHighlight(
  content: HTMLElement,
  isSearchOpen: () => boolean
): SelectHighlightController {
  const supportsHighlight =
    typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  // --- Thước overview bên phải (chỉ báo trực quan, không click-to-jump) ---
  const overview = document.createElement('div');
  overview.id = 'select-overview';
  overview.hidden = true;
  document.body.appendChild(overview);

  // Dải mờ đánh dấu vị trí đang cuộn tới trên thước overview (khác tick "current" — vốn chỉ đánh
  // dấu chính vùng đang chọn, không đổi khi cuộn trang). Cập nhật liên tục theo scroll, ẩn/hiện
  // đồng bộ tay với `overview` — xem syncViewportBand().
  const viewportBand = createViewportBand('select-viewport-band');

  function syncViewportBand(): void {
    viewportBand.hidden = overview.hidden;
    if (!overview.hidden) {
      updateViewportBand(viewportBand);
    }
  }

  // Cache haystack giữa các lần 'selectionchange' liên tiếp (nội dung tài liệu
  // không đổi khi chỉ selection đổi). Chỉ invalidate khi content thay đổi,
  // qua refresh() bên dưới.
  let haystackCache: Haystack | undefined;

  function invalidateHaystack(): void {
    haystackCache = undefined;
  }

  function collect(): Haystack {
    if (!haystackCache) {
      haystackCache = collectHaystack(content);
    }
    return haystackCache;
  }

  function clear(): void {
    if (supportsHighlight) {
      CSS.highlights.delete(SELECT_HL);
    }
  }

  function clearStrip(): void {
    overview.hidden = true;
    overview.textContent = '';
    syncViewportBand();
  }

  /** Xoá cả highlight lẫn strip — dùng ở mọi nhánh "không còn gì để tô" (không selection hợp lệ, Ctrl+F đang mở, Esc, refresh...). */
  function clearAll(): void {
    clear();
    clearStrip();
  }

  // Throttle riêng cho phần build tick DOM (đắt: tạo node + getBoundingClientRect() mỗi match).
  // Phần paint CSS.highlights.set(...) ở recompute() KHÔNG bị throttle bởi biến này — giữ nguyên
  // tần suất rAF hiện có (rẻ, không thao tác DOM).
  let lastStripBuildTime = 0;

  /**
   * @param selRange Range của chính vùng đang được chọn — luôn được thêm vào strip ở vị trí ĐẦU
   *   danh sách kèm `current: 0` (C1 mở rộng, chốt #3: cần thấy vị trí đang chọn để so sánh với các
   *   match khác trên cùng thước, không chỉ thấy các match). buildOverviewTicks tự gắn class
   *   'current' cho tick ở index này, style riêng qua CSS `.select-tick.current`.
   */
  function buildStripThrottled(matches: Range[], selRange: Range): void {
    const now = Date.now();
    if (now - lastStripBuildTime < SELECT_OVERVIEW_THROTTLE_MS) {
      // Bỏ qua rebuild strip nhịp này (strip cũ vẫn hiện) — paint highlight đã cập nhật ngay ở
      // trên rồi, hai bước không còn cần chạy lockstep với nhau.
      return;
    }
    lastStripBuildTime = now;
    buildOverviewTicks({
      container: overview,
      matches: [selRange, ...matches],
      tickClass: 'select-tick',
      current: 0,
      maxTicks: SELECT_OVERVIEW_MAX_TICKS,
    });
    syncViewportBand();
  }

  /** So sánh hai Range có cùng điểm đầu/cuối hay không (dùng để loại chính vùng đang chọn khỏi kết quả tô). */
  function isSameRange(a: Range, b: Range): boolean {
    try {
      return (
        a.compareBoundaryPoints(Range.START_TO_START, b) === 0 &&
        a.compareBoundaryPoints(Range.END_TO_END, b) === 0
      );
    } catch {
      return false;
    }
  }

  function recompute(): void {
    if (!supportsHighlight) {
      return;
    }
    // C1 quyết định #2: Ctrl+F đang mở ⇒ Feature A tắt hẳn (không paint, không build strip,
    // không tính toán gì thêm) — coi như "không có selection hợp lệ".
    if (isSearchOpen()) {
      clearAll();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      clearAll();
      return;
    }
    const anchor = sel.anchorNode;
    const focus = sel.focusNode;
    if (!anchor || !focus || !content.contains(anchor) || !content.contains(focus)) {
      clearAll();
      return;
    }
    // Chỉ trim khoảng trắng đầu/cuối cho QUERY thực sự tìm kiếm — không bóc
    // dấu câu bên trong (chỉ dùng bản bóc dấu câu để xét ngưỡng độ dài).
    const query = (sel.toString() ?? '').trim();
    if (!query) {
      clearAll();
      return;
    }
    const stripped = query.replace(WHITESPACE_OR_PUNCT_RE, '');
    if (stripped.length < MIN_SELECT_LENGTH) {
      clearAll();
      return;
    }
    const { haystack, segs } = collect();
    // Feature A giữ NGUYÊN hành vi cũ: substring, luôn case-insensitive — KHÔNG
    // chịu ảnh hưởng của option Match Case/Whole Word (C4, chốt #1). Truyền
    // tường minh để hành vi không âm thầm đổi theo default của findMatches.
    const all = findMatches(haystack, segs, query, { matchCase: false, wholeWord: false });
    if (!all.length) {
      clearAll();
      return;
    }
    const selRange = sel.getRangeAt(0);
    const others = all.filter((r) => !isSameRange(r, selRange));
    if (others.length) {
      CSS.highlights.set(SELECT_HL, new Highlight(...others));
    } else {
      clear();
    }
    // Strip luôn dựng (kể cả khi others rỗng) để tick "vị trí đang chọn" luôn hiện — khác highlight
    // CSS.highlights (chỉ cần khi CÓ match khác để tô).
    buildStripThrottled(others, selRange);
  }

  // Coalesce các sự kiện 'selectionchange' bắn liên tiếp (vd. kéo chuột) về
  // một lần tính toán mỗi khung hình, thay vì tính lại trên từng sự kiện.
  let rafId: number | undefined;
  document.addEventListener('selectionchange', () => {
    if (rafId !== undefined) {
      return;
    }
    rafId = requestAnimationFrame(() => {
      rafId = undefined;
      recompute();
    });
  });

  // Esc luôn xoá highlight + strip (rẻ, không cần điều kiện gì thêm).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearAll();
    }
  });

  // Cập nhật vị trí viewport band theo scroll, coalesce về 1 lần/khung hình — độc lập với throttle
  // rebuild tick (SELECT_OVERVIEW_THROTTLE_MS) vì chỉ tính lại top/height %, không đụng DOM tick.
  let viewportRafId: number | undefined;
  window.addEventListener(
    'scroll',
    () => {
      if (viewportBand.hidden || viewportRafId !== undefined) {
        return;
      }
      viewportRafId = requestAnimationFrame(() => {
        viewportRafId = undefined;
        updateViewportBand(viewportBand);
      });
    },
    { passive: true }
  );

  return {
    refresh(): void {
      // Nội dung tài liệu đã đổi → haystack cache cũ không còn đúng, bỏ đi.
      // Range của highlight/strip cũ (nếu có) cũng đã hỏng theo DOM mới — xoá luôn
      // thay vì cố tính lại theo selection (thường đã mất/không còn hợp lệ
      // ngay sau khi #content vừa được render lại).
      invalidateHaystack();
      clearAll();
    },
  };
}
