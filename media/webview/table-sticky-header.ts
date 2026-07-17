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
 */
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

  /** Bảng đang được "dính" header (null = không bảng nào). */
  let activeTable: HTMLTableElement | null = null;
  /** Clone <table> chỉ chứa thead của activeTable — dựng lại khi đổi bảng/resize. */
  let cloneTable: HTMLTableElement | null = null;

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
   * chung (CSS #sticky-table-header bù màu nền/viền theo theme + palette).
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

  function update(): void {
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

  // Cuộn trang dọc, cuộn ngang trong scroll island (bắt bằng capture vì sự kiện
  // scroll không nổi bọt), resize panel → tính lại vị trí/độ rộng cột.
  window.addEventListener('scroll', update, { passive: true });
  content.addEventListener('scroll', update, { capture: true, passive: true });
  window.addEventListener('resize', () => {
    // Resize đổi bề rộng cột → buộc dựng lại clone.
    activeTable = null;
    update();
  });

  return {
    refresh(): void {
      // DOM bảng vừa dựng lại — clone cũ trỏ node đã mất, tính lại từ đầu.
      hide();
      update();
    },
  };
}
