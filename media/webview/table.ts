/**
 * Thao tác bảng: toolbar nổi (thêm/xóa dòng/cột, căn lề cột, xóa bảng) và
 * điều hướng ô bằng Tab. Toolbar tự ẩn sau vài giây, chỉ hiện lại khi click
 * chuột vào bảng (gõ phím không tính).
 */
import { fillSequenceColumn } from './pipeline';
import { closestElement, emptyParagraph, showToast, svgIcon, type DomHelpers } from './dom-utils';
import { TABLE_TOOLBAR_HIDE_MS } from './constants';
import { isValidSiblingGap } from './sibling-move';

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

/** Rebuilds `source` as a `<th>`/`<td>` (per `tag`), preserving its `align`/`style` and moving
 * (not cloning) its children over — shared by `deleteRow`'s auto-promote-on-delete and
 * `setAsHeaderRow`'s manual promote/demote swap (bug 0716 round 2). */
function convertCell(source: HTMLTableCellElement, tag: 'th' | 'td'): HTMLTableCellElement {
  const target = document.createElement(tag);
  for (const attr of ['align', 'style']) {
    const v = source.getAttribute(attr);
    if (v) {
      target.setAttribute(attr, v);
    }
  }
  while (source.firstChild) {
    target.appendChild(source.firstChild);
  }
  return target;
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
      newHead.appendChild(convertCell(td, 'th'));
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

/** Promotes `row` to become the table's header, swapping it with the current header row — the old
 * header becomes a normal body row exactly where `row` used to be, every other row keeps its
 * position. Manual complement to `deleteRow`'s automatic promote-on-delete (bug 0716 round 2,
 * "Set as header row" on a row handle's click-to-menu). No-op if `row` already is the header. */
function setAsHeaderRow(row: HTMLTableRowElement): void {
  const table = row.closest('table') as HTMLTableElement | null;
  const oldHeader = table?.tHead?.rows[0];
  if (!table || !oldHeader || row === oldHeader) {
    return;
  }
  const newHeader = document.createElement('tr');
  for (const cell of Array.from(row.cells)) {
    newHeader.appendChild(convertCell(cell, 'th'));
  }
  const oldAsBody = document.createElement('tr');
  for (const cell of Array.from(oldHeader.cells)) {
    oldAsBody.appendChild(convertCell(cell, 'td'));
  }
  row.replaceWith(oldAsBody);
  oldHeader.replaceWith(newHeader);
  ctx.dom.placeCaretIn(newHeader.cells[0]);
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
  const p = emptyParagraph();
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
  const cells = Array.from(table.rows).flatMap((row) => Array.from(row.cells));
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
      const p = emptyParagraph();
      outerTable.after(p);
      ctx.dom.placeCaretIn(p);
    }
  }

  const bodyRow = '<tr><td><br></td><td><br></td><td><br></td></tr>';
  const html =
    '<table><thead><tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr></thead><tbody>' +
    bodyRow.repeat(2) +
    '</tbody></table><p><br></p>';
  document.execCommand('insertHTML', false, html);
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
// Row reorder used to reuse sibling-move.ts as-is (tbody rows are plain
// element siblings, exactly the case that primitive was generalized for —
// see drag-drop.ts, US-17.3, for the full undo-mechanism rationale), but bug
// 0716 round 2 found `document.execCommand('insertHTML', ...)` doesn't parse
// a bare `<tr>...</tr>` HTML string correctly when it's not wrapped in a
// `<table>`/`<tbody>` — unlike `<p>`/`<li>`/heading tags (valid almost
// anywhere), `<tr>` needs a table-row parsing context the command doesn't
// reliably provide, and the browser silently drops the row/cell boundaries,
// dumping every affected row's text into one cell. Moving more than one row
// (which `computeSiblingMove`'s Range always ends up spanning unless the
// dragged row lands at the very first/last gap) reproduced this on every
// drag. `finishRowMove` below moves the live `<tr>` node directly instead —
// no HTML serialize/reparse round-trip, so there's nothing for the browser
// to misparse. Trade-off: unlike the column move below (still execCommand,
// see its own comment), a row move no longer lands on the native undo stack
// as its own step — accepted over the alternative of corrupting the table.
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

/** Row armed via a row handle's mousedown — read back on mouseup to open the row menu when the
 * click never turned into a drag (bug 0716 round 2, mirrors `armedBlock` in drag-drop.ts). Set for
 * both header and body rows; only body rows also go through `armRowDrag`'s full drag machinery. */
let armedRow: HTMLTableRowElement | null = null;
/** Row whose `.dd-hover-outline` is being kept alive by an open row menu — mirrors
 * `menuTargetBlock` in drag-drop.ts. */
let rowMenuTargetRow: HTMLTableRowElement | null = null;
let rowMenuPopupEl: HTMLDivElement;

function tbodyRows(table: HTMLTableElement): HTMLTableRowElement[] {
  const tbody = table.querySelector('tbody');
  return tbody ? (Array.from(tbody.children).filter((el) => el.tagName === 'TR') as HTMLTableRowElement[]) : [];
}

/** Row under the cursor — trigger zone extends `rowHandleEl`'s width to the left of the table so
 * hovering the handle's own column still counts. Includes the header row (bug 0716 round 2) so it
 * gets a handle too, same as any other row — `armRowDrag` refuses to actually arm a drag for it
 * (GFM always needs exactly one header row at the top), but its handle still supports the
 * click-to-menu "Set as header row" path via `armedRow`. */
function findRowAt(clientX: number, clientY: number): HTMLTableRowElement | null {
  for (const table of Array.from(content.querySelectorAll('table')) as HTMLTableElement[]) {
    const tRect = table.getBoundingClientRect();
    if (clientY < tRect.top || clientY > tRect.bottom || clientX < tRect.left - 24 || clientX > tRect.right) {
      continue;
    }
    const headerRow = table.tHead?.rows[0];
    for (const row of headerRow ? [headerRow, ...tbodyRows(table)] : tbodyRows(table)) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        return row;
      }
    }
  }
  return null;
}

/** Column under the cursor — x matched against header cell boundaries (columns align vertically down the table), y spans the whole table (plus `colHandleEl`'s height above the header) so the column handle tracks the hovered cell in ANY row, not just the header (bug 0715 #11: row and column must be able to show together). */
function findHeaderCellAt(clientX: number, clientY: number): { table: HTMLTableElement; index: number } | null {
  for (const table of Array.from(content.querySelectorAll('table')) as HTMLTableElement[]) {
    const headerRow = table.tHead?.rows[0];
    if (!headerRow) {
      continue;
    }
    const tRect = table.getBoundingClientRect();
    if (clientY < tRect.top - 24 || clientY > tRect.bottom || clientX < tRect.left || clientX > tRect.right) {
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

/** Hit column spans the row's own full height and sits flush (zero gap) against the
 * table's own left edge — `right` (not `left`) anchoring guarantees the flush fit
 * regardless of the icon's CSS width, matching drag-drop.ts's `positionHandle` (bug 0716
 * #4, table equivalent). */
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
  rowHandleEl.style.height = `${rRect.height}px`;
  rowHandleEl.style.right = `${window.innerWidth - tRect.left}px`;
}

/** Hit column spans the header cell's own full width and sits flush (zero gap) against
 * the table's own top edge — `bottom` anchoring guarantees the flush fit regardless of
 * the icon's CSS height (bug 0716 #4, table equivalent). */
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
  const tRect = col.table.getBoundingClientRect();
  const cRect = cell.getBoundingClientRect();
  colHandleEl.style.display = 'flex';
  colHandleEl.style.left = `${cRect.left}px`;
  colHandleEl.style.width = `${cRect.width}px`;
  colHandleEl.style.bottom = `${window.innerHeight - tRect.top}px`;
}

function sameCol(a: { table: HTMLTableElement; index: number } | null, b: { table: HTMLTableElement; index: number } | null): boolean {
  return a === b || (!!a && !!b && a.table === b.table && a.index === b.index);
}

/** Tracks whichever row is currently hovered and removes `.dd-hover-outline` when it stops
 * being hovered (bug 0715 #12 clear-path) — `hoveredRow` itself is the tracked "currently
 * highlighted" element. Adding the class is NOT this function's job (bug 0716 #6): only
 * `armRowDrag` (mousedown on the row handle) adds it, so plain hover never shows it. */
function setHighlightedRow(row: HTMLTableRowElement | null): void {
  if (row === hoveredRow) {
    return;
  }
  hoveredRow?.classList.remove('dd-hover-outline');
  hoveredRow = row;
}

/** Tracks whichever column is currently hovered and removes `.dd-hover-outline-cell` from
 * every cell in it when it stops being hovered (mirrors `setHighlightedRow`). Adding the
 * class is NOT this function's job (bug 0716 #6): only `armColDrag` (mousedown on the
 * column handle) adds it. */
function setColumnHighlight(col: { table: HTMLTableElement; index: number } | null): void {
  if (sameCol(col, hoveredCol)) {
    return;
  }
  if (hoveredCol) {
    for (const row of Array.from(hoveredCol.table.rows)) {
      row.cells[hoveredCol.index]?.classList.remove('dd-hover-outline-cell');
    }
  }
  hoveredCol = col;
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
  armedRow = null;
  // Skip clearing the outline here when a row menu is open for this exact row — openRowMenu()
  // (called just before this in the click path) already claimed it via `rowMenuTargetRow`;
  // closeRowMenu() clears it for real once the menu goes away (mirrors drag-drop.ts's
  // menuTargetBlock/resetState split, bug 0716 #5/round 2).
  if (hoveredRow !== rowMenuTargetRow) {
    setHighlightedRow(null);
  }
  setColumnHighlight(null);
  document.removeEventListener('mousemove', onTdMouseMove);
  document.removeEventListener('mouseup', onTdMouseUp);
  document.removeEventListener('keydown', onTdKeyDown);
}

function isRowMenuOpen(): boolean {
  return rowMenuPopupEl.style.display !== 'none';
}

function closeRowMenu(): void {
  rowMenuPopupEl.style.display = 'none';
  rowMenuPopupEl.replaceChildren();
  if (rowMenuTargetRow) {
    rowMenuTargetRow.classList.remove('dd-hover-outline');
    rowMenuTargetRow = null;
  }
}

/** Click (not drag) on a row handle opens this — currently a single action, "Set as header row",
 * hidden when `row` already is the header (bug 0716 round 2). */
function openRowMenu(row: HTMLTableRowElement): void {
  closeRowMenu();
  if (row.parentElement?.tagName === 'THEAD') {
    return;
  }
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'dd-menu-item';
  item.textContent = 'Set as header row';
  item.addEventListener('click', () => {
    closeRowMenu();
    setAsHeaderRow(row);
  });
  rowMenuPopupEl.appendChild(item);

  const rect = rowHandleEl.getBoundingClientRect();
  rowMenuPopupEl.style.display = 'block';
  rowMenuPopupEl.style.top = `${rect.top + rect.height / 2}px`;
  rowMenuPopupEl.style.left = `${rect.right + 4}px`;

  rowMenuTargetRow = row;
  row.classList.add('dd-hover-outline');
}

function onHeaderRowHandleMouseUp(): void {
  if (armedRow) {
    openRowMenu(armedRow);
  }
  armedRow = null;
}

function finishRowMove(): void {
  if (!tdTable) {
    return;
  }
  const tbody = tdTable.querySelector('tbody');
  if (!tbody) {
    return;
  }
  const row = tdRows[tdRowIdx];
  // `tdCurrentGap` indexes into `tdRows`, captured once at drag-arm time — each entry is a
  // live element reference, so it still points at the right node regardless of where `row`
  // currently sits; `undefined` (gap === tdRows.length) means "insert at the end".
  const refRow = tdRows[tdCurrentGap] ?? null;
  tbody.insertBefore(row, refRow);
  const firstCell = row.querySelector('td, th');
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
    const rect = row.getBoundingClientRect();
    const clone = row.cloneNode(true) as HTMLElement;
    clone.classList.remove('dd-hover-outline');
    tdGhostEl.replaceChildren(clone);
    tdGhostEl.style.width = `${rect.width}px`;
    tdGhostEl.style.height = `${rect.height}px`;
    row.classList.add('dd-source-muted');
  } else if (tdKind === 'col' && tdTable) {
    const headerRow = tdTable.tHead?.rows[0];
    const cell = headerRow?.cells[tdColIndex];
    if (cell) {
      // A column spans every row, so unlike the row ghost there's no single element to
      // clone — stack a clone of each row's own cell instead, one per <tr> so they stay
      // separate vertical rows (bare <td> siblings would otherwise anonymous-table-generate
      // into one horizontal row). Real content instead of the old empty placeholder box
      // (bug 0716 round 2 #4).
      const cellRect = cell.getBoundingClientRect();
      const tableRect = tdTable.getBoundingClientRect();
      tdGhostEl.replaceChildren();
      for (const row of Array.from(tdTable.rows)) {
        const srcCell = row.cells[tdColIndex];
        if (!srcCell) {
          continue;
        }
        const cellClone = srcCell.cloneNode(true) as HTMLElement;
        cellClone.classList.remove('dd-hover-outline', 'dd-hover-outline-cell', 'dd-source-muted');
        cellClone.style.width = '100%';
        cellClone.style.height = `${row.getBoundingClientRect().height}px`;
        const rowWrap = document.createElement('tr');
        rowWrap.appendChild(cellClone);
        tdGhostEl.appendChild(rowWrap);
      }
      tdGhostEl.style.width = `${cellRect.width}px`;
      tdGhostEl.style.height = `${tableRect.height}px`;
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
      // Clear the highlight before the move rebuilds the DOM (row reorder replaces
      // rows via Range + insertHTML; column reorder clones the whole table) —
      // otherwise tdResetState()'s own clear below only touches the stale,
      // now-detached original row/table, leaving the newly-created node
      // highlighted forever (bug 0715 #12).
      setHighlightedRow(null);
      setColumnHighlight(null);
      if (kind === 'row') {
        finishRowMove();
      } else {
        finishColMove();
      }
    }
  } else {
    tdCleanupVisuals();
    // Never crossed TD_DRAG_THRESHOLD_PX — a click, not a drag. Only row handles set `armedRow`
    // (col handles don't have an equivalent menu), so this is a no-op for column clicks.
    if (armedRow) {
      openRowMenu(armedRow);
    }
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
  row.classList.add('dd-hover-outline');
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
  for (const row of Array.from(table.rows)) {
    row.cells[index]?.classList.add('dd-hover-outline-cell');
  }
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
  tdGhostEl.className = 'dd-ghost dd-ghost-table';
  tdGhostEl.style.display = 'none';
  document.body.appendChild(tdGhostEl);

  tdDropLineEl = document.createElement('div');
  tdDropLineEl.className = 'dd-drop-line';
  tdDropLineEl.style.display = 'none';
  document.body.appendChild(tdDropLineEl);

  rowMenuPopupEl = document.createElement('div');
  rowMenuPopupEl.className = 'dd-menu-popup dd-row-menu-popup';
  rowMenuPopupEl.style.display = 'none';
  document.body.appendChild(rowMenuPopupEl);

  document.addEventListener('mousedown', (e) => {
    if (isRowMenuOpen() && !rowMenuPopupEl.contains(e.target as Node)) {
      closeRowMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isRowMenuOpen()) {
      closeRowMenu();
    }
  });

  content.addEventListener('mousemove', (e) => {
    if (tdState !== 'idle') {
      return;
    }
    const row = findRowAt(e.clientX, e.clientY);
    if (row !== hoveredRow) {
      setHighlightedRow(row);
      positionRowHandle(row);
    }
    const col = findHeaderCellAt(e.clientX, e.clientY);
    if (!sameCol(col, hoveredCol)) {
      setColumnHighlight(col);
      positionColHandle(col);
    }
  });

  content.addEventListener('mouseleave', (e: MouseEvent) => {
    if (tdState !== 'idle') {
      return;
    }
    // Handles live outside #content (appended to document.body), so moving the
    // cursor onto them fires #content's mouseleave — don't clear hover state
    // in that case, only when leaving toward something unrelated to the
    // handles themselves (mirrors the same guard in drag-drop.ts, bug 0715 #9).
    const related = e.relatedTarget as Node | null;
    // A real mouse move can skip clean over the (still fairly narrow) handle column in one
    // sampled step without landing on `rowHandleEl`/`colHandleEl` itself — fall back to a
    // geometric check against the gutter band the currently hovered handle lives in
    // (mirrors the same follow-up fix in drag-drop.ts, bug 0716 #4).
    const rowGutter =
      hoveredRow &&
      (() => {
        const tRect = hoveredRow.closest('table')?.getBoundingClientRect();
        const rRect = hoveredRow.getBoundingClientRect();
        return !!tRect && e.clientX < tRect.left && e.clientY >= rRect.top && e.clientY <= rRect.bottom;
      })();
    const colGutter =
      hoveredCol &&
      (() => {
        const tRect = hoveredCol.table.getBoundingClientRect();
        const cell = hoveredCol.table.tHead?.rows[0]?.cells[hoveredCol.index];
        const cRect = cell?.getBoundingClientRect();
        return !!cRect && e.clientY < tRect.top && e.clientX >= cRect.left && e.clientX <= cRect.right;
      })();
    if ((related && (rowHandleEl.contains(related) || colHandleEl.contains(related))) || rowGutter || colGutter) {
      return;
    }
    setHighlightedRow(null);
    setColumnHighlight(null);
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
    armedRow = hoveredRow;
    if (hoveredRow.parentElement?.tagName === 'THEAD') {
      // The header row can't be dragged/reordered (GFM always needs exactly one, at the top) —
      // only the click-to-menu path applies, so skip the drag state machine entirely.
      document.addEventListener('mouseup', onHeaderRowHandleMouseUp, { once: true });
    } else {
      armRowDrag(hoveredRow, e.clientX, e.clientY);
    }
  });

  colHandleEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hoveredCol) {
      return;
    }
    e.preventDefault();
    armColDrag(hoveredCol.table, hoveredCol.index, e.clientX, e.clientY);
  });
}
