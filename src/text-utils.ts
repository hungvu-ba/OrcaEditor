/**
 * Logic THUẦN của extension host, tách khỏi provider.ts để unit-test được mà
 * không cần VS Code runtime (provider.ts import 'vscode' ở top nên không test
 * trực tiếp). Không import 'vscode' ở đây — chỉ chuỗi/số học thuần (finding C6).
 */

import { isWindowsDrivePath } from './shared/link-scheme';

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

/**
 * Performance Audit P-8: rebuild the webview's new full text from a diff-shaped
 * 'edit' applied to `base` (the host's mirror of the webview's `currentText`).
 *
 * Returns `null` — meaning "refuse, ask for a full resync" — rather than
 * applying anything questionable: `baseLength` disagreeing with the mirror says
 * the two sides are describing different documents, and out-of-range or
 * inverted offsets say the same about a message that cannot be trusted. Splicing
 * at guessed offsets would corrupt the user's file, so every failure is total.
 * The rev check that catches a LEGITIMATE divergence (a push the webview
 * deferred) lives at the call site, which is the side that knows the revs.
 */
export function rebuildFromEditDiff(
  base: string,
  edit: { start: number; oldEnd: number; newText: string; baseLength: number }
): string | null {
  const { start, oldEnd, newText, baseLength } = edit;
  // `newText` is typed as string, but this is a message boundary — a dropped or
  // malformed field must be refused like every other bad input here, not
  // concatenated. Without this, an absent `newText` splices the literal
  // "undefined" into the user's markdown and is then stored as the new mirror.
  if (typeof newText !== 'string') {
    return null;
  }
  if (baseLength !== base.length) {
    return null;
  }
  if (!Number.isInteger(start) || !Number.isInteger(oldEnd) || start < 0 || oldEnd < start || oldEnd > base.length) {
    return null;
  }
  return base.slice(0, start) + newText + base.slice(oldEnd);
}

/**
 * Normalize the line endings of `text` to the document's EOL before diffing.
 * The webview serialize() always emits LF; for a CRLF document a raw LF-vs-CRLF
 * diff mismatches at offset 0 → a whole-document edit (X-2). When `useCrlf`, turn
 * every `\r\n`/`\n` into `\r\n`. The `/\r\n|\n/g` form (not `/\n/g`) is idempotent
 * when a `\r\n` already survives.
 */
export function normalizeEol(text: string, useCrlf: boolean): string {
  return useCrlf ? text.replace(/\r\n|\n/g, '\r\n') : text;
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
  if (isWindowsDrivePath(href)) {
    return { kind: 'relative' }; // X-7: `C:\…` is a local path, not scheme `c:` — resolve as a file target.
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    return { kind: 'absolute', scheme, safe: SAFE_LINK_SCHEMES.has(scheme.toLowerCase()) };
  }
  return { kind: 'relative' };
}

/**
 * Case-preserving core của chuẩn hoá tên file: bỏ dấu tiếng Việt (kể cả đ/Đ→d/D
 * vì NFD không tách được), mọi ký tự khác chữ/số thành '-'. Tách riêng để
 * imageNamePrefix (X-21) dùng bản GIỮ HOA/THƯỜNG trên filesystem phân biệt
 * hoa/thường (Linux) mà không đụng normalizeForSearch của các consumer tìm kiếm.
 */
function normalizeNameCore(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// X-21: case-folding version for search consumers (searchWorkspaceFiles,
// EntityIndex.query, @-trigger filter). Byte-identical output to the previous
// implementation (lowercase then NFD/strip/đ→d): folding after the core
// collapses the same characters.
export function normalizeForSearch(s: string): string {
  return normalizeNameCore(s).toLowerCase();
}

/**
 * Prefix gắn vào tên file ảnh dán, suy ra từ basename file .md sở hữu nó —
 * để cleanup ảnh mồ côi (xem cleanupOrphanImages trong provider.ts) nhận ra
 * ảnh nào "thuộc về" file nào chỉ bằng tên file, không cần quét nội dung mọi
 * file .md khác trong thư mục. Rỗng nếu basename không còn ký tự chữ/số nào
 * sau chuẩn hoá (vd toàn CJK) — caller tự fallback về không prefix (ảnh đó
 * nằm ngoài phạm vi cleanup tự động).
 *
 * X-21: trên filesystem phân biệt hoa/thường (Linux, caseInsensitive=false) giữ
 * nguyên hoa/thường để `Report.md` và `report.md` không cùng prefix (mỗi file coi
 * ảnh của file kia là mồ côi). Mặc định true (macOS/Windows) → lowercase như cũ,
 * nên tên ảnh dán đã ghi từ trước không đổi.
 */
export function imageNamePrefix(baseName: string, caseInsensitive = true): string {
  const normalized = caseInsensitive ? normalizeForSearch(baseName) : normalizeNameCore(baseName);
  return normalized.slice(0, 40);
}

/**
 * Basename-only, safe to join under the assets folder (US-17.6, M4 — file
 * dropped from outside the editor). `name` is client-controlled (the
 * browser File object's `.name`, forwarded from the webview) so it must not
 * be trusted as a path: strips every `/`/`\` (no directory traversal
 * survives), leading dots (no hidden file / relative-`..` trick), trailing
 * dots/spaces, and prefixes a Windows-reserved device stem (S-6), falling
 * back to a generic name if nothing safe is left.
 *
 * The stem is capped at DROPPED_STEM_MAX chars (X-9): a browser-supplied
 * `file.name` can be 100+ chars, and under a long OneDrive root that crosses
 * Windows' 260-char MAX_PATH so `writeFile` throws. The extension is preserved;
 * the uniqueness suffix (`(2)`, `(3)`…) is added later by `uniqueAssetUri`, so
 * it stays outside this cap.
 */
export const DROPPED_STEM_MAX = 60;

/**
 * Whether a caught filesystem error is a path/name-length failure (X-9). Covers
 * both the POSIX code (`ENAMETOOLONG`) and the two Windows codes a MAX_PATH
 * overrun surfaces as (`ERROR_PATH_NOT_FOUND`, or `ENOENT` when a too-long path
 * is reported as "not found"), reading `err.code` from either a Node error or a
 * `vscode.FileSystemError` and falling back to the message text.
 */
export function isPathTooLongError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code ?? '') : '';
  if (code === 'ENAMETOOLONG' || code === 'ERROR_PATH_NOT_FOUND') {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /ENAMETOOLONG|ERROR_PATH_NOT_FOUND|path.*too long|name too long/i.test(msg);
}

/**
 * Windows reserved device names (S-6): `CON`, `CON.pdf`, `com1.PDF`... all
 * resolve to the device namespace on Windows regardless of extension, while
 * `bacon.pdf` must not match (the anchors make it a whole-segment match, not a
 * substring one).
 */
const WINDOWS_RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function sanitizeDroppedFileName(name: string): string {
  const safe = name
    .replace(/[\\/]/g, '_')
    // trim() BEFORE stripping leading dots (review finding, step-04, edge case
    // hunter — confirmed by direct execution): a name with whitespace ahead of
    // its leading dot(s) — " .htaccess", "  ..secret" — used to keep the dot(s)
    // untouched, because they weren't at position 0 until trim ran, by which
    // point the leading-dot strip had already had its one pass.
    .trim()
    .replace(/^\.+/, '')
    // Windows silently drops trailing dots/spaces from the final path
    // component (S-6) — left uncleaned, a name like "notes." or "notes. "
    // writes as something other than what the caller expects.
    .replace(/[.\s]+$/, '');
  if (!safe) {
    return 'file';
  }
  // Split off a trailing extension (last dot not at position 0, reasonably
  // short) so truncation never eats it; a name with no such dot is all stem.
  const dot = safe.lastIndexOf('.');
  const hasExt = dot > 0 && safe.length - dot <= 11;
  let stem = hasExt ? safe.slice(0, dot) : safe;
  const ext = hasExt ? safe.slice(dot) : '';
  // Review finding (blind hunter, 2026-07-28): Windows keys reserved-device-name
  // blocking off the segment before the FIRST dot in the whole name, not the
  // last — "aux.spec.ts" is still the AUX device even though the last-dot split
  // above puts "aux.spec" in `stem`. Check that first segment specifically, but
  // prefix `stem` (which may carry more than just that segment for a compound
  // extension) so the rest of the name survives untouched.
  const firstDot = safe.indexOf('.');
  const reservedSegment = firstDot === -1 ? safe : safe.slice(0, firstDot);
  if (WINDOWS_RESERVED_NAME.test(reservedSegment)) {
    stem = `_${stem}`;
  }
  return (stem.length > DROPPED_STEM_MAX ? stem.slice(0, DROPPED_STEM_MAX) : stem) + ext;
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

/**
 * Đường dẫn tương đối từ thư mục fromDir tới file toFile (cùng scheme file).
 * When `caseInsensitive` is set (win32/darwin, X-8), segments are folded ONLY
 * for the common-prefix comparison — the emitted path keeps `toFile`'s original
 * casing — so a `C:` vs `c:` (or any case-variant) prefix no longer produces a
 * bogus `../../../c:/…` link. Default false keeps case-sensitive (Linux) output
 * byte-identical.
 */
export function relativePath(fromDir: string, toFile: string, caseInsensitive = false): string {
  const from = fromDir.split('/').filter(Boolean);
  const to = toFile.split('/').filter(Boolean);
  const fold = (s: string): string => (caseInsensitive ? s.toLowerCase() : s);
  let common = 0;
  while (common < from.length && common < to.length && fold(from[common]) === fold(to[common])) {
    common++;
  }
  const up: string[] = new Array(from.length - common).fill('..');
  return [...up, ...to.slice(common)].join('/');
}

/**
 * Leading drive letter of a path, lower-cased and without the colon (`c`), or
 * '' if there is none. Tolerates a leading `/` (Uri.path form `/C:/…`) and
 * either slash after the colon. Pure helper for X-8's cross-OS path handling.
 */
function driveLetterOf(pathLike: string): string {
  const m = /^\/?([a-zA-Z]):[\\/]/.exec(pathLike);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Normalize the `assetsPaste.customFolderPath` setting once on read (X-8):
 * trim, `\` → `/`, and strip trailing separators. Idempotent. A Windows-style
 * absolute path (`c:\a\b\`) becomes `c:/a/b`, so drive detection and Uri.file
 * work the same regardless of the host OS the setting was authored on.
 */
export function normalizeCustomFolderPath(raw: string): string {
  const forward = raw.trim().replace(/\\/g, '/');
  const stripped = forward.replace(/\/+$/, '');
  // Keep a bare root the strip would otherwise erase: a Windows drive-root
  // (`c:/` — `c:` alone is not recognized by isWindowsDrivePath and would read
  // as a relative folder literally named "c:"), or POSIX root (`/`).
  if (/^[a-zA-Z]:$/.test(stripped)) {
    return stripped + '/';
  }
  if (stripped === '' && forward.startsWith('/')) {
    return '/';
  }
  return stripped;
}

/**
 * A specific hint appended to the "outside the allowed workspace" error (X-8)
 * when a custom folder is refused because its drive differs from the workspace's
 * — a relative link across drives is impossible, so the generic message is
 * confusing. Returns '' when there is no drive mismatch (caller keeps the plain
 * message). Both inputs are expected already `normalizeCustomFolderPath`-shaped
 * (or a `Uri.path`). Pure — unit-tested in isolation.
 */
export function driveMismatchHint(customPathNorm: string, workspacePathNorm: string): string {
  const custom = driveLetterOf(customPathNorm);
  const workspace = driveLetterOf(workspacePathNorm);
  if (!custom || custom === workspace) {
    return '';
  }
  return workspace
    ? ` It is on drive ${custom.toUpperCase()}: but the workspace is on drive ${workspace.toUpperCase()}:; choose a folder on the same drive.`
    : ` It looks like a Windows path (drive ${custom.toUpperCase()}:) that is not inside this workspace.`;
}

/**
 * Identity comparison of two `Uri.toString()` strings for the SAME document,
 * case-folded on case-insensitive filesystems (X-8) so a file opened as
 * `Doc.md` and enumerated by `findFiles` as `doc.md` is recognized as itself
 * (and thus excluded from its own link suggestions). Percent-encoding uses
 * uppercase hex on both sides, so folding stays consistent. Default (false)
 * keeps exact equality on case-sensitive filesystems.
 */
export function sameDocumentUri(aStr: string, bStr: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? aStr.toLowerCase() === bStr.toLowerCase() : aStr === bStr;
}

/**
 * Canonical form of a document `Uri.toString()` for use as a persisted STORAGE
 * KEY (Req 23 US-23.2's per-file "Show Comments" flag in `workspaceState`).
 *
 * `sameDocumentUri` answers "are these the same document?" but a key needs one
 * stable string, so the same folding is applied here up-front. NFC as well as
 * case: a name typed on macOS (NFD) and the same name on Windows (NFC) are
 * different strings, so keying on the raw uri silently wrote the flag under one
 * key and read it back under another (CLAUDE.md's cross-platform trap).
 */
export function documentStateKey(uriStr: string, caseInsensitive: boolean): string {
  const nfc = uriStr.normalize('NFC');
  return caseInsensitive ? nfc.toLowerCase() : nfc;
}
