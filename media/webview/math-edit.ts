/**
 * Sửa công thức Math (KaTeX) qua popup nổi (US-4.19, bug report 2026-07-14 —
 * mục 9: thay cho toggle inline render⇄source của US-4.18, vốn tự đóng
 * "không bespoke text UI" để giảm rủi ro, nhưng không cho hướng dẫn ký tự và
 * dễ đè lên chính công thức đang sửa khi công thức inline nằm sát mép). Popup
 * chứa 1 textarea (TeX thô) + bảng gợi ý cú pháp KaTeX phổ biến, định vị bằng
 * `positionNear` (dom-utils.ts) để không che formula gốc — ưu tiên bên dưới,
 * lật lên trên nếu thiếu chỗ, giống các popover đã có (cross-file-search.ts).
 *
 * Vì việc sửa giờ diễn ra trong 1 `<textarea>` độc lập (focus/caret quản lý
 * bởi chính textarea) thay vì bật contenteditable ngay trong nội dung công
 * thức, nửa đầu bug report mục 8 ("caret lạc vào TEXT công thức đang sửa")
 * không còn khả năng tái hiện. Nửa sau — caret lạc vào chính LABEL "Edit"
 * của nút toggle — KHÔNG do module này gây ra và KHÔNG được sửa ở đây: nút
 * đó nằm ngay trong #content (contenteditable=true), fix thật ở
 * `dom-postprocess.ts` (`buildMathEditStructure`, thêm
 * `contenteditable="false"` trực tiếp trên nút — US-4.22).
 */
import { renderToString } from 'katex';
import { makeDraggable, positionNear } from './dom-utils';
import { MATH_BLOCK_CLASS, MATH_INLINE_CLASS, MATH_RENDER_CLASS, MATH_TOGGLE_CLASS } from './render';

const MATH_WRAPPER_SELECTOR = `.${MATH_BLOCK_CLASS}, .${MATH_INLINE_CLASS}`;

/** Gợi ý cú pháp KaTeX hay dùng — click để chèn snippet vào vị trí caret trong textarea. */
const KATEX_CHEAT_SHEET: ReadonlyArray<{ label: string; snippet: string }> = [
  { label: 'Fraction', snippet: '\\frac{a}{b}' },
  { label: 'Superscript', snippet: 'x^{2}' },
  { label: 'Subscript', snippet: 'x_{i}' },
  { label: 'Square root', snippet: '\\sqrt{x}' },
  { label: 'Sum', snippet: '\\sum_{i=1}^{n}' },
  { label: 'Integral', snippet: '\\int_{a}^{b}' },
  { label: 'Greek letters', snippet: '\\alpha \\beta \\gamma' },
  { label: 'Not equal', snippet: '\\neq' },
];

/** Chèn `snippet` vào vị trí caret hiện tại trong `textarea`, giữ caret ngay sau đoạn vừa chèn. */
function insertSnippet(textarea: HTMLTextAreaElement, snippet: string): void {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.slice(0, start) + snippet + textarea.value.slice(end);
  const caret = start + snippet.length;
  textarea.setSelectionRange(caret, caret);
  textarea.focus();
}

function renderInto(wrapper: HTMLElement, tex: string): void {
  const renderEl = wrapper.querySelector(`.${MATH_RENDER_CLASS}`);
  if (!renderEl) {
    return;
  }
  const isBlock = wrapper.classList.contains(MATH_BLOCK_CLASS);
  renderEl.innerHTML = renderToString(tex, { throwOnError: false, displayMode: isBlock });
  wrapper.setAttribute('data-tex', tex);
}

let closeActivePopover: (() => void) | undefined;

function openEditPopover(wrapper: HTMLElement): void {
  closeActivePopover?.();

  const currentTex = wrapper.getAttribute('data-tex') ?? '';
  const popover = document.createElement('div');
  popover.className = 'md-math-edit-popover';

  const textarea = document.createElement('textarea');
  textarea.className = 'md-math-edit-input';
  textarea.spellcheck = false;
  textarea.value = currentTex;
  popover.appendChild(textarea);

  const cheatSheet = document.createElement('div');
  cheatSheet.className = 'md-math-edit-cheatsheet';
  for (const { label, snippet } of KATEX_CHEAT_SHEET) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-math-cheat-btn';
    btn.title = snippet;
    // Show cả tên gọi lẫn cú pháp TeX ngay trên nút (bug report mục 11: trước
    // đó snippet chỉ nằm trong `title`, phải hover mới thấy) — label + snippet
    // xếp 2 dòng thay vì chỉ 1 dòng label như trước.
    const labelEl = document.createElement('span');
    labelEl.className = 'md-math-cheat-label';
    labelEl.textContent = label;
    const snippetEl = document.createElement('code');
    snippetEl.className = 'md-math-cheat-snippet';
    snippetEl.textContent = snippet;
    btn.append(labelEl, snippetEl);
    // mousedown + preventDefault: không cướp focus khỏi textarea khi bấm gợi ý.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => insertSnippet(textarea, snippet));
    cheatSheet.appendChild(btn);
  }
  popover.appendChild(cheatSheet);

  const buttons = document.createElement('div');
  buttons.className = 'md-math-edit-buttons';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.textContent = 'Apply';
  buttons.append(cancelBtn, applyBtn);
  popover.appendChild(buttons);

  document.body.appendChild(popover);
  positionNear(popover, wrapper.getBoundingClientRect());
  // Kéo thả bằng hàm chung (US-17.1/US-17.2, dom-utils.ts) — mousedown ở bất kỳ
  // đâu trên popover trừ textarea/nút (DRAG_IGNORE_SELECTOR), giống prompt-box.
  makeDraggable(popover);

  const close = (): void => {
    popover.remove();
    document.removeEventListener('mousedown', onOutsideMousedown, true);
    closeActivePopover = undefined;
  };
  const commit = (): void => {
    // TeX rỗng (user xoá hết) → giữ nguyên công thức cũ thay vì dựng lỗi/trống rỗng.
    renderInto(wrapper, textarea.value.trim() || currentTex);
    close();
  };
  const onOutsideMousedown = (e: MouseEvent): void => {
    if (!popover.contains(e.target as Node)) {
      close();
    }
  };
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  });
  cancelBtn.addEventListener('click', close);
  applyBtn.addEventListener('click', commit);
  document.addEventListener('mousedown', onOutsideMousedown, true);
  closeActivePopover = close;

  textarea.focus();
  textarea.select();
}

export function initMathEdit(content: HTMLElement): void {
  // mousedown + preventDefault: không mất selection trong #content, giống nút toggle Mermaid.
  content.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest(`.${MATH_TOGGLE_CLASS}`)) {
      e.preventDefault();
    }
  });

  content.addEventListener('click', (e) => {
    const toggle = (e.target as HTMLElement).closest(`.${MATH_TOGGLE_CLASS}`);
    if (!toggle) {
      return;
    }
    const wrapper = toggle.closest(MATH_WRAPPER_SELECTOR) as HTMLElement | null;
    if (!wrapper) {
      return;
    }
    openEditPopover(wrapper);
  });
}
