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
import { showTooltip, hideTooltip } from './tooltip';
import { getDocHeight } from './match-utils';
import { extractReadableText, countWords, estimateReadMinutes, formatCount } from './reading-stats';
import type { VsCodeApi } from './vscode-api';

export interface TocController {
  /** Dựng lại danh sách mục lục (khi nội dung đổi) nếu panel đang mở. Có debounce. */
  refresh(): void;
  /** Bật/tắt panel mục lục. */
  toggle(): void;
  /** Panel có đang mở không (để đồng bộ trạng thái nút toolbar). */
  isOpen(): boolean;
  /** Re-apply the panel width, capped to the current window (call on window resize). */
  reflowWidth(): void;
}

interface TocEntry {
  heading: HTMLElement;
  link: HTMLAnchorElement;
}

const HEADING_SEL = 'h1, h2, h3, h4, h5, h6';

/** Giới hạn bề rộng panel khi kéo (px). Max còn bị kẹp thêm theo viewport lúc kéo. */
const TOC_MIN_WIDTH = 200;
const TOC_MAX_WIDTH = 600;
/** The effective panel width never exceeds this fraction of window.innerWidth, so
 *  the panel shrinks proportionally on a narrower tab (down to TOC_MIN_WIDTH,
 *  after which the narrow-viewport auto-hide in main.ts takes over). */
const TOC_SHRINK_RATIO = 0.35;
/** Preferred width when the user hasn't resized (mirrors --toc-width in editor.css). */
const TOC_DEFAULT_WIDTH = 300;

/** US-10.6: heading-level filter — số heading tối đa (level <= 2) trước khi mặc định thu về H1-only. */
const TOC_FILTER_DEFAULT_MAX_COUNT = 20;

const SVG_NS = 'http://www.w3.org/2000/svg';
/**
 * US-10.7 reading-progress ring geometry (SVG stroke-dashoffset donut) —
 * matches the design handoff's 54x54 hifi ring (r=24, stroke-width 6,
 * circumference 150.8). The viewBox and the rendered size are both a fixed
 * 54px (#toc-progress-ring in editor.css) — the ring no longer scales with the
 * panel width, since a resizing ring read as unstable.
 */
const RING_VIEWBOX_SIZE = 54;
const RING_CENTER = RING_VIEWBOX_SIZE / 2;
const RING_RADIUS = 24;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Builds the reading-progress ring: a track circle + a fill circle animated via stroke-dashoffset, plus a centered percent label. */
function createProgressRing(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'toc-progress-ring';
  svg.setAttribute('viewBox', `0 0 ${RING_VIEWBOX_SIZE} ${RING_VIEWBOX_SIZE}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Reading progress: 0%');

  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('class', 'toc-progress-track');
  track.setAttribute('cx', String(RING_CENTER));
  track.setAttribute('cy', String(RING_CENTER));
  track.setAttribute('r', String(RING_RADIUS));

  const fill = document.createElementNS(SVG_NS, 'circle');
  fill.setAttribute('class', 'toc-progress-fill');
  fill.setAttribute('cx', String(RING_CENTER));
  fill.setAttribute('cy', String(RING_CENTER));
  fill.setAttribute('r', String(RING_RADIUS));
  fill.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  fill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));

  const value = document.createElementNS(SVG_NS, 'text');
  value.setAttribute('class', 'toc-progress-value');
  value.setAttribute('x', String(RING_CENTER));
  value.setAttribute('y', String(RING_CENTER + 1));
  value.textContent = '0%';

  svg.appendChild(track);
  svg.appendChild(fill);
  svg.appendChild(value);
  return svg;
}

export function initToc(content: HTMLElement, vscode: VsCodeApi | undefined): TocController {
  // --- Panel bên phải ---
  // Không dùng thuộc tính `hidden` — show/hide panel giờ chạy bằng transition
  // CSS (width/opacity/visibility, xem #toc-panel trong editor.css) để có hiệu
  // ứng trượt mở/đóng theo design handoff thay vì bật/tắt tức thời.
  const panel = document.createElement('aside');
  panel.id = 'toc-panel';

  const resizer = document.createElement('div');
  resizer.id = 'toc-resize';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-label', 'Resize table of contents');

  const header = document.createElement('div');
  header.id = 'toc-header';

  // US-10.7: reading-stats block replaces the "Table of Contents" title —
  // progress ring + read-time/word-count text, both recomputed in build().
  const stats = document.createElement('div');
  stats.id = 'toc-stats';
  stats.setAttribute('aria-label', 'Document reading statistics');
  stats.appendChild(createProgressRing());
  const statsText = document.createElement('div');
  statsText.id = 'toc-stats-text';
  const minutesLine = document.createElement('div');
  minutesLine.className = 'toc-stats-minutes';
  const wordsLine = document.createElement('div');
  wordsLine.className = 'toc-stats-words';
  statsText.appendChild(minutesLine);
  statsText.appendChild(wordsLine);
  stats.appendChild(statsText);
  header.appendChild(stats);

  // --- US-10.6: heading-level filter (1=H1 only, 2=H1–H2, 3=H1–H2–H3) ---
  // maxLevel mặc định = 2; maxLevelInitialized đánh dấu heuristic >20 heading
  // (xem build()) đã chạy — chỉ chạy 1 lần cho mỗi tab, không re-run ở rebuild sau.
  let maxLevel: 1 | 2 | 3 = 2;
  let maxLevelInitialized = false;
  const savedMaxLevel = vscode?.getState()?.tocMaxLevel;
  if (savedMaxLevel === 1 || savedMaxLevel === 2 || savedMaxLevel === 3) {
    maxLevel = savedMaxLevel;
    maxLevelInitialized = true;
  }

  // Thanh lọc riêng (không nhét chung hàng với title trong #toc-header) — full
  // width, nằm dưới #toc-header nên không bị #toolbar (overlap band) che mất.
  // 3 nút pill H1/H2/H3 (design handoff: Wireframe Handoff/design_handoff_orca_editor
  // — depthBtns) thay cho slider liên tục trước đây (US-10.6 decision 2026-07-19,
  // xem Requirement - 10 Document Navigation.md — reverses the 2026-07-16 "native
  // range slider" call now that the reason for it, avoiding a discrete control
  // clashing with TOC-drag, no longer applies since TOC-drag was removed entirely).
  const filterBar = document.createElement('div');
  filterBar.id = 'toc-filter-bar';
  filterBar.setAttribute('role', 'group');
  filterBar.setAttribute('aria-label', 'Filter heading levels shown in Table of Contents');

  const depthButtons: HTMLButtonElement[] = [];

  function updateDepthButtons(): void {
    for (const btn of depthButtons) {
      const active = Number(btn.dataset.level) === maxLevel;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
  }

  // Apply a new depth filter — shared by the depth pills and the empty-state
  // "Show H1–H2–H3" reset link so both go through one path (persist + rebuild).
  function setMaxLevel(level: 1 | 2 | 3): void {
    maxLevel = level;
    maxLevelInitialized = true;
    updateDepthButtons();
    // merge: giữ tocWidth do resizer ghi.
    vscode?.setState({ ...vscode.getState(), tocMaxLevel: maxLevel });
    build();
  }

  for (const level of [1, 2, 3] as const) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toc-depth-btn';
    btn.dataset.level = String(level);
    btn.textContent = `H${level}`;
    btn.addEventListener('click', () => setMaxLevel(level));
    depthButtons.push(btn);
    filterBar.appendChild(btn);
  }
  updateDepthButtons();

  const list = document.createElement('nav');
  list.id = 'toc-list';
  list.setAttribute('aria-label', 'Table of Contents');

  panel.append(resizer, header, filterBar, list);
  document.body.appendChild(panel);

  // --- Bề rộng: khôi phục width đã lưu, cho kéo đổi rộng ---

  function clampWidth(px: number): number {
    const max = Math.min(TOC_MAX_WIDTH, Math.round(window.innerWidth * TOC_SHRINK_RATIO));
    return Math.max(TOC_MIN_WIDTH, Math.min(max, px));
  }

  function applyWidth(px: number): void {
    document.documentElement.style.setProperty('--toc-width', `${px}px`);
  }

  // preferredWidth is the width the user wants (default, or dragged/restored).
  // The applied width always clamps preferred to a fraction of the window
  // (reflowWidth), so the panel shrinks proportionally as the window narrows;
  // preferred is kept intact so it restores exactly when the window grows back.
  let preferredWidth = TOC_DEFAULT_WIDTH;
  const savedWidth = vscode?.getState()?.tocWidth;
  if (typeof savedWidth === 'number' && savedWidth > 0) {
    preferredWidth = savedWidth;
  }

  function reflowWidth(): void {
    applyWidth(clampWidth(preferredWidth));
  }

  reflowWidth();

  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('toc-resizing');

    const onMove = (ev: PointerEvent): void => {
      // Panel neo mép phải (right:0) → width = mép phải viewport trừ vị trí con trỏ.
      const width = clampWidth(window.innerWidth - ev.clientX);
      applyWidth(width);
      scheduleUpdateActive();
    };
    const onUp = (ev: PointerEvent): void => {
      resizer.releasePointerCapture(ev.pointerId);
      document.body.classList.remove('toc-resizing');
      resizer.removeEventListener('pointermove', onMove);
      resizer.removeEventListener('pointerup', onUp);
      const width = clampWidth(window.innerWidth - ev.clientX);
      preferredWidth = width;
      // merge: giữ scrollTop do main.ts ghi.
      vscode?.setState({ ...vscode.getState(), tocWidth: width });
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onUp);
  });

  // --- Trạng thái ---
  let open = false;
  let entries: TocEntry[] = [];
  // US-10.6: TOÀN BỘ heading (không lọc theo maxLevel) — updateActive() cần
  // danh sách đầy đủ để tìm heading gần nhất rồi truy ngược tới tổ tiên còn
  // hiển thị khi heading gần nhất bị filter ẩn (xem updateActive()).
  let allHeadings: HTMLElement[] = [];
  let activeIndex = -1;
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollScheduled = false;

  function headingLevel(heading: HTMLElement): number {
    return Number(heading.nodeName.charAt(1)) || 1;
  }

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

  /**
   * US-10.7: (re)computes the progress-ring percent from the current scroll
   * position and shows/hides the ring based on whether the document is
   * scrollable. Cheap (no getBoundingClientRect) — safe to call from the
   * rAF-throttled scroll path (scheduleUpdateActive → updateActive) with no
   * new scroll listener. Re-queries the ring node each call (no stale/detached
   * reference across a header rebuild).
   */
  function updateProgressRing(): void {
    const ring = header.querySelector<SVGElement>('#toc-progress-ring');
    if (!ring) {
      return;
    }
    const docHeight = getDocHeight();
    const scrollable = docHeight > window.innerHeight;
    ring.toggleAttribute('hidden', !scrollable);
    if (!scrollable) {
      return;
    }
    const fill = ring.querySelector('.toc-progress-fill');
    const valueText = ring.querySelector('.toc-progress-value');
    if (!fill || !valueText) {
      return;
    }
    const maxScroll = docHeight - window.innerHeight;
    const fraction = maxScroll <= 0 ? 1 : Math.min(1, Math.max(0, window.scrollY / maxScroll));
    const percent = fraction >= 1 ? 100 : Math.floor(fraction * 100);
    fill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE * (1 - percent / 100)));
    valueText.textContent = `${percent}%`;
    ring.setAttribute('aria-label', `Reading progress: ${percent}%`);
  }

  /**
   * US-10.7: recomputes word count + read time from the current document and
   * updates the ring's initial value. Runs on the same debounced cadence as
   * the TOC list rebuild (called from build(), which only runs while open).
   */
  function updateReadingStats(): void {
    const minutesLine = header.querySelector<HTMLElement>('.toc-stats-minutes');
    const wordsLine = header.querySelector<HTMLElement>('.toc-stats-words');
    if (!minutesLine || !wordsLine) {
      return;
    }
    const words = countWords(extractReadableText(content));
    const hasWords = words > 0;
    minutesLine.hidden = !hasWords;
    wordsLine.hidden = !hasWords;
    if (hasWords) {
      minutesLine.textContent = `${estimateReadMinutes(words)} min read`;
      wordsLine.textContent = `${formatCount(words)} word${words === 1 ? '' : 's'}`;
    }
    updateProgressRing();
  }

  function build(): void {
    updateReadingStats();
    allHeadings = Array.from(content.querySelectorAll(HEADING_SEL)) as HTMLElement[];
    // US-10.6: smart default — only on the FIRST build of a tab with no saved
    // tocMaxLevel (maxLevelInitialized false at that point). Counts against the
    // full unfiltered heading list, not the already-filtered one below, and must
    // never re-run on later rebuilds (content edits) so the filter never jumps
    // out from under a value the user set (or implicitly kept).
    if (!maxLevelInitialized) {
      const level12Count = allHeadings.filter((h) => headingLevel(h) <= 2).length;
      if (level12Count > TOC_FILTER_DEFAULT_MAX_COUNT) {
        maxLevel = 1;
        updateDepthButtons();
      }
      maxLevelInitialized = true;
    }
    const headings = allHeadings.filter((h) => headingLevel(h) <= maxLevel);
    list.textContent = '';
    entries = [];
    activeIndex = -1;
    if (headings.length === 0) {
      const empty = document.createElement('div');
      empty.id = 'toc-empty';
      // Two cases, distinguished by icon shape (design handoff): "no match" =
      // the filter hides every heading (circle-outline icon + in-place reset
      // link); "headless" = the document has no headings at all (rounded-rect
      // icon + a muted hint).
      const noMatch = allHeadings.length > 0;

      const SVG_NS = 'http://www.w3.org/2000/svg';
      const icon = document.createElementNS(SVG_NS, 'svg');
      icon.setAttribute('class', 'toc-empty-icon');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '1.6');
      icon.setAttribute('aria-hidden', 'true');
      const shape = document.createElementNS(SVG_NS, noMatch ? 'circle' : 'rect');
      if (noMatch) {
        shape.setAttribute('cx', '12');
        shape.setAttribute('cy', '12');
        shape.setAttribute('r', '8');
      } else {
        shape.setAttribute('x', '4');
        shape.setAttribute('y', '4');
        shape.setAttribute('width', '16');
        shape.setAttribute('height', '16');
        shape.setAttribute('rx', '3');
      }
      icon.appendChild(shape);
      empty.appendChild(icon);

      const msg = document.createElement('div');
      msg.className = 'toc-empty-msg';
      msg.textContent = noMatch ? 'No headings match the current filter' : 'No headings yet';
      empty.appendChild(msg);

      // Only offer the reset when clearing the filter would actually reveal a
      // heading — i.e. one exists at a selectable depth (≤3). A document whose
      // only headings are H4–H6 is no-match at every pill level, so a reset
      // would be a dead-end; show the message alone there, no false affordance.
      const canReset = noMatch && allHeadings.some((h) => headingLevel(h) <= 3);
      if (canReset) {
        // Reset the filter to show all levels, in place — saves the user
        // reaching back up to the depth pills (design handoff affordance).
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'toc-empty-reset';
        reset.textContent = 'Show H1–H2–H3';
        reset.addEventListener('click', () => setMaxLevel(3));
        empty.appendChild(reset);
      } else if (!noMatch) {
        const hint = document.createElement('div');
        hint.className = 'toc-empty-hint';
        hint.textContent = 'Add a heading (#) to populate.';
        empty.appendChild(hint);
      }

      list.appendChild(empty);
      return;
    }
    for (const heading of headings) {
      const level = headingLevel(heading);
      const link = document.createElement('a');
      link.className = `toc-item toc-level-${level}`;
      const text = (heading.textContent ?? '').trim() || '(empty)';
      link.textContent = text;
      link.href = '#';
      // Chặn native HTML5 link-drag ghost (bug 0716 #7 root cause a) — không có
      // custom drag nào thay thế nữa nên chỉ cần tắt hẳn drag mặc định của <a>.
      link.draggable = false;
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
        scrollToHeading(heading);
      });
      list.appendChild(link);
      entries.push({ heading, link });
    }
    updateActive();
  }

  // -------------------------------------------------------------------------
  // Scrollspy: tô sáng mục đang đọc
  // -------------------------------------------------------------------------

  function updateActive(): void {
    // US-10.7: ring tracks scroll independently of whether the doc has any
    // headings, so it must update before the entries.length early return.
    updateProgressRing();
    if (entries.length === 0) {
      return;
    }
    const threshold = toolbarHeight() + 12;
    // US-10.6: quét trên TOÀN BỘ heading (allHeadings), không chỉ entries[]
    // đã lọc — heading gần nhất theo scroll có thể là 1 heading bị filter ẩn
    // (vd. H3 khi maxLevel=2), nên phải biết nó rồi mới truy ngược tổ tiên.
    let found = -1;
    for (let i = 0; i < allHeadings.length; i++) {
      // +1 để tránh sai số làm tưởng heading vừa chạm mép vẫn nằm dưới
      if (allHeadings[i].getBoundingClientRect().top - threshold <= 1) {
        found = i;
      } else {
        break;
      }
    }
    if (found < 0) {
      // Chưa cuộn tới heading đầu tiên → vẫn coi mục đầu là đang đọc.
      setActive(0);
      return;
    }
    // Heading gần nhất bị filter ẩn (level > maxLevel) → truy ngược tới
    // tổ tiên gần nhất còn hiển thị (level <= maxLevel).
    let candidateIdx = found;
    while (candidateIdx >= 0 && headingLevel(allHeadings[candidateIdx]) > maxLevel) {
      candidateIdx--;
    }
    if (candidateIdx < 0) {
      // Không có tổ tiên nào còn hiển thị (vd. H3 trước mọi H1/H2) → không tô sáng gì cả.
      setActive(-1);
      return;
    }
    const entryIdx = entries.findIndex((e) => e.heading === allHeadings[candidateIdx]);
    setActive(entryIdx >= 0 ? entryIdx : 0);
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

  /** Gom nhiều lần gọi trong cùng một frame thành một updateActive() (rAF) — dùng cho cả scroll và kéo resize panel (mỗi pointermove đọc getBoundingClientRect mọi heading, phải throttle). */
  function scheduleUpdateActive(): void {
    if (!open || scrollScheduled) {
      return;
    }
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      updateActive();
    });
  }

  function onScroll(): void {
    scheduleUpdateActive();
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
    reflowWidth,
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
