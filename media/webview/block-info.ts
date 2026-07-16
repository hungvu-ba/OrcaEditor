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
  const start = ownOrNestedAttr(el, LINE_NUMBER_ATTR);
  if (!start) {
    return null;
  }
  const end = ownOrNestedAttr(el, LINE_NUMBER_END_ATTR);
  return { start: Number(start), end: Number(end ?? start) };
}
