/**
 * Đọc data-line/data-line-end trên một node đã render, kể cả khi attr nằm ở
 * phần tử CON thay vì chính nó (fence markdown-it đặt attr lên <code> bên
 * trong <pre> — xem comment trong render.ts). Dùng chung bởi gutter.ts (đánh
 * số dòng) và block-map.ts (Block Map, HLR mục 18) để không có hai bản
 * dò-cấp-con khác nhau cho cùng một vấn đề.
 */
import { LINE_NUMBER_ATTR, LINE_NUMBER_END_ATTR, type LineRange } from './render';

export function ownOrNestedAttr(el: Element, attr: string): string | null {
  return el.getAttribute(attr) ?? el.querySelector(`[${attr}]`)?.getAttribute(attr) ?? null;
}

/**
 * srcRange (1-based, bao gồm) đọc trực tiếp từ DOM đã render. Trả về null nếu
 * `el` không có data-line — trường hợp duy nhất là <p> "caret-trap" tự chèn
 * (ensureTrailingParagraph/ensureCaretSpotAfterAtomBlocks trong main.ts), vốn
 * không phải block markdown thật (bị turndown bỏ khi lưu, rule emptyParagraph).
 */
export function readSrcRange(el: Element): LineRange | null {
  return srcRangeOf(ownOrNestedAttr(el, LINE_NUMBER_ATTR), ownOrNestedAttr(el, LINE_NUMBER_END_ATTR));
}

/**
 * srcRange from `el`'s OWN attributes only — no descendant fallback.
 *
 * The fallback above is right for a top-level block (a fence keeps its attrs on
 * the inner <code>), but wrong for an intermediate container: a nested
 * <blockquote> carries no data-line of its own, so reading through to a
 * descendant hands back the line of some node INSIDE it — a bullet below the
 * quoted paragraph, not an ancestor's line. Anything walking UP a subtree must
 * use this one (block-map.ts's comment-anchor line resolution).
 */
export function readOwnSrcRange(el: Element): LineRange | null {
  return srcRangeOf(el.getAttribute(LINE_NUMBER_ATTR), el.getAttribute(LINE_NUMBER_END_ATTR));
}

function srcRangeOf(start: string | null, end: string | null): LineRange | null {
  if (!start) {
    return null;
  }
  return { start: Number(start), end: Number(end ?? start) };
}
