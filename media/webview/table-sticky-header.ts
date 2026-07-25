/**
 * Sticky table header (HLR mục 19, US-19.14).
 *
 * Khi cuộn một bảng DÀI xuống quá dòng header, dòng tiêu đề cột (thead) "dính"
 * lại ngay dưới toolbar để user luôn đọc được tên cột đang so dữ liệu.
 *
 * Vì sao KHÔNG dùng `position: sticky` thuần: bảng ở đây là `display:block;
 * overflow-x:auto` (scroll island của US-19.3). `overflow-x:auto` biến chính
 * <table> thành scroll-container ở CẢ hai trục → `position:sticky` trên thead sẽ
 * neo theo scrollport của bảng (không cuộn dọc vì bảng cao đúng bằng nội dung),
 * nên header trôi mất theo trang thay vì dính. Giải pháp: 1 bản CLONE nổi
 * (position:fixed) của thead, đặt NGOÀI #content (không đụng contentEditable →
 * không lẫn vào serialize `.md`, roundtrip-safe), tự đồng bộ:
 *   - vị trí ngang (left) + bề rộng cột với bảng thật,
 *   - scroll ngang trong scroll island (translateX theo table.scrollLeft),
 *   - ẩn/hiện theo việc header bảng đã trôi qua vạch sticky (dưới toolbar) chưa.
 *
 * US-19.24: cùng controller còn quản lý 1 THANH CUỘN NGANG NỔI (#sticky-table-
 * scrollbar) ghim đáy viewport, khớp cột bảng đang xem — để bảng vừa rộng vừa
 * dài không phải cuộn xuống tận đáy mới với tới thanh cuộn ngang gốc (nằm ở đáy
 * scroll island). Là 1 "scroll-proxy" (khung overflow-x:auto + spacer rộng đúng
 * scrollWidth) đồng bộ 2 chiều với table.scrollLeft; cũng dựng ngoài #content
 * nên roundtrip-safe. Ẩn khi bảng không tràn ngang / ra khỏi viewport / khi
 * thanh cuộn gốc ở đáy bảng đã lọt vào màn hình.
 */

/** Chiều cao thanh cuộn nổi (US-19.24) — GIỮ ĐỒNG BỘ với `#sticky-table-scrollbar
 * { height }` trong markdown.css. Dùng làm biên: chỉ hiện thanh nổi khi đáy bảng
 * (và thanh cuộn ngang gốc nằm ở đó) còn ở dưới vạch này, để 2 thanh không chồng
 * nhau trong dải ~14px sát đáy viewport (edge-case review). */
const FLOATING_HSCROLL_HEIGHT = 14;

export interface StickyTableHeaderController {
  /** Gọi sau mỗi renderDocument() — DOM bảng đã đổi, bỏ cache clone + tính lại. */
  refresh(): void;
}

export function initStickyTableHeader(
  content: HTMLElement,
  toolbarEl: HTMLElement
): StickyTableHeaderController {
  const floatEl = document.createElement('div');
  floatEl.id = 'sticky-table-header';
  document.body.appendChild(floatEl);

  // US-19.24: thanh cuộn ngang NỔI. Scroll-proxy — khung overflow-x:auto ghim đáy
  // viewport, bên trong 1 spacer rộng đúng scrollWidth của bảng → sinh scrollbar
  // native (kéo được, đúng theme) mà khỏi tự tính/vẽ thumb.
  const scrollbarEl = document.createElement('div');
  scrollbarEl.id = 'sticky-table-scrollbar';
  const scrollbarSpacer = document.createElement('div');
  scrollbarEl.appendChild(scrollbarSpacer);
  document.body.appendChild(scrollbarEl);

  /** Bảng đang được "dính" header (null = không bảng nào). */
  let activeTable: HTMLTableElement | null = null;
  /** Clone <table> chỉ chứa thead của activeTable — dựng lại khi đổi bảng/resize. */
  let cloneTable: HTMLTableElement | null = null;
  /** Bảng mà thanh cuộn nổi (US-19.24) đang điều khiển (null = ẩn). */
  let scrollTable: HTMLTableElement | null = null;

  /** Vạch sticky = đáy toolbar trong viewport (0 khi toolbar bị ẩn — Zen mode). */
  function stickyTop(): number {
    const b = toolbarEl.getBoundingClientRect().bottom;
    return b > 0 ? b : 0;
  }

  /**
   * Chọn bảng cần dính header: bảng có dòng header đã trôi lên tới/qua vạch
   * sticky NHƯNG thân bảng vẫn còn dưới vạch (còn dữ liệu để đọc). Nếu nhiều
   * bảng thỏa (bảng dài xếp chồng), lấy bảng có mép trên THẤP nhất (bảng dưới
   * cùng đang che vạch) để header hiển thị đúng bảng người dùng đang đọc.
   */
  function pickTable(top: number): { table: HTMLTableElement; headH: number; rect: DOMRect } | null {
    let best: { table: HTMLTableElement; headH: number; rect: DOMRect } | null = null;
    for (const table of Array.from(content.querySelectorAll('table'))) {
      const thead = table.tHead;
      if (!thead) {
        continue;
      }
      const rect = table.getBoundingClientRect();
      const headH = thead.getBoundingClientRect().height;
      if (headH <= 0) {
        continue;
      }
      // Header đã lên tới/qua vạch, và còn ít nhất một dòng thân dưới header dính.
      if (rect.top <= top && rect.bottom > top + headH) {
        if (!best || rect.top > best.rect.top) {
          best = { table, headH, rect };
        }
      }
    }
    return best;
  }

  /**
   * Dựng lại clone thead cho `table`: khóa bề rộng từng cột theo bề rộng cột
   * THẬT đang render (table-layout:fixed) để header dính khớp cột thân bảng kể
   * cả khi scroll ngang. Đặt ngoài #content nên chỉ hưởng style `th`/`table`
   * chung (CSS #sticky-table-header bù màu nền/viền theo theme + reading mode).
   */
  function buildClone(table: HTMLTableElement): void {
    const thead = table.tHead!;
    const headerCells = Array.from(thead.rows[0]?.cells ?? []);
    const widths = headerCells.map((c) => c.getBoundingClientRect().width);

    const clone = document.createElement('table');
    clone.appendChild(thead.cloneNode(true));
    // Bề rộng nội dung bảng (kể cả phần tràn scroll ngang) để cột không co lại.
    const total = widths.reduce((a, b) => a + b, 0);
    clone.style.width = `${total}px`;

    const cloneCells = Array.from((clone.tHead?.rows[0]?.cells ?? []) as HTMLCollectionOf<HTMLTableCellElement>);
    cloneCells.forEach((c, i) => {
      const w = widths[i] ?? 0;
      c.style.width = `${w}px`;
      c.style.minWidth = `${w}px`;
      c.style.maxWidth = `${w}px`;
    });

    floatEl.replaceChildren(clone);
    cloneTable = clone;
  }

  function hide(): void {
    floatEl.classList.remove('visible');
    activeTable = null;
    cloneTable = null;
  }

  function updateHeader(): void {
    const top = stickyTop();
    const picked = pickTable(top);
    if (!picked) {
      hide();
      return;
    }
    const { table, headH, rect } = picked;
    if (table !== activeTable || !cloneTable) {
      activeTable = table;
      buildClone(table);
    }
    // Khung nổi bám mép trong (content box) của bảng, cao đúng dòng header, cắt
    // phần cột tràn ngoài scroll island (overflow:hidden trong CSS).
    floatEl.style.top = `${top}px`;
    floatEl.style.left = `${rect.left + table.clientLeft}px`;
    floatEl.style.width = `${table.clientWidth}px`;
    floatEl.style.height = `${headH}px`;
    if (cloneTable) {
      cloneTable.style.transform = `translateX(${-table.scrollLeft}px)`;
    }
    floatEl.classList.add('visible');
  }

  /**
   * US-19.24: chọn bảng cho thanh cuộn ngang NỔI (đáy viewport). Khác pickTable
   * (ngưỡng header trôi qua ĐỈNH): thanh cuộn cần hiện khi bảng TRÀN NGANG và
   * đáy bảng (nơi có thanh cuộn ngang gốc) còn nằm đủ sâu dưới màn hình để thanh
   * gốc CHƯA với tới. Trừ hẳn 1 chiều cao thanh nổi (FLOATING_HSCROLL_HEIGHT) để
   * không hiện chồng lên thanh gốc trong dải ~14px sát đáy. Nhiều bảng thỏa → lấy
   * bảng có mép trên thấp nhất (bảng đang chiếm đáy màn hình).
   */
  function pickScrollTable(viewportBottom: number): { table: HTMLTableElement; rect: DOMRect } | null {
    let best: { table: HTMLTableElement; rect: DOMRect } | null = null;
    for (const table of Array.from(content.querySelectorAll('table'))) {
      // Không tràn ngang → không cần thanh cuộn nổi.
      if (table.scrollWidth - table.clientWidth <= 1) {
        continue;
      }
      const rect = table.getBoundingClientRect();
      // Bảng đang trong tầm nhìn VÀ đáy (thanh cuộn gốc) còn sâu dưới vạch đáy hơn
      // một chiều cao thanh nổi → thanh gốc chưa lộ ra, mới cần thanh nổi (không
      // chồng 2 thanh trong dải sát đáy).
      if (rect.top < viewportBottom && rect.bottom > viewportBottom + FLOATING_HSCROLL_HEIGHT) {
        if (!best || rect.top > best.rect.top) {
          best = { table, rect };
        }
      }
    }
    return best;
  }

  function hideScrollbar(): void {
    scrollbarEl.classList.remove('visible');
    scrollTable = null;
  }

  function updateScrollbar(): void {
    const picked = pickScrollTable(window.innerHeight);
    if (!picked) {
      hideScrollbar();
      return;
    }
    const { table, rect } = picked;
    scrollTable = table;
    // Khớp mép trái + bề rộng KHUNG bảng (giống header dính); spacer rộng đúng bề
    // rộng NỘI DUNG (kể cả phần tràn) → tỉ lệ thumb = clientWidth/scrollWidth.
    scrollbarEl.style.left = `${rect.left + table.clientLeft}px`;
    scrollbarEl.style.width = `${table.clientWidth}px`;
    scrollbarSpacer.style.width = `${table.scrollWidth}px`;
    // Đồng bộ vị trí cuộn bảng → proxy. Chặn >1px để không ping-pong với handler
    // scroll của proxy bên dưới (nó ghi ngược proxy → bảng).
    if (Math.abs(scrollbarEl.scrollLeft - table.scrollLeft) > 1) {
      scrollbarEl.scrollLeft = table.scrollLeft;
    }
    scrollbarEl.classList.add('visible');
  }

  function update(): void {
    updateHeader();
    updateScrollbar();
  }

  // rAF coalescing: gộp mọi sự kiện scroll/resize trong 1 khung hình để các phép
  // đọc layout-forcing (getBoundingClientRect/clientWidth/scrollWidth/scrollLeft)
  // chỉ chạy 1 lần/khung (Known Traps — throttle layout reads trong hot handler).
  let rafPending = false;
  function scheduleUpdate(): void {
    if (rafPending) {
      return;
    }
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      update();
    });
  }

  // Kéo/cuộn thanh nổi → cuộn ngang bảng thật. Proxy nằm ngoài #content nên sự
  // kiện scroll của nó KHÔNG lọt vào listener capture bên dưới; đồng bộ ngược
  // (bảng → proxy) do updateScrollbar lo. Chặn >1px để không ping-pong.
  scrollbarEl.addEventListener(
    'scroll',
    () => {
      if (!scrollTable) {
        return;
      }
      if (Math.abs(scrollTable.scrollLeft - scrollbarEl.scrollLeft) > 1) {
        scrollTable.scrollLeft = scrollbarEl.scrollLeft;
      }
    },
    { passive: true }
  );

  // Cuộn trang dọc, cuộn ngang trong scroll island (bắt bằng capture vì sự kiện
  // scroll không nổi bọt), resize panel → tính lại vị trí/độ rộng cột.
  window.addEventListener('scroll', scheduleUpdate, { passive: true });
  content.addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });
  window.addEventListener('resize', () => {
    // Resize đổi bề rộng cột → buộc dựng lại clone.
    activeTable = null;
    scheduleUpdate();
  });

  return {
    refresh(): void {
      // DOM bảng vừa dựng lại — clone cũ trỏ node đã mất, tính lại từ đầu.
      hide();
      hideScrollbar();
      update();
    },
  };
}
