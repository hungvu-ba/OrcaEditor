/**
 * Tiện ích dùng chung để quét văn bản trong #content thành một chuỗi phẳng
 * ("haystack") kèm bản đồ segment, và tìm/dựng lại Range cho các match.
 *
 * Dùng chung bởi search.ts (Ctrl+F) và select-highlight.ts (highlight khi
 * bôi đen văn bản) — tách ra đây để hai tính năng không phân kỳ logic.
 */

/**
 * Ranh giới khối: một match không được nối ngang qua ranh giới này (tránh
 * cụm "…đoạn A" + "đoạn B…" bị coi là một match vắt qua hai khối). Trong cùng
 * một khối, các text node nội tuyến (do <strong>, <em>, <code>… tách ra) vẫn
 * được nối liền nên "Last **Con**voy" tìm "Convoy" vẫn khớp.
 */
import { findTextMatches, type MatchOptions } from '../../src/shared/text-match';

const BLOCK_SEL = 'p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,dt,dd,figcaption,summary,hr,div';

export interface Segment {
  node: Text;
  /** Offset đầu của node trong chuỗi haystack ghép chung. */
  start: number;
  len: number;
}

export interface Haystack {
  haystack: string;
  segs: Segment[];
}

/** Quét #content (hoặc bất kỳ container nào) thành haystack + segments, tôn trọng ranh giới khối. */
export function collectHaystack(content: HTMLElement): Haystack {
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
  return { haystack, segs };
}

/** Chuyển offset [gStart, gEnd) trong haystack thành Range sống trong DOM. Trả null nếu không dựng được. */
export function rangeAt(segs: Segment[], gStart: number, gEnd: number): Range | null {
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

/**
 * Tìm mọi match của q trong haystack/segs theo `options` (Match Case / Whole
 * Word — C4), không chồng lấn, cap maxMatches (mặc định 5000).
 *
 * Offset-finding uỷ cho lõi thuần findTextMatches (src/shared/text-match.ts,
 * dùng chung với host provider.ts để logic ranh giới từ không phân kỳ), rồi
 * dựng lại Range qua rangeAt như cũ. `options` mặc định substring +
 * case-insensitive (giữ đúng hành vi cũ cho call site chưa truyền — nhưng các
 * call site đều truyền tường minh, xem search.ts/select-highlight.ts).
 */
export function findMatches(
  haystack: string,
  segs: Segment[],
  query: string,
  options: MatchOptions = { matchCase: false, wholeWord: false },
  maxMatches = 5000
): Range[] {
  const found: Range[] = [];
  if (!query) {
    return found;
  }
  const offsets = findTextMatches(haystack, query, options, maxMatches);
  for (const { start, end } of offsets) {
    const r = rangeAt(segs, start, end);
    if (r) {
      found.push(r);
    }
  }
  return found;
}

export interface OverviewTicksOptions {
  /** Container để dựng tick vào (vd #search-overview / #select-overview). Bị ẩn (hidden=true) khi matches rỗng. */
  container: HTMLElement;
  /** Danh sách match cần vẽ tick. */
  matches: Range[];
  /** CSS class gán cho mỗi tick (vd 'search-tick' / 'select-tick') — mỗi caller dùng class riêng để style độc lập. */
  tickClass: string;
  /** Index của match "hiện tại" để style khác biệt (thêm class 'current'). -1 (mặc định) = không có khái niệm current. */
  current?: number;
  /**
   * Số tick tối đa dựng mỗi lần rebuild (mặc định không giới hạn — giữ đúng hành vi Ctrl+F hiện có,
   * vốn đã cap số match ở findMatches). Feature A truyền cap thấp hơn (500) vì build tick DOM +
   * getBoundingClientRect() mỗi match có thể nặng nếu chạy trên rất nhiều match — xem
   * SELECT_OVERVIEW_THROTTLE_MS/select-highlight.ts. Nếu matches.length vượt cap, chỉ dựng tick cho
   * phần đầu và console.warn (không silent-cap).
   */
  maxTicks?: number;
  /** Handler click cho mỗi tick (nhận index). Bỏ trống ⇒ tick không tương tác (không cursor:pointer nào được gán ở đây, tự lo bằng CSS). */
  onTickClick?: (index: number) => void;
}

/**
 * Dựng/replace tick DOM trong `container`, một tick cho mỗi Range trong `matches`, định vị bằng
 * `rect.top + window.scrollY` chia cho chiều cao tài liệu (tính theo %). Dùng chung bởi search.ts
 * (Ctrl+F, có click-to-jump + tick "current") và select-highlight.ts (Feature A, chỉ báo trực quan
 * thuần, không click-to-jump, không khái niệm "current").
 */
export function buildOverviewTicks(options: OverviewTicksOptions): void {
  const { container, matches, tickClass, current = -1, maxTicks = Infinity, onTickClick } = options;
  container.textContent = '';
  if (!matches.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const docHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
    1
  );
  const capped = matches.length > maxTicks;
  const list = capped ? matches.slice(0, maxTicks) : matches;
  if (capped) {
    // Không silent-cap: log rõ đã cắt bớt tick overview để dễ chẩn đoán khi file quá dài/quá nhiều match.
    console.warn(
      `[match-utils] buildOverviewTicks: ${matches.length} match nhưng chỉ dựng ${maxTicks} tick đầu (đã cắt bớt để tránh rebuild quá nặng).`
    );
  }
  // Pha ĐỌC: gom mọi getBoundingClientRect() trước, không xen ghi DOM để
  // tránh forced reflow mỗi match.
  const tops = list.map((r) => r.getBoundingClientRect().top + window.scrollY);
  // Pha GHI: tạo tick vào DocumentFragment rồi chèn một lần.
  const frag = document.createDocumentFragment();
  tops.forEach((top, i) => {
    const tick = document.createElement('div');
    tick.className = tickClass + (i === current ? ' current' : '');
    tick.style.top = `${(top / docHeight) * 100}%`;
    tick.title = `Result ${i + 1}`;
    if (onTickClick) {
      tick.addEventListener('mousedown', (e) => e.preventDefault());
      tick.addEventListener('click', () => onTickClick(i));
    }
    frag.appendChild(tick);
  });
  container.appendChild(frag);
}

/**
 * Tạo phần tử "viewport band" — dải mờ trên thước overview đánh dấu vùng tài liệu đang nằm trong
 * khung nhìn, cập nhật theo scroll (độc lập với việc rebuild tick theo match/resize). Là phần tử
 * RIÊNG, không nằm trong container tick (#search-overview/#select-overview) vì buildOverviewTicks()
 * xoá sạch container.textContent mỗi lần rebuild — nếu band là con của container sẽ bị xoá theo.
 * Caller tự đồng bộ `band.hidden` với `container.hidden` (band chỉ có ý nghĩa khi thước đang hiện).
 */
export function createViewportBand(id: string): HTMLElement {
  const band = document.createElement('div');
  band.id = id;
  band.hidden = true;
  document.body.appendChild(band);
  return band;
}

/** Cập nhật top/height (%) của band theo scrollY/innerHeight hiện tại so với chiều cao tài liệu. */
export function updateViewportBand(band: HTMLElement): void {
  const docHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 1);
  const top = (window.scrollY / docHeight) * 100;
  const height = Math.min(100 - top, (window.innerHeight / docHeight) * 100);
  band.style.top = `${top}%`;
  band.style.height = `${Math.max(height, 0)}%`;
}
