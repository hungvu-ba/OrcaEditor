/**
 * Tooltip tự vẽ dùng chung (toolbar buttons, TOC items...) thay vì dựa vào
 * title attribute gốc của trình duyệt — title attribute im lặng không hiện
 * được ở một số vị trí trong webview này (nghi do tương tác giữa layout
 * flex-wrap/scroll với việc trình duyệt xác định "phần tử đang hover" cho
 * riêng cơ chế tooltip, khác với hit-test click bình thường), nên không thể
 * tin cậy hoàn toàn vào title. Tự quản lý show/hide qua mouseenter/focus và
 * mouseleave/blur đảm bảo hiện thị nhất quán bất kể vị trí phần tử.
 */

let tooltipEl: HTMLDivElement | undefined;

/**
 * `placement` = 'above' đặt tooltip PHÍA TRÊN target (mặc định 'below', dưới
 * target). Entity-ref info tooltip dùng 'above' để không đè lên popup sửa link
 * hỏng của broken-ref.ts (popup đó luôn nằm dưới anchor) trong lúc chuột băng
 * từ tam giác sang phần chữ. Tự lật xuống dưới nếu 'above' không đủ chỗ.
 */
export function showTooltip(target: HTMLElement, text: string, placement: 'above' | 'below' = 'below'): void {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'toolbar-tooltip';
    document.body.appendChild(tooltipEl);
  }
  tooltipEl.textContent = text;
  tooltipEl.style.display = 'block';
  const rect = target.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  const left = Math.max(4, Math.min(rect.left + rect.width / 2 - tipRect.width / 2, window.innerWidth - tipRect.width - 4));
  tooltipEl.style.left = `${left}px`;
  const aboveTop = rect.top - 6 - tipRect.height;
  const top = placement === 'above' && aboveTop >= 4 ? aboveTop : rect.bottom + 6;
  tooltipEl.style.top = `${top}px`;
}

export function hideTooltip(): void {
  if (tooltipEl) {
    tooltipEl.style.display = 'none';
  }
}

/**
 * Cập nhật text tooltip cho 1 phần tử đã attachTooltip (đọc lại lúc hover, nên
 * đổi được động — vd. nút đổi lời giải thích khi bị vô hiệu, US-4.23).
 */
export function setTooltip(el: HTMLElement, text: string): void {
  el.dataset.tooltip = text;
}

/** Gắn tooltip tự vẽ (mouseenter/focus → hiện, mouseleave/blur → ẩn) cho 1 phần tử. */
export function attachTooltip(el: HTMLElement, text: string): void {
  setTooltip(el, text);
  el.addEventListener('mouseenter', () => showTooltip(el, el.dataset.tooltip ?? text));
  el.addEventListener('mouseleave', hideTooltip);
  el.addEventListener('focus', () => showTooltip(el, el.dataset.tooltip ?? text));
  el.addEventListener('blur', hideTooltip);
}
