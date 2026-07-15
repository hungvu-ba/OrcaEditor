/**
 * Drag & drop reorder for top-level blocks (US-17.3) and list items
 * (US-17.5, M3) — HLR section 17.
 *
 * Undo mechanism (F1, spike decision): a move never mutates the DOM directly
 * (appendChild/insertBefore/remove) — that would desync the browser's native
 * undo stack the same way raw DOM surgery does for
 * fixOrphanNestedListItems/replaceBlockTag (main.ts / dom-utils.ts). Instead,
 * exactly like those two, a move selects a single Range spanning every
 * top-level block between the old and new position (inclusive) and replaces
 * it with ONE `execCommand('insertHTML', ...)` call carrying the same blocks
 * in their new order. One Range + one execCommand call = one native undo
 * step, regardless of how far the block travels or how many blocks a
 * section-move carries along.
 *
 * DOM stays the source of truth (architecture note in the code plan): the
 * live #content DOM is read fresh on every drag start, nothing is cached
 * across renders. Block Map (US-18.1) is intentionally NOT used here — it is
 * only rebuilt on full renderDocument() and can be stale mid-session; a move
 * only needs "current top-level children with a real markdown source range",
 * which is exactly what readSrcRange() (already shared with block-map.ts and
 * gutter.ts) tells us, filtered straight off content.children.
 */
import { readSrcRange } from './block-info';
import { MERMAID_CLASS, MATH_BLOCK_CLASS } from './pipeline';
import { isValidSiblingGap, computeSiblingMove, applySiblingMove } from './sibling-move';
import type { LineGutter } from './gutter';
import type { DomHelpers } from './dom-utils';

export interface DragDropDeps {
  scheduleSync: () => void;
  dom: DomHelpers;
  lineGutter: LineGutter;
}

export interface DragDropController {
  /** Call after #content is fully rebuilt (renderDocument) — drops any stale hover/drag state that referenced old nodes. */
  refresh(): void;
}

type DragState = 'idle' | 'armed' | 'dragging';
type DragKind = 'block' | 'li';
/** M3: horizontal drag past this threshold re-indents the list item IN PLACE instead of reordering it — a drag gesture is either a vertical reorder OR a horizontal indent/outdent, not a combined diagonal move (see drag-drop.ts M3 header note in the requirement doc for the scope call). */
type IndentDir = 'in' | 'out' | null;

const HEADING_RE = /^H([1-6])$/;
const DRAG_THRESHOLD_PX = 4;
const LIST_INDENT_THRESHOLD_PX = 32;
const AUTOSCROLL_EDGE_PX = 56;
const AUTOSCROLL_SPEED_PX = 16;
const AUTOSCROLL_INTERVAL_MS = 16;
const HANDLE_GLYPH = '⠿'; // ⠿

function headingLevel(el: Element): number | null {
  const m = HEADING_RE.exec(el.tagName);
  return m ? Number(m[1]) : null;
}

function isAtomBlock(el: Element): boolean {
  return el.classList.contains(MERMAID_CLASS) || el.classList.contains(MATH_BLOCK_CLASS);
}

/**
 * Section-move (F7 companion, also reused for TOC-drag — US-17.7/M5): dragging
 * a heading carries every following block up to (not including) the next
 * heading of the same or higher level — same "which level closes this
 * section" rule TOC would need for a tree, but TOC only builds a flat list
 * (toc.ts) so this lives here instead. Module-scope (not a closure over
 * `content`) so other callers can reuse it against their own block list.
 */
export function computeHeadingSectionSpan(startEl: HTMLElement, blocks: HTMLElement[]): HTMLElement[] {
  const startIdx = blocks.indexOf(startEl);
  const level = headingLevel(startEl);
  if (level === null) {
    return [startEl];
  }
  const span = [startEl];
  for (let i = startIdx + 1; i < blocks.length; i++) {
    const lvl = headingLevel(blocks[i]);
    if (lvl !== null && lvl <= level) {
      break;
    }
    span.push(blocks[i]);
  }
  return span;
}

/** Top-level children of `content` with a real markdown source range — excludes the trailing caret-trap <p> (same filter as block-map.ts). Exported for reuse (TOC-drag, US-17.7/M5). */
export function draggableTopLevelBlocks(content: HTMLElement): HTMLElement[] {
  return (Array.from(content.children) as HTMLElement[]).filter((el) => readSrcRange(el) !== null);
}

export function initDragDrop(content: HTMLElement, deps: DragDropDeps): DragDropController {
  function draggableBlocks(): HTMLElement[] {
    return draggableTopLevelBlocks(content);
  }

  /** Gap index g means "insert before blocks[g]" (g === blocks.length means "insert at the end"). */
  function gapAt(blocks: HTMLElement[], clientY: number): number {
    for (let i = 0; i < blocks.length; i++) {
      const r = blocks[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        return i;
      }
    }
    return blocks.length;
  }

  /** Performs the move (one execCommand call, via sibling-move.ts) and returns the moved block's new live element, for caret placement. */
  function performMove(span: HTMLElement[], blocks: HTMLElement[], gap: number): HTMLElement | null {
    const spanStartIdx = blocks.indexOf(span[0]);
    const spanEndIdx = spanStartIdx + span.length - 1;
    const result = computeSiblingMove(
      blocks,
      spanStartIdx,
      spanEndIdx,
      gap,
      (prev, cur) => isAtomBlock(prev) && isAtomBlock(cur)
    );
    return applySiblingMove(content, result);
  }

  // ---------------------------------------------------------------------
  // Hover handle
  // ---------------------------------------------------------------------

  const handleEl = document.createElement('div');
  handleEl.className = 'dd-handle';
  handleEl.textContent = HANDLE_GLYPH;
  handleEl.style.display = 'none';
  document.body.appendChild(handleEl);

  let hoveredBlock: HTMLElement | null = null;

  function findBlockAt(clientY: number): HTMLElement | null {
    const blocks = draggableBlocks();
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        return b;
      }
    }
    return null;
  }

  function positionHandle(block: HTMLElement | null): void {
    if (!block) {
      handleEl.style.display = 'none';
      menuBtnEl.style.display = 'none';
      return;
    }
    const contentRect = content.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    handleEl.style.display = 'flex';
    handleEl.style.top = `${blockRect.top}px`;
    handleEl.style.left = `${contentRect.left - 20}px`;
    menuBtnEl.style.display = 'flex';
    menuBtnEl.style.top = `${blockRect.top + 20}px`;
    menuBtnEl.style.left = `${contentRect.left - 20}px`;
  }

  // ---------------------------------------------------------------------
  // Handle menu (US-17.7, M5): click the ⋮ button (not a drag) → "Move up /
  // Move down / Move to <heading>…" — a mouse-only shortcut for long blocks
  // that would otherwise need a long drag (F11: no keyboard nav in MVP).
  // Reuses the exact same computeHeadingSectionSpan/sibling-move.ts primitives
  // as an actual drag — a menu move IS a drag, just with the gap picked from
  // a list instead of a drop-line position.
  // ---------------------------------------------------------------------

  const menuBtnEl = document.createElement('div');
  menuBtnEl.className = 'dd-menu-btn';
  menuBtnEl.textContent = '⋮';
  menuBtnEl.style.display = 'none';
  menuBtnEl.setAttribute('role', 'button');
  menuBtnEl.setAttribute('aria-label', 'Block actions');
  document.body.appendChild(menuBtnEl);

  const menuPopupEl = document.createElement('div');
  menuPopupEl.className = 'dd-menu-popup';
  menuPopupEl.style.display = 'none';
  document.body.appendChild(menuPopupEl);

  function isMenuOpen(): boolean {
    return menuPopupEl.style.display !== 'none';
  }

  function closeMenu(): void {
    menuPopupEl.style.display = 'none';
    menuPopupEl.replaceChildren();
  }

  function moveBlockToGap(block: HTMLElement, gap: number): void {
    const blocks = draggableBlocks();
    const idx = blocks.indexOf(block);
    if (idx < 0) {
      return;
    }
    const span = computeHeadingSectionSpan(block, blocks);
    const spanEndIdx = idx + span.length - 1;
    const clampedGap = Math.max(0, Math.min(gap, blocks.length));
    if (!isValidSiblingGap(clampedGap, idx, spanEndIdx)) {
      return;
    }
    const result = computeSiblingMove(blocks, idx, spanEndIdx, clampedGap, (prev, cur) => isAtomBlock(prev) && isAtomBlock(cur));
    applySiblingMove(content, result);
    deps.lineGutter.refreshFromDom();
    deps.scheduleSync();
  }

  function addMenuItem(label: string, disabled: boolean, onClick: () => void): void {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'dd-menu-item';
    item.textContent = label;
    item.disabled = disabled;
    item.addEventListener('click', () => {
      closeMenu();
      if (!disabled) {
        onClick();
      }
    });
    menuPopupEl.appendChild(item);
  }

  function openMenu(block: HTMLElement): void {
    closeMenu();
    const blocks = draggableBlocks();
    const idx = blocks.indexOf(block);
    if (idx < 0) {
      return;
    }
    const span = computeHeadingSectionSpan(block, blocks);
    const spanEndIdx = idx + span.length - 1;

    addMenuItem('Move up', idx === 0, () => moveBlockToGap(block, idx - 1));
    addMenuItem('Move down', spanEndIdx >= blocks.length - 1, () => moveBlockToGap(block, spanEndIdx + 2));

    const headings = blocks.filter((b) => headingLevel(b) !== null && !span.includes(b));
    if (headings.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'dd-menu-sep';
      menuPopupEl.appendChild(sep);
      const label = document.createElement('div');
      label.className = 'dd-menu-label';
      label.textContent = 'Move to…';
      menuPopupEl.appendChild(label);
      for (const h of headings) {
        const gapIdx = blocks.indexOf(h) + 1; // just after this heading's own line
        const text = (h.textContent ?? '').trim() || '(untitled)';
        addMenuItem(text, false, () => moveBlockToGap(block, gapIdx));
      }
    }

    const rect = menuBtnEl.getBoundingClientRect();
    menuPopupEl.style.display = 'block';
    menuPopupEl.style.top = `${rect.bottom + 4}px`;
    menuPopupEl.style.left = `${rect.left}px`;
  }

  menuBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!hoveredBlock) {
      return;
    }
    if (isMenuOpen()) {
      closeMenu();
    } else {
      openMenu(hoveredBlock);
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (isMenuOpen() && e.target !== menuBtnEl && !menuPopupEl.contains(e.target as Node)) {
      closeMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isMenuOpen()) {
      closeMenu();
    }
  });

  // ---------------------------------------------------------------------
  // List-item hover handle (US-17.5, M3) — independent of the block handle
  // above: hovering inside a list matches BOTH (the <ul>/<ol> is itself a
  // top-level block, AND the specific <li> under the cursor), so both
  // handles can show at once. They don't collide visually — the block
  // handle sits at a fixed offset from #content's own left edge (the
  // reserved gutter margin), while the li handle sits relative to that
  // specific <li>'s own (indented) left edge, which is further right for
  // any nested item and only close to the block handle for a depth-0 item.
  // ---------------------------------------------------------------------

  const liHandleEl = document.createElement('div');
  liHandleEl.className = 'dd-handle dd-li-handle';
  liHandleEl.textContent = HANDLE_GLYPH;
  liHandleEl.style.display = 'none';
  document.body.appendChild(liHandleEl);

  let hoveredLi: HTMLLIElement | null = null;

  /** elementFromPoint (not a rect scan like findBlockAt) so nested lists resolve to the INNERMOST <li> under the cursor, not an ancestor. */
  function findLiAt(clientX: number, clientY: number): HTMLLIElement | null {
    const el = document.elementFromPoint(clientX, clientY);
    const li = (el as HTMLElement | null)?.closest?.('li');
    return li && content.contains(li) ? (li as HTMLLIElement) : null;
  }

  function positionLiHandle(li: HTMLLIElement | null): void {
    if (!li) {
      liHandleEl.style.display = 'none';
      return;
    }
    const r = li.getBoundingClientRect();
    liHandleEl.style.display = 'flex';
    liHandleEl.style.top = `${r.top}px`;
    liHandleEl.style.left = `${r.left - 20}px`;
  }

  function onContentHover(e: MouseEvent): void {
    if (state !== 'idle') {
      return;
    }
    const block = findBlockAt(e.clientY);
    if (block !== hoveredBlock) {
      hoveredBlock = block;
      positionHandle(block);
    }
    const li = findLiAt(e.clientX, e.clientY);
    if (li !== hoveredLi) {
      hoveredLi = li;
      positionLiHandle(li);
    }
  }

  content.addEventListener('mousemove', onContentHover);
  content.addEventListener('mouseleave', () => {
    if (state === 'idle') {
      hoveredBlock = null;
      hoveredLi = null;
      positionHandle(null);
      positionLiHandle(null);
    }
  });

  // ---------------------------------------------------------------------
  // IME guard (F5)
  // ---------------------------------------------------------------------

  let isComposing = false;
  content.addEventListener('compositionstart', () => {
    isComposing = true;
  });
  content.addEventListener('compositionend', () => {
    isComposing = false;
  });

  // ---------------------------------------------------------------------
  // Drag state machine (F4: mousedown + threshold, not native draggable=true —
  // avoids fighting contentEditable's own drag handling)
  // ---------------------------------------------------------------------

  let state: DragState = 'idle';
  let kind: DragKind = 'block';
  let startX = 0;
  let startY = 0;
  let dragBlocks: HTMLElement[] = [];
  let dragSpan: HTMLElement[] = [];
  let currentGap = 0;
  let currentGapValid = false;

  // M3 list-item drag state — reuses the same ghost/drop-line/threshold/Esc
  // machinery above, just a different target shape (one <li> among its own
  // parent list's direct children, not a run of #content's top-level children).
  let liDragged: HTMLLIElement | null = null;
  let liParent: HTMLElement | null = null;
  let liSiblings: HTMLLIElement[] = [];
  let liIdx = -1;
  let liIndentDir: IndentDir = null;

  const ghostEl = document.createElement('div');
  ghostEl.className = 'dd-ghost';
  ghostEl.style.display = 'none';
  document.body.appendChild(ghostEl);

  const dropLineEl = document.createElement('div');
  dropLineEl.className = 'dd-drop-line';
  dropLineEl.style.display = 'none';
  document.body.appendChild(dropLineEl);

  let autoScrollTimer: ReturnType<typeof setInterval> | undefined;

  function stopAutoScroll(): void {
    if (autoScrollTimer !== undefined) {
      clearInterval(autoScrollTimer);
      autoScrollTimer = undefined;
    }
  }

  function maintainAutoScroll(clientY: number): void {
    const toolbarBottom = document.getElementById('toolbar')?.getBoundingClientRect().bottom ?? 0;
    const nearTop = clientY < toolbarBottom + AUTOSCROLL_EDGE_PX;
    const nearBottom = clientY > window.innerHeight - AUTOSCROLL_EDGE_PX;
    if (!nearTop && !nearBottom) {
      stopAutoScroll();
      return;
    }
    if (autoScrollTimer !== undefined) {
      return;
    }
    const dir = nearTop ? -1 : 1;
    autoScrollTimer = setInterval(() => window.scrollBy(0, dir * AUTOSCROLL_SPEED_PX), AUTOSCROLL_INTERVAL_MS);
  }

  function updateGhostPosition(clientX: number, clientY: number): void {
    ghostEl.style.left = `${clientX + 12}px`;
    ghostEl.style.top = `${clientY + 12}px`;
  }

  function updateBlockDropLine(clientY: number): void {
    const spanStartIdx = dragBlocks.indexOf(dragSpan[0]);
    const spanEndIdx = spanStartIdx + dragSpan.length - 1;
    const gap = gapAt(dragBlocks, clientY);
    currentGap = gap;
    currentGapValid = isValidSiblingGap(gap, spanStartIdx, spanEndIdx);
    if (!currentGapValid) {
      dropLineEl.style.display = 'none';
      return;
    }
    const contentRect = content.getBoundingClientRect();
    let y: number;
    if (gap === 0) {
      y = dragBlocks[0].getBoundingClientRect().top;
    } else if (gap === dragBlocks.length) {
      y = dragBlocks[dragBlocks.length - 1].getBoundingClientRect().bottom;
    } else {
      const prevBottom = dragBlocks[gap - 1].getBoundingClientRect().bottom;
      const nextTop = dragBlocks[gap].getBoundingClientRect().top;
      y = (prevBottom + nextTop) / 2;
    }
    dropLineEl.className = 'dd-drop-line';
    dropLineEl.style.display = 'block';
    dropLineEl.style.top = `${y}px`;
    dropLineEl.style.left = `${contentRect.left}px`;
    dropLineEl.style.width = `${contentRect.width}px`;
    dropLineEl.style.height = '2px';
  }

  /** gap index among `liSiblings` (mirrors gapAt, kept separate since the element list is per-drag, not a closure over `content`). */
  function liGapAt(clientY: number): number {
    for (let i = 0; i < liSiblings.length; i++) {
      const r = liSiblings[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        return i;
      }
    }
    return liSiblings.length;
  }

  /**
   * M3: horizontal drag past LIST_INDENT_THRESHOLD_PX switches to re-indent
   * mode — draws a short indent guide near the hovered item instead of a
   * full-width line, and drop() will call execCommand('indent'/'outdent')
   * (see performListIndent) instead of a sibling reorder. Reuses the native
   * indent/outdent mechanism already proven for Tab/Shift+Tab in main.ts
   * (including its DOM-quirk cleanup at serialize time, normalizeListDom) —
   * safer than hand-rolling custom nesting DOM surgery.
   */
  function updateLiDropLine(clientX: number, clientY: number): void {
    if (!liParent || !liDragged) {
      return;
    }
    const dx = clientX - startX;
    const gap = liGapAt(clientY);
    currentGap = gap;
    if (Math.abs(dx) > LIST_INDENT_THRESHOLD_PX) {
      liIndentDir = dx > 0 ? 'in' : 'out';
      currentGapValid =
        liIndentDir === 'in' ? liIdx > 0 : !!liParent.parentElement?.closest('li') && content.contains(liParent);
      if (!currentGapValid) {
        dropLineEl.style.display = 'none';
        return;
      }
      const anchor = liSiblings[Math.min(Math.max(gap, 0), liSiblings.length - 1)] ?? liDragged;
      const r = anchor.getBoundingClientRect();
      dropLineEl.className = 'dd-drop-line dd-indent-guide';
      dropLineEl.style.display = 'block';
      dropLineEl.style.top = `${r.top}px`;
      dropLineEl.style.left = `${r.left + (liIndentDir === 'in' ? 24 : -24)}px`;
      dropLineEl.style.width = '20px';
      dropLineEl.style.height = '2px';
      return;
    }
    liIndentDir = null;
    currentGapValid = isValidSiblingGap(gap, liIdx, liIdx);
    if (!currentGapValid || liSiblings.length === 0) {
      dropLineEl.style.display = 'none';
      return;
    }
    const parentRect = liParent.getBoundingClientRect();
    let y: number;
    if (gap === 0) {
      y = liSiblings[0].getBoundingClientRect().top;
    } else if (gap === liSiblings.length) {
      y = liSiblings[liSiblings.length - 1].getBoundingClientRect().bottom;
    } else {
      y = (liSiblings[gap - 1].getBoundingClientRect().bottom + liSiblings[gap].getBoundingClientRect().top) / 2;
    }
    dropLineEl.className = 'dd-drop-line';
    dropLineEl.style.display = 'block';
    dropLineEl.style.top = `${y}px`;
    dropLineEl.style.left = `${parentRect.left}px`;
    dropLineEl.style.width = `${parentRect.width}px`;
    dropLineEl.style.height = '2px';
  }

  function startDragging(): void {
    state = 'dragging';
    handleEl.style.display = 'none';
    menuBtnEl.style.display = 'none';
    closeMenu();
    liHandleEl.style.display = 'none';
    if (kind === 'block') {
      ghostEl.replaceChildren(dragSpan[0].cloneNode(true) as HTMLElement);
      if (dragSpan.length > 1) {
        const badge = document.createElement('div');
        badge.className = 'dd-ghost-badge';
        badge.textContent = String(dragSpan.length);
        ghostEl.appendChild(badge);
      }
      dragSpan.forEach((el) => el.classList.add('dd-source-muted'));
    } else if (liDragged) {
      ghostEl.replaceChildren(liDragged.cloneNode(true) as HTMLElement);
      liDragged.classList.add('dd-source-muted');
    }
    ghostEl.style.display = 'block';
    document.body.classList.add('dd-dragging');
  }

  function cleanupVisuals(): void {
    dragSpan.forEach((el) => el.classList.remove('dd-source-muted'));
    liDragged?.classList.remove('dd-source-muted');
    ghostEl.style.display = 'none';
    ghostEl.replaceChildren();
    dropLineEl.style.display = 'none';
    dropLineEl.className = 'dd-drop-line';
    document.body.classList.remove('dd-dragging');
    stopAutoScroll();
  }

  function resetState(): void {
    state = 'idle';
    kind = 'block';
    dragBlocks = [];
    dragSpan = [];
    currentGapValid = false;
    liDragged = null;
    liParent = null;
    liSiblings = [];
    liIdx = -1;
    liIndentDir = null;
    hoveredBlock = null;
    hoveredLi = null;
    document.removeEventListener('mousemove', onDocMouseMove);
    document.removeEventListener('mouseup', onDocMouseUp);
    document.removeEventListener('keydown', onDocKeyDown);
  }

  function finishBlockMove(): void {
    const movedEl = performMove(dragSpan, dragBlocks, currentGap);
    if (movedEl) {
      const r = document.createRange();
      r.selectNodeContents(movedEl);
      r.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      content.focus();
    }
  }

  /** Places the caret inside `li` then calls the native indent/outdent command — same mechanism as Tab/Shift+Tab in main.ts, including its existing Chromium DOM-quirk cleanup at serialize time. */
  function performListIndent(li: HTMLLIElement, dir: 'indent' | 'outdent'): void {
    const range = document.createRange();
    range.selectNodeContents(li);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    content.focus();
    document.execCommand(dir);
  }

  function finishLiMove(): void {
    if (!liParent || !liDragged) {
      return;
    }
    if (liIndentDir) {
      performListIndent(liDragged, liIndentDir === 'in' ? 'indent' : 'outdent');
      return;
    }
    const result = computeSiblingMove(liSiblings, liIdx, liIdx, currentGap);
    const movedEl = applySiblingMove(liParent, result);
    if (movedEl) {
      const r = document.createRange();
      r.selectNodeContents(movedEl);
      r.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      content.focus();
    }
  }

  function onDocMouseMove(e: MouseEvent): void {
    if (state === 'armed') {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
        return;
      }
      startDragging();
    }
    if (state !== 'dragging') {
      return;
    }
    updateGhostPosition(e.clientX, e.clientY);
    if (kind === 'block') {
      updateBlockDropLine(e.clientY);
    } else {
      updateLiDropLine(e.clientX, e.clientY);
    }
    maintainAutoScroll(e.clientY);
  }

  function onDocMouseUp(): void {
    if (state === 'dragging') {
      const shouldMove = currentGapValid;
      const dragKind = kind;
      cleanupVisuals();
      if (shouldMove) {
        if (dragKind === 'block') {
          finishBlockMove();
        } else {
          finishLiMove();
        }
        deps.lineGutter.refreshFromDom();
        deps.scheduleSync();
      }
    } else {
      cleanupVisuals();
    }
    resetState();
  }

  function onDocKeyDown(e: KeyboardEvent): void {
    // Cancel/Esc (F6): drop never touched the DOM before mouseup, so cancelling is pure visual cleanup.
    if (e.key === 'Escape') {
      cleanupVisuals();
      resetState();
    }
  }

  function armDrag(block: HTMLElement, clientX: number, clientY: number): void {
    state = 'armed';
    kind = 'block';
    startX = clientX;
    startY = clientY;
    dragBlocks = draggableBlocks();
    dragSpan = computeHeadingSectionSpan(block, dragBlocks);
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    document.addEventListener('keydown', onDocKeyDown);
  }

  function armLiDrag(li: HTMLLIElement, clientX: number, clientY: number): void {
    const parent = li.parentElement;
    if (!parent) {
      return;
    }
    state = 'armed';
    kind = 'li';
    startX = clientX;
    startY = clientY;
    liDragged = li;
    liParent = parent;
    liSiblings = Array.from(parent.children).filter((c) => c.tagName === 'LI') as HTMLLIElement[];
    liIdx = liSiblings.indexOf(li);
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    document.addEventListener('keydown', onDocKeyDown);
  }

  handleEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hoveredBlock || isComposing) {
      return;
    }
    e.preventDefault();
    armDrag(hoveredBlock, e.clientX, e.clientY);
  });

  liHandleEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hoveredLi || isComposing) {
      return;
    }
    e.preventDefault();
    armLiDrag(hoveredLi, e.clientX, e.clientY);
  });

  function refresh(): void {
    if (state !== 'idle') {
      cleanupVisuals();
      resetState();
    }
    closeMenu();
    hoveredBlock = null;
    hoveredLi = null;
    positionHandle(null);
    positionLiHandle(null);
  }

  return { refresh };
}
