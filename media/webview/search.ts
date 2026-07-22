/**
 * Tìm kiếm văn bản trong preview (Ctrl+F / ⌘F).
 *
 *  - Highlight match bằng CSS Custom Highlight API (CSS.highlights + Highlight +
 *    Range). Ưu điểm sống còn: KHÔNG chèn <mark> hay chỉnh sửa DOM của #content
 *    nên không phá contentEditable, không kích hoạt sự kiện 'input' và không
 *    làm bẩn markdown khi serialize.
 *  - Thanh "overview" cố định bên phải hiển thị vị trí mọi match (giống thước
 *    tổng quan của editor VS Code); click vào vạch để nhảy tới match đó.
 *  - Điều hướng: Enter / nút ⌄ tới match kế; Shift+Enter / nút ⌃ về match trước;
 *    Esc / nút ✕ đóng.
 */

import { INPUT_DEBOUNCE_MS, REFRESH_DEBOUNCE_MS } from './constants';
import { scrollBehavior } from './dom-utils';
import {
  buildOverviewTicks,
  collectHaystack,
  createViewportBand,
  findMatches,
  updateViewportBand,
  type Haystack,
} from './match-utils';
import { buildMatchOptionToggles } from './match-options';
import type { MatchOptions } from '../../src/shared/text-match';

export interface SearchController {
  /** Chạy lại tìm kiếm (khi nội dung đổi) nếu hộp tìm đang mở. Có debounce. */
  refresh(): void;
  /** true nếu hộp tìm kiếm (#search-box) đang mở — Feature A (select-highlight.ts) dùng để tự tắt hẳn khi Ctrl+F đang mở (C1). */
  isOpen(): boolean;
}

/** Tên highlight đăng ký với CSS.highlights — khớp với ::highlight() trong CSS. */
const MATCH_HL = 'search-match';
const CURRENT_HL = 'search-current';

function svg(inner: string): string {
  return (
    '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    inner +
    '</svg>'
  );
}
const STROKE = 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"';
const ICON_PREV = svg(`<path d="M4 10l4-4 4 4" ${STROKE}/>`);
const ICON_NEXT = svg(`<path d="M4 6l4 4 4-4" ${STROKE}/>`);
const ICON_CLOSE = svg(`<path d="M4 4l8 8M12 4l-8 8" ${STROKE}/>`);

export function initSearch(content: HTMLElement): SearchController {
  const supportsHighlight =
    typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  // --- Hộp tìm kiếm (góc trên bên phải) ---
  const box = document.createElement('div');
  box.id = 'search-box';
  box.hidden = true;

  const input = document.createElement('input');
  input.id = 'search-input';
  input.type = 'text';
  input.placeholder = 'Find';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Find in document');

  // Option Match Case / Whole Word (C4). Mặc định Whole Word = ON, Match Case
  // = OFF. State là object được MUTATE trực tiếp (buildMatchOptionToggles + luồng
  // fallback cùng nhìn một object).
  const matchOptions: MatchOptions = { matchCase: false, wholeWord: true };

  const count = document.createElement('span');
  count.id = 'search-count';

  // Ghi chú fallback (C4, chốt #4): hiện khi whole-word 0 kết quả và đã hạ về
  // substring — text ngắn, câu đầy đủ nằm ở title.
  const fallbackNote = document.createElement('span');
  fallbackNote.id = 'search-fallback-note';
  fallbackNote.hidden = true;
  fallbackNote.textContent = 'substring';
  fallbackNote.title = 'No whole-word match — showing substring results';

  const mkBtn = (icon: string, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = icon;
    b.title = title;
    // Giữ vùng chọn/caret trong #content khi bấm nút.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    return b;
  };
  const prevBtn = mkBtn(ICON_PREV, 'Previous match (⇧Enter)');
  const nextBtn = mkBtn(ICON_NEXT, 'Next match (Enter)');
  const closeBtn = mkBtn(ICON_CLOSE, 'Close (Esc)');

  // Toggle Aa/ab — bấm → lật state → re-run query hiện tại (giống gõ phím). `run`
  // là function declaration (hoisted) nên tham chiếu trong callback hợp lệ dù nó
  // khai báo phía dưới; callback chỉ chạy khi user bấm, lúc mọi thứ đã init.
  const toggles = buildMatchOptionToggles(matchOptions, () => {
    if (input.value) {
      run(input.value, false);
    }
  });

  box.append(input, ...toggles.elements, count, fallbackNote, prevBtn, nextBtn, closeBtn);
  document.body.appendChild(box);

  // --- Thanh overview bên phải ---
  const overview = document.createElement('div');
  overview.id = 'search-overview';
  overview.hidden = true;
  document.body.appendChild(overview);

  // Dải mờ đánh dấu vị trí đang cuộn tới trên thước overview (khác khái niệm "current match" —
  // cập nhật liên tục theo scroll, không chỉ khi điều hướng prev/next). Phần tử riêng, ẩn/hiện
  // đồng bộ tay với `overview` — xem syncViewportBand().
  const viewportBand = createViewportBand('search-viewport-band');

  function syncViewportBand(): void {
    viewportBand.hidden = overview.hidden;
    if (!overview.hidden) {
      updateViewportBand(viewportBand);
    }
  }

  // --- Trạng thái ---
  let matches: Range[] = [];
  let current = -1;
  let query = '';
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;

  // -------------------------------------------------------------------------
  // Thu thập text + tìm match
  // -------------------------------------------------------------------------

  // Cache kết quả TreeWalker giữa các lần gõ TỪ KHÓA (haystack không đổi khi
  // chỉ query đổi). Chỉ invalidate khi nội dung tài liệu đổi — qua hook
  // refresh() bên dưới (được gọi mỗi khi content thay đổi).
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

  function computeMatches(q: string): Range[] {
    if (!q) {
      return [];
    }
    const { haystack, segs } = collect();
    return findMatches(haystack, segs, q, matchOptions);
  }

  // true khi lần tìm hiện tại đã hạ Whole Word → substring vì whole-word 0 kết
  // quả (C4, chốt #4) — điều khiển hiển thị fallbackNote trong updateCount().
  let usedFallback = false;

  // -------------------------------------------------------------------------
  // Highlight + overview
  // -------------------------------------------------------------------------

  function paint(): void {
    paintHighlights();
    buildOverview();
    syncViewportBand();
  }

  /**
   * Tô hai lớp highlight KHÔNG chồng nhau để màu khớp đúng của VS Code:
   *  - CURRENT_HL: chỉ mình match hiện tại → nền editor.findMatchBackground.
   *  - MATCH_HL:   mọi match CÒN LẠI      → nền editor.findMatchHighlightBackground.
   * Nếu để match hiện tại nằm trong cả hai lớp, hai nền bán trong suốt sẽ
   * cộng màu (vàng lẫn cam) làm sai màu — nên phải loại nó khỏi MATCH_HL.
   */
  function paintHighlights(): void {
    if (!supportsHighlight) {
      return;
    }
    const others = matches.filter((_, i) => i !== current);
    if (others.length) {
      CSS.highlights.set(MATCH_HL, new Highlight(...others));
    } else {
      CSS.highlights.delete(MATCH_HL);
    }
    const cur = matches[current];
    if (cur) {
      CSS.highlights.set(CURRENT_HL, new Highlight(cur));
    } else {
      CSS.highlights.delete(CURRENT_HL);
    }
  }

  function clearHighlights(): void {
    if (supportsHighlight) {
      CSS.highlights.delete(MATCH_HL);
      CSS.highlights.delete(CURRENT_HL);
    }
  }

  function buildOverview(): void {
    // Dùng hàm dựng tick dùng chung (match-utils.ts) — Feature A (select-highlight.ts) dùng
    // chung hàm này cho #select-overview, với tickClass/current/maxTicks/onTickClick khác.
    // Không truyền maxTicks ⇒ mặc định không giới hạn, giữ đúng hành vi cũ (render mọi match,
    // đã cap sẵn ở findMatches).
    buildOverviewTicks({
      container: overview,
      matches,
      tickClass: 'search-tick',
      current,
      onTickClick: (i) => setCurrent(i, true),
    });
  }

  function markActiveTick(): void {
    const ticks = overview.children;
    for (let i = 0; i < ticks.length; i++) {
      ticks[i].classList.toggle('current', i === current);
    }
  }

  // -------------------------------------------------------------------------
  // Điều hướng
  // -------------------------------------------------------------------------

  function updateCount(): void {
    if (!query) {
      count.textContent = '';
    } else if (!matches.length) {
      count.textContent = 'No results';
    } else {
      count.textContent = `${current + 1}/${matches.length}`;
    }
    count.classList.toggle('no-result', !!query && matches.length === 0);
    // Chỉ hiện ghi chú fallback khi thực sự đang xem kết quả substring (>0) sau khi
    // whole-word không có gì — nếu substring cũng 0 thì "No results" đã đủ nghĩa.
    fallbackNote.hidden = !(usedFallback && matches.length > 0);
    const disabled = matches.length === 0;
    prevBtn.disabled = disabled;
    nextBtn.disabled = disabled;
  }

  function setCurrent(i: number, scroll: boolean): void {
    if (!matches.length) {
      current = -1;
    } else {
      current = ((i % matches.length) + matches.length) % matches.length;
    }
    paintHighlights();
    markActiveTick();
    updateCount();
    if (scroll && current >= 0) {
      scrollIntoView(matches[current]);
    }
  }

  function scrollIntoView(r: Range): void {
    const rect = r.getBoundingClientRect();
    const toolbar = document.getElementById('toolbar');
    const topGuard = (toolbar?.offsetHeight ?? 0) + 60;
    if (rect.top < topGuard || rect.bottom > window.innerHeight - 40) {
      const target = window.scrollY + rect.top - window.innerHeight / 2;
      window.scrollTo({ top: Math.max(0, target), behavior: scrollBehavior() });
    }
  }

  /** Chọn match gần vị trí cuộn hiện tại (ở dưới mép trên khung nhìn). */
  function nearestToViewport(): number {
    const anchor = window.scrollY;
    for (let i = 0; i < matches.length; i++) {
      const top = matches[i].getBoundingClientRect().top + window.scrollY;
      if (top >= anchor - 4) {
        return i;
      }
    }
    return matches.length ? 0 : -1;
  }

  // -------------------------------------------------------------------------
  // Chạy tìm kiếm
  // -------------------------------------------------------------------------

  function run(q: string, keepCurrent: boolean): void {
    query = q;
    const prevIndex = current;
    usedFallback = false;
    matches = computeMatches(q);
    // Fallback cục bộ (C4, chốt #4 — luồng Ctrl+F, không cần round-trip host):
    // Whole Word đang bật mà 0 kết quả ⇒ hạ hẳn state về OFF (đồng bộ toggle),
    // tìm lại theo substring cho lần này. Hạ state (không chỉ tạm) để lần gõ sau
    // không lặp lại nhánh này với toggle hiện ON gây hiểu lầm.
    if (q && matchOptions.wholeWord && matches.length === 0) {
      matchOptions.wholeWord = false;
      toggles.sync();
      matches = computeMatches(q);
      usedFallback = true;
    }
    paint();
    if (!matches.length) {
      setCurrent(-1, false);
      return;
    }
    const idx = keepCurrent && prevIndex >= 0 ? Math.min(prevIndex, matches.length - 1) : nearestToViewport();
    setCurrent(idx, !keepCurrent);
  }

  function next(dir: 1 | -1): void {
    if (!matches.length) {
      return;
    }
    setCurrent(current + dir, true);
  }

  // -------------------------------------------------------------------------
  // Mở / đóng
  // -------------------------------------------------------------------------

  function open(): void {
    const wasHidden = box.hidden;
    box.hidden = false;
    // Ưu tiên chữ đang bôi đen làm từ khóa (giống Find của VS Code).
    const sel = window.getSelection()?.toString() ?? '';
    if (wasHidden && sel && !sel.includes('\n')) {
      input.value = sel;
    }
    input.focus();
    input.select();
    if (input.value) {
      run(input.value, false);
    }
  }

  function close(): void {
    if (inputTimer !== undefined) {
      clearTimeout(inputTimer);
      inputTimer = undefined;
    }
    box.hidden = true;
    overview.hidden = true;
    overview.textContent = '';
    syncViewportBand();
    clearHighlights();
    matches = [];
    current = -1;
    query = '';
    count.textContent = '';
    usedFallback = false;
    fallbackNote.hidden = true;
    // preventScroll: caret thật của contenteditable có thể đang ở vị trí cũ
    // (trước khi search, vd đầu file) — focus() mặc định sẽ tự cuộn nó vào
    // tầm nhìn, đè mất vị trí match vừa điều hướng tới (bug: bấm ra content
    // sau khi Next tới match ngoài viewport bị nhảy về caret cũ).
    content.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------
  // Sự kiện
  // -------------------------------------------------------------------------

  // Debounce sự kiện gõ vào ô tìm để không chạy lại toàn bộ tìm kiếm mỗi
  // ký tự (haystack đã được cache nên chỉ tốn indexOf + dựng lại overview).
  input.addEventListener('input', () => {
    if (inputTimer !== undefined) {
      clearTimeout(inputTimer);
    }
    inputTimer = setTimeout(() => {
      inputTimer = undefined;
      run(input.value, false);
    }, INPUT_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      next(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  prevBtn.addEventListener('click', () => {
    next(-1);
    input.focus();
  });
  nextBtn.addEventListener('click', () => {
    next(1);
    input.focus();
  });
  closeBtn.addEventListener('click', close);

  // Bấm ra ngoài hộp tìm (và ngoài thanh overview) → đóng, giống các popup khác.
  document.addEventListener('mousedown', (e) => {
    if (box.hidden) {
      return;
    }
    const target = e.target as Node;
    if (!box.contains(target) && !overview.contains(target)) {
      close();
    }
  });

  // Ctrl/Cmd+F mở hộp tìm. Dùng capture để đứng trước các handler khác; webview
  // không có 'editorFocus' nên VS Code không nuốt phím này.
  document.addEventListener(
    'keydown',
    (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        open();
      }
    },
    true
  );

  // Vị trí vạch overview phụ thuộc chiều cao tài liệu — dựng lại khi cửa sổ đổi cỡ.
  window.addEventListener('resize', () => {
    if (!box.hidden && matches.length) {
      buildOverview();
      markActiveTick();
    }
    syncViewportBand();
  });

  // Cập nhật vị trí viewport band theo scroll, coalesce về 1 lần/khung hình (giống
  // 'selectionchange' của select-highlight.ts) — rẻ vì chỉ tính lại top/height %, không đụng DOM tick.
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
      // Nội dung tài liệu đã đổi → haystack cache cũ không còn đúng, bỏ đi
      // (kể cả khi hộp tìm đang ẩn, để lần mở sau collect() dựng lại mới).
      invalidateHaystack();
      if (box.hidden || !query) {
        return;
      }
      if (refreshTimer !== undefined) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (!box.hidden && query) {
          run(query, true);
        }
      }, REFRESH_DEBOUNCE_MS);
    },
    isOpen(): boolean {
      return !box.hidden;
    },
  };
}
