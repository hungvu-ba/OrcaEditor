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

export interface TocController {
  /** Dựng lại danh sách mục lục (khi nội dung đổi) nếu panel đang mở. Có debounce. */
  refresh(): void;
  /** Bật/tắt panel mục lục. */
  toggle(): void;
  /** Panel có đang mở không (để đồng bộ trạng thái nút toolbar). */
  isOpen(): boolean;
}

interface TocEntry {
  heading: HTMLElement;
  link: HTMLAnchorElement;
}

const HEADING_SEL = 'h1, h2, h3, h4, h5, h6';

export function initToc(content: HTMLElement): TocController {
  // --- Panel bên phải ---
  const panel = document.createElement('aside');
  panel.id = 'toc-panel';
  panel.hidden = true;

  const header = document.createElement('div');
  header.id = 'toc-header';
  const title = document.createElement('span');
  title.id = 'toc-title';
  title.textContent = 'Table of Contents';
  header.appendChild(title);

  const list = document.createElement('nav');
  list.id = 'toc-list';
  list.setAttribute('aria-label', 'Table of Contents');

  panel.append(header, list);
  document.body.appendChild(panel);

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
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
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
      link.title = text;
      link.href = '#';
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
