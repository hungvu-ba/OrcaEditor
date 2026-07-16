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
 * (SYNC_DEBOUNCE_MS): parse lại markdown vừa gõ (không render HTML, xem
 * MarkdownRenderer.computeTopLevelBlockRanges) để lấy range của từng block cấp
 * cao nhất, rồi khớp theo THỨ TỰ + "hình dạng" (list hay không, số item) từ
 * hai đầu tài liệu vào giữa (collectDomBlockGroups/shapeMatches bên dưới).
 * Vùng khớp được ghi số dòng mới bình thường; CHỈ vùng không khớp ở giữa (nơi
 * vừa gõ thêm/xoá bullet, hoặc tách/gộp block — hiếm) giữ số cũ tới lần
 * renderDocument() đầy đủ kế tiếp — bail-out thu hẹp ở mức "khối lệch", không
 * còn bỏ cả tài liệu như trước (HLR mục 18, US-18.1, GĐ1 Block-Indexed
 * Architecture — refreshFromMarkdown giờ là consumer đầu tiên hưởng lợi).
 */
import {
  LINE_NUMBER_ATTR,
  LINE_NUMBER_END_ATTR,
  MERMAID_CLASS,
  MATH_BLOCK_CLASS,
  type LineRange,
  type MarkdownRenderer,
  type TopLevelBlockRange,
} from './pipeline';
import { collectHaystack, rangeAt } from './match-utils';
import { ownOrNestedAttr } from './block-info';
import { scrollBehavior } from './dom-utils';

export interface LineGutter {
  /** Dựng lại toàn bộ (số + vị trí) từ chính data-line có sẵn trên DOM — gọi sau renderDocument(). */
  refreshFromDom(): void;
  /** Parse lại markdown (không render HTML) để lấy range dòng mới, khớp theo thứ tự với DOM hiện có — gọi sau debounce edit. */
  refreshFromMarkdown(markdown: string): void;
  /** Dựng lại vị trí (và phân loại đơn/đôi) theo layout hiện tại — gọi khi layout đổi (resize, ảnh/SVG tải xong, toggle mermaid...). */
  reposition(): void;
  /**
   * Scroll #content sao cho block chứa dòng nguồn 1-based `line` vào view. Trả về true nếu tìm thấy block khớp.
   * Nếu truyền thêm `character`/`length` (0-based, cùng quy ước CrossFileMatch) VÀ block khớp chỉ trải đúng
   * một dòng nguồn (block đơn dòng — đa số đoạn văn/list item/heading), còn select luôn đoạn văn bản đó
   * (C6, chốt #2: "chỉ scroll" là chưa đủ, cần select để thấy ngay kết quả tìm được). Block trải nhiều dòng
   * nguồn (info.start !== info.end, vd đoạn văn xuống dòng mềm) bị bỏ qua phần select — không đủ dữ liệu để
   * ánh xạ character của MỘT dòng con về offset trong text đã ghép phẳng của cả block.
   * `matchText` (raw markdown đã khớp) là MỎ NEO ưu tiên để định vị đoạn cần select — xem selectWithinBlock.
   */
  scrollToSourceLine(line: number, character?: number, length?: number, matchText?: string): boolean;
}

const NOOP_GUTTER: LineGutter = {
  refreshFromDom: () => {},
  refreshFromMarkdown: () => {},
  reposition: () => {},
  scrollToSourceLine: () => false,
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

  /** Một block cấp cao nhất hiện có trên DOM — `lis` khác null nếu là <ul>/<ol>. */
  interface DomBlockGroup {
    el: HTMLElement;
    lis: HTMLElement[] | null;
  }

  /** Con trực tiếp của #content CÓ data-line — bỏ qua <p> caret-trap tự chèn (main.ts), không phải block markdown thật. */
  function collectDomBlockGroups(): DomBlockGroup[] {
    const groups: DomBlockGroup[] = [];
    for (const child of Array.from(content.children) as HTMLElement[]) {
      if (!ownOrNestedAttr(child, LINE_NUMBER_ATTR)) {
        continue;
      }
      const isList = child.tagName === 'UL' || child.tagName === 'OL';
      groups.push({ el: child, lis: isList ? (Array.from(child.querySelectorAll('li')) as HTMLElement[]) : null });
    }
    return groups;
  }

  /** "Hình dạng" (list hay không, số lượng item) khớp — đủ tin cậy để ghi lại số dòng mới cho block này. */
  function shapeMatches(dom: DomBlockGroup, group: TopLevelBlockRange): boolean {
    const domIsList = dom.lis !== null;
    const groupIsList = group.itemRanges !== undefined;
    if (domIsList !== groupIsList) {
      return false;
    }
    return !domIsList || dom.lis!.length === group.itemRanges!.length;
  }

  function writeRange(el: HTMLElement, range: LineRange): void {
    // Ghi số dòng mới TRỞ LẠI DOM: các <li> gõ thêm trong lúc soạn (Enter tạo
    // mục mới) KHÔNG có data-line — chỉ markdown-it lúc render mới gắn. Nếu
    // không ghi lại, refreshFromDom (ResizeObserver bắn mỗi lần layout đổi khi
    // gõ) đọc data-line rỗng của các mục mới và bỏ số của chúng, ghi đè lên kết
    // quả parse đúng ở đây → list gõ thêm chỉ hiện số của các mục cũ.
    el.setAttribute(LINE_NUMBER_ATTR, String(range.start));
    el.setAttribute(LINE_NUMBER_END_ATTR, String(range.end));
  }

  function applyGroupRanges(doms: DomBlockGroup[], groups: TopLevelBlockRange[]): void {
    doms.forEach((dom, i) => {
      const group = groups[i];
      if (!group) {
        return;
      }
      if (dom.lis) {
        dom.lis.forEach((li, k) => {
          const item = group.itemRanges?.[k];
          if (item) {
            writeRange(li, item);
          }
        });
      } else {
        writeRange(dom.el, group.range);
      }
    });
  }

  function refreshFromMarkdown(markdown: string): void {
    const renderer = getRenderer();
    if (!renderer) {
      return;
    }
    const groups = renderer.computeTopLevelBlockRanges(markdown);
    const doms = collectDomBlockGroups();
    // Khớp theo THỨ TỰ + "hình dạng" (list hay không, số item) từ hai đầu tài
    // liệu vào giữa. Vùng khớp được (đầu/cuối) ghi số dòng mới bình thường;
    // vùng KHÔNG khớp ở giữa (nơi vừa gõ thêm/xoá bullet, hoặc tách/gộp block)
    // giữ số cũ tới lần renderDocument() đầy đủ kế tiếp — thu hẹp bail-out từ
    // "cả tài liệu" (cơ chế cũ) xuống "chỉ vùng lệch".
    let i = 0;
    let j = 0;
    while (i < doms.length && j < groups.length && shapeMatches(doms[i], groups[j])) {
      i++;
      j++;
    }
    let ie = doms.length - 1;
    let je = groups.length - 1;
    while (ie >= i && je >= j && shapeMatches(doms[ie], groups[je])) {
      ie--;
      je--;
    }
    applyGroupRanges(doms.slice(0, i), groups.slice(0, j));
    applyGroupRanges(doms.slice(ie + 1), groups.slice(je + 1));
    refreshFromDom();
  }

  // Danh sách phần tử được đánh số, theo thứ tự tài liệu. Mỗi block cấp cao
  // nhất là MỘT phần tử, RIÊNG danh sách (<ul>/<ol>) được tách thành từng <li>
  // (mọi độ sâu) để mỗi dòng bullet có số riêng — dùng bởi refreshFromDom (đọc
  // thẳng data-line hiện có trên DOM, không parse markdown) và scrollToSourceLine.
  // Mỗi <li> đã được gắn data-line lúc render nên readBlockInfo đọc được số
  // dòng của chính nó.
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

  // C6: dùng khi mở kết quả tìm xuyên file / cross-file link trỏ tới file .md
  // này — cần scroll tới đúng block chứa dòng nguồn được yêu cầu, tái dùng
  // đúng cơ chế ánh xạ dòng→DOM đã có (enumerateNumberedElements/readBlockInfo)
  // thay vì viết lại từ đầu; hoạt động bất kể gutter số dòng có đang bật hiển
  // thị hay không (data-line/data-line-end luôn có trên DOM sau render).
  /**
   * Select đúng đoạn đã khớp bên trong block `el` (đã render).
   *
   * KHÔNG dùng thẳng offset thô [character, character+length): `character` được
   * host tính trên DÒNG MARKDOWN GỐC (còn `#`, `**`, `- `, số thứ tự...), còn
   * haystack ở đây là text ĐÃ RENDER (cú pháp markdown đã bị strip), nên hai hệ
   * toạ độ lệch nhau — áp offset thô sẽ highlight lệch vị trí (bug #2, vd tìm
   * "Text" trong "## 2. Text Styles" bị nhảy thành "t St").
   *
   * Thay vào đó dùng `matchText` (đúng đoạn text đã khớp) làm MỎ NEO: tìm mọi
   * lần xuất hiện của nó trong haystack rồi chọn cái GẦN offset thô nhất (raw và
   * rendered thường chỉ lệch nhau một hằng số nhỏ = độ dài tiền tố bị strip, nên
   * occurrence gần nhất gần như luôn đúng). Chỉ khi không có matchText / không
   * tìm thấy (vd đoạn khớp chứa cú pháp markdown đã bị strip khi render) mới lùi
   * về offset thô như trước.
   */
  function selectWithinBlock(el: HTMLElement, character: number, length: number, matchText?: string): void {
    const { haystack, segs } = collectHaystack(el);
    let gStart = character;
    let gEnd = character + length;

    const anchor = matchText?.trim() ? matchText : '';
    if (anchor) {
      const occurrences: number[] = [];
      for (let i = haystack.indexOf(anchor); i !== -1; i = haystack.indexOf(anchor, i + 1)) {
        occurrences.push(i);
      }
      if (occurrences.length > 0) {
        // Occurrence có |index - character| nhỏ nhất — khử nhập nhằng khi đoạn
        // text khớp xuất hiện nhiều lần trong cùng block.
        let best = occurrences[0];
        for (const i of occurrences) {
          if (Math.abs(i - character) < Math.abs(best - character)) {
            best = i;
          }
        }
        gStart = best;
        gEnd = best + anchor.length;
      }
    }

    const range = rangeAt(segs, gStart, Math.min(gEnd, haystack.length));
    if (!range) {
      return;
    }
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // preventScroll: focus/selection không được tự ý cuộn — scrollIntoView
    // smooth ở scrollToSourceLine (chạy SAU, xem lý do thứ tự ở đó) mới là
    // nguồn cuộn duy nhất, tránh bug "nhảy về vị trí caret cũ" khi kết quả
    // search nằm ngoài viewport (focus() mặc định tự cuộn ngay lập tức và
    // cắt ngang animation smooth đang chạy dở).
    content.focus({ preventScroll: true });
  }

  function scrollToSourceLine(line: number, character?: number, length?: number, matchText?: string): boolean {
    const els = enumerateNumberedElements();
    if (els.length === 0) {
      return false;
    }
    let exactMatch: HTMLElement | undefined;
    let exactMatchInfo: BlockLineInfo | undefined;
    let closest: HTMLElement | undefined;
    let closestDistance = Infinity;
    for (const el of els) {
      const info = readBlockInfo(el);
      if (!info.start) {
        continue;
      }
      const start = Number(info.start);
      const end = info.end ? Number(info.end) : start;
      if (Number.isNaN(start)) {
        continue;
      }
      if (line >= start && line <= end) {
        exactMatch = el;
        exactMatchInfo = info;
        break;
      }
      const distance = Math.abs(start - line);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = el;
      }
    }
    const target = exactMatch ?? closest;
    if (!target) {
      return false;
    }
    // Chỉ select khi block khớp CHÍNH XÁC dòng nguồn (không phải fallback "gần nhất").
    // Có `matchText` → tìm theo mỏ neo text nên select được cả block đa dòng (start !== end);
    // không có matchText thì vẫn giới hạn ở block đơn dòng như cũ (offset thô chỉ đáng tin khi
    // block trải đúng MỘT dòng nguồn — xem selectWithinBlock).
    // Set selection TRƯỚC rồi mới scrollIntoView SAU CÙNG: nếu scroll trước,
    // focus()/addRange() theo sau có thể tự cuộn (kể cả có preventScroll ở
    // Safari cũ) và cắt ngang animation smooth, khiến view "nhảy về" vị trí
    // caret cũ thay vì dừng đúng ở kết quả search mới.
    if (
      exactMatch &&
      exactMatchInfo &&
      character !== undefined &&
      length !== undefined &&
      length > 0 &&
      (!!matchText?.trim() || exactMatchInfo.start === exactMatchInfo.end)
    ) {
      selectWithinBlock(target, character, length, matchText);
    }
    target.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    return true;
  }

  return { refreshFromDom, refreshFromMarkdown, reposition: refreshFromDom, scrollToSourceLine };
}
