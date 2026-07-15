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
 */

const ZOOM_ICON =
  '<svg width="15" height="15" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<circle cx="7" cy="7" r="4.25" stroke="currentColor" stroke-width="1.4" fill="none"/>' +
  '<path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  '<path d="M7 5.25v3.5M5.25 7h3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
  '</svg>';

export function initImageZoom(content: HTMLElement): void {
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
        openLightbox(currentImg);
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
    currentImg = img;
    btn.style.display = 'flex';
    btn.style.top = `${rect.top + 6}px`;
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

  // -------------------------------------------------------------------------
  // Lightbox overlay (zoom/pan) — đóng bằng Esc / click nền.
  // -------------------------------------------------------------------------
  let overlay: HTMLDivElement | undefined;
  let overlayImg: HTMLImageElement | undefined;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;

  function ensureOverlay(): HTMLDivElement {
    if (overlay) {
      return overlay;
    }
    const el = document.createElement('div');
    el.id = 'img-lightbox';
    el.style.display = 'none';
    const img = document.createElement('img');
    img.id = 'img-lightbox-img';
    el.appendChild(img);
    const hint = document.createElement('div');
    hint.id = 'img-lightbox-hint';
    hint.textContent = 'Scroll to zoom · drag to pan · Esc to close';
    el.appendChild(hint);

    el.addEventListener('click', (e) => {
      if (e.target === el) {
        closeLightbox();
      }
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      scale = Math.min(8, Math.max(1, scale * factor));
      if (scale === 1) {
        panX = 0;
        panY = 0;
      }
      applyTransform();
    }, { passive: false });
    img.addEventListener('mousedown', (e) => {
      if (scale <= 1) {
        return;
      }
      e.preventDefault();
      dragging = true;
      dragStartX = e.clientX - panX;
      dragStartY = e.clientY - panY;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) {
        return;
      }
      panX = e.clientX - dragStartX;
      panY = e.clientY - dragStartY;
      applyTransform();
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay?.style.display === 'flex') {
        closeLightbox();
      }
    });

    document.body.appendChild(el);
    overlay = el;
    overlayImg = img;
    return el;
  }

  function applyTransform(): void {
    if (overlayImg) {
      overlayImg.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
      overlayImg.style.cursor = scale > 1 ? 'grab' : 'default';
    }
  }

  function openLightbox(img: HTMLImageElement): void {
    ensureOverlay();
    if (!overlay || !overlayImg) {
      return;
    }
    hideBtn();
    scale = 1;
    panX = 0;
    panY = 0;
    overlayImg.src = img.currentSrc || img.src;
    overlayImg.alt = img.alt;
    applyTransform();
    overlay.style.display = 'flex';
  }

  function closeLightbox(): void {
    if (overlay) {
      overlay.style.display = 'none';
    }
  }
}
