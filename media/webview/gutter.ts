/**
 * Gutter số dòng bên trái, giống raw text editor. Vì #content là WYSIWYG
 * contenteditable (không phải text thuần) nên số dòng gắn theo TỪNG BLOCK
 * cấp cao nhất (đoạn văn, heading, list, bảng, code, mermaid...), lấy từ
 * data-line/data-line-end do markdown-it gắn lúc render (xem pipeline.ts,
 * LINE_NUMBER_ATTR/LINE_NUMBER_END_ATTR) — là số dòng THẬT trong file
 * Markdown gốc, không phải số ước lượng.
 *
 * Phần lớn block hiển thị TUYẾN TÍNH (chiều cao tỉ lệ thuận với số dòng
 * nguồn) nên chỉ cần một số ở mép trên là đủ. Riêng những block bị "chuyển
 * đổi" sang một hình thức trình bày khác hẳn — biểu đồ Mermaid (chế độ
 * chart) và công thức KaTeX (math block) — chiều cao hiển thị không còn liên
 * quan gì tới số dòng mã nguồn (một dòng mã Mermaid có thể vẽ ra biểu đồ cao
 * cả trăm px, một công thức nhiều dòng có thể co lại thành một hàng). Với
 * nhóm này, gutter hiển thị HAI số: dòng bắt đầu ở mép TRÊN và dòng kết thúc
 * ở mép DƯỚI của block, để người dùng biết đúng phạm vi dòng nguồn tương ứng.
 *
 * Trong lúc gõ, DOM không được render lại (tránh mất caret/undo — xem
 * main.ts:renderDocument), nên data-line trên DOM cũ dần lệch so với nội dung
 * mới gõ. refreshFromMarkdown() được gọi cùng nhịp debounce với việc lưu file
 * (SYNC_DEBOUNCE_MS): parse lại markdown vừa gõ (không render HTML) để lấy
 * range dòng mới, rồi khớp theo THỨ TỰ với các con hiện có của #content. Nếu
 * số lượng lệch nhau (hiếm — cấu trúc DOM vừa đổi khác số block parse được),
 * bỏ qua đợt cập nhật đó, giữ số cũ tới lần renderDocument() đầy đủ kế tiếp.
 */
import {
  LINE_NUMBER_ATTR,
  LINE_NUMBER_END_ATTR,
  MERMAID_CLASS,
  MATH_BLOCK_CLASS,
  type LineRange,
  type MarkdownRenderer,
} from './pipeline';

export interface LineGutter {
  /** Dựng lại toàn bộ (số + vị trí) từ chính data-line có sẵn trên DOM — gọi sau renderDocument(). */
  refreshFromDom(): void;
  /** Parse lại markdown (không render HTML) để lấy range dòng mới, khớp theo thứ tự với DOM hiện có — gọi sau debounce edit. */
  refreshFromMarkdown(markdown: string): void;
  /** Dựng lại vị trí (và phân loại đơn/đôi) theo layout hiện tại — gọi khi layout đổi (resize, ảnh/SVG tải xong, toggle mermaid...). */
  reposition(): void;
}

const NOOP_GUTTER: LineGutter = {
  refreshFromDom: () => {},
  refreshFromMarkdown: () => {},
  reposition: () => {},
};

/** Block mà chiều cao hiển thị KHÔNG tỉ lệ với số dòng nguồn — cần số ở cả hai mép. */
function isDualBoundaryBlock(el: Element): boolean {
  if (el.classList.contains(MATH_BLOCK_CLASS)) {
    return true;
  }
  if (el.classList.contains(MERMAID_CLASS)) {
    // Ở view "code" (bấm nút chuyển đổi), khối hiện lại y hệt một code block
    // bình thường (1 dòng nguồn = 1 dòng hiển thị) — không cần số ở mép dưới.
    return el.getAttribute('data-mermaid-view') !== 'code';
  }
  return false;
}

function ownOrNestedAttr(el: Element, attr: string): string | null {
  return el.getAttribute(attr) ?? el.querySelector(`[${attr}]`)?.getAttribute(attr) ?? null;
}

interface BlockLineInfo {
  start: string | null;
  end: string | null;
  dual: boolean;
}

function readBlockInfo(el: Element): BlockLineInfo {
  return {
    start: ownOrNestedAttr(el, LINE_NUMBER_ATTR),
    end: ownOrNestedAttr(el, LINE_NUMBER_END_ATTR),
    dual: isDualBoundaryBlock(el),
  };
}

export function initLineGutter(
  content: HTMLElement,
  gutterElOrNull: HTMLElement | null,
  getRenderer: () => MarkdownRenderer | undefined
): LineGutter {
  if (!gutterElOrNull) {
    return NOOP_GUTTER;
  }
  const gutterEl = gutterElOrNull;

  function buildMarker(text: string, top: number, isEnd: boolean): HTMLElement {
    const marker = document.createElement('div');
    marker.className = isEnd ? 'md-line-number md-line-number-end' : 'md-line-number';
    marker.textContent = text;
    marker.style.top = `${top}px`;
    return marker;
  }

  function rebuildDom(children: HTMLElement[], infos: Array<BlockLineInfo | null>): void {
    const frag = document.createDocumentFragment();
    children.forEach((child, i) => {
      const info = infos[i];
      if (!info?.start) {
        return;
      }
      if (info.dual && info.end && info.end !== info.start) {
        frag.appendChild(buildMarker(info.start, child.offsetTop, false));
        frag.appendChild(buildMarker(info.end, child.offsetTop + child.offsetHeight, true));
      } else {
        frag.appendChild(buildMarker(info.start, child.offsetTop, false));
      }
    });
    gutterEl.replaceChildren(frag);
  }

  function refreshFromDom(): void {
    const els = enumerateNumberedElements();
    rebuildDom(
      els,
      els.map((el) => readBlockInfo(el))
    );
  }

  function refreshFromMarkdown(markdown: string): void {
    const renderer = getRenderer();
    if (!renderer) {
      return;
    }
    const ranges = renderer.computeTopLevelLineRanges(markdown);
    const els = enumerateNumberedElements();
    if (ranges.length !== els.length) {
      return;
    }
    const infos = els.map((el, i) => {
      const range: LineRange = ranges[i];
      const start = String(range.start);
      const end = String(range.end);
      // Ghi số dòng mới TRỞ LẠI DOM: các <li> gõ thêm trong lúc soạn (Enter tạo
      // mục mới) KHÔNG có data-line — chỉ markdown-it lúc render mới gắn. Nếu
      // không ghi lại, refreshFromDom (ResizeObserver bắn mỗi lần layout đổi khi
      // gõ) đọc data-line rỗng của các mục mới và bỏ số của chúng, ghi đè lên kết
      // quả parse đúng ở đây → list gõ thêm chỉ hiện số của các mục cũ.
      el.setAttribute(LINE_NUMBER_ATTR, start);
      el.setAttribute(LINE_NUMBER_END_ATTR, end);
      return {
        start,
        end,
        dual: isDualBoundaryBlock(el),
      };
    });
    rebuildDom(els, infos);
  }

  // Danh sách phần tử được đánh số, theo thứ tự tài liệu. Mỗi block cấp cao
  // nhất là MỘT phần tử, RIÊNG danh sách (<ul>/<ol>) được tách thành từng <li>
  // (mọi độ sâu) để mỗi dòng bullet có số riêng — phải khớp đúng thứ tự với
  // computeTopLevelLineRanges (renderer). Mỗi <li> đã được gắn data-line lúc
  // render nên readBlockInfo đọc được số dòng của chính nó.
  function enumerateNumberedElements(): HTMLElement[] {
    const els: HTMLElement[] = [];
    for (const child of Array.from(content.children) as HTMLElement[]) {
      if (child.tagName === 'UL' || child.tagName === 'OL') {
        child.querySelectorAll('li').forEach((li) => els.push(li as HTMLElement));
      } else {
        els.push(child);
      }
    }
    return els;
  }

  // Gom nhiều callback ResizeObserver trong cùng một frame lại thành một lần
  // refreshFromDom() qua requestAnimationFrame (nếu đã có rAF pending thì bỏ
  // qua) — tránh reflow/dựng lại gutter lặp lại nhiều lần trong 1 frame.
  let rafPending: number | undefined;
  const resizeObserver = new ResizeObserver(() => {
    if (rafPending !== undefined) {
      return;
    }
    rafPending = requestAnimationFrame(() => {
      rafPending = undefined;
      refreshFromDom();
    });
  });
  resizeObserver.observe(content);

  return { refreshFromDom, refreshFromMarkdown, reposition: refreshFromDom };
}
