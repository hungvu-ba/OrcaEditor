/**
 * Mục lục (Table of Contents) cho preview.
 *
 *  - Panel cố định bên phải, bật/tắt bằng nút trên toolbar (không đụng DOM của
 *    #content nên không ảnh hưởng contentEditable hay serialize markdown).
 *  - Xây từ các heading h1–h6 trong #content; mỗi mục là một link cuộn tới
 *    heading tương ứng (đặt heading ngay dưới toolbar sticky, không bị che).
 *  - Đồng bộ khi cuộn (scrollspy): heading gần mép trên khung nhìn nhất được
 *    tô sáng; panel tự cuộn để mục đang đọc luôn nằm trong tầm nhìn.
 *  - Rebuild (debounce) khi nội dung đổi để bám theo heading vừa sửa.
 */

import { REBUILD_DEBOUNCE_MS } from './constants';
import { scrollBehavior } from './dom-utils';
import { computeHeadingSectionSpan, draggableTopLevelBlocks } from './drag-drop';
import { computeSiblingMove, applySiblingMove, isValidSiblingGap } from './sibling-move';
import { showTooltip, hideTooltip } from './tooltip';
import type { VsCodeApi } from './vscode-api';

export interface TocController {
  /** Dựng lại danh sách mục lục (khi nội dung đổi) nếu panel đang mở. Có debounce. */
  refresh(): void;
  /** Bật/tắt panel mục lục. */
  toggle(): void;
  /** Panel có đang mở không (để đồng bộ trạng thái nút toolbar). */
  isOpen(): boolean;
}

export interface TocDeps {
  /** US-17.7 (M5): TOC-drag reorders a section in #content — needs to persist the edit. */
  scheduleSync: () => void;
}

interface TocEntry {
  heading: HTMLElement;
  link: HTMLAnchorElement;
}

const HEADING_SEL = 'h1, h2, h3, h4, h5, h6';

/** Giới hạn bề rộng panel khi kéo (px). Max còn bị kẹp thêm theo viewport lúc kéo. */
const TOC_MIN_WIDTH = 200;
const TOC_MAX_WIDTH = 600;

/** US-17.7 (M5): pixel threshold before a mousedown-on-TOC-item becomes a drag instead of the existing click-to-scroll. */
const TOC_DRAG_THRESHOLD_PX = 4;

export function initToc(content: HTMLElement, vscode: VsCodeApi | undefined, deps: TocDeps): TocController {
  // --- Panel bên phải ---
  const panel = document.createElement('aside');
  panel.id = 'toc-panel';
  panel.hidden = true;

  const resizer = document.createElement('div');
  resizer.id = 'toc-resize';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-label', 'Resize table of contents');

  const header = document.createElement('div');
  header.id = 'toc-header';
  const title = document.createElement('span');
  title.id = 'toc-title';
  title.textContent = 'Table of Contents';
  header.appendChild(title);

  const list = document.createElement('nav');
  list.id = 'toc-list';
  list.setAttribute('aria-label', 'Table of Contents');

  panel.append(resizer, header, list);
  document.body.appendChild(panel);

  // --- Bề rộng: khôi phục width đã lưu, cho kéo đổi rộng ---

  function clampWidth(px: number): number {
    const max = Math.min(TOC_MAX_WIDTH, Math.round(window.innerWidth * 0.6));
    return Math.max(TOC_MIN_WIDTH, Math.min(max, px));
  }

  function applyWidth(px: number): void {
    document.documentElement.style.setProperty('--toc-width', `${px}px`);
  }

  const savedWidth = vscode?.getState()?.tocWidth;
  if (typeof savedWidth === 'number' && savedWidth > 0) {
    applyWidth(clampWidth(savedWidth));
  }

  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('toc-resizing');

    const onMove = (ev: PointerEvent): void => {
      // Panel neo mép phải (right:0) → width = mép phải viewport trừ vị trí con trỏ.
      const width = clampWidth(window.innerWidth - ev.clientX);
      applyWidth(width);
      updateActive();
    };
    const onUp = (ev: PointerEvent): void => {
      resizer.releasePointerCapture(ev.pointerId);
      document.body.classList.remove('toc-resizing');
      resizer.removeEventListener('pointermove', onMove);
      resizer.removeEventListener('pointerup', onUp);
      const width = clampWidth(window.innerWidth - ev.clientX);
      // merge: giữ scrollTop do main.ts ghi.
      vscode?.setState({ ...vscode.getState(), tocWidth: width });
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onUp);
  });

  // --- Trạng thái ---
  let open = false;
  let entries: TocEntry[] = [];
  let activeIndex = -1;
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollScheduled = false;

  // -------------------------------------------------------------------------
  // Cuộn tới heading (chừa chỗ cho toolbar sticky)
  // -------------------------------------------------------------------------

  function toolbarHeight(): number {
    return document.getElementById('toolbar')?.offsetHeight ?? 0;
  }

  function scrollToHeading(heading: HTMLElement): void {
    const top = heading.getBoundingClientRect().top + window.scrollY - toolbarHeight() - 8;
    window.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior() });
  }

  // -------------------------------------------------------------------------
  // Dựng danh sách
  // -------------------------------------------------------------------------

  function build(): void {
    const headings = Array.from(content.querySelectorAll(HEADING_SEL)) as HTMLElement[];
    list.textContent = '';
    entries = [];
    activeIndex = -1;
    if (headings.length === 0) {
      const empty = document.createElement('div');
      empty.id = 'toc-empty';
      empty.textContent = 'No headings yet';
      list.appendChild(empty);
      return;
    }
    for (const heading of headings) {
      const level = Number(heading.nodeName.charAt(1)) || 1;
      const link = document.createElement('a');
      link.className = `toc-item toc-level-${level}`;
      const text = (heading.textContent ?? '').trim() || '(empty)';
      link.textContent = text;
      link.href = '#';
      // Chỉ hiện tooltip (tự vẽ, xem tooltip.ts) khi heading thực sự bị cắt
      // bởi ellipsis — không phiền người dùng với heading đã hiện đủ chữ.
      link.addEventListener('mouseenter', () => {
        if (link.scrollWidth > link.clientWidth) showTooltip(link, text);
      });
      link.addEventListener('mouseleave', hideTooltip);
      link.addEventListener('focus', () => {
        if (link.scrollWidth > link.clientWidth) showTooltip(link, text);
      });
      link.addEventListener('blur', hideTooltip);
      // preventDefault + stopPropagation: preload của VS Code webview có listener
      // click ở document sẽ phân giải href qua <base> (https://file+.vscode-resource…)
      // rồi mở ra BROWSER nếu sự kiện lọt tới nó — kể cả khi đã preventDefault.
      // Phải chặn propagation thì cuộn tới heading mới chạy được (giống link trong #content).
      link.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // US-17.7 (M5): a drag that just finished on this same link would
        // otherwise still fire this click afterwards (mousedown+mouseup on
        // the same element) — suppress that one click instead of scrolling.
        if (tocSuppressClick) {
          tocSuppressClick = false;
          return;
        }
        scrollToHeading(heading);
      });
      // US-17.7 (M5): TOC-drag reorders the corresponding SECTION in the
      // document (reuses US-17.3's section-move primitives). idx is snapshot
      // NOW (this entry's future index, since it matches entries.length right
      // before the push below) — evaluating entries.length lazily inside the
      // listener would read the wrong (final) value instead.
      const idx = entries.length;
      link.addEventListener('mousedown', (e) => {
        if (e.button !== 0) {
          return;
        }
        armTocDrag(idx, e.clientY);
      });
      list.appendChild(link);
      entries.push({ heading, link });
    }
    updateActive();
  }

  // -------------------------------------------------------------------------
  // TOC-drag (US-17.7, M5): drag a TOC entry to reorder the SECTION it
  // represents in the document — the TOC becomes a sorting control. Reuses
  // computeHeadingSectionSpan/sibling-move.ts verbatim (US-17.3); the only
  // new logic here is mapping a TOC-list gap to the matching #content
  // top-level-block gap. A section's own headings are always a CONTIGUOUS
  // run in the flat TOC list (by construction — no other heading can sit
  // between them without ending the section), so the invalid/no-op gap
  // range is just [draggedIdx, draggedIdx + headingCountInSpan].
  // -------------------------------------------------------------------------

  type TocDragState = 'idle' | 'armed' | 'dragging';
  let tocDragState: TocDragState = 'idle';
  let tocStartY = 0;
  let tocDraggedIdx = -1;
  let tocSpanHeadingCount = 1;
  let tocCurrentGap = -1;
  let tocCurrentGapValid = false;
  let tocSuppressClick = false;

  const tocGhostEl = document.createElement('div');
  tocGhostEl.className = 'dd-ghost';
  tocGhostEl.style.display = 'none';
  document.body.appendChild(tocGhostEl);

  const tocDropLineEl = document.createElement('div');
  tocDropLineEl.className = 'dd-drop-line';
  tocDropLineEl.style.display = 'none';
  document.body.appendChild(tocDropLineEl);

  function tocGapAt(clientY: number): number {
    for (let i = 0; i < entries.length; i++) {
      const r = entries[i].link.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        return i;
      }
    }
    return entries.length;
  }

  function tocUpdateDropLine(clientY: number): void {
    const gap = tocGapAt(clientY);
    tocCurrentGap = gap;
    tocCurrentGapValid = isValidSiblingGap(gap, tocDraggedIdx, tocDraggedIdx + tocSpanHeadingCount - 1);
    if (!tocCurrentGapValid || entries.length === 0) {
      tocDropLineEl.style.display = 'none';
      return;
    }
    const listRect = list.getBoundingClientRect();
    let y: number;
    if (gap === 0) {
      y = entries[0].link.getBoundingClientRect().top;
    } else if (gap === entries.length) {
      y = entries[entries.length - 1].link.getBoundingClientRect().bottom;
    } else {
      y = (entries[gap - 1].link.getBoundingClientRect().bottom + entries[gap].link.getBoundingClientRect().top) / 2;
    }
    tocDropLineEl.style.display = 'block';
    tocDropLineEl.style.top = `${y}px`;
    tocDropLineEl.style.left = `${listRect.left}px`;
    tocDropLineEl.style.width = `${listRect.width}px`;
    tocDropLineEl.style.height = '2px';
  }

  function tocCleanupVisuals(): void {
    entries[tocDraggedIdx]?.link.classList.remove('dd-source-muted');
    tocGhostEl.style.display = 'none';
    tocDropLineEl.style.display = 'none';
    document.body.classList.remove('dd-dragging');
  }

  function tocResetState(): void {
    tocDragState = 'idle';
    tocDraggedIdx = -1;
    tocCurrentGapValid = false;
    document.removeEventListener('mousemove', onTocMouseMove);
    document.removeEventListener('mouseup', onTocMouseUp);
    document.removeEventListener('keydown', onTocKeyDown);
  }

  function finishTocMove(): void {
    const draggedHeading = entries[tocDraggedIdx]?.heading;
    if (!draggedHeading) {
      return;
    }
    const blocks = draggableTopLevelBlocks(content);
    const spanStartIdx = blocks.indexOf(draggedHeading);
    if (spanStartIdx < 0) {
      return;
    }
    const span = computeHeadingSectionSpan(draggedHeading, blocks);
    const spanEndIdx = spanStartIdx + span.length - 1;
    const targetEntry = entries[tocCurrentGap];
    const blockGap = targetEntry ? blocks.indexOf(targetEntry.heading) : blocks.length;
    if (blockGap < 0 || !isValidSiblingGap(blockGap, spanStartIdx, spanEndIdx)) {
      return;
    }
    const result = computeSiblingMove(blocks, spanStartIdx, spanEndIdx, blockGap);
    applySiblingMove(content, result);
    deps.scheduleSync();
    build(); // reflect the new order immediately, don't wait for the debounced refresh()
  }

  function onTocMouseMove(e: MouseEvent): void {
    if (tocDragState === 'armed') {
      if (Math.abs(e.clientY - tocStartY) < TOC_DRAG_THRESHOLD_PX) {
        return;
      }
      tocDragState = 'dragging';
      tocSuppressClick = true;
      entries[tocDraggedIdx]?.link.classList.add('dd-source-muted');
      tocGhostEl.textContent = entries[tocDraggedIdx]?.link.textContent ?? '';
      tocGhostEl.style.display = 'block';
      document.body.classList.add('dd-dragging');
    }
    if (tocDragState !== 'dragging') {
      return;
    }
    tocGhostEl.style.left = `${e.clientX + 12}px`;
    tocGhostEl.style.top = `${e.clientY + 12}px`;
    tocUpdateDropLine(e.clientY);
  }

  function onTocMouseUp(): void {
    if (tocDragState === 'dragging') {
      const valid = tocCurrentGapValid;
      tocCleanupVisuals();
      if (valid) {
        finishTocMove();
      }
    } else {
      tocCleanupVisuals();
    }
    tocResetState();
  }

  function onTocKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      tocCleanupVisuals();
      tocResetState();
    }
  }

  function armTocDrag(idx: number, clientY: number): void {
    tocDragState = 'armed';
    tocStartY = clientY;
    tocDraggedIdx = idx;
    const heading = entries[idx]?.heading;
    const blocks = draggableTopLevelBlocks(content);
    tocSpanHeadingCount = heading
      ? computeHeadingSectionSpan(heading, blocks).filter((b) => /^H[1-6]$/.test(b.tagName)).length
      : 1;
    document.addEventListener('mousemove', onTocMouseMove);
    document.addEventListener('mouseup', onTocMouseUp);
    document.addEventListener('keydown', onTocKeyDown);
  }

  // -------------------------------------------------------------------------
  // Scrollspy: tô sáng mục đang đọc
  // -------------------------------------------------------------------------

  function updateActive(): void {
    if (entries.length === 0) {
      return;
    }
    const threshold = toolbarHeight() + 12;
    let found = -1;
    for (let i = 0; i < entries.length; i++) {
      // +1 để tránh sai số làm tưởng heading vừa chạm mép vẫn nằm dưới
      if (entries[i].heading.getBoundingClientRect().top - threshold <= 1) {
        found = i;
      } else {
        break;
      }
    }
    // Chưa cuộn tới heading đầu tiên → vẫn coi mục đầu là đang đọc.
    setActive(found >= 0 ? found : 0);
  }

  function setActive(idx: number): void {
    if (idx === activeIndex) {
      return;
    }
    if (activeIndex >= 0 && entries[activeIndex]) {
      entries[activeIndex].link.classList.remove('active');
    }
    activeIndex = idx;
    const entry = entries[idx];
    if (!entry) {
      return;
    }
    entry.link.classList.add('active');
    scrollLinkIntoView(entry.link);
  }

  /** Chỉ cuộn trong panel (list là offsetParent nhờ position:relative). */
  function scrollLinkIntoView(link: HTMLElement): void {
    const top = link.offsetTop;
    const bottom = top + link.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top - 8;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight + 8;
    }
  }

  function onScroll(): void {
    if (!open || scrollScheduled) {
      return;
    }
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      updateActive();
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    if (open) {
      updateActive();
    }
  });

  // -------------------------------------------------------------------------
  // Bật / tắt + refresh
  // -------------------------------------------------------------------------

  function toggle(): void {
    open = !open;
    panel.hidden = !open;
    document.body.classList.toggle('toc-open', open);
    if (open) {
      build();
      // padding của body vừa đổi → tính lại vị trí active ở frame kế tiếp
      requestAnimationFrame(updateActive);
    }
  }

  return {
    isOpen: () => open,
    toggle,
    refresh(): void {
      if (!open) {
        return;
      }
      if (rebuildTimer !== undefined) {
        clearTimeout(rebuildTimer);
      }
      rebuildTimer = setTimeout(() => {
        rebuildTimer = undefined;
        if (open) {
          build();
        }
      }, REBUILD_DEBOUNCE_MS);
    },
  };
}
