/**
 * Tìm xuyên file trong project (Feature B — "Tìm xuyên file trong project").
 *
 *  - Khi vùng chọn trong #content đứng yên đủ lâu (CROSS_FILE_ICON_DEBOUNCE_MS)
 *    và đủ dài (>= MIN_SELECT_LENGTH ký tự, không tính khoảng trắng/dấu câu —
 *    cùng ngưỡng đo với select-highlight.ts để nhất quán), hiện một icon kính
 *    lúp nổi ngay cạnh cuối vùng chọn.
 *  - Bấm icon (hoặc Ctrl/Cmd+Shift+F) mới thực sự chạy tìm kiếm — không có
 *    debounce tự tìm, chỉ debounce để hiện/ẩn icon.
 *  - Việc tìm match thực hiện ở HOST (extension), webview chỉ gửi
 *    {query, scope} và nhận lại nhóm kết quả theo file (đã kèm sẵn ngữ cảnh
 *    dòng trước/sau) — khác với search.ts/select-highlight.ts (tìm tại chỗ
 *    trong DOM của file đang mở).
 */

import {
  MIN_SELECT_LENGTH,
  CROSS_FILE_ICON_DEBOUNCE_MS,
  ICON_AUTO_HIDE_MS,
  ICON_HOVER_GRACE_MS,
  SNIPPET_CONTEXT_CHARS,
  CROSS_FILE_POPOVER_WIDTH_PX,
  CROSS_FILE_POPOVER_MAX_HEIGHT_CAP_PX,
  CROSS_FILE_POPOVER_MAX_HEIGHT_VH_RATIO,
} from './constants';
import { buildMatchOptionToggles } from './match-options';
import { makeDraggable } from './dom-utils';
import { registerEscapeHandler, ESCAPE_PRIORITY } from './escape-stack';
import type { VsCodeApi } from './vscode-api';
import type { CrossFileMatchGroup, CrossFileSearchScope, WebviewToHost } from '../../src/shared/messages';
import type { MatchOptions } from '../../src/shared/text-match';

export interface CrossFileSearchController {
  /** Gọi lại khi nội dung tài liệu vừa render lại — ẩn icon/đóng popover vì vị trí/selection cũ không còn hợp lệ. */
  refresh(): void;
  /** Đặt phạm vi mặc định ban đầu (từ InitConfig.crossFileSearchScope). */
  setDefaultScope(scope: CrossFileSearchScope): void;
  /** Gọi từ message handler của main.ts khi nhận 'crossFileSearch:result' từ extension. */
  notifyResult(requestId: number, groups: CrossFileMatchGroup[], truncated: boolean, usedFallback: boolean): void;
}

/** Ký tự khoảng trắng hoặc dấu câu (Unicode) — dùng để loại khỏi phần đếm ngưỡng độ dài (khớp select-highlight.ts). */
const WHITESPACE_OR_PUNCT_RE = /[\s\p{P}]/gu;

const ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" fill="none"/>' +
  '<path d="M10.5 10.5l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
  '</svg>';

/** "1 result" / "3 results", "1 match" / "12 matches" — `plural` mặc định là `word + 's'`, truyền tay cho từ bất quy tắc như "match" → "matches". */
function pluralize(n: number, word: string, plural = `${word}s`): string {
  return `${n} ${n === 1 ? word : plural}`;
}

/** Cắt bớt đầu chuỗi (giữ đoạn sát match) khi vượt ngân sách, thêm tiền tố "…". */
function truncateContextLeft(text: string, maxChars: number): string {
  return text.length > maxChars ? `…${text.slice(text.length - maxChars)}` : text;
}

/** Cắt bớt cuối chuỗi (giữ đoạn sát match) khi vượt ngân sách, thêm hậu tố "…". */
function truncateContextRight(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Tạo element + gán className (+ textContent nếu truyền) — gom cụm createElement/className/textContent lặp lại khắp phần dựng DOM. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

export function initCrossFileSearch(content: HTMLElement, vscode: VsCodeApi): CrossFileSearchController {
  function postToHost(msg: WebviewToHost): void {
    vscode.postMessage(msg);
  }

  // --- Icon nổi ---
  const icon = el('button', 'cross-file-search-icon');
  icon.type = 'button';
  icon.innerHTML = ICON_SVG;
  icon.title = 'Search across project files (⌘⇧F / Ctrl+Shift+F)';
  icon.setAttribute('aria-label', 'Search across project files');
  icon.hidden = true;
  // Giữ selection trong #content khi bấm icon (giống mkBtn của search.ts).
  icon.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.appendChild(icon);

  // --- Popover kết quả ---
  const popover = el('div', 'cross-file-search-popover');
  popover.hidden = true;
  // Kéo (drag) popover đi chỗ khác để lộ nội dung phía sau đang bị nó che —
  // dùng chung makeDraggable() (dom-utils.ts) như popup Insert Link/Image
  // (prompt.ts, US-17.2) và popover sửa Math (math-edit.ts, US-4.19). Vùng
  // tương tác (select scope, toggle Aa/ab, kết quả, nút "See more") đã tự
  // động bị loại khỏi vùng kéo qua DRAG_IGNORE_SELECTOR (select/button) nên
  // không cần đánh dấu `data-no-drag` thủ công. positionPopover() vẫn ghi đè
  // left/top mỗi lần mở lại → vị trí kéo tự reset về anchor mặc định ở lần
  // mở kế tiếp (US-17.1).
  makeDraggable(popover);

  // Option Match Case / Whole Word (C4). Mặc định Whole Word = ON, Match Case
  // = OFF — cùng registry/khuôn với Ctrl+F (search.ts).
  const matchOptions: MatchOptions = { matchCase: false, wholeWord: true };

  const header = el('div', 'cross-file-search-header');
  // Hàng trên: count + scope (giữ nguyên bố cục cũ). Header giờ là cột, toggle
  // xuống hàng phụ bên dưới (header vốn chật — chốt #6 cho phép tách 2 hàng).
  const headerTop = el('div', 'cross-file-search-header-top');
  const countEl = el('span', 'cross-file-search-count');
  const scopeSelect = el('select', 'cross-file-search-scope');
  scopeSelect.setAttribute('aria-label', 'Search scope');
  const optMarkdown = document.createElement('option');
  optMarkdown.value = 'markdown';
  optMarkdown.textContent = 'Markdown files';
  const optAll = document.createElement('option');
  optAll.value = 'allFiles';
  optAll.textContent = 'All files';
  scopeSelect.append(optMarkdown, optAll);
  headerTop.append(countEl, scopeSelect);

  // Hàng phụ: nút toggle Aa/ab. Bấm → lật state → re-run query hiện tại (giống
  // đổi scope). doSearch là function declaration (hoisted) nên callback hợp lệ.
  const optionsRow = el('div', 'cross-file-search-options');
  const toggles = buildMatchOptionToggles(matchOptions, () => {
    if (currentQuery) {
      doSearch(currentQuery, currentScope);
    }
  });
  optionsRow.append(...toggles.elements);

  header.append(headerTop, optionsRow);

  const resultsEl = el('div', 'cross-file-search-results');

  const moreEl = el('button', 'cross-file-search-more', 'See more in Search panel');
  moreEl.type = 'button';
  moreEl.hidden = true;

  popover.append(header, resultsEl, moreEl);
  document.body.appendChild(popover);

  // --- Trạng thái ---
  // currentScope đóng cả vai trò "scope mặc định" (đặt qua setDefaultScope lúc
  // init) lẫn "scope của lần tìm gần nhất" — không cần tách hai biến vì luôn
  // có giá trị hợp lệ (khởi tạo 'markdown', không bao giờ rỗng).
  let currentScope: CrossFileSearchScope = 'markdown';
  let currentQuery = '';
  let seq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Timer tự ẩn icon sau ICON_AUTO_HIDE_MS kể từ lúc hiện — pause khi hover/focus icon (xem showIconForSelection/hideIcon). */
  let autoHideTimer: ReturnType<typeof setTimeout> | undefined;
  /** Mốc thời gian icon vừa hiện — dùng để bỏ qua 'mouseenter' dư vị trí chuột trong ICON_HOVER_GRACE_MS đầu (xem mouseenter handler bên dưới). */
  let iconShownAt = 0;

  // -------------------------------------------------------------------------
  // Đo lường selection (khớp logic select-highlight.ts)
  // -------------------------------------------------------------------------

  function measureSelection(): { query: string; range: Range } | undefined {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      return undefined;
    }
    const anchor = sel.anchorNode;
    const focus = sel.focusNode;
    if (!anchor || !focus || !content.contains(anchor) || !content.contains(focus)) {
      return undefined;
    }
    const query = (sel.toString() ?? '').trim();
    if (!query) {
      return undefined;
    }
    const stripped = query.replace(WHITESPACE_OR_PUNCT_RE, '');
    if (stripped.length < MIN_SELECT_LENGTH) {
      return undefined;
    }
    const range = sel.getRangeAt(sel.rangeCount - 1);
    return { query, range };
  }

  // -------------------------------------------------------------------------
  // Icon nổi: hiện/ẩn/định vị
  // -------------------------------------------------------------------------

  /** Huỷ timer tự-ẩn 3s đang chạy (nếu có) — dùng khi ẩn icon vì lý do khác, hoặc khi pause lúc hover/focus. */
  function clearAutoHideTimer(): void {
    if (autoHideTimer !== undefined) {
      clearTimeout(autoHideTimer);
      autoHideTimer = undefined;
    }
  }

  /** Bắt đầu (hoặc khởi động lại từ đầu, không resume phần dở) timer tự-ẩn 3s. */
  function startAutoHideTimer(): void {
    clearAutoHideTimer();
    autoHideTimer = setTimeout(() => {
      autoHideTimer = undefined;
      hideIcon();
    }, ICON_AUTO_HIDE_MS);
  }

  function hideIcon(): void {
    clearAutoHideTimer();
    icon.hidden = true;
  }

  function closePopover(): void {
    popover.hidden = true;
    resultsEl.textContent = '';
    moreEl.hidden = true;
  }

  /** Đóng cả popover kết quả lẫn icon lơ lửng — cặp closePopover()+hideIcon() lặp ở mọi chỗ "xong việc/huỷ" (chọn kết quả, Esc, click ngoài...). */
  function dismiss(): void {
    closePopover();
    hideIcon();
  }

  /**
   * Vị trí neo (viewport-relative) cho bubble: dòng cuối cùng của vùng chọn
   * (Fallback 2 — user thường buông chuột gần đó), fallback về bounding box
   * toàn vùng chọn nếu getClientRects() rỗng (vd trường hợp DOM lạ).
   */
  function getAnchorRect(range: Range): DOMRect {
    const rects = range.getClientRects();
    if (rects.length > 0) {
      return rects[rects.length - 1];
    }
    return range.getBoundingClientRect();
  }

  /**
   * Định vị icon kiểu bubble (F, đã chốt): phía trên vùng chọn, canh giữa
   * theo chiều ngang, toạ độ tài liệu (absolute + scrollX/scrollY) để icon
   * tự cuộn theo nội dung thay vì "floating" cố định trên viewport.
   *  - Fallback 1: không đủ chỗ phía trên → lật xuống dưới.
   *  - Fallback 3: clamp ngang trong [4, innerWidth - iconSize - 4].
   *  - Fallback 4: icon vẫn append vào document.body (không đổi) nên không
   *    bị overflow:hidden của table cell cắt hình.
   */
  function positionBubble(rect: DOMRect): void {
    const iconSize = 26;
    const gap = 8;
    const centerX = (rect.left + rect.right) / 2;
    const leftViewport = Math.min(Math.max(4, centerX - iconSize / 2), window.innerWidth - iconSize - 4);
    const hasRoomAbove = rect.top >= iconSize + gap;
    const topViewport = hasRoomAbove ? rect.top - iconSize - gap : rect.bottom + gap;
    icon.style.left = `${leftViewport + window.scrollX}px`;
    icon.style.top = `${topViewport + window.scrollY}px`;
  }

  function showIconForSelection(range: Range): void {
    const boundingRect = range.getBoundingClientRect();
    if (boundingRect.width === 0 && boundingRect.height === 0) {
      hideIcon();
      return;
    }
    positionBubble(getAnchorRect(range));
    icon.hidden = false;
    iconShownAt = Date.now();
    startAutoHideTimer();
  }

  function recomputeIcon(): void {
    const measured = measureSelection();
    if (!measured) {
      hideIcon();
      return;
    }
    showIconForSelection(measured.range);
  }

  // -------------------------------------------------------------------------
  // Chạy tìm kiếm
  // -------------------------------------------------------------------------

  /** [US-15.9] Kích thước dùng để clamp vị trí — cố định 1 lần lúc mở popover cho 1 lượt search, không tính lại khi accordion 1 dòng file expand/collapse (tránh popover "nhảy" giữa lúc đang đọc). */
  function positionPopover(anchorRect: DOMRect): void {
    const popW = CROSS_FILE_POPOVER_WIDTH_PX;
    const popMaxH = Math.min(window.innerHeight * CROSS_FILE_POPOVER_MAX_HEIGHT_VH_RATIO, CROSS_FILE_POPOVER_MAX_HEIGHT_CAP_PX);
    const left = Math.min(Math.max(4, anchorRect.left), window.innerWidth - popW - 4);
    const top = Math.min(Math.max(4, anchorRect.bottom + 4), window.innerHeight - popMaxH - 4);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  /** Gửi yêu cầu tìm kiếm mới (query/scope/option hiện tại) — dùng cho lần tìm đầu, đổi scope, hoặc toggle option. */
  function doSearch(query: string, scope: CrossFileSearchScope): void {
    currentQuery = query;
    currentScope = scope;
    scopeSelect.value = scope;
    resultsEl.textContent = '';
    moreEl.hidden = true;
    countEl.textContent = 'Searching…';
    postToHost({
      type: 'crossFileSearch:request',
      requestId: ++seq,
      query,
      scope,
      matchCase: matchOptions.matchCase,
      wholeWord: matchOptions.wholeWord,
    });
  }

  /** Mở popover ở vị trí gần anchorRect (vùng chọn/icon) rồi chạy tìm kiếm — dùng khi bấm icon hoặc phím tắt. */
  function openAndSearch(query: string, scope: CrossFileSearchScope, anchorRect: DOMRect): void {
    positionPopover(anchorRect);
    popover.hidden = false;
    hideIcon();
    doSearch(query, scope);
  }

  function triggerFromIconOrShortcut(): boolean {
    const measured = measureSelection();
    if (!measured) {
      return false;
    }
    const rect = measured.range.getBoundingClientRect();
    openAndSearch(measured.query, currentScope, rect);
    return true;
  }

  // -------------------------------------------------------------------------
  // Render kết quả
  // -------------------------------------------------------------------------

  function renderMatchRow(group: CrossFileMatchGroup, matchIndex: number): HTMLButtonElement {
    const match = group.matches[matchIndex];
    const row = el('button', 'cross-file-search-match');
    row.type = 'button';

    const before = match.lineText.slice(0, match.character);
    const mid = match.lineText.slice(match.character, match.character + match.length);
    const after = match.lineText.slice(match.character + match.length);

    // Ghép ngữ cảnh trái/phải rồi cắt theo ngân sách ký tự TRƯỚC khi đưa vào DOM
    // (thay vì phó mặc cho CSS `text-overflow: ellipsis`, vốn chỉ cắt ở mép phải
    // của toàn bộ chuỗi — nếu contextBefore + before đã dài hơn bề rộng popover,
    // phần <mark> bị đẩy ra ngoài vùng nhìn thấy và bị `overflow: hidden` nuốt
    // mất hoàn toàn, không còn dấu hiệu "…" nào báo cho user).
    const leftRaw = match.contextBefore ? `${match.contextBefore} ${before}` : before;
    const rightRaw = match.contextAfter ? `${after} ${match.contextAfter}` : after;
    const left = truncateContextLeft(leftRaw, SNIPPET_CONTEXT_CHARS);
    const right = truncateContextRight(rightRaw, SNIPPET_CONTEXT_CHARS);

    // Element.append() nhận string trực tiếp (tự tạo text node) — không cần
    // gom parts rồi tự phân biệt string/Element.
    const mark = el('span', 'cross-file-search-mark', mid);
    if (left) {
      row.append(left);
    }
    row.append(mark);
    if (right) {
      row.append(right);
    }

    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => {
      postToHost({
        type: 'crossFileSearch:openResult',
        uri: group.uri,
        line: match.line,
        character: match.character,
        length: match.length,
        // Gửi kèm đoạn text đã khớp (raw) làm mỏ neo — webview đích tìm lại vị
        // trí bằng text thay vì áp offset thô (lệch với rendered, xem bug #2).
        matchText: mid,
      });
      dismiss();
    });
    return row;
  }

  /** Tên file/đường dẫn + badge số match — phần dùng chung giữa header có chevron (≥2 match) và dòng tĩnh (đúng 1 match, xem renderSingleMatchHeader). */
  function renderGroupInfoAndBadge(group: CrossFileMatchGroup): { info: HTMLSpanElement; badge: HTMLSpanElement } {
    const fileEl = el('span', 'cross-file-search-file', group.fileName);
    const pathEl = el('span', 'cross-file-search-path', group.relativePath);
    const info = el('span', 'cross-file-search-group-info');
    info.append(fileEl, pathEl);

    const badge = el('span', 'cross-file-search-badge', pluralize(group.totalInFile, 'match', 'matches'));

    return { info, badge };
  }

  /** Header 1 nhóm file có ≥2 match (dòng khi collapsed): chevron + tên file/đường dẫn + badge. Click → chỉ toggle, KHÔNG mở file (tránh lẫn với renderMatchRow). */
  function renderGroupHeader(group: CrossFileMatchGroup, onToggle: () => void): HTMLButtonElement {
    const btn = el('button', 'cross-file-search-group-header');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');

    const chevron = el('span', 'cross-file-search-chevron');
    chevron.setAttribute('aria-hidden', 'true');

    const { info, badge } = renderGroupInfoAndBadge(group);

    btn.append(chevron, info, badge);
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', onToggle);
    return btn;
  }

  /**
   * [US-15.6, đổi 2026-07-14] Dòng file khi file chỉ có ĐÚNG 1 match — không còn
   * gì để expand/collapse nên không dùng <button>/chevron thật (giữ 1 chevron ẩn
   * chỉ để canh lề thẳng hàng với các dòng ≥2 match khác trong cùng danh sách).
   * Snippet của match duy nhất render thẳng ngay bên dưới, luôn hiện sẵn — xem
   * renderResults().
   */
  function renderSingleMatchHeader(group: CrossFileMatchGroup): HTMLDivElement {
    const row = el('div', 'cross-file-search-group-header cross-file-search-group-header-static');

    const chevronSpacer = el('span', 'cross-file-search-chevron cross-file-search-chevron-hidden');
    chevronSpacer.setAttribute('aria-hidden', 'true');

    const { info, badge } = renderGroupInfoAndBadge(group);

    row.append(chevronSpacer, info, badge);
    return row;
  }

  /** Dòng "+N match khác trong file này" — chỉ render khi group bị cắt bớt (totalInFile > số match đã gửi). */
  function renderOverflowRow(group: CrossFileMatchGroup): HTMLButtonElement | undefined {
    const remaining = group.totalInFile - group.matches.length;
    if (remaining <= 0) {
      return undefined;
    }
    const row = el(
      'button',
      'cross-file-search-overflow',
      `+${remaining} match khác trong file này → xem trong Search panel`
    );
    row.type = 'button';
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => {
      // GĐ4: scope Search panel về ĐÚNG file này (không phải toàn `currentScope`).
      postToHost({
        type: 'crossFileSearch:openInSearchPanel',
        query: currentQuery,
        scope: currentScope,
        relativePath: group.relativePath,
      });
      dismiss();
    });
    return row;
  }

  function renderResults(groups: CrossFileMatchGroup[], truncated: boolean, usedFallback: boolean): void {
    resultsEl.textContent = '';
    const total = groups.reduce((n, g) => n + g.totalInFile, 0);
    // Fallback (C4, chốt #4): host đã hạ whole-word→substring vì 0 kết quả. Đồng
    // bộ toggle Whole Word về OFF + hạ state thật (khớp luồng cục bộ của Ctrl+F).
    if (usedFallback) {
      matchOptions.wholeWord = false;
      toggles.sync();
    }

    if (groups.length === 0) {
      countEl.textContent = '0 results';
      countEl.title = '';
      const empty = el(
        'div',
        'cross-file-search-empty',
        currentScope === 'markdown'
          ? 'No results in project. Try switching scope to "All files".'
          : 'No results in project.'
      );
      resultsEl.appendChild(empty);
      moreEl.hidden = true;
      return;
    }

    if (usedFallback) {
      const msg = `No whole-word match — showing substring results (${total})`;
      countEl.textContent = msg;
      countEl.title = msg;
    } else {
      countEl.textContent = pluralize(total, 'result');
      countEl.title = '';
    }
    const frag = document.createDocumentFragment();
    for (const group of groups) {
      const groupEl = el('div', 'cross-file-search-group');

      // [US-15.6, đổi 2026-07-14] File chỉ có đúng 1 match — show thẳng snippet,
      // không cần accordion (không có chevron, không toggle expand/collapse).
      if (group.totalInFile === 1) {
        groupEl.classList.add('cross-file-search-group-single');
        const matchesEl = el('div', 'cross-file-search-group-matches');
        matchesEl.appendChild(renderMatchRow(group, 0));
        groupEl.append(renderSingleMatchHeader(group), matchesEl);
        frag.appendChild(groupEl);
        continue;
      }

      const matchesEl = el('div', 'cross-file-search-group-matches');
      matchesEl.hidden = true;
      // Dựng các dòng match LƯỜI — chỉ khi group được mở lần đầu. Trước đây mọi
      // dòng của mọi group đều dựng sẵn dù đang thu gọn (matchesEl.hidden), phí
      // công DOM cho nội dung người dùng có thể không bao giờ mở ra.
      let built = false;
      const buildRows = (): void => {
        if (built) {
          return;
        }
        built = true;
        group.matches.forEach((_m, i) => matchesEl.appendChild(renderMatchRow(group, i)));
        const overflowRow = renderOverflowRow(group);
        if (overflowRow) {
          matchesEl.appendChild(overflowRow);
        }
      };

      let expanded = false;
      const headerBtn = renderGroupHeader(group, () => {
        expanded = !expanded;
        if (expanded) {
          buildRows();
        }
        matchesEl.hidden = !expanded;
        headerBtn.setAttribute('aria-expanded', String(expanded));
        groupEl.classList.toggle('expanded', expanded);
      });

      groupEl.append(headerBtn, matchesEl);
      frag.appendChild(groupEl);
    }
    resultsEl.appendChild(frag);
    moreEl.hidden = !truncated;
  }

  // -------------------------------------------------------------------------
  // Sự kiện
  // -------------------------------------------------------------------------

  /**
   * "Không phải ý định search" (C3, đã chốt): copy/cut, hoặc Backspace/Delete
   * khi đang có selection active — huỷ debounce timer đang chờ (nếu có) và ẩn
   * icon nếu đã hiện, bất kể debounce đang ở giá trị nào.
   */
  function cancelPendingIcon(): void {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    if (!icon.hidden) {
      hideIcon();
    }
  }

  document.addEventListener('selectionchange', () => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      recomputeIcon();
    }, CROSS_FILE_ICON_DEBOUNCE_MS);
  });

  // Copy/cut trên #content → không phải ý định search (đã chốt C3).
  content.addEventListener('copy', cancelPendingIcon);
  content.addEventListener('cut', cancelPendingIcon);

  icon.addEventListener('click', () => {
    triggerFromIconOrShortcut();
  });

  // Pause timer tự-ẩn 3s khi hover/focus icon; RESET về đủ 3000ms (không
  // resume phần dở) khi rời hover/blur — đã chốt C2 điểm 2.
  //
  // 'mouseenter' bỏ qua ICON_HOVER_GRACE_MS đầu tiên kể từ lúc icon hiện (C4 bug report #1): icon
  // luôn xuất hiện đúng ngay chỗ chuột vừa dừng (cuối vùng chọn vừa kéo), nên chỉ cần rung tay nhẹ
  // là 'mouseenter' bắn ra ngay — pause timer vĩnh viễn vì chuột chưa hề THỰC SỰ rời đi để
  // 'mouseleave' có cơ hội resume. Sau grace window, hover được coi là chủ ý và pause bình thường.
  icon.addEventListener('mouseenter', () => {
    if (Date.now() - iconShownAt < ICON_HOVER_GRACE_MS) {
      return;
    }
    clearAutoHideTimer();
  });
  icon.addEventListener('mouseleave', () => {
    if (!icon.hidden) {
      startAutoHideTimer();
    }
  });
  icon.addEventListener('focus', clearAutoHideTimer);
  icon.addEventListener('focusout', () => {
    if (!icon.hidden) {
      startAutoHideTimer();
    }
  });

  scopeSelect.addEventListener('change', () => {
    if (!currentQuery) {
      return;
    }
    doSearch(currentQuery, scopeSelect.value as CrossFileSearchScope);
  });

  moreEl.addEventListener('mousedown', (e) => e.preventDefault());
  moreEl.addEventListener('click', () => {
    postToHost({ type: 'crossFileSearch:openInSearchPanel', query: currentQuery, scope: currentScope });
    dismiss();
  });

  // Bấm ra ngoài icon và popover → ẩn/đóng, giống pattern của search.ts.
  document.addEventListener('mousedown', (e) => {
    const target = e.target as Node;
    if (icon.hidden && popover.hidden) {
      return;
    }
    if (!icon.contains(target) && !popover.contains(target)) {
      dismiss();
    }
  });

  // Gõ phím (ngoại trừ chính phím tắt Ctrl/Cmd+Shift+F, xử lý riêng bên dưới
  // ở capture phase kèm stopPropagation) → ẩn icon, người dùng đang gõ tiếp.
  // Bao gồm cả Backspace/Delete khi đang có selection active (trước khi trình
  // duyệt xoá text) — coi như "không phải ý định search" giống copy/cut ở
  // trên (đã chốt C3): cũng phải huỷ debounce timer đang chờ, không chỉ ẩn
  // icon đã hiện, nếu không icon có thể tự bật lại 750ms sau đó.
  document.addEventListener('keydown', () => {
    cancelPendingIcon();
  });

  // Escape → dismiss, routed through the shared Escape stack (Req 20 US-20.4).
  // Reports active only when the icon or popover is visible; otherwise returns
  // false so Escape falls through (parity with the previous unconditional
  // cancelPendingIcon path — nothing was visible to dismiss anyway).
  registerEscapeHandler(ESCAPE_PRIORITY.CROSS_FILE, () => {
    if (icon.hidden && popover.hidden) {
      return false;
    }
    dismiss();
    return true;
  });

  // Ctrl/Cmd+Shift+F: kích hoạt tìm kiếm trực tiếp trên selection hiện tại
  // (không cần icon đã hiện) — dùng capture để đứng trước handler khác, giống
  // Ctrl+F của search.ts.
  document.addEventListener(
    'keydown',
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        if (triggerFromIconOrShortcut()) {
          e.preventDefault();
          e.stopPropagation();
        }
        // Không có selection hợp lệ → để phím tắt rơi qua bình thường.
      }
    },
    true
  );

  // Không còn listener 'scroll' để ẩn icon: icon giờ định vị theo toạ độ tài
  // liệu (position: absolute, rect.top/left + scrollY/scrollX — xem
  // positionBubble) nên tự cuộn cùng nội dung, luôn bám đúng vị trí selection
  // (đã chốt C3, thay thế SCROLL_HIDE_THRESHOLD_PX cũ).

  return {
    refresh(): void {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      dismiss();
    },
    setDefaultScope(scope: CrossFileSearchScope): void {
      currentScope = scope;
      scopeSelect.value = scope;
    },
    notifyResult(requestId: number, groups: CrossFileMatchGroup[], truncated: boolean, usedFallback: boolean): void {
      if (requestId !== seq) {
        return; // kết quả của lần tìm cũ
      }
      if (popover.hidden) {
        return;
      }
      renderResults(groups, truncated, usedFallback);
    },
  };
}
