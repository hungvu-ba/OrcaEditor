// Session-only column-width locks for tables (US-6.10). Nothing here touches `document`/`window` at
// module top level: test/unit.ts imports this module under Node.

export type ColumnOp =
  | { kind: 'insert'; index: number }
  | { kind: 'delete'; index: number }
  | { kind: 'move'; from: number; to: number };
export type LockedWidths = (number | undefined)[];
export interface TableLockSnapshot { entries: { ordinal: number; colCount: number; widths: LockedWidths }[] }
export interface ColResizeHooks {
  measureHardMin(table: HTMLTableElement): number[];
  refit(table: HTMLTableElement): void;
  isDragBusy(): boolean;
  onColumnWidthsChanged(): void;
}

export const RESIZE_HIT_PX = 4;

const locks = new WeakMap<HTMLTableElement, LockedWidths>();

/** Pure; returns a new array. An index outside the valid range leaves the widths unchanged. */
export function remapWidths(widths: LockedWidths, op: ColumnOp): LockedWidths {
  const out = widths.slice();
  const last = out.length - 1;
  switch (op.kind) {
    case 'insert':
      if (op.index >= 0 && op.index <= out.length) out.splice(op.index, 0, undefined);
      break;
    case 'delete':
      if (op.index >= 0 && op.index <= last) out.splice(op.index, 1);
      break;
    case 'move':
      if (op.from >= 0 && op.from <= last && op.to >= 0 && op.to <= last) {
        out.splice(op.to, 0, out.splice(op.from, 1)[0]);
      }
      break;
  }
  return out;
}

export function isTableLocked(table: HTMLTableElement): boolean {
  return locks.has(table);
}

export function lockedWidths(table: HTMLTableElement): LockedWidths | undefined {
  return locks.get(table);
}

export function lockTable(table: HTMLTableElement, widths: LockedWidths): void {
  locks.set(table, widths.slice());
}

export function unlockTable(table: HTMLTableElement): void {
  locks.delete(table);
}

export function remapTableLock(table: HTMLTableElement, op: ColumnOp): void {
  const widths = locks.get(table);
  if (widths) locks.set(table, remapWidths(widths, op));
}

function columnCount(table: HTMLTableElement): number {
  let max = 0;
  for (const row of Array.from(table.rows)) max = Math.max(max, row.cells.length);
  return max;
}

export function snapshotTableLocks(content: HTMLElement): TableLockSnapshot {
  const entries: TableLockSnapshot['entries'] = [];
  Array.from(content.querySelectorAll('table')).forEach((table, ordinal) => {
    const widths = locks.get(table);
    if (widths) entries.push({ ordinal, colCount: columnCount(table), widths: widths.slice() });
  });
  return { entries };
}

export function restoreTableLocks(content: HTMLElement, snap: TableLockSnapshot): void {
  if (snap.entries.length === 0) return;
  const tables = content.querySelectorAll('table');
  for (const { ordinal, colCount, widths } of snap.entries) {
    const table = tables[ordinal];
    if (table && !locks.has(table) && columnCount(table) === colCount) lockTable(table, widths);
  }
}

const LINE_CLASS = 'table-col-resize-line';
const HOVER_BODY_CLASS = 'table-col-resize-hover';
const RESIZING_BODY_CLASS = 'table-col-resizing';

interface ResizeEdge {
  table: HTMLTableElement;
  col: number;
  /** Viewport x of the edge. */
  x: number;
}

interface ResizeDrag {
  table: HTMLTableElement;
  col: number;
  startX: number;
  startW: number;
  minW: number;
  widths: LockedWidths;
  x: number;
  raf: number;
}

function hasSpans(table: HTMLTableElement): boolean {
  return Array.from(table.rows).some((r) => Array.from(r.cells).some((c) => c.colSpan !== 1 || c.rowSpan !== 1));
}

function headerRow(table: HTMLTableElement): HTMLTableRowElement {
  return table.tHead?.rows[0] ?? table.rows[0];
}

/** Contract 9: the column edge within RESIZE_HIT_PX of (x, y), or null. */
function hitTest(content: HTMLElement, x: number, y: number): ResizeEdge | null {
  for (const table of Array.from(content.querySelectorAll('table'))) {
    const t = table.getBoundingClientRect();
    if (y < t.top || y > t.bottom || x < t.left - RESIZE_HIT_PX || x > t.right + RESIZE_HIT_PX) {
      continue;
    }
    if (hasSpans(table)) {
      return null;
    }
    for (const row of Array.from(table.rows)) {
      const r = row.getBoundingClientRect();
      if (y < r.top || y > r.bottom) {
        continue;
      }
      let best: ResizeEdge | null = null;
      let bestDist = RESIZE_HIT_PX;
      for (let i = 0; i < row.cells.length; i++) {
        const c = row.cells[i].getBoundingClientRect();
        if (Math.abs(x - c.right) <= bestDist) {
          bestDist = Math.abs(x - c.right);
          best = { table, col: i, x: c.right };
        }
        if (i > 0 && Math.abs(x - c.left) < bestDist) {
          bestDist = Math.abs(x - c.left);
          best = { table, col: i - 1, x: c.left };
        }
      }
      return best;
    }
  }
  return null;
}

/** US-6.10: hover highlight + drag-to-resize on table column edges. */
export function initTableColResize(content: HTMLElement, hooks: ColResizeHooks): void {
  const line = document.createElement('div');
  line.className = LINE_CLASS;
  line.style.display = 'none';
  document.body.appendChild(line);

  let hover: ResizeEdge | null = null;
  let drag: ResizeDrag | null = null;

  function showLine(edge: ResizeEdge): void {
    const t = edge.table.getBoundingClientRect();
    const top = Math.max(t.top, 0);
    const bottom = Math.min(t.bottom, document.documentElement.clientHeight);
    line.style.left = `${Math.round(edge.x) - 1}px`;
    line.style.top = `${top}px`;
    line.style.height = `${Math.max(0, bottom - top)}px`;
    line.style.display = 'block';
  }

  function setHover(edge: ResizeEdge | null): void {
    hover = edge;
    document.body.classList.toggle(HOVER_BODY_CLASS, !!edge);
    if (edge) {
      showLine(edge);
    } else {
      line.style.display = 'none';
    }
  }

  // Contract 12: rAF-coalesced hit-test (pattern: initTableDragDrop hoverRaf).
  let hoverRaf = 0;
  let hoverX = 0;
  let hoverY = 0;
  content.addEventListener('mousemove', (e) => {
    if (drag) {
      return;
    }
    hoverX = e.clientX;
    hoverY = e.clientY;
    if (hoverRaf !== 0) {
      return;
    }
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (!drag) {
        setHover(hooks.isDragBusy() ? null : hitTest(content, hoverX, hoverY));
      }
    });
  });
  content.addEventListener('mouseleave', () => {
    if (hoverRaf !== 0) {
      cancelAnimationFrame(hoverRaf);
      hoverRaf = 0;
    }
    if (!drag && hover) {
      setHover(null);
    }
  });
  window.addEventListener(
    'scroll',
    () => {
      if (!drag && hover) {
        setHover(null);
      }
    },
    { passive: true, capture: true }
  );

  function applyDrag(d: ResizeDrag): void {
    d.widths[d.col] = Math.max(d.minW, Math.round(d.startW + d.x - d.startX));
    lockTable(d.table, d.widths);
    hooks.refit(d.table);
    hooks.onColumnWidthsChanged();
    showLine({ table: d.table, col: d.col, x: headerRow(d.table).cells[d.col].getBoundingClientRect().right });
  }

  function onDragMove(e: MouseEvent): void {
    e.stopPropagation();
    const d = drag;
    if (!d) {
      return;
    }
    d.x = e.clientX;
    if (d.raf === 0) {
      d.raf = requestAnimationFrame(() => {
        d.raf = 0;
        applyDrag(d);
      });
    }
  }

  function onDragEnd(e: MouseEvent): void {
    e.stopPropagation();
    window.removeEventListener('mousemove', onDragMove, true);
    window.removeEventListener('mouseup', onDragEnd, true);
    const d = drag;
    drag = null;
    if (d) {
      cancelAnimationFrame(d.raf);
      d.x = e.clientX;
      applyDrag(d);
    }
    document.body.classList.remove(RESIZING_BODY_CLASS);
    setHover(null);
    // Contract 11: the click that follows this mouseup must not show the table toolbar.
    const swallowClick = (ev: MouseEvent): void => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', swallowClick, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallowClick, true), 0);
  }

  // Contract 11: capture on document so no caret move, selection or row/column drag arm happens.
  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0 || drag || !content.contains(e.target as Node) || hooks.isDragBusy()) {
        return;
      }
      const edge = hitTest(content, e.clientX, e.clientY);
      if (!edge) {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      const { table, col } = edge;
      // Contract 4: pin every column to its rendered width; contract 5: hard min measured once here.
      const widths: LockedWidths = Array.from(headerRow(table).cells, (c) => Math.ceil(c.getBoundingClientRect().width));
      // An all-unpinned lock makes the refit strip every applied width, so the measure sees bare cells.
      lockTable(table, widths.map(() => undefined));
      hooks.refit(table);
      const minW = Math.ceil(hooks.measureHardMin(table)[col] ?? 0);
      drag = { table, col, startX: e.clientX, startW: widths[col] ?? minW, minW, widths, x: e.clientX, raf: 0 };
      document.body.classList.remove(HOVER_BODY_CLASS);
      document.body.classList.add(RESIZING_BODY_CLASS);
      applyDrag(drag);
      window.addEventListener('mousemove', onDragMove, true);
      window.addEventListener('mouseup', onDragEnd, true);
    },
    true
  );
}
