/**
 * C4: Lõi so khớp văn bản THUẦN, dùng chung cho cả hai bundle:
 *  - extension host (Node) — src/provider.ts, quét file trên đĩa/buffer.
 *  - webview (browser) — media/webview/match-utils.ts (Ctrl+F, Feature A).
 *
 * KHÔNG import `vscode`, KHÔNG chạm DOM/Node API — cùng khuôn với
 * src/shared/messages.ts để esbuild bundle được cho cả hai phía mà không kéo
 * code chuyên biệt của bên này sang bên kia.
 *
 * Vì sao không dùng regex `\b`/`\w` cho "whole word": `\w` chỉ nhận
 * `[A-Za-z0-9_]`, coi các chữ có dấu tiếng Việt (ă, â, ê, ô, ơ, ư, đ, các dấu
 * thanh) là ký tự NON-word ⇒ tính sai ranh giới từ với nội dung tiếng Việt của
 * dự án. Thay vào đó dùng Unicode property escape (`\p{L}`, `\p{N}`, cộng `_`)
 * với flag `u` để xét ký tự liền trước/sau match có phải "ký tự từ" hay không.
 */

export interface MatchOptions {
  /** true = phân biệt hoa/thường. Mặc định ứng dụng: false (case-insensitive). */
  matchCase: boolean;
  /** true = chỉ khớp khi query đứng như một từ trọn vẹn (ranh giới Unicode-aware). */
  wholeWord: boolean;
}

/** Một match: [start, end) theo offset UTF-16 code unit trong `text`. */
export interface TextMatchOffset {
  /** Offset đầu (inclusive). */
  start: number;
  /** Offset cuối (exclusive). */
  end: number;
}

/**
 * Ký tự "thuộc từ" cho mục đích whole-word: chữ cái (\p{L}), chữ số (\p{N}),
 * và `_` (khớp ngữ nghĩa "whole word" quen thuộc của VS Code). Regex đơn ký tự,
 * flag `u` bắt buộc để \p{...} hoạt động.
 */
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

/** Ký tự tại vị trí i có phải "ký tự từ" không. Ngoài biên chuỗi ⇒ false (coi như biên từ). */
function isWordCharAt(text: string, i: number): boolean {
  if (i < 0 || i >= text.length) {
    return false;
  }
  return WORD_CHAR_RE.test(text[i]);
}

/**
 * Tìm mọi match KHÔNG chồng lấn của `query` trong `text` theo `options`, cap ở
 * `maxMatches` (nếu truyền). Giữ đúng ngữ nghĩa non-overlapping như findMatches
 * cũ: sau mỗi match, con trỏ nhảy qua hết đoạn khớp.
 *
 * Case: nếu `!matchCase`, hạ thường cả hai vế rồi indexOf (toLowerCase không
 * đổi độ dài chuỗi với các ký tự thực dùng ở đây; KHÔNG dùng toUpperCase vì có
 * codepoint như ß nở dài ra, làm lệch offset).
 *
 * Whole word: sau khi indexOf tìm được đoạn khớp thô, kiểm tra ký tự liền
 * TRƯỚC start và liền SAU end — chỉ giữ match nếu CẢ HAI đều không phải ký tự
 * từ (hoặc chạm biên chuỗi). Không build regex từ query (query là text tuỳ ý,
 * không phải pattern; escape thủ công dễ sai hơn là kiểm biên sau indexOf).
 */
export function findTextMatches(
  text: string,
  query: string,
  options: MatchOptions,
  maxMatches?: number
): TextMatchOffset[] {
  const found: TextMatchOffset[] = [];
  if (!query) {
    return found;
  }
  const cap = maxMatches ?? Infinity;
  const hay = options.matchCase ? text : text.toLowerCase();
  const needle = options.matchCase ? query : query.toLowerCase();
  const nlen = needle.length;
  let from = 0;
  while (found.length < cap) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) {
      break;
    }
    const end = idx + nlen;
    if (!options.wholeWord || (!isWordCharAt(text, idx - 1) && !isWordCharAt(text, end))) {
      found.push({ start: idx, end });
    }
    // Nhảy qua đoạn khớp thô kể cả khi bị loại bởi whole-word: giữ đúng ngữ
    // nghĩa non-overlapping và tránh vòng lặp vô hạn khi nlen là hằng.
    from = end;
  }
  return found;
}
