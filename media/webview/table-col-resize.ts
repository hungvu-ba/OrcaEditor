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
  content.querySelectorAll('table').forEach((table, ordinal) => {
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
