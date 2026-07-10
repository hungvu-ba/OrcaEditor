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

export interface SearchController {
  /** Chạy lại tìm kiếm (khi nội dung đổi) nếu hộp tìm đang mở. Có debounce. */
  refresh(): void;
}

/** Tên highlight đăng ký với CSS.highlights — khớp với ::highlight() trong CSS. */
const MATCH_HL = 'search-match';
const CURRENT_HL = 'search-current';

/**
 * Ranh giới khối: một match không được nối ngang qua ranh giới này (tránh
 * cụm "…đoạn A" + "đoạn B…" bị coi là một match vắt qua hai khối). Trong cùng
 * một khối, các text node nội tuyến (do <strong>, <em>, <code>… tách ra) vẫn
 * được nối liền nên "Last **Con**voy" tìm "Convoy" vẫn khớp.
 */
const BLOCK_SEL = 'p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,dt,dd,figcaption,summary,hr,div';

interface Segment {
  node: Text;
  /** Offset đầu của node trong chuỗi haystack ghép chung. */
  start: number;
  len: number;
}

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
  input.placeholder = 'Tìm';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Tìm trong tài liệu');

  const count = document.createElement('span');
  count.id = 'search-count';

  const mkBtn = (icon: string, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = icon;
    b.title = title;
    // Giữ vùng chọn/caret trong #content khi bấm nút.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    return b;
  };
  const prevBtn = mkBtn(ICON_PREV, 'Kết quả trước (⇧Enter)');
  const nextBtn = mkBtn(ICON_NEXT, 'Kết quả sau (Enter)');
  const closeBtn = mkBtn(ICON_CLOSE, 'Đóng (Esc)');

  box.append(input, count, prevBtn, nextBtn, closeBtn);
  document.body.appendChild(box);

  // --- Thanh overview bên phải ---
  const overview = document.createElement('div');
  overview.id = 'search-overview';
  overview.hidden = true;
  document.body.appendChild(overview);

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
  let haystackCache: { haystack: string; segs: Segment[] } | undefined;

  function invalidateHaystack(): void {
    haystackCache = undefined;
  }

  function collect(): { haystack: string; segs: Segment[] } {
    if (haystackCache) {
      return haystackCache;
    }
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode(node): number {
        const el = node.parentElement;
        if (!el || !node.nodeValue) {
          return NodeFilter.FILTER_REJECT;
        }
        // Bỏ text ẩn/không thực (KaTeX dựng cả MathML + annotation ẩn), script, style.
        if (el.closest('.katex, script, style')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const segs: Segment[] = [];
    let haystack = '';
    let prevBlock: Element | null = null;
    let first = true;
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const node = n as Text;
      const block = node.parentElement ? node.parentElement.closest(BLOCK_SEL) : null;
      if (!first && block !== prevBlock) {
        // Chèn '\n' ngăn cách hai khối. Vì ô tìm không cho nhập '\n' nên
        // match không bao giờ vắt qua dấu ngăn này ⇒ không vắt qua khối.
        haystack += '\n';
      }
      segs.push({ node, start: haystack.length, len: node.nodeValue!.length });
      haystack += node.nodeValue;
      prevBlock = block;
      first = false;
    }
    haystackCache = { haystack, segs };
    return haystackCache;
  }

  function rangeAt(segs: Segment[], gStart: number, gEnd: number): Range | null {
    const startSeg = segs.find((s) => gStart >= s.start && gStart < s.start + s.len);
    const endSeg = segs.find((s) => gEnd > s.start && gEnd <= s.start + s.len);
    if (!startSeg || !endSeg) {
      return null;
    }
    const r = document.createRange();
    try {
      r.setStart(startSeg.node, gStart - startSeg.start);
      r.setEnd(endSeg.node, gEnd - endSeg.start);
    } catch {
      return null;
    }
    return r;
  }

  function computeMatches(q: string): Range[] {
    const found: Range[] = [];
    if (!q) {
      return found;
    }
    const { haystack, segs } = collect();
    const hay = haystack.toLowerCase();
    const needle = q.toLowerCase();
    let from = 0;
    while (found.length < 5000) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) {
        break;
      }
      const r = rangeAt(segs, idx, idx + needle.length);
      if (r) {
        found.push(r);
      }
      from = idx + needle.length; // không cho match chồng lấn
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // Highlight + overview
  // -------------------------------------------------------------------------

  function paint(): void {
    paintHighlights();
    buildOverview();
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
    const others: Range[] = [];
    for (let i = 0; i < matches.length; i++) {
      if (i !== current) {
        others.push(matches[i]);
      }
    }
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
    overview.textContent = '';
    if (!matches.length) {
      overview.hidden = true;
      return;
    }
    overview.hidden = false;
    const docHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      1
    );
    // Pha ĐỌC: gom mọi getBoundingClientRect() trước, không xen ghi DOM để
    // tránh forced reflow mỗi match.
    const tops = matches.map((r) => r.getBoundingClientRect().top + window.scrollY);
    // Pha GHI: tạo tick vào DocumentFragment rồi chèn một lần.
    const frag = document.createDocumentFragment();
    tops.forEach((top, i) => {
      const tick = document.createElement('div');
      tick.className = 'search-tick' + (i === current ? ' current' : '');
      tick.style.top = `${(top / docHeight) * 100}%`;
      tick.title = `Kết quả ${i + 1}`;
      tick.addEventListener('mousedown', (e) => e.preventDefault());
      tick.addEventListener('click', () => setCurrent(i, true));
      frag.appendChild(tick);
    });
    overview.appendChild(frag);
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
      count.textContent = 'Không có';
    } else {
      count.textContent = `${current + 1}/${matches.length}`;
    }
    count.classList.toggle('no-result', !!query && matches.length === 0);
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
      window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
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
    matches = computeMatches(q);
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
    clearHighlights();
    matches = [];
    current = -1;
    query = '';
    count.textContent = '';
    content.focus();
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
  });

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
  };
}
