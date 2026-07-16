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

export function showTooltip(target: HTMLElement, text: string): void {
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
  tooltipEl.style.top = `${rect.bottom + 6}px`;
}

export function hideTooltip(): void {
  if (tooltipEl) {
    tooltipEl.style.display = 'none';
  }
}

/** Gắn tooltip tự vẽ (mouseenter/focus → hiện, mouseleave/blur → ẩn) cho 1 phần tử. */
export function attachTooltip(el: HTMLElement, text: string): void {
  el.addEventListener('mouseenter', () => showTooltip(el, text));
  el.addEventListener('mouseleave', hideTooltip);
  el.addEventListener('focus', () => showTooltip(el, text));
  el.addEventListener('blur', hideTooltip);
}
