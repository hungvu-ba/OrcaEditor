/**
 * Tiện ích DOM portable dùng chung nhiều nơi trong pipeline (chạy được cả trên
 * Node/domino cho round-trip test lẫn trong webview trình duyệt).
 */

/** Thay cho Element.closest — domino (DOM của turndown trên Node) không chắc hỗ trợ. */
export function hasAncestor(node: Node, predicate: (el: Element) => boolean): boolean {
  return getAncestor(node, predicate) !== null;
}

export function getAncestor(node: Node, predicate: (el: Element) => boolean): Element | null {
  let cur: Node | null = node.parentNode;
  while (cur) {
    if (cur.nodeType === 1 && predicate(cur as Element)) {
      return cur as Element;
    }
    cur = cur.parentNode;
  }
  return null;
}
