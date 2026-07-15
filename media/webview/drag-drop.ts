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

export function initDragDrop(content: HTMLElement, deps: DragDropDeps): DragDropController {
  /** Top-level children with a real markdown source range — excludes the trailing caret-trap <p> (same filter as block-map.ts). */
  function draggableBlocks(): HTMLElement[] {
    return (Array.from(content.children) as HTMLElement[]).filter((el) => readSrcRange(el) !== null);
  }

  /**
   * Section-move (F7 companion): dragging a heading carries every following
   * block up to (not including) the next heading of the same or higher level —
   * same "which level closes this section" rule TOC would need for a tree, but
   * TOC only builds a flat list (toc.ts) so this is computed locally here.
   */
  function computeDragSpan(startEl: HTMLElement, blocks: HTMLElement[]): HTMLElement[] {
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

  /** A gap inside (or bracketing at the same spot as) the dragged span is a no-op/self-drop — reject (F7). */
  function isValidGap(gap: number, spanStartIdx: number, spanEndIdx: number): boolean {
    return gap <= spanStartIdx || gap > spanEndIdx;
  }

  /**
   * Builds the replacement HTML for the affected range [lowOrig, highOrig] of
   * `blocks`, plus the sibling-hop count to reach the moved block's first
   * element in the live DOM afterwards (for caret placement). Inserts an
   * empty `<p><br></p>` spacer wherever the reorder would otherwise land two
   * atom blocks (Mermaid/math — no caret position inside or directly after
   * them, main.ts ensureCaretSpotAfterAtomBlocks) back-to-back — done INSIDE
   * this single HTML string so it stays part of the one execCommand call
   * instead of a second DOM edit that would cost a second undo step.
   */
  function buildInsertion(
    newSpanBlocks: HTMLElement[],
    movedFirstIdx: number,
    beforeEl: HTMLElement | null,
    afterEl: HTMLElement | null
  ): { html: string; movedHopCount: number } {
    const parts: string[] = [];
    let movedHopCount = 0;
    for (let i = 0; i < newSpanBlocks.length; i++) {
      const prev = i === 0 ? beforeEl : newSpanBlocks[i - 1];
      const cur = newSpanBlocks[i];
      if (prev && isAtomBlock(prev) && isAtomBlock(cur)) {
        parts.push('<p><br></p>');
      }
      if (i === movedFirstIdx) {
        movedHopCount = parts.length;
      }
      parts.push(cur.outerHTML);
    }
    const last = newSpanBlocks[newSpanBlocks.length - 1];
    if (last && afterEl && isAtomBlock(last) && isAtomBlock(afterEl)) {
      parts.push('<p><br></p>');
    }
    return { html: parts.join(''), movedHopCount };
  }

  /** Performs the move (one execCommand call) and returns the moved block's new live element, for caret placement. */
  function performMove(span: HTMLElement[], blocks: HTMLElement[], gap: number): HTMLElement | null {
    const spanStartIdx = blocks.indexOf(span[0]);
    const spanEndIdx = spanStartIdx + span.length - 1;
    const remaining = blocks.filter((_, i) => i < spanStartIdx || i > spanEndIdx);
    const insertionIndex = gap <= spanStartIdx ? gap : gap - span.length;
    const newOrder = [...remaining.slice(0, insertionIndex), ...span, ...remaining.slice(insertionIndex)];
    const lowOrig = Math.min(spanStartIdx, gap);
    const highOrig = Math.max(spanEndIdx, gap - 1);
    const newSpanBlocks = newOrder.slice(lowOrig, highOrig + 1);
    const movedFirstIdx = newOrder.indexOf(span[0]) - lowOrig;
    const beforeEl = lowOrig > 0 ? blocks[lowOrig - 1] : null;
    const afterEl = highOrig < blocks.length - 1 ? blocks[highOrig + 1] : null;
    const { html, movedHopCount } = buildInsertion(newSpanBlocks, movedFirstIdx, beforeEl, afterEl);

    const range = document.createRange();
    range.setStartBefore(blocks[lowOrig]);
    range.setEndAfter(blocks[highOrig]);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('insertHTML', false, html);

    let el: Element | null = beforeEl ? beforeEl.nextElementSibling : content.firstElementChild;
    for (let i = 0; i < movedHopCount && el; i++) {
      el = el.nextElementSibling;
    }
    return el as HTMLElement | null;
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
    currentGapValid = isValidGap(gap, spanStartIdx, spanEndIdx);
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
    dragSpan = computeDragSpan(block, dragBlocks);
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
