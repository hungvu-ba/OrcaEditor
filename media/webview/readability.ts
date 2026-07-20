/**
 * Reading Mode / Readability (HLR mục 19).
 *
 * Lái trạng thái đọc (US-19.24 Reading Mode, US-19.6 typography, US-19.9 Zen)
 * bằng CSS class trên <body> + CSS var — KHÔNG bao giờ đụng nội dung `.md`.
 * Giá trị đo/typography/màu được định nghĩa thuần CSS (markdown.css/editor.css);
 * module này chỉ bật/tắt class.
 *
 * US-19.24: gộp 2 trục preset/palette cũ (US-19.18/19.21/4.27) thành MỘT khái
 * niệm `mode` (standard/sepia/paper). `body.reading-mode` = typography đọc;
 * `body.reading-mode-<mode>` (sepia/paper) = màu; `standard` = follow theme,
 * không thêm class màu.
 *
 * SCOPE (bug 0716 #2, reversal 2026-07-16 — supersedes bug 0715 mục 4's
 * per-tab design): `enabled`/`mode` đều **global-in-memory ở host** (không
 * persist Settings), cùng mô hình `zen` bên dưới — đổi ở 1 tab lan sang MỌI
 * tab .md đang mở và tab mới mở sau đó trong cùng phiên VS Code.
 * toggle/setMode/disable báo host qua `onReadingModeChange`, host broadcast
 * lại, applyReadingModeFromHost() áp cục bộ khi tab này nhận broadcast từ tab
 * khác (không gọi lại onReadingModeChange, tránh vòng lặp) — kênh riêng, độc
 * lập với kênh `zen`. `fontFamily` KHÔNG nằm trong bundle global này — không
 * có UI toggle runtime, vẫn seed 1 lần từ `orcaEditor.readability.fontFamily`
 * mỗi tab (applyFromHost lúc init), không persist ngược.
 *
 * `zen` (US-19.19): global-in-memory ở host (không persist Settings) —
 * toggleZen/exitZen/disable báo host qua `onZenChange`, host broadcast lại
 * cho MỌI tab .md đang mở (kể cả tab mới mở sau đó trong cùng phiên VS Code,
 * seed qua 'init'), applyZenFromHost() áp cục bộ khi tab này nhận broadcast
 * từ tab khác (không gọi lại onZenChange, tránh vòng lặp).
 *
 * "Reading styling có hiệu lực" = CHỈ Reading Mode bật (`enabled`). bug_General
 * #1 (đảo chốt cũ của US-19.9): Zen KHÔNG còn tự kéo theo styling đọc — vào Zen
 * giữ nguyên Reading Mode hiện tại (tắt thì vẫn Follow VS Code), Zen chỉ ẩn
 * toolbar/gutter (class `reading-zen`). Hai toggle hoàn toàn độc lập.
 *
 * US-19.24: dropdown Reading Mode trên toolbar liệt kê 3 mode — "Standard"
 * (tắt hẳn Reading Mode, follow theme) + "Sepia"/"Paper" (setMode).
 */
import type {
  ReadabilityConfig,
  ReadingMode,
} from '../../src/shared/messages';

export interface ReadabilityDeps {
  content: HTMLElement;
  /**
   * Bug 0716 #1: provider.ts's getHtml() bakes an inline `style` directly onto
   * #toolbar (first-paint seed, hides it before editor.css has a chance to
   * load late and animate the transition — see getHtml()'s comment). That
   * inline style always wins over the CSS class rule it mirrors, so once JS
   * takes over (applyFromHost's first apply completes) it MUST be cleared, or
   * the toolbar is permanently stuck hidden — CSS classes alone can never
   * override it again (Esc/reveal/toggle all only flip classes).
   */
  toolbar: HTMLElement;
  /** Đồng bộ .active của nút Reading Mode/Zen trên toolbar theo state hiện tại. */
  syncButtons: () => void;
  /**
   * Đang có popover toolbar nào mở không (dropdown split-button, menu tràn...).
   * Khi có, KHÔNG được ẩn toolbar reveal dù con trỏ đã rê xuống dưới ngưỡng —
   * user đang chọn trong dropdown, toolbar trượt đi sẽ làm popover mất neo.
   * Wire từ toolbar.isPopoverOpen qua main.ts (toolbar.ts đã import ngược từ
   * file này, không import thẳng để tránh vòng phụ thuộc). Bỏ trống trong test.
   */
  isPopoverOpen?: () => boolean;
  /**
   * US-19.19: Zen/Focus mode vừa đổi Ở CHÍNH TAB NÀY (toggleZen/exitZen)
   * → báo host broadcast sang mọi tab .md khác (Zen global, kênh
   * riêng — xem onReadingModeChange bên dưới cho enabled/mode, giờ cũng
   * global nhưng là 1 kênh độc lập). KHÔNG gọi khi state.zen
   * đổi vì nhận broadcast từ tab khác (applyZenFromHost) — tránh vòng lặp. Bỏ
   * trống ở môi trường test (không có host).
   */
  onZenChange?: (zen: boolean) => void;
  /**
   * Bug 0716 #2 (reversal 2026-07-16): enabled/mode vừa đổi Ở CHÍNH
   * TAB NÀY (toggle/setMode/disable) → báo host broadcast sang mọi tab .md
   * khác (đảo ngược per-tab cũ của bug 0715 mục 4, giờ global giống Zen — kênh
   * riêng, không gộp vào onZenChange). KHÔNG gọi khi 2 field này đổi vì nhận
   * broadcast từ tab khác (applyReadingModeFromHost) — tránh vòng lặp.
   * fontFamily KHÔNG nằm trong bundle này (không có UI toggle runtime). Bỏ
   * trống ở môi trường test (không có host).
   */
  onReadingModeChange?: (state: { enabled: boolean; mode: ReadingMode }) => void;
  /**
   * bug_General #7: một bộ style vừa được COMMIT (apply()) — mode có thể đã
   * đổi. Cho phép phần khác (Mermaid) phản ứng khi nền sáng/tối lật. CHỈ gọi ở
   * apply(), KHÔNG ở previewMode() (hover): re-render mermaid lúc hover dễ gây
   * nháy. Bỏ trống ở test/không cần Mermaid.
   */
  onStyleApplied?: () => void;
}

/** Các reading mode có màu riêng (khác `standard` = follow theme). US-19.24. */
const COLOR_MODES: ReadingMode[] = ['sepia', 'paper'];

export interface ReadabilityController {
  isEnabled(): boolean;
  isZen(): boolean;
  /** Reading mode hiện tại (standard/sepia/paper). */
  getMode(): ReadingMode;
  /**
   * Bật/tắt Reading Mode (tab-local) — bật thì giữ nguyên mode đã chọn gần
   * nhất; tắt thì tương đương chọn hàng "Standard" (xem disable()).
   */
  toggle(): void;
  /** Áp 1 reading mode có màu (sepia/paper) — bật Reading Mode nếu đang tắt (tab-local, không persist/broadcast). */
  setMode(mode: ReadingMode): void;
  /** Dòng "Standard" — tắt hẳn Reading Mode, về theme VS Code gốc. */
  disable(): void;
  /**
   * Preview khi hover 1 hàng trong dropdown (không đụng state đã commit) — áp
   * tạm mode/`'off'` lên DOM để user thấy trước theme sẽ đổi ra sao.
   */
  previewMode(mode: ReadingMode | 'off'): void;
  /** Huỷ preview — render lại đúng state đã commit (gọi khi rời hàng/đóng dropdown mà không chọn). */
  cancelPreview(): void;
  /** Bật/tắt Zen (US-19.19: global — báo host broadcast sang mọi tab .md khác). */
  toggleZen(): void;
  /** Thoát Zen (Esc) — no-op nếu đang không ở Zen; cũng broadcast global (US-19.19). */
  exitZen(): void;
  /** Áp state seed nhận từ host lúc init (default cho tab) — không persist ngược. */
  applyFromHost(cfg: ReadabilityConfig): void;
  /**
   * US-19.19: nhận Zen mới do TAB KHÁC vừa đổi (host broadcast) — chỉ apply
   * cục bộ, KHÔNG gọi lại `onZenChange` (tránh vòng lặp broadcast ngược host).
   */
  applyZenFromHost(zen: boolean): void;
  /**
   * Bug 0716 #2: nhận enabled/mode mới do TAB KHÁC vừa đổi (host broadcast) —
   * chỉ apply cục bộ, KHÔNG gọi lại `onReadingModeChange` (tránh vòng lặp
   * broadcast ngược host).
   */
  applyReadingModeFromHost(next: { enabled: boolean; mode: ReadingMode }): void;
}

export function initReadability(deps: ReadabilityDeps): ReadabilityController {
  const { content, toolbar } = deps;
  const state: ReadabilityConfig = {
    enabled: false,
    mode: 'standard',
    fontFamily: '',
    zen: false,
  };
  /**
   * Bug 0715 #14: flips true once applyFromHost()'s own reading-no-anim
   * guard has been removed. Scopes applyZenFromHost()'s no-anim guard to
   * ONLY the init-handshake race — a 'zenChanged' broadcast landing before
   * this panel has finished its own init. After init, cross-tab Zen
   * broadcasts must still animate normally (a live toggle from another tab
   * is a real, visible state change, not a seed).
   */
  let initApplyDone = false;

  /**
   * Reading styling đang có hiệu lực = CHỈ Reading Mode (`state.enabled`).
   * bug_General #1: Zen KHÔNG còn tự kéo theo reading styling — vào/ra Zen phải
   * giữ nguyên Reading Mode hiện tại (tắt thì vẫn Follow VS Code). Zen chỉ ẩn
   * toolbar/gutter qua class `reading-zen` (độc lập, xem apply()).
   */
  function stylingActive(): boolean {
    return state.enabled;
  }

  /**
   * Vẽ class reading mode lên body cho 1 mode bất kỳ — dùng chung cho apply()
   * (state đã commit) VÀ previewMode()/cancelPreview() (hover, full preview:
   * màu + typography/measure). `body.reading-mode` = typography đọc; class màu
   * `body.reading-mode-<mode>` chỉ thêm cho sepia/paper (standard = follow
   * theme, không thêm class màu). Tắt Reading Mode = tắt tất cả.
   *
   * Preview đổi mode (kể cả tắt hẳn `reading-mode` khi preview "Standard") kéo
   * theo `--reading-ui-fs-N` (editor.css US-19.6) — bucket `--reading-ui-fs-12`
   * cũng điều khiển cỡ chữ của CHÍNH `.toolbar-popover-item` — đổi theo, tự làm
   * dropdown đang mở vỡ hình ngay lúc hover (hàng dưới dịch chuyển khỏi con
   * trỏ). Fix ở toolbar.ts: `openPopover()` khoá cứng `font-size` bằng inline
   * style trực tiếp trên TỪNG hàng khi mở (không chỉ đóng băng custom property
   * — rule còn gate theo sự có mặt của class `reading-mode` nên riêng biến
   * không đủ), nên preview ở đây cứ đổi class thoải mái — dropdown đã tự "điếc"
   * với mọi thay đổi đó cho tới khi đóng lại.
   */
  function render(mode: ReadingMode, active: boolean): void {
    const body = document.body;
    body.classList.toggle('reading-mode', active);
    for (const m of COLOR_MODES) {
      body.classList.toggle(`reading-mode-${m}`, active && mode === m);
    }
  }

  function apply(): void {
    const body = document.body;
    const active = stylingActive();
    render(state.mode, active);
    body.classList.toggle('reading-zen', state.zen);
    if (active && state.fontFamily.trim()) {
      content.style.setProperty('--reading-font-override', state.fontFamily);
      // Bug fix: #toc-panel lives outside #content (appended to document.body,
      // see toc.ts) so an inline custom property scoped to #content never
      // reaches it. Hoist the same override onto <body> too so the TOC (and
      // any other chrome outside #content) follows the user's free-text font,
      // mirroring the --reading-ui-fs-N/--reading-ui-font-family hoisting
      // pattern already used for reading-mode font-size and color.
      body.style.setProperty('--reading-font-override', state.fontFamily);
    } else {
      content.style.removeProperty('--reading-font-override');
      body.style.removeProperty('--reading-font-override');
    }
    deps.syncButtons();
    // bug_General #7: mode có thể vừa đổi → cho Mermaid dựng lại theo theme mới.
    deps.onStyleApplied?.();
  }

  // Zen: thoát bằng Esc; hé lộ lại toolbar khi rê chuột sát mép trên (US-19.9).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.zen) {
      exitZen();
    }
  });
  // Bug 0715 mục 4: nút Focus nằm ngay trên toolbar → bấm xong con trỏ vẫn ở dải
  // trên, khiến toolbar hé lộ lại ngay dù user chỉ muốn rê xuống đọc. Cơ chế
  // "arm": chỉ cho phép reveal SAU KHI con trỏ đã rời dải trên một lần (>
  // HIDE_Y). Reset false mỗi lần vào/ra Zen (xem toggleZen/exitZen).
  let revealArmed = false;

  const REVEAL_CLASS = 'reading-zen-reveal';

  /**
   * Ngưỡng hover gắn theo chiều cao THẬT của #toolbar (đo lại mỗi lần, không
   * hardcode) — tự nới theo scale-up của #toolbar (editor.css) thay vì lệch
   * dần/kẹt hẹp mỗi khi đổi cỡ nút. Trước đây hardcode 64/120px: dải hover quá
   * mỏng so với chiều cao toolbar thật, khó rê trúng (feedback: "khó hover hơn
   * trước"). SHOW_MARGIN nới hẳn ra ngoài mép toolbar cho dễ trúng; HIDE_MARGIN
   * xa hơn nữa tạo vùng đệm (dead zone) chống nhấp nháy khi con trỏ dao động
   * quanh mép toolbar vừa hiện (chỉnh 96→76 theo feedback: dải hover giữ hiện
   * hơi rộng, thu hẹp lại).
   */
  const SHOW_MARGIN_PX = 40;
  const HIDE_MARGIN_PX = 76;

  function showReveal(): void {
    document.body.classList.add(REVEAL_CLASS);
  }

  function hideReveal(): void {
    document.body.classList.remove(REVEAL_CLASS);
  }

  // #toolbar.offsetHeight bắt layout reflow — cache lại, chỉ đọc lại tối đa 1
  // lần/frame qua rAF thay vì mỗi mousemove (chiều cao toolbar chỉ đổi khi
  // resize/zoom chứ không theo di chuột). Trễ 1 frame vô hại với dải SHOW/HIDE
  // margin rộng sẵn — cùng kiểu rAF-coalesce như onScroll/scheduleUpdateActive.
  let cachedToolbarH = 40;
  let toolbarHRaf = 0;
  function refreshToolbarH(): void {
    toolbarHRaf = 0;
    cachedToolbarH = document.getElementById('toolbar')?.offsetHeight ?? 40;
  }

  document.addEventListener('mousemove', (e) => {
    if (!state.zen) {
      if (document.body.classList.contains(REVEAL_CLASS)) {
        hideReveal();
      }
      return;
    }
    if (toolbarHRaf === 0) {
      toolbarHRaf = requestAnimationFrame(refreshToolbarH);
    }
    const toolbarH = cachedToolbarH;
    if (e.clientY > toolbarH + HIDE_MARGIN_PX) {
      revealArmed = true;
      // Đang mở dropdown (popover neo dưới toolbar, sâu quá ngưỡng) thì giữ
      // toolbar lại — ẩn giữa chừng làm popover mất neo khi user đang chọn.
      if (!deps.isPopoverOpen?.()) {
        hideReveal();
      }
    } else if (e.clientY <= toolbarH + SHOW_MARGIN_PX && revealArmed) {
      showReveal();
    }
  });
  // Con trỏ RỜI HẲN webview (thường là lia lên tab bar/title xuyên qua dải
  // trên — chính thao tác đó vừa bật reveal) → không còn mousemove nào bên
  // trong nữa, nhánh ẩn ở trên vĩnh viễn không chạy, toolbar kẹt hiện và che
  // chữ. Gỡ reveal ngay khi chuột ra khỏi tài liệu / webview mất focus; quay
  // lại rê vào dải trên thì reveal bật lại ngay nên không mất tiện dụng.
  document.documentElement.addEventListener('mouseleave', () => {
    if (state.zen && !deps.isPopoverOpen?.()) {
      hideReveal();
    }
  });
  window.addEventListener('blur', () => {
    if (state.zen && !deps.isPopoverOpen?.()) {
      hideReveal();
    }
  });

  /** Vào/ra Zen: chưa cho reveal tới khi con trỏ rời dải trên một lần (bug 0715 mục 4). */
  function resetZenReveal(): void {
    revealArmed = false;
    hideReveal();
  }

  /**
   * Khuôn chung của toggle/setMode/disable: chụp snapshot enabled/mode TRƯỚC,
   * chạy `mutate`, apply() rồi notifyReadingModeChange(prev) để broadcast (guard
   * "không đổi thì thôi" nằm trong notify) — gom giống cách setZen() gom mọi
   * thay đổi Zen về một chỗ.
   */
  function mutateAndNotify(mutate: () => void): void {
    const prev = { enabled: state.enabled, mode: state.mode };
    mutate();
    apply();
    notifyReadingModeChange(prev);
  }

  function toggle(): void {
    // Tắt qua nút chính phải mang đúng nghĩa hàng "Standard" trong dropdown —
    // dùng chung disable() thay vì chỉ lật `enabled`.
    if (state.enabled) {
      disable();
      return;
    }
    mutateAndNotify(() => {
      state.enabled = true;
    });
  }

  function getMode(): ReadingMode {
    return state.mode;
  }

  /** Áp 1 reading mode có màu (sepia/paper) — luôn bật Reading Mode, giờ global (bug 0716 #2, xem notifyReadingModeChange). */
  function setMode(mode: ReadingMode): void {
    mutateAndNotify(() => {
      state.mode = mode;
      state.enabled = true;
    });
  }

  /**
   * Dòng "Standard" (và nút chính khi đang bật) — reset hẳn về VS Code gốc.
   * Chỉ đổi `enabled`/`mode`, KHÔNG đụng Zen (bug_General #1: hai toggle độc
   * lập hoàn toàn — Standard không còn kéo theo thoát Zen).
   */
  function disable(): void {
    mutateAndNotify(() => {
      state.enabled = false;
    });
  }

  /**
   * US-19.19: MỌI thay đổi `state.zen` khởi phát TỪ TAB NÀY (toggleZen/
   * exitZen) phải đi qua đây để báo host broadcast sang các tab .md
   * khác (Zen global, kênh riêng — xem notifyReadingModeChange bên dưới cho
   * enabled/mode). Guard "không đổi thì thôi" tránh broadcast
   * thừa (vd exitZen() gọi khi Zen vốn đã tắt sẵn). KHÔNG dùng
   * cho applyZenFromHost (nhận broadcast từ tab khác) — hàm đó set thẳng
   * `state.zen`, không gọi lại onZenChange.
   */
  function setZen(zen: boolean): void {
    if (state.zen === zen) {
      return;
    }
    state.zen = zen;
    deps.onZenChange?.(zen);
  }

  /**
   * Bug 0716 #2: MỌI thay đổi enabled/mode khởi phát TỪ TAB NÀY
   * (toggle/setMode/disable) phải gọi hàm này để báo host broadcast sang các
   * tab .md khác (đảo ngược per-tab cũ, giờ global giống Zen). Nhận `prev`
   * (snapshot chụp TRƯỚC khi hàm gọi mutate state) để so sánh — cùng tinh
   * thần guard "không đổi thì thôi" của setZen(): bấm lại đúng hàng dropdown
   * đang active (setMode cùng mode) hoặc bấm "Standard" khi đã tắt sẵn
   * (disable gọi trực tiếp từ dropdown, không qua toggle()'s guard) không nên
   * phát broadcast thừa tới mọi tab khác. KHÔNG dùng cho applyReadingModeFromHost
   * (nhận broadcast từ tab khác) — hàm đó set thẳng state, không gọi lại
   * onReadingModeChange (tránh vòng lặp).
   */
  function notifyReadingModeChange(prev: { enabled: boolean; mode: ReadingMode }): void {
    if (prev.enabled === state.enabled && prev.mode === state.mode) {
      return;
    }
    deps.onReadingModeChange?.({ enabled: state.enabled, mode: state.mode });
  }

  /**
   * Preview hover: đổi NGAY toàn bộ (màu + typography/measure/font) — KHÔNG
   * đụng state đã commit, KHÔNG gọi syncButtons (dấu ✓ trong dropdown không
   * được nhảy theo hover). An toàn với self-reflow vì toolbar.ts đã đóng băng
   * cỡ chữ của popover khi mở (xem comment ở render()).
   */
  function previewMode(mode: ReadingMode | 'off'): void {
    if (mode === 'off') {
      render(state.mode, false);
      return;
    }
    render(mode, true);
  }

  /** Huỷ preview — render lại đúng mode đã commit (rời hàng/đóng dropdown mà không chọn). */
  function cancelPreview(): void {
    render(state.mode, stylingActive());
  }

  function toggleZen(): void {
    setZen(!state.zen);
    // Vào Zen hay ra Zen đều reset "arm": mới bấm Focus thì con trỏ còn ở dải
    // trên, chưa được coi là chủ động rê lên để gọi toolbar.
    resetZenReveal();
    apply();
  }

  function exitZen(): void {
    if (!state.zen) {
      return;
    }
    setZen(false);
    resetZenReveal();
    apply();
  }

  /**
   * Runs `fn` (an apply() call) with `#toolbar`'s transition suppressed via
   * the `reading-no-anim` class, then lifts the suppression after the
   * browser has painted the new state (double rAF). Shared by
   * applyFromHost() (cold-init seed) and applyZenFromHost()'s init-race
   * branch (bug 0715 #14) — both need the same "seed must not animate"
   * guarantee.
   */
  function runNoAnimGuarded(fn: () => void, after?: () => void): void {
    document.body.classList.add('reading-no-anim');
    fn();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.body.classList.remove('reading-no-anim');
        after?.();
      });
    });
  }

  /**
   * US-19.19: Zen mới do TAB KHÁC đổi, host broadcast lại — set thẳng
   * `state.zen` (KHÔNG qua setZen()/onZenChange, tab này không phải nguồn
   * gốc thay đổi, báo ngược host sẽ tạo vòng lặp broadcast vô hạn).
   */
  function applyZenFromHost(zen: boolean): void {
    if (state.zen === zen) {
      return;
    }
    state.zen = zen;
    resetZenReveal();
    if (initApplyDone) {
      // Steady-state cross-tab broadcast (another tab's user toggled Zen
      // live) — let #toolbar's transition play normally.
      apply();
      return;
    }
    // Bug 0715 #14: this broadcast landed before applyFromHost()'s own
    // reading-no-anim guard finished (init-handshake race) — without the
    // same guard here, #toolbar's transition fires uncontested on first
    // paint.
    runNoAnimGuarded(apply);
  }

  /**
   * Bug 0716 #2: enabled/mode mới do TAB KHÁC đổi, host broadcast lại — set
   * thẳng state (KHÔNG qua toggle()/setMode()/disable()/notifyReadingModeChange,
   * tab này không phải nguồn gốc thay đổi, báo ngược host sẽ tạo vòng lặp
   * broadcast vô hạn). Không cần no-anim guard kiểu Zen — không có CSS
   * transition nào gắn với các class reading-mode/reading-mode-<mode> (đã grep
   * xác nhận), nên không có rủi ro flash tương tự bug 0716 #1.
   */
  function applyReadingModeFromHost(next: { enabled: boolean; mode: ReadingMode }): void {
    if (state.enabled === next.enabled && state.mode === next.mode) {
      return;
    }
    state.enabled = next.enabled;
    state.mode = next.mode;
    apply();
  }

  function applyFromHost(cfg: ReadabilityConfig): void {
    state.enabled = cfg.enabled;
    state.mode = cfg.mode;
    state.fontFamily = cfg.fontFamily;
    state.zen = cfg.zen;
    // Seed lúc mở tab (bug 0715, US-19.9): trạng thái ban đầu phải áp TỨC THỜI
    // — provider đã bake class vào HTML nên bình thường đây là no-op, nhưng nếu
    // seed lệch với HTML (config đổi giữa lúc tạo panel và lúc 'ready') thì
    // cũng không được chạy animation trượt toolbar; animation chỉ dành cho user
    // bấm nút Focus. Chặn transition trong lúc áp, mở lại sau khi trình duyệt
    // đã paint xong trạng thái mới (double rAF).
    runNoAnimGuarded(apply, () => {
      initApplyDone = true;
      // Bug 0716 #1: apply() vừa xác nhận class CSS (reading-zen) đã khớp
      // đúng state.zen — từ giờ CSS class là chủ sở hữu duy nhất, gỡ luôn
      // inline style seed của getHtml() (nếu có) kẻo nó đè vĩnh viễn lên mọi
      // toggle sau này (inline style luôn thắng rule CSS class).
      toolbar.removeAttribute('style');
    });
  }

  return {
    isEnabled: () => state.enabled,
    isZen: () => state.zen,
    getMode,
    toggle,
    setMode,
    disable,
    previewMode,
    cancelPreview,
    toggleZen,
    exitZen,
    applyFromHost,
    applyZenFromHost,
    applyReadingModeFromHost,
  };
}
