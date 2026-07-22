/**
 * Shared fullscreen lightbox overlay (zoom/pan) reused by image click-to-zoom
 * (US-19.4, image-zoom.ts) and Mermaid diagram zoom (bug_General #6, mermaid.ts).
 *
 * One singleton overlay lives on <body> — never inside #content, so serialize
 * (which reads #content) stays byte-clean. Scroll to zoom (1–8x), drag to pan
 * when zoomed in, Esc / click backdrop to close.
 *
 * Content is either a raster image (given a src) or an inline SVG (given its
 * markup). SVG is kept as vector so Mermaid diagrams stay crisp at high zoom.
 */

export type LightboxContent =
  | { kind: 'image'; src: string; alt?: string }
  | { kind: 'svg'; svg: string };

let overlay: HTMLDivElement | undefined;
let stage: HTMLDivElement | undefined;

let scale = 1;
let panX = 0;
let panY = 0;
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
// True once a pan drag actually moved, so the trailing `click` (fired at the
// common ancestor of mousedown/mouseup) does not read as a backdrop click and
// tear the overlay down mid-pan.
let panMoved = false;

function applyTransform(): void {
  if (stage) {
    stage.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    stage.style.cursor = scale > 1 ? 'grab' : 'default';
  }
}

function isOpen(): boolean {
  return overlay?.style.display === 'flex';
}

function close(): void {
  if (overlay) {
    overlay.style.display = 'none';
  }
  dragging = false; // a drag may still be "held" if mouseup landed off-window
}

function ensureOverlay(): HTMLDivElement {
  if (overlay) {
    return overlay;
  }
  const el = document.createElement('div');
  el.id = 'md-lightbox';
  el.style.display = 'none';

  const st = document.createElement('div');
  st.id = 'md-lightbox-stage';
  el.appendChild(st);

  const hint = document.createElement('div');
  hint.id = 'md-lightbox-hint';
  hint.textContent = 'Scroll to zoom · drag to pan · Esc to close';
  el.appendChild(hint);

  el.addEventListener('click', (e) => {
    if (panMoved) {
      panMoved = false; // this click just ended a pan drag — keep the overlay open
      return;
    }
    if (e.target === el) {
      close();
    }
  });
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      scale = Math.min(8, Math.max(1, scale * factor));
      if (scale === 1) {
        panX = 0;
        panY = 0;
      }
      applyTransform();
    },
    { passive: false }
  );
  st.addEventListener('mousedown', (e) => {
    panMoved = false;
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
    panMoved = true;
    panX = e.clientX - dragStartX;
    panY = e.clientY - dragStartY;
    applyTransform();
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
  });
  // Capture phase + stopPropagation so an open lightbox behaves as a true modal:
  // Esc closes it and does NOT also fire other document-level Esc handlers behind
  // it (Zen exit, selection-highlight clear, toolbar/search popovers).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && isOpen()) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    },
    { capture: true }
  );

  document.body.appendChild(el);
  overlay = el;
  stage = st;
  return el;
}

export function openLightbox(content: LightboxContent): void {
  ensureOverlay();
  if (!overlay || !stage) {
    return;
  }
  scale = 1;
  panX = 0;
  panY = 0;
  dragging = false;
  panMoved = false;

  stage.textContent = ''; // clear previous content
  stage.setAttribute('data-kind', content.kind);
  if (content.kind === 'image') {
    const img = document.createElement('img');
    img.src = content.src;
    img.alt = content.alt ?? '';
    stage.appendChild(img);
  } else {
    stage.innerHTML = content.svg;
    const svg = stage.querySelector('svg');
    if (svg) {
      fitSvgToViewport(svg);
    }
  }

  applyTransform();
  overlay.style.display = 'flex';
}

/**
 * Mermaid renders its SVG with an inline `style="max-width: <intrinsic>px"` and
 * no fixed width/height, so dropped into the lightbox it shows at its (small)
 * native size — the CSS `max-width: 92vw` never wins against that inline cap.
 * Read the diagram's aspect ratio and size the SVG to fill the viewport (minus
 * the 24px stage padding), so the diagram opens already fit-to-screen and the
 * user rarely needs to zoom manually.
 */
function fitSvgToViewport(svg: SVGElement): void {
  const vb = svg.getAttribute('viewBox');
  let intrinsicW = 0;
  let intrinsicH = 0;
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(Number);
    intrinsicW = parts[2];
    intrinsicH = parts[3];
  }
  if (!intrinsicW || !intrinsicH) {
    intrinsicW = parseFloat(svg.getAttribute('width') || '') || 0;
    intrinsicH = parseFloat(svg.getAttribute('height') || '') || 0;
  }
  // The inline max-width cap must go regardless, or the diagram can't grow.
  svg.style.maxWidth = 'none';
  svg.style.maxHeight = 'none';
  if (!intrinsicW || !intrinsicH) {
    return; // no usable aspect ratio — leave the CSS defaults to handle it
  }
  const padding = 48; // 24px each side (see #md-lightbox-stage[data-kind='svg'])
  const availW = window.innerWidth * 0.92 - padding;
  const availH = window.innerHeight * 0.92 - padding;
  const fit = Math.min(availW / intrinsicW, availH / intrinsicH);
  svg.style.width = `${Math.round(intrinsicW * fit)}px`;
  svg.style.height = `${Math.round(intrinsicH * fit)}px`;
}
