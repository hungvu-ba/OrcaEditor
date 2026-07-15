/**
 * Thao tác bảng: toolbar nổi (thêm/xóa dòng/cột, căn lề cột, xóa bảng) và
 * điều hướng ô bằng Tab. Toolbar tự ẩn sau vài giây, chỉ hiện lại khi click
 * chuột vào bảng (gõ phím không tính).
 */
import { fillSequenceColumn } from './pipeline';
import { closestElement, showToast, svgIcon, type DomHelpers } from './dom-utils';
import { TABLE_TOOLBAR_HIDE_MS } from './constants';
import { computeSiblingMove, applySiblingMove, isValidSiblingGap } from './sibling-move';

export interface TableContext {
  scheduleSync: () => void;
  dom: DomHelpers;
}

export interface TableController {
  hideTableToolbar(): void;
}

let content: HTMLElement;
let toolbarEl: HTMLElement;
let ctx: TableContext;
let tableToolbar: HTMLDivElement;

/** Ô bảng đang chứa caret — cập nhật qua selectionchange. */
let currentCell: HTMLTableCellElement | null = null;

const STROKE = 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"';

const TABLE_ICONS = {
  rowAbove: svgIcon(
    `<path d="M8 1.5v4M6 3.5h4" ${STROKE}/>` +
      '<rect x="2" y="8" width="12" height="2.5" rx="0.75" fill="currentColor"/>' +
      '<rect x="2" y="12" width="12" height="2.5" rx="0.75" fill="currentColor"/>'
  ),
  rowBelow: svgIcon(
    '<rect x="2" y="1.5" width="12" height="2.5" rx="0.75" fill="currentColor"/>' +
      '<rect x="2" y="5.5" width="12" height="2.5" rx="0.75" fill="currentColor"/>' +
      `<path d="M8 10.5v4M6 12.5h4" ${STROKE}/>`
  ),
  colLeft: svgIcon(
    `<path d="M1.5 8h4M3.5 6v4" ${STROKE}/>` +
      '<rect x="8" y="2" width="2.5" height="12" rx="0.75" fill="currentColor"/>' +
      '<rect x="12" y="2" width="2.5" height="12" rx="0.75" fill="currentColor"/>'
  ),
  colRight: svgIcon(
    '<rect x="1.5" y="2" width="2.5" height="12" rx="0.75" fill="currentColor"/>' +
      '<rect x="5.5" y="2" width="2.5" height="12" rx="0.75" fill="currentColor"/>' +
      `<path d="M10.5 8h4M12.5 6v4" ${STROKE}/>`
  ),
  alignLeft: svgIcon(`<path d="M2 3.25h12M2 6.5h7M2 9.75h12M2 13h7" ${STROKE}/>`),
  alignCenter: svgIcon(`<path d="M2 3.25h12M4.5 6.5h7M2 9.75h12M4.5 13h7" ${STROKE}/>`),
  alignRight: svgIcon(`<path d="M2 3.25h12M7 6.5h7M2 9.75h12M7 13h7" ${STROKE}/>`),
  delRow: svgIcon(
    '<rect x="2" y="2" width="12" height="2.5" rx="0.75" fill="currentColor"/>' +
      '<rect x="2" y="11.5" width="12" height="2.5" rx="0.75" fill="currentColor"/>' +
      `<path d="M5.5 6l5 4M10.5 6l-5 4" ${STROKE}/>`
  ),
  delCol: svgIcon(
    '<rect x="2" y="2" width="2.5" height="12" rx="0.75" fill="currentColor"/>' +
      '<rect x="11.5" y="2" width="2.5" height="12" rx="0.75" fill="currentColor"/>' +
      `<path d="M6 5.5l4 5M10 5.5l-4 5" ${STROKE}/>`
  ),
  trash: svgIcon(
    '<path d="M2.5 4h11M6 4V2.5h4V4M4.5 4l.6 9.5h5.8L11.5 4M6.75 6.5v4.5M9.25 6.5v4.5" ' +
      'stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
  ),
};

interface TableAction {
  icon: string;
  title: string;
  action: (cell: HTMLTableCellElement) => void;
  separatorBefore?: boolean;
}

const tableActions: TableAction[] = [
  { icon: TABLE_ICONS.rowAbove, title: 'Insert row above', action: (c) => insertRow(c, 'above') },
  { icon: TABLE_ICONS.rowBelow, title: 'Insert row below', action: (c) => insertRow(c, 'below') },
  { icon: TABLE_ICONS.colLeft, title: 'Insert column left', action: (c) => insertColumn(c, 'left'), separatorBefore: true },
  { icon: TABLE_ICONS.colRight, title: 'Insert column right', action: (c) => insertColumn(c, 'right') },
  { icon: TABLE_ICONS.alignLeft, title: 'Align column left (default)', action: (c) => alignTableColumn(c, 'left'), separatorBefore: true },
  { icon: TABLE_ICONS.alignCenter, title: 'Align column center', action: (c) => alignTableColumn(c, 'center') },
  { icon: TABLE_ICONS.alignRight, title: 'Align column right', action: (c) => alignTableColumn(c, 'right') },
  { icon: TABLE_ICONS.delRow, title: 'Delete current row', action: deleteRow, separatorBefore: true },
  { icon: TABLE_ICONS.delCol, title: 'Delete current column', action: deleteColumn },
  { icon: TABLE_ICONS.trash, title: 'Delete entire table', action: deleteTable, separatorBefore: true },
];

/** Toolbar bảng tự ẩn sau TABLE_TOOLBAR_HIDE_MS; chỉ hiện lại khi CLICK chuột vào bảng (gõ phím không tính). */
let tableToolbarHideTimer: ReturnType<typeof setTimeout> | undefined;
let lastInteractionWasPointer = false;

/** Ô bảng đã cảnh báo "sẽ lưu dạng HTML" — không nhắc lại nhiều lần. */
const warnedComplexCells = new WeakSet<Element>();

export function initTable(contentEl: HTMLElement, toolbarElArg: HTMLElement, context: TableContext): TableController {
  content = contentEl;
  toolbarEl = toolbarElArg;
  ctx = context;

  tableToolbar = document.createElement('div');
  tableToolbar.id = 'table-toolbar';
  document.body.appendChild(tableToolbar);

  for (const item of tableActions) {
    if (item.separatorBefore) {
      const sep = document.createElement('span');
      sep.className = 'toolbar-sep';
      tableToolbar.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = item.icon;
    btn.title = item.title;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (currentCell && currentCell.isConnected) {
        item.action(currentCell);
      }
    });
    tableToolbar.appendChild(btn);
  }

  // Rê chuột lên toolbar → dừng đếm giờ; rời chuột → đếm lại từ đầu.
  tableToolbar.addEventListener('mouseenter', clearHideTimer);
  tableToolbar.addEventListener('mouseleave', () => {
    if (tableToolbar.classList.contains('visible')) {
      startHideTimer();
    }
  });

  document.addEventListener('mousedown', () => {
    lastInteractionWasPointer = true;
  });
  document.addEventListener(
    'keydown',
    () => {
      lastInteractionWasPointer = false;
    },
    true
  );

  document.addEventListener('selectionchange', updateTableToolbar);

  // Click thẳng vào ô bảng luôn hiện toolbar (kể cả khi caret không đổi vị trí,
  // selectionchange có thể không bắn).
  content.addEventListener('click', (e) => {
    const cell = (e.target as HTMLElement).closest?.('td, th');
    if (cell && content.contains(cell)) {
      currentCell = cell as HTMLTableCellElement;
      showTableToolbar(cell);
    }
  });

  initTableDragDrop();

  return { hideTableToolbar };
}

function clearHideTimer(): void {
  if (tableToolbarHideTimer !== undefined) {
    clearTimeout(tableToolbarHideTimer);
    tableToolbarHideTimer = undefined;
  }
}

function startHideTimer(): void {
  clearHideTimer();
  tableToolbarHideTimer = setTimeout(() => {
    tableToolbar.classList.remove('visible');
    tableToolbarHideTimer = undefined;
  }, TABLE_TOOLBAR_HIDE_MS);
}

function updateTableToolbar(): void {
  const sel = window.getSelection();
  const anchor = sel?.anchorNode ? closestElement(sel.anchorNode) : null;
  const cell = anchor?.closest('td, th');
  if (cell && content.contains(cell)) {
    currentCell = cell as HTMLTableCellElement;
    if (lastInteractionWasPointer) {
      // Chuột click vào bảng → hiện + đặt lại đồng hồ 10s
      showTableToolbar(cell);
    } else if (tableToolbar.classList.contains('visible')) {
      // Đang gõ phím trong lúc toolbar còn hiện → chỉ bám theo vị trí,
      // không đặt lại đồng hồ (gõ phím không giữ toolbar sống mãi)
      positionTableToolbar(cell);
    }
  } else {
    hideTableToolbar();
  }
}

function hideTableToolbar(): void {
  currentCell = null;
  tableToolbar.classList.remove('visible');
  clearHideTimer();
}

function showTableToolbar(cell: Element): void {
  tableToolbar.classList.add('visible');
  positionTableToolbar(cell);
  // Đang rê chuột trên toolbar thì không chạy đồng hồ
  if (!tableToolbar.matches(':hover')) {
    startHideTimer();
  }
}

// Column drag handle sits in a 20px-tall band directly above the table
// (handle height 20px, offset `top - 20`); add 8px breathing room so the
// toolbar doesn't overlap it.
const TABLE_TOOLBAR_GAP_PX = 28;

function positionTableToolbar(cell: Element): void {
  const table = cell.closest('table');
  if (!table) {
    return;
  }
  const rect = table.getBoundingClientRect();
  const top = rect.top + window.scrollY - tableToolbar.offsetHeight - TABLE_TOOLBAR_GAP_PX;
  // không chui dưới toolbar chính (sticky trên cùng)
  const minTop = window.scrollY + toolbarEl.offsetHeight + 4;
  tableToolbar.style.top = `${Math.max(top, minTop)}px`;
  tableToolbar.style.left = `${rect.left + window.scrollX}px`;
}

function cellTable(cell: HTMLTableCellElement): HTMLTableElement | null {
  return cell.closest('table');
}

/** Class tạm dùng để đo bề rộng tự nhiên (không wrap) của ô — xem markdown.css. */
const MEASURE_CLASS = 'md-table-col-fit-measuring';

/**
 * Co từng cột về vừa nội dung khi nội dung ngắn hơn sàn 14ch mặc định (thay vì
 * mọi cột đều bị ép rộng bằng cột dài nhất — bug report 2026-07-15, ảnh bảng
 * nghiệp vụ với cột "#" rộng bằng cột "Mô tả"). Với mỗi cột: đo bề rộng tự
 * nhiên (1 dòng, không wrap) của ô rộng nhất trong cột, rồi ghi min-width =
 * nhỏ hơn giữa sàn CSS 14ch và bề rộng đó — cột ngắn co vừa nội dung, cột dài
 * vẫn giữ sàn 14ch (chống wrap vụn thành "2 ký tự × N dòng", US-19.3).
 */
export function fitTableColumns(table: HTMLTableElement): void {
  const rows = Array.from(table.rows);
  if (rows.length === 0) {
    return;
  }

  // Sàn CSS (14ch + padding + box model hiện tại) đo qua 1 <td> rỗng tạm thêm
  // vào bảng — hưởng ĐÚNG CSS mặc định (th,td { min-width: 14ch }) nên khỏi
  // phải tính lại padding/box-sizing thủ công.
  const probeRow = document.createElement('tr');
  probeRow.style.visibility = 'hidden';
  probeRow.appendChild(document.createElement('td'));
  (table.tBodies[0] ?? table).appendChild(probeRow);
  const floorPx = probeRow.cells[0].getBoundingClientRect().width;
  probeRow.remove();
  if (!(floorPx > 0)) {
    return; // không đo được (bảng đang ẩn...) — giữ nguyên sàn CSS mặc định
  }

  // Bề rộng tự nhiên từng cột — gỡ tạm sàn/trần + cấm wrap (đồng bộ, không
  // nháy hình vì chưa có khung hình nào vẽ ra giữa lúc thêm/gỡ class).
  table.classList.add(MEASURE_CLASS);
  // Clear previously-set inline min-width first — otherwise it outranks the
  // class-selector override and the measurement pass can never go below a
  // width set by an earlier fit, so columns could only grow, never shrink
  // back after content got shorter.
  for (const row of rows) {
    for (const cell of Array.from(row.cells)) {
      cell.style.removeProperty('min-width');
    }
  }
  const colCount = Math.max(...rows.map((r) => r.cells.length));
  const naturalByCol: number[] = new Array(colCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.cells.length; i++) {
      const w = row.cells[i].getBoundingClientRect().width;
      if (w > naturalByCol[i]) {
        naturalByCol[i] = w;
      }
    }
  }
  table.classList.remove(MEASURE_CLASS);

  for (const row of rows) {
    for (let i = 0; i < row.cells.length; i++) {
      const cell = row.cells[i];
      // box-sizing:border-box để giá trị px ghi vào khớp đúng bề rộng đã đo
      // (getBoundingClientRect trả border-box), không bị cộng thêm padding/viền.
      cell.style.boxSizing = 'border-box';
      cell.style.minWidth = `${Math.ceil(Math.min(floorPx, naturalByCol[i]))}px`;
    }
  }
}

function emptyCell(tag: 'td' | 'th'): HTMLTableCellElement {
  const el = document.createElement(tag);
  el.appendChild(document.createElement('br')); // placeholder để đặt được caret
  return el;
}

function insertRow(cell: HTMLTableCellElement, where: 'above' | 'below', focusCol?: number): void {
  const row = cell.closest('tr');
  const table = cellTable(cell);
  if (!row || !table) {
    return;
  }
  const newRow = document.createElement('tr');
  for (let i = 0; i < row.cells.length; i++) {
    newRow.appendChild(emptyCell('td'));
  }
  if (row.parentElement?.tagName === 'THEAD') {
    // GFM chỉ có 1 dòng header → dòng mới luôn vào đầu tbody
    let tbody = table.querySelector('tbody');
    if (!tbody) {
      tbody = document.createElement('tbody');
      table.appendChild(tbody);
    }
    tbody.insertBefore(newRow, tbody.firstChild);
  } else {
    row.parentElement?.insertBefore(newRow, where === 'above' ? row : row.nextSibling);
  }
  // Cột đầu là số thứ tự → tự điền số cho dòng mới (và đánh lại số các dòng sau)
  const sttFilled = fillSequenceColumn(table, newRow);
  let col = focusCol ?? Math.min(cell.cellIndex, newRow.cells.length - 1);
  if (sttFilled && col === 0 && newRow.cells.length > 1) {
    col = 1; // ô số thứ tự đã được điền sẵn — đưa caret sang ô nhập liệu kế tiếp
  }
  ctx.dom.placeCaretIn(newRow.cells[col]);
  afterTableEdit(table);
}

function insertColumn(cell: HTMLTableCellElement, where: 'left' | 'right'): void {
  const table = cellTable(cell);
  if (!table) {
    return;
  }
  const index = cell.cellIndex + (where === 'right' ? 1 : 0);
  let newHeaderCell: HTMLTableCellElement | null = null;
  for (const row of Array.from(table.rows)) {
    const isHeader = row.parentElement?.tagName === 'THEAD';
    const el = emptyCell(isHeader ? 'th' : 'td');
    if (isHeader) {
      // Đặt sẵn tên cột để bảng luôn có header dễ nhận biết
      el.textContent = 'New Column';
      newHeaderCell ??= el;
    }
    row.insertBefore(el, row.cells[index] ?? null);
  }
  if (newHeaderCell) {
    // Chọn sẵn tên placeholder — gõ là thay được tên ngay
    ctx.dom.placeCaretIn(newHeaderCell, true);
  } else {
    const targetRow = cell.closest('tr');
    if (targetRow) {
      ctx.dom.placeCaretIn(targetRow.cells[index]);
    }
  }
  afterTableEdit(table);
}

function deleteRow(cell: HTMLTableCellElement): void {
  const row = cell.closest('tr');
  const table = cellTable(cell);
  if (!row || !table) {
    return;
  }
  if (row.parentElement?.tagName === 'THEAD') {
    // GFM bắt buộc có header → đưa dòng dữ liệu đầu tiên lên làm header
    const firstBody = table.querySelector('tbody tr');
    if (!firstBody) {
      deleteTable(cell);
      return;
    }
    const newHead = document.createElement('tr');
    for (const td of Array.from((firstBody as HTMLTableRowElement).cells)) {
      const th = document.createElement('th');
      for (const attr of ['align', 'style']) {
        const v = td.getAttribute(attr);
        if (v) {
          th.setAttribute(attr, v);
        }
      }
      while (td.firstChild) {
        th.appendChild(td.firstChild);
      }
      newHead.appendChild(th);
    }
    firstBody.remove();
    row.replaceWith(newHead);
    ctx.dom.placeCaretIn(newHead.cells[0]);
  } else {
    const next = (row.nextElementSibling ?? row.previousElementSibling ?? table.rows[0]) as HTMLTableRowElement | null;
    row.remove();
    if (next) {
      ctx.dom.placeCaretIn(next.cells[Math.min(cell.cellIndex, next.cells.length - 1)]);
    }
  }
  afterTableEdit(table);
}

function deleteColumn(cell: HTMLTableCellElement): void {
  const table = cellTable(cell);
  if (!table) {
    return;
  }
  const index = cell.cellIndex;
  if ((table.rows[0]?.cells.length ?? 0) <= 1) {
    // cột cuối cùng → xóa cả bảng
    deleteTable(cell);
    return;
  }
  const row = cell.closest('tr') as HTMLTableRowElement | null;
  for (const r of Array.from(table.rows)) {
    if (index < r.cells.length) {
      r.deleteCell(index);
    }
  }
  if (row) {
    ctx.dom.placeCaretIn(row.cells[Math.min(index, row.cells.length - 1)]);
  }
  afterTableEdit(table);
}

function deleteTable(cell: HTMLTableCellElement): void {
  const table = cellTable(cell);
  if (!table) {
    return;
  }
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  table.replaceWith(p);
  ctx.dom.placeCaretIn(p);
  afterTableEdit();
}

/** Tab: nhảy ô kế tiếp/trước; hết ô cuối → tạo dòng mới (focus cột đầu). */
export function navigateCells(cell: HTMLTableCellElement, dir: 1 | -1): void {
  const table = cellTable(cell);
  if (!table) {
    return;
  }
  const cells: HTMLTableCellElement[] = [];
  for (const row of Array.from(table.rows)) {
    cells.push(...Array.from(row.cells));
  }
  const next = cells.indexOf(cell) + dir;
  if (next < 0) {
    return;
  }
  if (next >= cells.length) {
    insertRow(cell, 'below', 0);
    return;
  }
  ctx.dom.placeCaretIn(cells[next], true);
}

function afterTableEdit(table?: HTMLTableElement): void {
  if (table) {
    fitTableColumns(table);
  }
  ctx.scheduleSync();
  updateTableToolbar();
}

/**
 * Căn lề cả cột bảng chứa ô đang chọn — đúng ngữ nghĩa :---: / ---: của
 * bảng GFM (căn lề trong markdown là thuộc tính của cột, không phải ô).
 * Căn trái = bỏ căn lề (mặc định).
 */
function alignTableColumn(cell: HTMLTableCellElement, align: 'left' | 'center' | 'right'): void {
  const table = cellTable(cell);
  if (!table) {
    return;
  }
  const index = cell.cellIndex;
  for (const row of Array.from(table.rows)) {
    const c = row.cells[index];
    if (!c) {
      continue;
    }
    if (align === 'left') {
      c.removeAttribute('align');
      c.style.textAlign = '';
      if (!c.getAttribute('style')) {
        c.removeAttribute('style');
      }
    } else {
      c.setAttribute('align', align);
      c.style.textAlign = align;
    }
  }
  ctx.scheduleSync();
}

/**
 * Ô có list lồng list không? Đếm theo tổ tiên ul/ol nên bắt được cả cấu trúc
 * DOM méo do execCommand indent/outdent sinh ra (ul>ul, li>li…), khớp với mức
 * thụt lề người dùng nhìn thấy.
 */
function cellHasNestedList(cell: Element): boolean {
  for (const list of Array.from(cell.querySelectorAll('ul, ol'))) {
    for (let a = list.parentElement; a && a !== cell && cell.contains(a); a = a.parentElement) {
      if (a.nodeName === 'UL' || a.nodeName === 'OL') {
        return true;
      }
    }
  }
  return false;
}

/**
 * Sau thao tác indent: nếu ô bảng hiện tại có list phân cấp (li lồng li) thì
 * bảng đó không còn là Markdown thuần được nữa — sẽ được lưu dưới dạng HTML.
 * Nhắc người dùng một lần cho mỗi ô.
 */
export function warnIfComplexTableList(): void {
  const sel = window.getSelection();
  const node = sel?.anchorNode ? closestElement(sel.anchorNode) : null;
  const cell = node?.closest('td, th');
  if (!cell || !content.contains(cell) || !cellHasNestedList(cell)) {
    return;
  }
  if (warnedComplexCells.has(cell)) {
    return;
  }
  warnedComplexCells.add(cell);
  showToast(
    '⚠ Tables containing nested lists will be saved as HTML — ' + 'this cell is no longer a plain Markdown table.'
  );
}

/** Chèn bảng 3×3 mới tại vị trí caret (nút toolbar chính "⊞"). */
export function insertTable(): void {
  // Nếu caret đang ở trong ô của một bảng khác, chèn thẳng vào đó sẽ tạo
  // bảng lồng bảng — không thể biểu diễn bằng pipe Markdown thuần (bị vỡ
  // thành chuỗi "|" thoát dấu khi serialize). Đưa caret ra ngay sau bảng
  // đang chứa nó trước khi chèn.
  const selBefore = window.getSelection();
  const anchorBefore = selBefore?.anchorNode ? closestElement(selBefore.anchorNode) : null;
  const enclosingCell = anchorBefore?.closest('td, th');
  if (enclosingCell && content.contains(enclosingCell)) {
    const outerTable = enclosingCell.closest('table');
    if (outerTable) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      outerTable.after(p);
      ctx.dom.placeCaretIn(p);
    }
  }

  const rows: string[] = [];
  rows.push('<table><thead><tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr></thead><tbody>');
  for (let r = 0; r < 2; r++) {
    rows.push('<tr><td><br></td><td><br></td><td><br></td></tr>');
  }
  rows.push('</tbody></table><p><br></p>');
  document.execCommand('insertHTML', false, rows.join(''));
  // Đặt caret vào ô header đầu tiên của bảng vừa chèn (bảng gần caret nhất)
  const sel = window.getSelection();
  const anchor = sel?.anchorNode ? closestElement(sel.anchorNode) : null;
  let table = anchor?.closest('table') ?? null;
  if (!table) {
    let prev = anchor?.previousElementSibling ?? null;
    while (prev && prev.tagName !== 'TABLE') {
      prev = prev.previousElementSibling;
    }
    table = prev as HTMLTableElement | null;
  }
  const firstCell = table?.querySelector('th, td');
  if (firstCell) {
    ctx.dom.placeCaretIn(firstCell, true);
  }
  if (table) {
    fitTableColumns(table);
  }
}

// ---------------------------------------------------------------------------
// Row/column drag & drop (HLR section 17, US-17.4, M2)
//
// Row reorder reuses sibling-move.ts as-is: tbody rows are plain element
// siblings, exactly the case that primitive was generalized for (see
// drag-drop.ts, US-17.3, for the full undo-mechanism rationale).
//
// Column reorder is a DIFFERENT shape — a "column" isn't a DOM sibling run,
// it's one cell per row scattered across every <tr>. Rather than juggling N
// separate Ranges (which would cost N undo steps, breaking F1), the whole
// <table> is cloned, every row's cells are reordered in the clone, and the
// ENTIRE table is swapped in with a single Range (selectNode(table)) +
// execCommand('insertHTML') call — one undo step for the whole column move,
// same technique, applied to a subtree-rebuild instead of a sibling-reorder.
// Each cell keeps its own align/style attributes since real cell elements
// move as a unit — no separate column-alignment bookkeeping needed.
// ---------------------------------------------------------------------------

type TableDragKind = 'row' | 'col';
type TableDragState = 'idle' | 'armed' | 'dragging';

const TD_DRAG_THRESHOLD_PX = 4;
const TD_HANDLE_GLYPH = '⠿';

let tdState: TableDragState = 'idle';
let tdKind: TableDragKind = 'row';
let tdStartX = 0;
let tdStartY = 0;
let tdTable: HTMLTableElement | null = null;
let tdRows: HTMLTableRowElement[] = [];
let tdRowIdx = -1;
let tdColIndex = -1;
let tdCurrentGap = -1;
let tdCurrentGapValid = false;

let rowHandleEl: HTMLDivElement;
let colHandleEl: HTMLDivElement;
let tdDropLineEl: HTMLDivElement;
let tdGhostEl: HTMLDivElement;

let hoveredRow: HTMLTableRowElement | null = null;
let hoveredCol: { table: HTMLTableElement; index: number } | null = null;

function tbodyRows(table: HTMLTableElement): HTMLTableRowElement[] {
  const tbody = table.querySelector('tbody');
  return tbody ? (Array.from(tbody.children).filter((el) => el.tagName === 'TR') as HTMLTableRowElement[]) : [];
}

/** Row under the cursor — trigger zone extends `rowHandleEl`'s width to the left of the table so hovering the handle's own column still counts. */
function findRowAt(clientX: number, clientY: number): HTMLTableRowElement | null {
  for (const table of Array.from(content.querySelectorAll('table')) as HTMLTableElement[]) {
    const tRect = table.getBoundingClientRect();
    if (clientY < tRect.top || clientY > tRect.bottom || clientX < tRect.left - 24 || clientX > tRect.right) {
      continue;
    }
    for (const row of tbodyRows(table)) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        return row;
      }
    }
  }
  return null;
}

/** Header cell under the cursor — trigger zone extends `colHandleEl`'s height above the table. */
function findHeaderCellAt(clientX: number, clientY: number): { table: HTMLTableElement; index: number } | null {
  for (const table of Array.from(content.querySelectorAll('table')) as HTMLTableElement[]) {
    const headerRow = table.tHead?.rows[0];
    if (!headerRow) {
      continue;
    }
    const hRect = headerRow.getBoundingClientRect();
    if (clientY < hRect.top - 24 || clientY > hRect.bottom || clientX < hRect.left || clientX > hRect.right) {
      continue;
    }
    for (let i = 0; i < headerRow.cells.length; i++) {
      const r = headerRow.cells[i].getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) {
        return { table, index: i };
      }
    }
  }
  return null;
}

function positionRowHandle(row: HTMLTableRowElement | null): void {
  if (!row) {
    rowHandleEl.style.display = 'none';
    return;
  }
  const table = row.closest('table') as HTMLTableElement;
  const tRect = table.getBoundingClientRect();
  const rRect = row.getBoundingClientRect();
  rowHandleEl.style.display = 'flex';
  rowHandleEl.style.top = `${rRect.top}px`;
  rowHandleEl.style.left = `${tRect.left - 20}px`;
}

function positionColHandle(col: { table: HTMLTableElement; index: number } | null): void {
  if (!col) {
    colHandleEl.style.display = 'none';
    return;
  }
  const headerRow = col.table.tHead?.rows[0];
  const cell = headerRow?.cells[col.index];
  if (!cell) {
    colHandleEl.style.display = 'none';
    return;
  }
  const cRect = cell.getBoundingClientRect();
  colHandleEl.style.display = 'flex';
  colHandleEl.style.left = `${cRect.left + cRect.width / 2 - 8}px`;
  colHandleEl.style.top = `${cRect.top - 20}px`;
}

function sameCol(a: { table: HTMLTableElement; index: number } | null, b: { table: HTMLTableElement; index: number } | null): boolean {
  return a === b || (!!a && !!b && a.table === b.table && a.index === b.index);
}

function rowGapAt(rows: HTMLTableRowElement[], clientY: number): number {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) {
      return i;
    }
  }
  return rows.length;
}

function colGapAt(table: HTMLTableElement, clientX: number): number {
  const headerRow = table.tHead?.rows[0];
  if (!headerRow) {
    return 0;
  }
  for (let i = 0; i < headerRow.cells.length; i++) {
    const r = headerRow.cells[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) {
      return i;
    }
  }
  return headerRow.cells.length;
}

function tdCleanupVisuals(): void {
  if (tdKind === 'row' && tdTable) {
    tdRows[tdRowIdx]?.classList.remove('dd-source-muted');
  } else if (tdKind === 'col' && tdTable) {
    for (const row of Array.from(tdTable.rows)) {
      row.cells[tdColIndex]?.classList.remove('dd-source-muted');
    }
  }
  tdGhostEl.style.display = 'none';
  tdGhostEl.replaceChildren();
  tdDropLineEl.style.display = 'none';
  document.body.classList.remove('dd-dragging');
}

function tdResetState(): void {
  tdState = 'idle';
  tdTable = null;
  tdRows = [];
  tdRowIdx = -1;
  tdColIndex = -1;
  tdCurrentGapValid = false;
  hoveredRow = null;
  hoveredCol = null;
  document.removeEventListener('mousemove', onTdMouseMove);
  document.removeEventListener('mouseup', onTdMouseUp);
  document.removeEventListener('keydown', onTdKeyDown);
}

function finishRowMove(): void {
  if (!tdTable) {
    return;
  }
  const tbody = tdTable.querySelector('tbody');
  if (!tbody) {
    return;
  }
  const result = computeSiblingMove(tdRows, tdRowIdx, tdRowIdx, tdCurrentGap);
  const movedEl = applySiblingMove(tbody, result);
  const firstCell = movedEl?.querySelector('td, th');
  if (firstCell) {
    ctx.dom.placeCaretIn(firstCell);
  }
  fitTableColumns(tdTable);
  ctx.scheduleSync();
}

/** Column move: whole-table rebuild + single execCommand — see the block comment above this section. */
function finishColMove(): void {
  const table = tdTable;
  if (!table) {
    return;
  }
  const fromIdx = tdColIndex;
  const gap = tdCurrentGap;
  const clone = table.cloneNode(true) as HTMLTableElement;
  const insertionIndex = gap > fromIdx ? gap - 1 : gap;
  for (const row of Array.from(clone.rows)) {
    const cells = Array.from(row.cells);
    const moved = cells[fromIdx];
    if (!moved) {
      continue;
    }
    cells.splice(fromIdx, 1);
    cells.splice(insertionIndex, 0, moved);
    row.replaceChildren(...cells);
  }
  const prevSibling = table.previousElementSibling;
  const parent = table.parentElement;
  const range = document.createRange();
  range.selectNode(table);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand('insertHTML', false, clone.outerHTML);

  const newTable = (prevSibling ? prevSibling.nextElementSibling : parent?.firstElementChild) as HTMLTableElement | null;
  if (newTable) {
    fitTableColumns(newTable);
    const headerCell = newTable.tHead?.rows[0]?.cells[insertionIndex];
    if (headerCell) {
      ctx.dom.placeCaretIn(headerCell, true);
    }
  }
  ctx.scheduleSync();
}

function tdUpdateGhostPosition(clientX: number, clientY: number): void {
  tdGhostEl.style.left = `${clientX + 12}px`;
  tdGhostEl.style.top = `${clientY + 12}px`;
}

function tdUpdateRowDropLine(clientY: number): void {
  if (!tdTable) {
    return;
  }
  const gap = rowGapAt(tdRows, clientY);
  tdCurrentGap = gap;
  tdCurrentGapValid = isValidSiblingGap(gap, tdRowIdx, tdRowIdx);
  if (!tdCurrentGapValid || tdRows.length === 0) {
    tdDropLineEl.style.display = 'none';
    return;
  }
  const tRect = tdTable.getBoundingClientRect();
  let y: number;
  if (gap === 0) {
    y = tdRows[0].getBoundingClientRect().top;
  } else if (gap === tdRows.length) {
    y = tdRows[tdRows.length - 1].getBoundingClientRect().bottom;
  } else {
    y = (tdRows[gap - 1].getBoundingClientRect().bottom + tdRows[gap].getBoundingClientRect().top) / 2;
  }
  tdDropLineEl.className = 'dd-drop-line';
  tdDropLineEl.style.display = 'block';
  tdDropLineEl.style.top = `${y}px`;
  tdDropLineEl.style.left = `${tRect.left}px`;
  tdDropLineEl.style.width = `${tRect.width}px`;
  tdDropLineEl.style.height = '2px';
}

function tdUpdateColDropLine(clientX: number): void {
  if (!tdTable) {
    return;
  }
  const headerRow = tdTable.tHead?.rows[0];
  if (!headerRow) {
    return;
  }
  const gap = colGapAt(tdTable, clientX);
  tdCurrentGap = gap;
  tdCurrentGapValid = isValidSiblingGap(gap, tdColIndex, tdColIndex);
  const tRect = tdTable.getBoundingClientRect();
  if (!tdCurrentGapValid) {
    tdDropLineEl.style.display = 'none';
    return;
  }
  let x: number;
  if (gap === 0) {
    x = headerRow.cells[0].getBoundingClientRect().left;
  } else if (gap === headerRow.cells.length) {
    x = headerRow.cells[headerRow.cells.length - 1].getBoundingClientRect().right;
  } else {
    x = (headerRow.cells[gap - 1].getBoundingClientRect().right + headerRow.cells[gap].getBoundingClientRect().left) / 2;
  }
  tdDropLineEl.className = 'dd-drop-line dd-drop-line-vertical';
  tdDropLineEl.style.display = 'block';
  tdDropLineEl.style.left = `${x}px`;
  tdDropLineEl.style.top = `${tRect.top}px`;
  tdDropLineEl.style.height = `${tRect.height}px`;
  tdDropLineEl.style.width = '2px';
}

function tdStartDragging(): void {
  tdState = 'dragging';
  rowHandleEl.style.display = 'none';
  colHandleEl.style.display = 'none';
  if (tdKind === 'row' && tdTable) {
    const row = tdRows[tdRowIdx];
    tdGhostEl.replaceChildren(row.cloneNode(true) as HTMLElement);
    row.classList.add('dd-source-muted');
  } else if (tdKind === 'col' && tdTable) {
    const headerRow = tdTable.tHead?.rows[0];
    const cell = headerRow?.cells[tdColIndex];
    if (cell) {
      tdGhostEl.replaceChildren(cell.cloneNode(true) as HTMLElement);
    }
    for (const row of Array.from(tdTable.rows)) {
      row.cells[tdColIndex]?.classList.add('dd-source-muted');
    }
  }
  tdGhostEl.style.display = 'block';
  document.body.classList.add('dd-dragging');
}

function onTdMouseMove(e: MouseEvent): void {
  if (tdState === 'armed') {
    if (Math.hypot(e.clientX - tdStartX, e.clientY - tdStartY) < TD_DRAG_THRESHOLD_PX) {
      return;
    }
    tdStartDragging();
  }
  if (tdState !== 'dragging') {
    return;
  }
  tdUpdateGhostPosition(e.clientX, e.clientY);
  if (tdKind === 'row') {
    tdUpdateRowDropLine(e.clientY);
  } else {
    tdUpdateColDropLine(e.clientX);
  }
}

function onTdMouseUp(): void {
  if (tdState === 'dragging') {
    const shouldMove = tdCurrentGapValid;
    const kind = tdKind;
    tdCleanupVisuals();
    if (shouldMove) {
      if (kind === 'row') {
        finishRowMove();
      } else {
        finishColMove();
      }
    }
  } else {
    tdCleanupVisuals();
  }
  tdResetState();
}

function onTdKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    tdCleanupVisuals();
    tdResetState();
  }
}

function armRowDrag(row: HTMLTableRowElement, clientX: number, clientY: number): void {
  const table = row.closest('table') as HTMLTableElement | null;
  if (!table) {
    return;
  }
  tdKind = 'row';
  tdState = 'armed';
  tdStartX = clientX;
  tdStartY = clientY;
  tdTable = table;
  tdRows = tbodyRows(table);
  tdRowIdx = tdRows.indexOf(row);
  document.addEventListener('mousemove', onTdMouseMove);
  document.addEventListener('mouseup', onTdMouseUp);
  document.addEventListener('keydown', onTdKeyDown);
}

function armColDrag(table: HTMLTableElement, index: number, clientX: number, clientY: number): void {
  tdKind = 'col';
  tdState = 'armed';
  tdStartX = clientX;
  tdStartY = clientY;
  tdTable = table;
  tdColIndex = index;
  document.addEventListener('mousemove', onTdMouseMove);
  document.addEventListener('mouseup', onTdMouseUp);
  document.addEventListener('keydown', onTdKeyDown);
}

function initTableDragDrop(): void {
  rowHandleEl = document.createElement('div');
  rowHandleEl.className = 'dd-handle dd-row-handle';
  rowHandleEl.textContent = TD_HANDLE_GLYPH;
  rowHandleEl.style.display = 'none';
  document.body.appendChild(rowHandleEl);

  colHandleEl = document.createElement('div');
  colHandleEl.className = 'dd-handle dd-col-handle';
  colHandleEl.textContent = TD_HANDLE_GLYPH;
  colHandleEl.style.display = 'none';
  document.body.appendChild(colHandleEl);

  tdGhostEl = document.createElement('div');
  tdGhostEl.className = 'dd-ghost';
  tdGhostEl.style.display = 'none';
  document.body.appendChild(tdGhostEl);

  tdDropLineEl = document.createElement('div');
  tdDropLineEl.className = 'dd-drop-line';
  tdDropLineEl.style.display = 'none';
  document.body.appendChild(tdDropLineEl);

  content.addEventListener('mousemove', (e) => {
    if (tdState !== 'idle') {
      return;
    }
    const row = findRowAt(e.clientX, e.clientY);
    if (row !== hoveredRow) {
      hoveredRow = row;
      positionRowHandle(row);
    }
    if (row) {
      if (hoveredCol) {
        hoveredCol = null;
        positionColHandle(null);
      }
      return;
    }
    const col = findHeaderCellAt(e.clientX, e.clientY);
    if (!sameCol(col, hoveredCol)) {
      hoveredCol = col;
      positionColHandle(col);
    }
  });

  content.addEventListener('mouseleave', () => {
    if (tdState !== 'idle') {
      return;
    }
    hoveredRow = null;
    hoveredCol = null;
    positionRowHandle(null);
    positionColHandle(null);
  });

  // Handles use viewport coordinates from getBoundingClientRect(), recomputed
  // only on mousemove over #content — a scroll with the mouse stationary
  // otherwise leaves them stuck at the old position while the row/column
  // underneath moves (mirrors the block-level drag handle in drag-drop.ts).
  window.addEventListener(
    'scroll',
    () => {
      if (tdState !== 'idle') {
        return;
      }
      if (hoveredRow) {
        positionRowHandle(hoveredRow);
      }
      if (hoveredCol) {
        positionColHandle(hoveredCol);
      }
    },
    { passive: true, capture: true }
  );

  rowHandleEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hoveredRow) {
      return;
    }
    e.preventDefault();
    armRowDrag(hoveredRow, e.clientX, e.clientY);
  });

  colHandleEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hoveredCol) {
      return;
    }
    e.preventDefault();
    armColDrag(hoveredCol.table, hoveredCol.index, e.clientX, e.clientY);
  });
}
