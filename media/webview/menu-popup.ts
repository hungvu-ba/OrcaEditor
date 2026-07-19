/**
 * Shared placement + scroll-lock for handle menus (bug General R2). Both the block/table handle
 * menu (drag-drop.ts) and the table row handle menu (table.ts) open the same kind of
 * `.dd-menu-popup` next to a selected element; this module keeps them placing consistently —
 * clear of their own selected block/row, inside the viewport, and never over the sticky
 * `#toolbar` — and locks page scroll while any of them is open.
 */

const MARGIN = 4;

/**
 * Position `popup` (already `display:block`, so measurable) clear of `targetRect` — the rect of
 * the selected element the menu belongs to (a block, a `<table>`, or a `<tr>`). Opens just below
 * the target, flips above only when there's room above the toolbar, left-aligns to the target,
 * and clamps fully inside the viewport and below `#toolbar`'s bottom (read live — its height
 * varies with wrapping/zoom). A top-level block spans nearly the full editor width, so there's
 * no room to the side: below/above is the only non-overlapping placement.
 */
export function positionMenuClearOf(popup: HTMLElement, targetRect: DOMRect): void {
  const w = popup.offsetWidth;
  const h = popup.offsetHeight;
  const toolbarBottom = document.getElementById('toolbar')?.getBoundingClientRect().bottom ?? 0;
  const minTop = toolbarBottom + MARGIN;
  const maxTop = window.innerHeight - h - MARGIN;
  const left = Math.max(MARGIN, Math.min(targetRect.left, window.innerWidth - w - MARGIN));
  let top = targetRect.bottom + MARGIN;
  if (top > maxTop) {
    // No room below — try above the target, but never above the toolbar.
    const above = targetRect.top - h - MARGIN;
    if (above >= minTop) {
      top = above;
    }
  }
  top = Math.max(minTop, Math.min(top, maxTop));
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

// --- Page scroll lock while a handle menu is open (bug General R2 #3) ---------------------------
// Ref-counted so the block menu and the row menu can each lock/unlock without unbalancing the
// other; a stray double-close can't leave the page permanently frozen (the counter floors at 0).

let scrollLocks = 0;

function blockScroll(e: Event): void {
  // Let the popup's own overflow scroll (a long "Move to…" list); freeze everything else.
  if (!(e.target as Element | null)?.closest?.('.dd-menu-popup')) {
    e.preventDefault();
  }
}

export function lockPageScroll(): void {
  if (scrollLocks++ === 0) {
    window.addEventListener('wheel', blockScroll, { passive: false, capture: true });
    window.addEventListener('touchmove', blockScroll, { passive: false, capture: true });
  }
}

export function unlockPageScroll(): void {
  if (scrollLocks === 0) {
    return;
  }
  if (--scrollLocks === 0) {
    window.removeEventListener('wheel', blockScroll, { capture: true });
    window.removeEventListener('touchmove', blockScroll, { capture: true });
  }
}
