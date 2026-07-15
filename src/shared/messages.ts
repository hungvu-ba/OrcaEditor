/**
 * C3: Hợp đồng type dùng chung cho kênh postMessage giữa extension host
 * (src/provider.ts, bundle Node) và webview (media/webview, bundle browser).
 *
 * Đây là NGUỒN SỰ THẬT DUY NHẤT về hình dạng message hai chiều. Cả hai đầu
 * `import type` từ file này (chỉ là type, esbuild xoá hết lúc bundle nên không
 * kéo code Node vào bundle browser và ngược lại). Đổi tên/field một đầu mà quên
 * đầu kia → compiler báo lỗi thay vì lệch âm thầm.
 */

/** Một gợi ý file trả về cho popup chèn link (kết quả searchWorkspaceFiles). */
export interface FileSuggestion {
  path: string;
  name: string;
  dir: string;
}

/** Phạm vi tìm xuyên file (setting `orcaEditor.crossFileSearch.scope`). */
export type CrossFileSearchScope = 'markdown' | 'allFiles';

/**
 * Preset đọc (US-19.1) — mỗi preset gói measure + line-height + font.
 * `academic` (US-19.15) = look bài luận serif kiểu ai-2027.com (cột hẹp, serif
 * cổ điển, giãn dòng rộng); ghép đẹp nhất với palette `paper`.
 */
export type ReadingPreset = 'comfortable' | 'default' | 'compact' | 'dyslexia' | 'academic';

/**
 * Bảng màu đọc (US-19.5) — `followTheme` = kế thừa theme VS Code (mặc định).
 * `paper` (US-19.15) = nền kem trắng ấm #fffff8 + chữ gần-đen kiểu ai-2027.com.
 */
export type ReadingPalette = 'followTheme' | 'light' | 'dark' | 'sepia' | 'highContrast' | 'paper';

/**
 * Trạng thái Reading Mode (US-19.1/19.5/19.6/19.9). Host CHỈ dùng để gửi giá trị
 * seed ban đầu (đọc từ `orcaEditor.readability.*`) trong 'init'; sau đó
 * `enabled`/`preset`/`palette`/`fontFamily` là per-tab, session-only ở webview
 * (bug 0715 mục 4) — không persist ngược về config. `zen` là NGOẠI LỆ
 * (US-19.19): global-in-memory ở host, đổi ở 1 tab lan sang mọi tab .md đang
 * mở qua message `zenChanged` (webview áp bằng CSS var/class, KHÔNG đụng nội
 * dung `.md`).
 */
export interface ReadabilityConfig {
  enabled: boolean;
  preset: ReadingPreset;
  palette: ReadingPalette;
  fontFamily: string;
  zen: boolean;
}

/** Một match tìm thấy trong 1 file, kèm snippet ngữ cảnh ~1 dòng trước/sau. */
export interface CrossFileMatch {
  /** Dòng chứa match (0-based), dùng để mở file đúng vị trí. */
  line: number;
  /** Offset ký tự bắt đầu match trên dòng đó (0-based, UTF-16 code unit). */
  character: number;
  /** Độ dài đoạn khớp (= độ dài query). */
  length: number;
  /** Dòng liền trước, đã trim (rỗng nếu là dòng đầu file). */
  contextBefore: string;
  /** Toàn bộ dòng chứa match, đã trim — webview tự highlight đoạn [character, character+length). */
  lineText: string;
  /** Dòng liền sau, đã trim (rỗng nếu là dòng cuối file). */
  contextAfter: string;
  /** Offset ký tự XẤP XỈ của match trong toàn bộ nội dung file gốc (0-based) — dùng cho positionBoost khi xếp hạng (US-15.7), không dùng để mở file (đã có line/character). */
  charOffset: number;
}

/** Kết quả nhóm theo file cho tìm xuyên file. */
export interface CrossFileMatchGroup {
  /** uri.toString() của file — gửi lại nguyên văn khi bấm mở kết quả. */
  uri: string;
  /** Tên file (basename), hiển thị trong header nhóm. */
  fileName: string;
  /** Đường dẫn tương đối so với workspace, hiển thị dưới tên file. */
  relativePath: string;
  /** Tổng số match THẬT tìm được trong file (trước khi cắt còn tối đa 10 để gửi đi) — dùng cho badge + dòng "+N match khác". */
  totalInFile: number;
  /** Độ dài nội dung file gốc (số ký tự) — mẫu số cho positionBoost khi xếp hạng (US-15.7). */
  fileLength: number;
  matches: CrossFileMatch[];
}

/**
 * Cấu hình render gửi kèm message `init`. Field & kiểu lấy đúng từ
 * provider.ts (case 'ready' → postMessage 'init').
 */
export interface InitConfig {
  breaks: boolean;
  linkify: boolean;
  wordWrap: boolean;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  autoOpenToc: boolean;
  showLineNumbers: boolean;
  /** Giá trị mặc định ban đầu của dropdown scope trong popover tìm xuyên file. */
  crossFileSearchScope: CrossFileSearchScope;
  /** Trạng thái Reading Mode ban đầu (US-19.x). */
  readability: ReadabilityConfig;
}

/** Message webview → host (discriminated theo `type`). */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'openLink'; href: string }
  | { type: 'searchFiles'; query: string; requestId: number }
  | { type: 'addToClaudeContext' }
  | { type: 'viewSource' }
  | { type: 'crossFileSearch:request'; requestId: number; query: string; scope: CrossFileSearchScope; matchCase: boolean; wholeWord: boolean }
  | { type: 'crossFileSearch:openResult'; uri: string; line: number; character: number; length: number; matchText: string }
  /** relativePath: có khi bấm "+N match khác trong file này" (GĐ4) — Search panel chỉ hiện kết quả đúng file đó thay vì toàn scope. */
  | { type: 'crossFileSearch:openInSearchPanel'; query: string; scope: CrossFileSearchScope; relativePath?: string }
  /** Ảnh dán từ clipboard (paste event hoặc fallback Clipboard API) — host lưu file thật rồi trả lại đường dẫn tương đối. */
  | { type: 'pasteImage'; requestId: number; mime: string; dataBase64: string }
  /**
   * US-17.6 (M4): file kéo thả từ ngoài (Explorer/Finder) không phải ảnh —
   * host copy vào folder assets (resolveAssetsDir) rồi trả đường dẫn tương
   * đối; webview chèn `[name](path)` tại vị trí thả. Ảnh kéo thả dùng lại
   * message `pasteImage` sẵn có (external-drop.ts gọi thẳng vào luồng
   * paste-image.ts), KHÔNG qua message này.
   */
  | { type: 'dropFile'; requestId: number; name: string; dataBase64: string }
  /**
   * US-19.19: Zen/Focus mode vừa đổi ở TAB NÀY — host giữ lại làm state
   * global-in-memory (KHÔNG persist Settings) rồi phát cho MỌI panel .md
   * khác đang mở (trừ chính panel gửi, đã tự apply cục bộ rồi). Khác
   * preset/palette/enabled (vẫn per-tab, session-only — US-19.18).
   */
  | { type: 'zenChanged'; zen: boolean };

/** Message host → webview (discriminated theo `type`). */
export type HostToWebview =
  | {
      type: 'init';
      text: string;
      config: InitConfig;
      /**
       * C6: vị trí cần scroll tới ngay sau khi render lần đầu — trạng thái
       * "dùng một lần" cho riêng lượt mở panel này (khác `InitConfig`, vốn là
       * setting bền vững). Có khi panel mới mở được điều hướng từ kết quả
       * tìm xuyên file. `line`/`character` 0-based, cùng quy ước với
       * `CrossFileMatch` ở trên. `length` = độ dài đoạn cần select luôn (không
       * chỉ scroll tới) — 0/undefined nếu chỉ cần scroll, không select.
       */
      reveal?: { line: number; character: number; length: number; matchText?: string };
    }
  | { type: 'update'; text: string }
  | { type: 'fileSearchResult'; requestId: number; files: FileSuggestion[] }
  | { type: 'configUpdate'; autoOpenToc: boolean; showLineNumbers: boolean }
  /**
   * C4: `usedFallback` = true khi host đã âm thầm hạ một truy vấn Whole Word 0
   * kết quả xuống substring cho chính response này — webview hiện thông báo +
   * đồng bộ toggle Whole Word về OFF.
   */
  | { type: 'crossFileSearch:result'; requestId: number; groups: CrossFileMatchGroup[]; truncated: boolean; usedFallback: boolean }
  /** C6b: file .md đã mở sẵn ở tab khác — gửi thẳng tới panel đó thay vì qua 'init'. Cùng ý nghĩa `length` như `reveal` ở trên. */
  | { type: 'scrollToPosition'; line: number; character: number; length: number; matchText?: string }
  /** Kết quả lưu ảnh dán từ clipboard — relativePath thiếu khi lưu thất bại (kèm error để hiện toast). */
  | { type: 'pasteImageResult'; requestId: number; relativePath?: string; error?: string }
  /** Kết quả lưu file kéo thả (US-17.6, M4) — cùng hình dạng với pasteImageResult. */
  | { type: 'dropFileResult'; requestId: number; relativePath?: string; error?: string }
  /** US-19.19: broadcast lại Zen mới (do 1 tab KHÁC vừa đổi) — webview chỉ apply cục bộ, không gửi ngược lại (tránh vòng lặp). */
  | { type: 'zenChanged'; zen: boolean };
