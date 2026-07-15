/**
 * Drag & drop reorder for top-level blocks (HLR section 17, US-17.3).
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

const HEADING_RE = /^H([1-6])$/;
const DRAG_THRESHOLD_PX = 4;
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
      return;
    }
    const contentRect = content.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    handleEl.style.display = 'flex';
    handleEl.style.top = `${blockRect.top}px`;
    handleEl.style.left = `${contentRect.left - 20}px`;
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
  }

  content.addEventListener('mousemove', onContentHover);
  content.addEventListener('mouseleave', () => {
    if (state === 'idle') {
      hoveredBlock = null;
      positionHandle(null);
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
  let startX = 0;
  let startY = 0;
  let dragBlocks: HTMLElement[] = [];
  let dragSpan: HTMLElement[] = [];
  let currentGap = 0;
  let currentGapValid = false;

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

  function updateDropLine(clientY: number): void {
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
    dropLineEl.style.display = 'block';
    dropLineEl.style.top = `${y}px`;
    dropLineEl.style.left = `${contentRect.left}px`;
    dropLineEl.style.width = `${contentRect.width}px`;
  }

  function startDragging(): void {
    state = 'dragging';
    handleEl.style.display = 'none';
    ghostEl.replaceChildren((dragSpan[0].cloneNode(true) as HTMLElement));
    if (dragSpan.length > 1) {
      const badge = document.createElement('div');
      badge.className = 'dd-ghost-badge';
      badge.textContent = String(dragSpan.length);
      ghostEl.appendChild(badge);
    }
    ghostEl.style.display = 'block';
    dragSpan.forEach((el) => el.classList.add('dd-source-muted'));
    document.body.classList.add('dd-dragging');
  }

  function cleanupVisuals(): void {
    dragSpan.forEach((el) => el.classList.remove('dd-source-muted'));
    ghostEl.style.display = 'none';
    ghostEl.replaceChildren();
    dropLineEl.style.display = 'none';
    document.body.classList.remove('dd-dragging');
    stopAutoScroll();
  }

  function resetState(): void {
    state = 'idle';
    dragBlocks = [];
    dragSpan = [];
    currentGapValid = false;
    hoveredBlock = null;
    document.removeEventListener('mousemove', onDocMouseMove);
    document.removeEventListener('mouseup', onDocMouseUp);
    document.removeEventListener('keydown', onDocKeyDown);
  }

  function finishMove(): void {
    const span = dragSpan;
    const blocks = dragBlocks;
    const gap = currentGap;
    const movedEl = performMove(span, blocks, gap);
    if (movedEl) {
      const r = document.createRange();
      r.selectNodeContents(movedEl);
      r.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      content.focus();
    }
    deps.lineGutter.refreshFromDom();
    deps.scheduleSync();
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
    updateDropLine(e.clientY);
    maintainAutoScroll(e.clientY);
  }

  function onDocMouseUp(): void {
    if (state === 'dragging') {
      const shouldMove = currentGapValid;
      cleanupVisuals();
      if (shouldMove) {
        finishMove();
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
    startX = clientX;
    startY = clientY;
    dragBlocks = draggableBlocks();
    dragSpan = computeHeadingSectionSpan(block, dragBlocks);
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

  function refresh(): void {
    if (state !== 'idle') {
      cleanupVisuals();
      resetState();
    }
    hoveredBlock = null;
    positionHandle(null);
  }

  return { refresh };
}
