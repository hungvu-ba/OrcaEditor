/**
 * Reading Mode / Readability (HLR mục 19).
 *
 * Lái trạng thái đọc (US-19.1 preset, US-19.5 palette, US-19.6 typography,
 * US-19.9 Zen) bằng CSS class trên <body>/#content + CSS var — KHÔNG bao giờ
 * đụng nội dung `.md`. Giá trị đo/typography/palette được định nghĩa thuần CSS
 * (markdown.css/editor.css); module này chỉ bật/tắt class.
 *
 * SCOPE (bug 0716 #2, reversal 2026-07-16 — supersedes bug 0715 mục 4's
 * per-tab design): `enabled`/`preset`/`palette` đều **global-in-memory ở
 * host** (không persist Settings), cùng mô hình `zen` bên dưới — 1 trong 9
 * bundle `READING_STYLES` (US-19.18, chỉnh về 9 ở US-4.27) đổi ở 1 tab lan sang MỌI
 * tab .md đang mở và tab mới mở sau đó trong cùng phiên VS Code.
 * toggle/setStyle/disable báo host qua `onReadingModeChange`, host broadcast
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
 * US-19.18 (bug 0715): palette KHÔNG còn là lớp GLOBAL độc lập của US-19.11 —
 * giờ đi kèm 1:1 với preset qua 1 trong 9 bundle `READING_STYLES` đã kiểm
 * chứng. Dropdown Reading Mode trên toolbar chỉ còn liệt kê 9 bundle này +
 * dòng "Follow VS Code" (tắt hẳn Reading Mode).
 */
import type {
  ReadabilityConfig,
  ReadingPalette,
  ReadingPreset,
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
   * US-19.19: Zen/Focus mode vừa đổi Ở CHÍNH TAB NÀY (toggleZen/exitZen/
   * disable) → báo host broadcast sang mọi tab .md khác (Zen global, kênh
   * riêng — xem onReadingModeChange bên dưới cho bundle enabled/preset/
   * palette, giờ cũng global nhưng là 1 kênh độc lập). KHÔNG gọi khi state.zen
   * đổi vì nhận broadcast từ tab khác (applyZenFromHost) — tránh vòng lặp. Bỏ
   * trống ở môi trường test (không có host).
   */
  onZenChange?: (zen: boolean) => void;
  /**
   * Bug 0716 #2 (reversal 2026-07-16): enabled/preset/palette vừa đổi Ở CHÍNH
   * TAB NÀY (toggle/setStyle/disable) → báo host broadcast sang mọi tab .md
   * khác (đảo ngược per-tab cũ của bug 0715 mục 4, giờ global giống Zen — kênh
   * riêng, không gộp vào onZenChange). KHÔNG gọi khi 3 field này đổi vì nhận
   * broadcast từ tab khác (applyReadingModeFromHost) — tránh vòng lặp.
   * fontFamily KHÔNG nằm trong bundle này (không có UI toggle runtime). Bỏ
   * trống ở môi trường test (không có host).
   */
  onReadingModeChange?: (state: { enabled: boolean; preset: ReadingPreset; palette: ReadingPalette }) => void;
  /**
   * bug_General #7: một bộ style vừa được COMMIT (apply()) — palette có thể đã
   * đổi. Cho phép phần khác (Mermaid) phản ứng khi nền sáng/tối lật. CHỈ gọi ở
   * apply(), KHÔNG ở previewStyle() (hover): re-render mermaid lúc hover dễ gây
   * nháy. Bỏ trống ở test/không cần Mermaid.
   */
  onStyleApplied?: () => void;
}

const PRESETS: ReadingPreset[] = ['comfortable', 'default', 'compact', 'dyslexia', 'academic'];
const PALETTES: ReadingPalette[] = ['followTheme', 'light', 'dark', 'sepia', 'highContrast', 'paper'];

/** 1 bộ preset+palette đã kiểm chứng (contrast WCAG + soi ảnh khi ship US-19.18). */
export interface ReadingStyle {
  id: string;
  preset: ReadingPreset;
  palette: ReadingPalette;
  label: string;
}

/**
 * US-19.18 (bug 0715): dropdown Reading Mode liệt kê các bộ preset+palette đã
 * kiểm chứng (thay vì 2 dropdown Reading/Palette độc lập). Palette đi kèm 1:1 với
 * bundle — không còn là lớp GLOBAL độc lập (thay phần đó của US-19.11).
 * US-4.27 (2026-07-19): chỉnh bộ này về ĐÚNG 9 combo của wireframe state (d) —
 * bỏ academic-sepia/dyslexia-highContrast/compact-highContrast, thêm compact-light
 * + dyslexia-sepia; xếp theo nhóm preset để dropdown render caption nhóm. Đổi bộ
 * combo an toàn: state persist theo preset+palette (không theo id), một combo bị
 * bỏ vẫn render đúng look, chỉ mất dấu ✓ trên hàng tương ứng.
 */
export const READING_STYLES: ReadingStyle[] = [
  { id: 'comfortable-sepia', preset: 'comfortable', palette: 'sepia', label: 'Comfortable Reading — Sepia' },
  { id: 'comfortable-light', preset: 'comfortable', palette: 'light', label: 'Comfortable Reading — Light' },
  { id: 'comfortable-dark', preset: 'comfortable', palette: 'dark', label: 'Comfortable Reading — Dark' },
  { id: 'comfortable-paper', preset: 'comfortable', palette: 'paper', label: 'Comfortable Reading — Paper' },
  { id: 'academic-paper', preset: 'academic', palette: 'paper', label: 'Academic Paper — Paper' },
  { id: 'compact-dark', preset: 'compact', palette: 'dark', label: 'Compact — Dark' },
  { id: 'compact-light', preset: 'compact', palette: 'light', label: 'Compact — Light' },
  { id: 'dyslexia-sepia', preset: 'dyslexia', palette: 'sepia', label: 'Dyslexia-friendly — Sepia' },
  { id: 'dyslexia-light', preset: 'dyslexia', palette: 'light', label: 'Dyslexia-friendly — Light' },
];

export interface ReadabilityController {
  isEnabled(): boolean;
  isZen(): boolean;
  /** id trong READING_STYLES khớp (preset, palette) hiện tại, hoặc undefined nếu không khớp bộ nào (seed tay qua settings.json). */
  getStyleId(): string | undefined;
  /**
   * Bật/tắt Reading Mode (tab-local) — bật thì giữ nguyên preset/palette đã
   * chọn gần nhất; tắt thì tương đương chọn hàng "Follow VS Code" (cũng thoát
   * Zen nếu đang bật, xem disable()).
   */
  toggle(): void;
  /** Áp 1 bundle từ READING_STYLES — bật Reading Mode nếu đang tắt (tab-local, không persist/broadcast). */
  setStyle(id: string): void;
  /** Dòng "Follow VS Code (no reading style)" — tắt hẳn Reading Mode, về theme gốc. */
  disable(): void;
  /**
   * Preview khi hover 1 hàng trong dropdown (không đụng state đã commit) — áp
   * tạm bundle/`'off'` lên DOM để user thấy trước theme sẽ đổi ra sao.
   */
  previewStyle(id: string | 'off'): void;
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
   * Bug 0716 #2: nhận enabled/preset/palette mới do TAB KHÁC vừa đổi (host
   * broadcast) — chỉ apply cục bộ, KHÔNG gọi lại `onReadingModeChange` (tránh
   * vòng lặp broadcast ngược host).
   */
  applyReadingModeFromHost(next: { enabled: boolean; preset: ReadingPreset; palette: ReadingPalette }): void;
  /**
   * US-19.15: dò nội dung tài liệu có phải tiếng Việt không → gắn/bỏ class
   * `content-lang-vi` để preset Academic Paper chọn font đúng (Việt→Literata,
   * còn lại→Iowan Old Style). Gọi lại mỗi khi #content được dựng lại (renderDocument).
   */
  refreshContentLanguage(): void;
}

/**
 * Ký tự gần như CHỈ có trong tiếng Việt: Latin Extended Additional
 * (U+1EA0–U+1EF9: ạ ả ấ ầ ẩ ẫ ậ ắ ằ ẳ ẵ ặ ẹ ẻ ẽ ế ề ể ễ ệ ị ọ ỏ ố ồ ổ ỗ ộ ớ ờ
 * ở ỡ ợ ụ ủ ứ ừ ử ữ ự ỳ ỵ ỷ ỹ + hoa) cùng ă/Ă, đ/Đ, ơ/Ơ, ư/Ư. Các dải này không
 * xuất hiện trong tiếng Anh/Pháp/Tây Ban Nha thông dụng → dấu hiệu tiếng Việt
 * đáng tin. (KHÔNG bắt à/á/é/ô… ở U+00C0–00FF vì chung với nhiều ngôn ngữ khác.)
 */
const VN_CHAR_RE = /[Ạ-ỹĂăĐđƠơƯư]/g;

export function initReadability(deps: ReadabilityDeps): ReadabilityController {
  const { content, toolbar } = deps;
  const state: ReadabilityConfig = {
    enabled: false,
    preset: 'comfortable',
    palette: 'followTheme',
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
   * Vẽ class preset+palette (+ `reading-mode`) lên body/#content cho 1 bộ bất
   * kỳ — dùng chung cho apply() (state đã commit) VÀ previewStyle()/
   * cancelPreview() (hover, full preview: màu + typography/measure, US-19.18).
   * US-19.18: palette giờ gate theo `active` giống preset (không còn là lớp
   * GLOBAL độc lập của US-19.11) — tắt Reading Mode = tắt luôn màu.
   *
   * Preview đổi preset (kể cả tắt hẳn `reading-mode` khi preview "Follow VS
   * Code") kéo theo `--reading-ui-font-size` (per preset, editor.css US-19.6)
   * — biến cũng điều khiển cỡ chữ của CHÍNH `.toolbar-popover-item` — đổi
   * theo, tự làm dropdown đang mở vỡ hình ngay lúc hover (hàng dưới dịch
   * chuyển khỏi con trỏ). Fix ở toolbar.ts: `openPopover()` khoá cứng
   * `font-size` bằng inline style trực tiếp trên TỪNG hàng khi mở (không chỉ
   * đóng băng custom property — rule còn gate theo sự có mặt của class
   * `reading-mode` nên riêng biến không đủ), nên preview ở đây cứ đổi class
   * thoải mái — dropdown đã tự "điếc" với mọi thay đổi đó cho tới khi đóng lại.
   */
  function render(preset: ReadingPreset, palette: ReadingPalette, active: boolean): void {
    const body = document.body;
    body.classList.toggle('reading-mode', active);
    for (const p of PRESETS) {
      content.classList.toggle(`reading-preset-${p}`, active && preset === p);
    }
    for (const pal of PALETTES) {
      body.classList.toggle(`reading-palette-${pal}`, active && pal !== 'followTheme' && palette === pal);
    }
  }

  function apply(): void {
    const body = document.body;
    const active = stylingActive();
    render(state.preset, state.palette, active);
    body.classList.toggle('reading-zen', state.zen);
    if (active && state.fontFamily.trim()) {
      content.style.setProperty('--reading-font-override', state.fontFamily);
      // Bug fix: #toc-panel lives outside #content (appended to document.body,
      // see toc.ts) so an inline custom property scoped to #content never
      // reaches it. Hoist the same override onto <body> too so the TOC (and
      // any other chrome outside #content) follows the user's free-text font,
      // mirroring the --reading-ui-font-size/--reading-ui-font-family hoisting
      // pattern already used for preset font-size and palette color.
      body.style.setProperty('--reading-font-override', state.fontFamily);
    } else {
      content.style.removeProperty('--reading-font-override');
      body.style.removeProperty('--reading-font-override');
    }
    deps.syncButtons();
    // bug_General #7: palette có thể vừa đổi → cho Mermaid dựng lại theo theme mới.
    deps.onStyleApplied?.();
  }

  /**
   * US-19.15: gắn class `content-lang-vi` nếu tài liệu là tiếng Việt. Ngưỡng ≥3
   * ký tự đặc trưng để một tên riêng lẻ (vd "Đà Nẵng") trong doc tiếng Anh không
   * lật cả tài liệu sang font Việt. Class áp thẳng trên #content, CSS chọn font
   * theo `#content.reading-preset-academic.content-lang-vi` (chỉ ảnh hưởng preset
   * Academic Paper; preset khác không ép serif nên không đổi gì).
   */
  function refreshContentLanguage(): void {
    const text = content.textContent ?? '';
    const matches = text.match(VN_CHAR_RE);
    content.classList.toggle('content-lang-vi', !!matches && matches.length >= 3);
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
   * Khuôn chung của toggle/setStyle/disable: chụp snapshot enabled/preset/palette
   * TRƯỚC, chạy `mutate`, apply() rồi notifyReadingModeChange(prev) để broadcast
   * (guard "không đổi thì thôi" nằm trong notify) — gom giống cách setZen() gom
   * mọi thay đổi Zen về một chỗ.
   */
  function mutateAndNotify(mutate: () => void): void {
    const prev = { enabled: state.enabled, preset: state.preset, palette: state.palette };
    mutate();
    apply();
    notifyReadingModeChange(prev);
  }

  function toggle(): void {
    // Tắt qua nút chính phải mang đúng nghĩa hàng "Follow VS Code" trong
    // dropdown — dùng chung disable() thay vì chỉ lật `enabled` để cùng lúc
    // thoát Zen (xem disable()): nếu để nguyên Zen, bấm nút chính xong toolbar
    // lại trượt đi mất, người dùng tưởng nút hỏng.
    if (state.enabled) {
      disable();
      return;
    }
    mutateAndNotify(() => {
      state.enabled = true;
    });
  }

  function getStyleId(): string | undefined {
    return READING_STYLES.find((s) => s.preset === state.preset && s.palette === state.palette)?.id;
  }

  /** Áp 1 bundle đã kiểm chứng (US-19.18) — luôn bật Reading Mode, giờ global (bug 0716 #2, xem notifyReadingModeChange). */
  function setStyle(id: string): void {
    const style = READING_STYLES.find((s) => s.id === id);
    if (!style) {
      return;
    }
    mutateAndNotify(() => {
      state.preset = style.preset;
      state.palette = style.palette;
      state.enabled = true;
    });
  }

  /**
   * Dòng "Follow VS Code" (và nút chính khi đang bật) — reset hẳn về VS Code
   * gốc. Ngoài `enabled = false`, cũng thoát Zen: đây là hướng Reading→Zen
   * (khác bug_General #1 chỉ tách hướng Zen→Reading ở stylingActive()) — chủ
   * đích để toolbar hiện lại thay vì kẹt ẩn sau khi rời Reading Mode. Reset
   * luôn reveal (giống toggleZen/exitZen) vì Zen tắt rồi thì cơ chế "arm" của
   * lần Zen tiếp theo phải bắt đầu lại từ đầu.
   */
  function disable(): void {
    mutateAndNotify(() => {
      state.enabled = false;
      setZen(false);
      resetZenReveal();
    });
  }

  /**
   * US-19.19: MỌI thay đổi `state.zen` khởi phát TỪ TAB NÀY (toggleZen/
   * exitZen/disable) phải đi qua đây để báo host broadcast sang các tab .md
   * khác (Zen global, kênh riêng — xem notifyReadingModeChange bên dưới cho
   * bundle enabled/preset/palette). Guard "không đổi thì thôi" tránh broadcast
   * thừa (vd disable() gọi setZen(false) dù Zen vốn đã tắt sẵn). KHÔNG dùng
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
   * Bug 0716 #2: MỌI thay đổi enabled/preset/palette khởi phát TỪ TAB NÀY
   * (toggle/setStyle/disable) phải gọi hàm này để báo host broadcast sang các
   * tab .md khác (đảo ngược per-tab cũ, giờ global giống Zen). Nhận `prev`
   * (snapshot chụp TRƯỚC khi hàm gọi mutate state) để so sánh — cùng tinh
   * thần guard "không đổi thì thôi" của setZen(): bấm lại đúng hàng dropdown
   * đang active (setStyle cùng id) hoặc bấm "Follow VS Code" khi đã tắt sẵn
   * (disable gọi trực tiếp từ dropdown, không qua toggle()'s guard) không nên
   * phát broadcast thừa tới mọi tab khác. KHÔNG dùng cho applyReadingModeFromHost
   * (nhận broadcast từ tab khác) — hàm đó set thẳng state, không gọi lại
   * onReadingModeChange (tránh vòng lặp).
   */
  function notifyReadingModeChange(prev: { enabled: boolean; preset: ReadingPreset; palette: ReadingPalette }): void {
    if (prev.enabled === state.enabled && prev.preset === state.preset && prev.palette === state.palette) {
      return;
    }
    deps.onReadingModeChange?.({ enabled: state.enabled, preset: state.preset, palette: state.palette });
  }

  /**
   * Preview hover: đổi NGAY toàn bộ (màu + typography/measure/font, US-19.18)
   * — KHÔNG đụng state đã commit, KHÔNG gọi syncButtons (dấu ✓ trong dropdown
   * không được nhảy theo hover). An toàn với self-reflow vì toolbar.ts đã đóng
   * băng cỡ chữ của popover khi mở (xem comment ở render()).
   */
  function previewStyle(id: string | 'off'): void {
    if (id === 'off') {
      render(state.preset, state.palette, false);
      return;
    }
    const style = READING_STYLES.find((s) => s.id === id);
    if (!style) {
      return;
    }
    render(style.preset, style.palette, true);
  }

  /** Huỷ preview — render lại đúng bộ đã commit (rời hàng/đóng dropdown mà không chọn). */
  function cancelPreview(): void {
    render(state.preset, state.palette, stylingActive());
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
   * Bug 0716 #2: enabled/preset/palette mới do TAB KHÁC đổi, host broadcast
   * lại — set thẳng state (KHÔNG qua toggle()/setStyle()/disable()/
   * notifyReadingModeChange, tab này không phải nguồn gốc thay đổi, báo ngược
   * host sẽ tạo vòng lặp broadcast vô hạn). Không cần no-anim guard kiểu Zen
   * — không có CSS transition nào gắn với các class reading-mode/
   * reading-preset/reading-palette (đã grep xác nhận), nên không có rủi ro
   * flash tương tự bug 0716 #1.
   */
  function applyReadingModeFromHost(next: { enabled: boolean; preset: ReadingPreset; palette: ReadingPalette }): void {
    if (state.enabled === next.enabled && state.preset === next.preset && state.palette === next.palette) {
      return;
    }
    state.enabled = next.enabled;
    state.preset = next.preset;
    state.palette = next.palette;
    apply();
  }

  function applyFromHost(cfg: ReadabilityConfig): void {
    state.enabled = cfg.enabled;
    state.preset = cfg.preset;
    state.palette = cfg.palette;
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
    getStyleId,
    toggle,
    setStyle,
    disable,
    previewStyle,
    cancelPreview,
    toggleZen,
    exitZen,
    applyFromHost,
    applyZenFromHost,
    applyReadingModeFromHost,
    refreshContentLanguage,
  };
}
