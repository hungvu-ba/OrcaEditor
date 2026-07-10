/**
 * Thao tác bảng: toolbar nổi (thêm/xóa dòng/cột, căn lề cột, xóa bảng) và
 * điều hướng ô bằng Tab. Toolbar tự ẩn sau vài giây, chỉ hiện lại khi click
 * chuột vào bảng (gõ phím không tính).
 */
import { fillSequenceColumn } from './pipeline';
import { closestElement, showToast, svgIcon, type DomHelpers } from './dom-utils';

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
  { icon: TABLE_ICONS.rowAbove, title: 'Thêm dòng phía trên', action: (c) => insertRow(c, 'above') },
  { icon: TABLE_ICONS.rowBelow, title: 'Thêm dòng phía dưới', action: (c) => insertRow(c, 'below') },
  { icon: TABLE_ICONS.colLeft, title: 'Thêm cột bên trái', action: (c) => insertColumn(c, 'left'), separatorBefore: true },
  { icon: TABLE_ICONS.colRight, title: 'Thêm cột bên phải', action: (c) => insertColumn(c, 'right') },
  { icon: TABLE_ICONS.alignLeft, title: 'Căn trái cột (mặc định)', action: (c) => alignTableColumn(c, 'left'), separatorBefore: true },
  { icon: TABLE_ICONS.alignCenter, title: 'Căn giữa cột', action: (c) => alignTableColumn(c, 'center') },
  { icon: TABLE_ICONS.alignRight, title: 'Căn phải cột', action: (c) => alignTableColumn(c, 'right') },
  { icon: TABLE_ICONS.delRow, title: 'Xóa dòng hiện tại', action: deleteRow, separatorBefore: true },
  { icon: TABLE_ICONS.delCol, title: 'Xóa cột hiện tại', action: deleteColumn },
  { icon: TABLE_ICONS.trash, title: 'Xóa cả bảng', action: deleteTable, separatorBefore: true },
];

/** Toolbar bảng tự ẩn sau 3s; chỉ hiện lại khi CLICK chuột vào bảng (gõ phím không tính). */
const TABLE_TOOLBAR_HIDE_MS = 3_000;
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

function positionTableToolbar(cell: Element): void {
  const table = cell.closest('table');
  if (!table) {
    return;
  }
  const rect = table.getBoundingClientRect();
  const top = rect.top + window.scrollY - tableToolbar.offsetHeight - 6;
  // không chui dưới toolbar chính (sticky trên cùng)
  const minTop = window.scrollY + toolbarEl.offsetHeight + 4;
  tableToolbar.style.top = `${Math.max(top, minTop)}px`;
  tableToolbar.style.left = `${rect.left + window.scrollX}px`;
}

function cellTable(cell: HTMLTableCellElement): HTMLTableElement | null {
  return cell.closest('table');
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
  afterTableEdit();
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
  afterTableEdit();
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
  afterTableEdit();
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
  afterTableEdit();
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

function afterTableEdit(): void {
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
    '⚠ Bảng có danh sách phân cấp sẽ được lưu dưới dạng HTML — ' + 'ô này không còn là bảng Markdown thuần.'
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
  rows.push('<table><thead><tr><th>Cột 1</th><th>Cột 2</th><th>Cột 3</th></tr></thead><tbody>');
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
}
