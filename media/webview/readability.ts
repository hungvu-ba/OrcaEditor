/**
 * Reading Mode / Readability (HLR mục 19).
 *
 * Lái trạng thái đọc (US-19.1 preset, US-19.5 palette, US-19.6 typography,
 * US-19.9 Zen) bằng CSS class trên <body>/#content + CSS var — KHÔNG bao giờ
 * đụng nội dung `.md`. Giá trị đo/typography/palette được định nghĩa thuần CSS
 * (markdown.css/editor.css); module này chỉ bật/tắt class.
 *
 * SCOPE (bug report 2026-07-15 mục 4): trạng thái đọc là **per-tab, session-
 * only** — sống trong CHÍNH webview instance này (giữ nguyên khi tab ẩn nhờ
 * retainContextWhenHidden), KHÔNG ghi về config Global nên bật/tắt ở tab này
 * không lan sang tab khác, và không được nhớ sau khi đóng tab. Giá trị khởi tạo
 * lấy từ `orcaEditor.readability.*` (applyFromHost lúc init) chỉ như DEFAULT cho
 * tab mới; mọi thao tác sau đó chỉ đổi state cục bộ, không persist ngược lại.
 *
 * "Reading styling có hiệu lực" = Reading Mode bật HOẶC Zen bật — Zen tự kéo
 * theo styling đọc dù Reading Mode tắt (chốt US-19.9), nhưng vẫn là 2 toggle
 * độc lập (đọc đẹp mà giữ toolbar vẫn được).
 */
import type {
  ReadabilityConfig,
  ReadingPalette,
  ReadingPreset,
} from '../../src/shared/messages';

export interface ReadabilityDeps {
  content: HTMLElement;
  /** Đồng bộ .active của nút Reading Mode/Zen trên toolbar theo state hiện tại. */
  syncButtons: () => void;
  /**
   * US-19.11 (bug 0715 mục 3): user đổi palette trên toolbar → báo host ghi
   * config Global + broadcast cho mọi tab. Chỉ gọi khi CHÍNH tab này đổi palette
   * (setPalette), KHÔNG gọi khi nhận palette từ host (applyPaletteFromHost) để
   * tránh vòng lặp. Bỏ trống ở môi trường test (không có host).
   */
  onPaletteChange?: (palette: ReadingPalette) => void;
  /**
   * Đang có popover toolbar nào mở không (dropdown split-button, menu tràn...).
   * Khi có, KHÔNG được ẩn toolbar reveal dù con trỏ đã rê xuống dưới ngưỡng —
   * user đang chọn trong dropdown, toolbar trượt đi sẽ làm popover mất neo.
   * Wire từ toolbar.isPopoverOpen qua main.ts (toolbar.ts đã import ngược từ
   * file này, không import thẳng để tránh vòng phụ thuộc). Bỏ trống trong test.
   */
  isPopoverOpen?: () => boolean;
}

const PRESETS: ReadingPreset[] = ['comfortable', 'default', 'compact', 'dyslexia', 'academic'];
const PALETTES: ReadingPalette[] = ['followTheme', 'light', 'dark', 'sepia', 'highContrast', 'paper'];

/** Nhãn preset cho dropdown Reading Mode (toolbar) — EN, theo quy ước nhãn toolbar. */
export const READING_PRESET_LABELS: Record<ReadingPreset, string> = {
  comfortable: 'Comfortable Reading',
  default: 'Default (follow VS Code)',
  compact: 'Compact',
  dyslexia: 'Dyslexia-friendly',
  academic: 'Academic Paper',
};

/** Nhãn palette cho dropdown chọn màu đọc trên toolbar (US-19.10) — EN. */
export const READING_PALETTE_LABELS: Record<ReadingPalette, string> = {
  followTheme: 'Follow VS Code',
  light: 'Light (warm ivory)',
  dark: 'Dark (dimmed)',
  sepia: 'Sepia',
  highContrast: 'High-contrast',
  paper: 'Paper (warm white)',
};

export interface ReadabilityController {
  isEnabled(): boolean;
  isZen(): boolean;
  getPreset(): ReadingPreset;
  presets(): ReadingPreset[];
  getPalette(): ReadingPalette;
  palettes(): ReadingPalette[];
  /** Bật/tắt Reading Mode (tab-local). */
  toggle(): void;
  /** Chọn preset — kéo theo bật Reading Mode nếu đang tắt (tab-local). */
  setPreset(preset: ReadingPreset): void;
  /**
   * Chọn palette đọc (US-19.10, tab-local). Palette màu chỉ hiển thị khi reading
   * styling active → mọi palette THẬT (light/dark/sepia/highContrast) tự bật
   * Reading Mode nếu đang tắt (nhất quán với setPreset). Riêng `followTheme` là
   * lựa chọn trung tính (kế thừa `--vscode-*`, không áp class màu) nên KHÔNG ép
   * bật — dùng như "reset về màu theme", không đổi layout nếu Reading Mode tắt.
   */
  setPalette(palette: ReadingPalette): void;
  /** Áp palette do host broadcast (US-19.11) — không báo ngược host, không đụng state per-tab. */
  applyPaletteFromHost(palette: ReadingPalette): void;
  /** Bật/tắt Zen (tab-local). */
  toggleZen(): void;
  /** Thoát Zen (Esc) — no-op nếu đang không ở Zen. */
  exitZen(): void;
  /** Áp state seed nhận từ host lúc init (default cho tab) — không persist ngược. */
  applyFromHost(cfg: ReadabilityConfig): void;
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
  const { content } = deps;
  const state: ReadabilityConfig = {
    enabled: true,
    preset: 'comfortable',
    palette: 'sepia',
    linkUnderline: false,
    fontFamily: '',
    zen: false,
  };

  /** Reading styling đang có hiệu lực (Reading Mode HOẶC Zen). */
  function stylingActive(): boolean {
    return state.enabled || state.zen;
  }

  function apply(): void {
    const body = document.body;
    const active = stylingActive();
    body.classList.toggle('reading-mode', active);
    body.classList.toggle('reading-zen', state.zen);
    for (const p of PRESETS) {
      content.classList.toggle(`reading-preset-${p}`, active && state.preset === p);
    }
    for (const pal of PALETTES) {
      // US-19.11 (bug 0715 mục 3): palette là lớp theme GLOBAL, ĐỘC LẬP với
      // Reading Mode/Zen — áp bất kể `active` (tab tắt Reading Mode vẫn đổi màu
      // theo theme chung). followTheme = không áp class (kế thừa --vscode-*).
      body.classList.toggle(`reading-palette-${pal}`, pal !== 'followTheme' && state.palette === pal);
    }
    body.classList.toggle('reading-link-underline', active && state.linkUnderline);
    if (active && state.fontFamily.trim()) {
      content.style.setProperty('--reading-font-override', state.fontFamily);
    } else {
      content.style.removeProperty('--reading-font-override');
    }
    deps.syncButtons();
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
  // trên (≤64), khiến toolbar hé lộ lại ngay dù user chỉ muốn rê xuống đọc. Cơ
  // chế "arm": chỉ cho phép reveal SAU KHI con trỏ đã rời dải trên một lần
  // (clientY > 120). Reset false mỗi lần vào/ra Zen (xem toggleZen/exitZen).
  let revealArmed = false;

  const REVEAL_CLASS = 'reading-zen-reveal';
  // Đi kèm reveal khi ở gần đỉnh: chừa padding-top đẩy chữ xuống (xem editor.css).
  const REVEAL_PUSH_CLASS = 'reading-zen-reveal-push';

  /**
   * scrollY còn trong vùng "toolbar che mà không cuộn thoát được": phần tài liệu
   * [0, toolbarH] chỉ đọc được khi scrollY < toolbarH — reveal lúc này phải ĐẨY
   * chữ xuống, không được phủ. Giữa tài liệu thì phủ tạm vô hại (cuộn được).
   */
  function nearTop(): boolean {
    const toolbarH = document.getElementById('toolbar')?.offsetHeight ?? 40;
    return window.scrollY <= toolbarH + 8;
  }

  function showReveal(): void {
    document.body.classList.add(REVEAL_CLASS);
    // Quyết định đẩy-hay-phủ chốt tại thời điểm reveal (giảm số lần xê dịch
    // layout); đã reveal dạng phủ rồi thì cuộn lên đỉnh mới nâng cấp thành đẩy
    // (listener scroll bên dưới), không hạ cấp ngược lại giữa chừng.
    if (nearTop()) {
      document.body.classList.add(REVEAL_PUSH_CLASS);
    }
  }

  function hideReveal(): void {
    document.body.classList.remove(REVEAL_CLASS);
    document.body.classList.remove(REVEAL_PUSH_CLASS);
  }

  document.addEventListener('mousemove', (e) => {
    if (!state.zen) {
      if (document.body.classList.contains(REVEAL_CLASS)) {
        hideReveal();
      }
      return;
    }
    // Rê chuột vào dải trên → hiện toolbar; kéo xuống quá ngưỡng → ẩn lại + arm.
    // Dải hover rộng (~64px) cho dễ trúng; ẩn lại khi xuống quá ~120px.
    if (e.clientY > 120) {
      revealArmed = true;
      // Đang mở dropdown (popover neo dưới toolbar, sâu quá 120px) thì giữ
      // toolbar lại — ẩn giữa chừng làm popover mất neo khi user đang chọn.
      if (!deps.isPopoverOpen?.()) {
        hideReveal();
      }
    } else if (e.clientY <= 64 && revealArmed) {
      showReveal();
    }
  });
  // Reveal dạng phủ (giữa tài liệu) mà user cuộn ngược lên đỉnh khi toolbar còn
  // hiện → vùng chữ đầu lại bị che không thoát được: nâng cấp thành đẩy. Chỉ
  // một chiều (phủ → đẩy), không gỡ push khi cuộn xuống để khỏi giật qua lại.
  window.addEventListener(
    'scroll',
    () => {
      if (
        state.zen &&
        document.body.classList.contains(REVEAL_CLASS) &&
        !document.body.classList.contains(REVEAL_PUSH_CLASS) &&
        nearTop()
      ) {
        document.body.classList.add(REVEAL_PUSH_CLASS);
      }
    },
    { passive: true }
  );
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

  function toggle(): void {
    state.enabled = !state.enabled;
    apply();
  }

  function setPreset(preset: ReadingPreset): void {
    state.preset = preset;
    // Chọn preset = có ý muốn đọc → bật Reading Mode nếu đang tắt.
    if (!state.enabled) {
      state.enabled = true;
    }
    apply();
  }

  function setPalette(palette: ReadingPalette): void {
    state.palette = palette;
    // US-19.11: palette đã tách khỏi reading styling (áp độc lập trong apply()) →
    // KHÔNG còn ép bật Reading Mode. Báo host để ghi Global + đồng bộ mọi tab.
    apply();
    deps.onPaletteChange?.(palette);
  }

  /**
   * Áp palette nhận từ host (US-19.11 broadcast, bug 0715 mục 3) — chỉ đổi màu
   * theme chung, KHÔNG đụng enabled/preset/zen per-tab, KHÔNG báo ngược host
   * (tránh vòng lặp). No-op nếu palette không đổi để khỏi rerender thừa.
   */
  function applyPaletteFromHost(palette: ReadingPalette): void {
    if (state.palette === palette) {
      return;
    }
    state.palette = palette;
    apply();
  }

  function toggleZen(): void {
    state.zen = !state.zen;
    // Vào Zen hay ra Zen đều reset "arm": mới bấm Focus thì con trỏ còn ở dải
    // trên, chưa được coi là chủ động rê lên để gọi toolbar.
    resetZenReveal();
    apply();
  }

  function exitZen(): void {
    if (!state.zen) {
      return;
    }
    state.zen = false;
    resetZenReveal();
    apply();
  }

  function applyFromHost(cfg: ReadabilityConfig): void {
    state.enabled = cfg.enabled;
    state.preset = cfg.preset;
    state.palette = cfg.palette;
    state.linkUnderline = cfg.linkUnderline;
    state.fontFamily = cfg.fontFamily;
    state.zen = cfg.zen;
    // Seed lúc mở tab (bug 0715, US-19.9): trạng thái ban đầu phải áp TỨC THỜI
    // — provider đã bake class vào HTML nên bình thường đây là no-op, nhưng nếu
    // seed lệch với HTML (config đổi giữa lúc tạo panel và lúc 'ready') thì
    // cũng không được chạy animation trượt toolbar; animation chỉ dành cho user
    // bấm nút Focus. Chặn transition trong lúc áp, mở lại sau khi trình duyệt
    // đã paint xong trạng thái mới (double rAF).
    document.body.classList.add('reading-no-anim');
    apply();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.body.classList.remove('reading-no-anim');
      });
    });
  }

  return {
    isEnabled: () => state.enabled,
    isZen: () => state.zen,
    getPreset: () => state.preset,
    presets: () => PRESETS,
    getPalette: () => state.palette,
    palettes: () => PALETTES,
    toggle,
    setPreset,
    setPalette,
    applyPaletteFromHost,
    toggleZen,
    exitZen,
    applyFromHost,
    refreshContentLanguage,
  };
}
