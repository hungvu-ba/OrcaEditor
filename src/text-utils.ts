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

/**
 * Canonical form of a RAW on-disk asset basename for orphan-cleanup comparison
 * (X-1): `.normalize('NFC')` (macOS dir entries are NFD, typed links NFC) plus
 * an optional case-fold on case-insensitive filesystems (win32/darwin — the
 * safe direction, since a fold can only spare a file from deletion, never cause
 * one). Deliberately does NOT percent-decode: an on-disk name is already
 * literal, so decoding it would turn a real `%20` in the name into a space and
 * diverge from the href (which round-trips back to `%20`). Decoding belongs on
 * the href side only — see `referencedAssetBasenames`.
 */
export function normalizeAssetName(name: string, caseInsensitive = false): string {
  const nfc = name.normalize('NFC');
  return caseInsensitive ? nfc.toLowerCase() : nfc;
}

/**
 * A link/href TARGET → normalized asset basename, or null if it has no usable
 * basename. Strips the `<...>` form, a ` "title"` suffix (already excluded by
 * the caller's capture) and any `?query`/`#frag`, then percent-decodes once
 * (guarded — a malformed `%` keeps the raw string) so an encoded href converges
 * with its raw on-disk name.
 */
function targetToAssetName(target: string, caseInsensitive: boolean): string | null {
  let t = target;
  if (t.startsWith('<') && t.endsWith('>')) {
    t = t.slice(1, -1);
  }
  t = t.split(/[?#]/)[0];
  if (!t) {
    return null;
  }
  const base = t.split('/').pop();
  if (!base) {
    return null;
  }
  let decoded = base;
  try {
    decoded = decodeURIComponent(base);
  } catch {
    // Malformed percent-sequence in the href — compare against the raw form.
  }
  return normalizeAssetName(decoded, caseInsensitive);
}

/**
 * Normalized basenames of the assets a document references — via markdown
 * link/image targets, HTML `<img src>` / `<a href>` (the editor writes sized
 * and table-cell images as raw `<img … width>` HTML, kept verbatim in the .md
 * by turndown), and reference-style `[label]: target` definitions. Used by
 * orphan cleanup to know which tracked assets are still in use. The reference
 * is the TARGET, never the display text.
 */
export function referencedAssetBasenames(text: string, caseInsensitive = false): Set<string> {
  const set = new Set<string>();
  const add = (target: string | undefined): void => {
    if (target == null) {
      return;
    }
    const name = targetToAssetName(target, caseInsensitive);
    if (name) {
      set.add(name);
    }
  };
  // Every markdown inline `](target)` — images, links, and nested/linked images
  // (`[![](inner)](outer)` yields two `](` hits, so both targets are captured).
  const md = /\]\(\s*(<[^>]*>|[^)\s]*)/g;
  // Reference-style definition `[label]: target`.
  const ref = /^[ \t]*\[(?:[^\]\\]|\\.)*\]:[ \t]*(<[^>]*>|\S+)/gm;
  // HTML src/href attribute value (single/double-quoted or bare).
  const html = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = md.exec(text))) {
    add(m[1]);
  }
  while ((m = ref.exec(text))) {
    add(m[1]);
  }
  while ((m = html.exec(text))) {
    add(m[1] ?? m[2] ?? m[3]);
  }
  return set;
}

/**
 * Pure classifier for orphan-asset cleanup (X-1): the pool names NOT referenced
 * by any link/image/HTML target in `text`. Compares full basenames through one
 * shared normalizer, so `img.png` never matches a longer `myimg.png` (the old
 * `text.includes(name)` substring bug) and an encoded/NFD href still matches
 * its raw/NFC on-disk name.
 */
export function orphanAssetNames(pool: Iterable<string>, text: string, caseInsensitive = false): string[] {
  const referenced = referencedAssetBasenames(text, caseInsensitive);
  return [...pool].filter((name) => !referenced.has(normalizeAssetName(name, caseInsensitive)));
}

/** Max chars of following text shown in an entity mention's hover preview (Req 21). */
const ENTITY_PREVIEW_MAX = 20;

/**
 * The FULL label text that FOLLOWS a `caption::NS_ID` declaration token — the
 * entity's human name used as a mention's link display text (Req 21). Trims
 * leading whitespace, stops at the first break delimiter (`:`, `;`, a backtick —
 * inline code / fence / command — or a newline), and trims trailing whitespace.
 * NOT length-capped (that is the preview's job). Empty string when nothing
 * meaningful follows. Pure — shared by the host index (entity-index.ts) and the
 * webview mention-insert paths (trigger-at.ts / entity-scope.ts) so they agree.
 */
export function entityFollowingLabel(following: string): string {
  const trimmed = following.replace(/^\s+/, '');
  const cut = trimmed.search(/[:;`\r\n]/);
  return (cut === -1 ? trimmed : trimmed.slice(0, cut)).trimEnd();
}

/**
 * Short preview of the entity label (entityFollowingLabel), capped at
 * ENTITY_PREVIEW_MAX chars for the hover tooltip (Req 21) so a bare namespace
 * code is understandable at a glance. Appends `…` only when the cap actually
 * truncated the text (a delimiter cut adds no `…`). Empty string when nothing
 * meaningful follows.
 */
export function entityFollowingPreview(following: string): string {
  const segment = entityFollowingLabel(following);
  // Count by code points (not UTF-16 units) so the cap never splits a surrogate
  // pair (emoji / astral chars) into a broken half-glyph.
  const points = Array.from(segment);
  if (points.length <= ENTITY_PREVIEW_MAX) {
    return segment;
  }
  return points.slice(0, ENTITY_PREVIEW_MAX).join('').trimEnd() + '…';
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
