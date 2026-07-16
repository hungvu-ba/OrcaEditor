/**
 * Logic THUẦN của extension host, tách khỏi provider.ts để unit-test được mà
 * không cần VS Code runtime (provider.ts import 'vscode' ở top nên không test
 * trực tiếp). Không import 'vscode' ở đây — chỉ chuỗi/số học thuần (finding C6).
 */

/** Kết quả diff nhỏ nhất: thay đoạn [start, oldEnd) của oldText bằng newText. */
export interface MinimalEdit {
  /** Offset (theo mã UTF-16) bắt đầu khác nhau trong oldText. */
  start: number;
  /** Offset kết thúc (exclusive) đoạn cần thay trong oldText. */
  oldEnd: number;
  /** Đoạn văn bản mới chèn vào [start, oldEnd). */
  newText: string;
}

/**
 * Tính edit nhỏ nhất biến oldText → newText bằng common prefix/suffix diff.
 * Trả `null` khi hai chuỗi bằng nhau (no-op). So sánh theo charCodeAt (UTF-16
 * code unit) đúng như positionAt của VS Code — offset khớp với TextDocument.
 */
export function computeMinimalEdit(oldText: string, newText: string): MinimalEdit | null {
  if (oldText === newText) {
    return null;
  }
  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (start < minLen && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start++;
  }
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  return { start, oldEnd, newText: newText.slice(start, newEnd) };
}

/** Các scheme URL tuyệt đối được phép mở ra ngoài — chặn command:, vscode:, ... */
export const SAFE_LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

/** Phân loại một href để openLink quyết định cách xử lý (không cần vscode.Uri). */
export interface LinkClassification {
  /** empty: rỗng; absolute: có scheme; relative: đường dẫn tương đối. */
  kind: 'empty' | 'absolute' | 'relative';
  /** Scheme nguyên gốc (giữ hoa/thường) khi kind === 'absolute'. */
  scheme?: string;
  /** Scheme có nằm trong allowlist không (khi kind === 'absolute'). */
  safe?: boolean;
}

/**
 * Phân loại href: rỗng, URL tuyệt đối (kèm scheme + có an toàn không), hay
 * đường dẫn tương đối. markdown-it validateLink không áp cho raw HTML anchor
 * nên host phải tự chặn scheme không an toàn dựa trên kết quả này.
 */
export function classifyLink(href: string): LinkClassification {
  if (!href) {
    return { kind: 'empty' };
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    return { kind: 'absolute', scheme, safe: SAFE_LINK_SCHEMES.has(scheme.toLowerCase()) };
  }
  return { kind: 'relative' };
}

/**
 * Chuẩn hóa chuỗi để so khớp tên file: thường hóa, bỏ dấu tiếng Việt
 * (kể cả đ→d vì NFD không tách được), mọi ký tự khác chữ/số thành '-'.
 */
export function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Prefix gắn vào tên file ảnh dán, suy ra từ basename file .md sở hữu nó —
 * để cleanup ảnh mồ côi (xem cleanupOrphanImages trong provider.ts) nhận ra
 * ảnh nào "thuộc về" file nào chỉ bằng tên file, không cần quét nội dung mọi
 * file .md khác trong thư mục. Rỗng nếu basename không còn ký tự chữ/số nào
 * sau chuẩn hoá (vd toàn CJK) — caller tự fallback về không prefix (ảnh đó
 * nằm ngoài phạm vi cleanup tự động).
 */
export function imageNamePrefix(baseName: string): string {
  return normalizeForSearch(baseName).slice(0, 40);
}

/**
 * Basename-only, safe to join under the assets folder (US-17.6, M4 — file
 * dropped from outside the editor). `name` is client-controlled (the
 * browser File object's `.name`, forwarded from the webview) so it must not
 * be trusted as a path: strips every `/`/`\` (no directory traversal
 * survives) and leading dots (no hidden file / relative-`..` trick), falling
 * back to a generic name if nothing safe is left.
 */
export function sanitizeDroppedFileName(name: string): string {
  const safe = name.replace(/[\\/]/g, '_').replace(/^\.+/, '').trim();
  return safe || 'file';
}

/** Đường dẫn tương đối từ thư mục fromDir tới file toFile (cùng scheme file). */
export function relativePath(fromDir: string, toFile: string): string {
  const from = fromDir.split('/').filter(Boolean);
  const to = toFile.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common++;
  }
  const up: string[] = new Array(from.length - common).fill('..');
  return [...up, ...to.slice(common)].join('/');
}
