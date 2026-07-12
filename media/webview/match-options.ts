/**
 * C4: Registry option tìm kiếm (Match Case / Whole Word) + hàm dựng hàng nút
 * toggle Aa/ab dùng CHUNG cho cả Ctrl+F (search.ts) và popover tìm xuyên file
 * (cross-file-search.ts). Một nguồn sự thật duy nhất: thêm "Regex" sau này chỉ
 * là thêm 1 entry vào MATCH_OPTION_DEFS + 1 nhánh trong lõi so khớp, không phải
 * viết lại markup ở hai nơi.
 */

import type { MatchOptions } from '../../src/shared/text-match';

export interface MatchOptionDef {
  /** Khoá tương ứng field trong MatchOptions — dùng làm state key. */
  key: keyof MatchOptions;
  /** Nhãn hiển thị trên nút khi không có `icon` (fallback text). */
  label: string;
  /** SVG markup hiển thị thay cho `label` khi có — dùng cho Whole Word (xem WHOLE_WORD_ICON). */
  icon?: string;
  /** Tooltip/aria-label. */
  tooltip: string;
}

/**
 * "ab" kèm 2 vạch đứng hai bên, giống hệt icon "Match Whole Word" thật của VS Code Find widget —
 * thay cho label text thuần "ab" trước đây (bị nhầm với toggle chữ hoa/thường cạnh "Aa", C4 bug
 * report #4). "Aa" (Match Case) GIỮ NGUYÊN dạng text vì đã là quy ước rõ nghĩa, không phải nguồn
 * gây nhầm lẫn.
 */
const WHOLE_WORD_ICON =
  '<svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path d="M1.5 2.5v9M12.5 2.5v9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" fill="none"/>' +
  '<text x="7" y="10" text-anchor="middle" font-size="8" font-weight="700" fill="currentColor">ab</text>' +
  '</svg>';

export const MATCH_OPTION_DEFS: MatchOptionDef[] = [
  { key: 'matchCase', label: 'Aa', tooltip: 'Match Case' },
  { key: 'wholeWord', label: 'ab', icon: WHOLE_WORD_ICON, tooltip: 'Whole Word' },
];

export interface MatchOptionToggles {
  /** Các nút toggle theo đúng thứ tự MATCH_OPTION_DEFS — caller tự append vào layout mong muốn. */
  elements: HTMLButtonElement[];
  /** Đồng bộ lại class active/aria-pressed theo `state` hiện tại — dùng khi state đổi NGOÀI luồng bấm (vd fallback whole-word→off). */
  sync(): void;
}

/**
 * Dựng hàng nút toggle từ registry. Mỗi nút bấm: lật `state[key]`, cập nhật
 * class active + aria-pressed, rồi gọi `onChange()` (caller re-run query hiện
 * tại). `state` được MUTATE trực tiếp để caller và nút luôn nhìn cùng một object.
 */
export function buildMatchOptionToggles(
  state: MatchOptions,
  onChange: () => void,
  btnClass = 'match-option-btn'
): MatchOptionToggles {
  const elements = MATCH_OPTION_DEFS.map((def) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = btnClass;
    if (def.icon) {
      b.innerHTML = def.icon;
    } else {
      b.textContent = def.label;
    }
    b.title = def.tooltip;
    b.setAttribute('aria-label', def.tooltip);
    b.classList.toggle('active', state[def.key]);
    b.setAttribute('aria-pressed', String(state[def.key]));
    // Giữ selection/caret trong #content khi bấm (giống mkBtn của search.ts).
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      state[def.key] = !state[def.key];
      b.classList.toggle('active', state[def.key]);
      b.setAttribute('aria-pressed', String(state[def.key]));
      onChange();
    });
    return b;
  });
  const sync = (): void => {
    MATCH_OPTION_DEFS.forEach((def, i) => {
      elements[i].classList.toggle('active', state[def.key]);
      elements[i].setAttribute('aria-pressed', String(state[def.key]));
    });
  };
  return { elements, sync };
}
