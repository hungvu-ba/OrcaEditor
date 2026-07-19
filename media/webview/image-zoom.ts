/**
 * Image click-to-zoom / lightbox (US-19.4).
 *
 * Ảnh trong prose giữ `max-width:100%` (không scroll ngang). Rê chuột lên ảnh →
 * hiện nút 🔍 ở góc trên-phải; bấm nút = mở lightbox xem full-size (zoom/pan),
 * KHÔNG đổi hành vi click ảnh sẵn có (đặt caret — xem main.ts). Hoạt động mọi
 * lúc, không phụ thuộc Reading Mode.
 *
 * Roundtrip-safe: nút hover + overlay đều gắn vào <body>, KHÔNG bọc/chèn gì vào
 * #content (serialize chỉ đọc #content) nên không rò tag ra `.md`.
 *
 * The zoom/pan overlay is shared with Mermaid — see lightbox.ts. This file only
 * keeps the image-hover detection + 🔍 button; openLightbox() owns the lightbox.
 */

import { openLightbox } from './lightbox';

const ZOOM_ICON =
  '<svg width="15" height="15" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<circle cx="7" cy="7" r="4.25" stroke="currentColor" stroke-width="1.4" fill="none"/>' +
  '<path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  '<path d="M7 5.25v3.5M5.25 7h3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
  '</svg>';

// Gap below the sticky toolbar's bottom edge so the zoom button never lands
// inside its band, including the drop-shadow the toolbar gains in Zen mode's
// revealed state (bug 0715 #6). Same clamp shape as table.ts's
// positionTableToolbar, but no `window.scrollY` term: #img-zoom-btn is
// `position: fixed` and #toolbar is `position: sticky`, so both rects are
// already viewport-relative (unlike table.ts's absolutely-positioned toolbar).
const TOOLBAR_GAP_PX = 10;

export function initImageZoom(content: HTMLElement, toolbarEl: HTMLElement): void {
  let hoverBtn: HTMLButtonElement | undefined;
  let currentImg: HTMLImageElement | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function ensureHoverBtn(): HTMLButtonElement {
    if (hoverBtn) {
      return hoverBtn;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'img-zoom-btn';
    btn.innerHTML = ZOOM_ICON;
    btn.setAttribute('aria-label', 'Zoom image');
    btn.style.display = 'none';
    // Không cướp caret/selection khi bấm.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('mouseenter', () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }
    });
    btn.addEventListener('mouseleave', scheduleHide);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentImg) {
        openLightbox({ kind: 'image', src: currentImg.currentSrc || currentImg.src, alt: currentImg.alt });
        hideBtn();
      }
    });
    document.body.appendChild(btn);
    hoverBtn = btn;
    return btn;
  }

  function positionBtn(img: HTMLImageElement): void {
    const btn = ensureHoverBtn();
    const rect = img.getBoundingClientRect();
    // Ảnh quá nhỏ (icon inline) → bỏ qua để nút không che hết ảnh.
    if (rect.width < 48 || rect.height < 48) {
      hideBtn();
      return;
    }
    // Read before the display write below so both rect reads land before any
    // style write forces a layout — avoids an extra forced reflow.
    const toolbarBottom = toolbarEl.getBoundingClientRect().bottom;
    currentImg = img;
    btn.style.display = 'flex';
    btn.style.top = `${Math.max(rect.top + 6, toolbarBottom + TOOLBAR_GAP_PX)}px`;
    btn.style.left = `${rect.right - btn.offsetWidth - 6}px`;
  }

  function hideBtn(): void {
    if (hoverBtn) {
      hoverBtn.style.display = 'none';
    }
    currentImg = undefined;
  }

  function scheduleHide(): void {
    hideTimer = setTimeout(hideBtn, 120);
  }

  content.addEventListener('mouseover', (e) => {
    const img = (e.target as HTMLElement).closest('img');
    if (img instanceof HTMLImageElement) {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }
      positionBtn(img);
    }
  });
  content.addEventListener('mouseout', (e) => {
    const related = e.relatedTarget as Node | null;
    if (related && (related === hoverBtn || hoverBtn?.contains(related))) {
      return; // đang di sang chính nút zoom
    }
    if ((e.target as HTMLElement).closest('img')) {
      scheduleHide();
    }
  });
  // Cuộn trang → toạ độ nút lệch khỏi ảnh, ẩn cho gọn.
  window.addEventListener('scroll', hideBtn, { passive: true });
}
