/**
 * Unit test cho logic THUẦN của extension host (src/text-utils.ts) — không cần
 * VS Code runtime. Bao computeMinimalEdit, normalizeForSearch, relativePath,
 * classifyLink (scheme allowlist) và một kiểm tra type-level của message
 * contract (src/shared/messages.ts). (finding C6)
 *
 * Cũng gồm security tripwire đọc src/provider.ts dạng text (xem cuối file) —
 * provider.ts import 'vscode' nên không import trực tiếp được ở đây.
 *
 * Chạy: npm run test:unit
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  classifyLink,
  computeMinimalEdit,
  driveMismatchHint,
  entityFollowingLabel,
  entityFollowingPreview,
  imageNamePrefix,
  isPathTooLongError,
  normalizeAssetName,
  normalizeCustomFolderPath,
  normalizeEol,
  normalizeForSearch,
  orphanAssetNames,
  referencedAssetBasenames,
  relativePath,
  sameDocumentUri,
  sanitizeDroppedFileName,
  type MinimalEdit,
} from '../src/text-utils';
import { isWindowsDrivePath, hasUrlScheme } from '../src/shared/link-scheme';
import type { HostToWebview, TriggerConfig, WebviewToHost } from '../src/shared/messages';
import { EntityIndex, parseEntities, nearestEnclosingHeading, type IndexedEntity } from '../src/entity-index';
import { canonicalEntityId, scanEntityOccurrences } from '../src/occurrence-scan';
import { findTextMatches, type MatchOptions } from '../src/shared/text-match';
import { detectBlockStyle, type StyleOverride } from '../media/webview/block-style';
import { truncateDisplay } from '../media/webview/trigger-popup';
import { headingSiblingGaps } from '../media/webview/drag-drop';
import { countWords, estimateReadMinutes, formatCount } from '../media/webview/reading-stats';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
    failures.push(`--- ${name} ---${detail ? '\n' + detail : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `  nhận:    ${a}\n  kỳ vọng: ${e}`);
}

// ---------------------------------------------------------------------------
// computeMinimalEdit — bất biến then chốt: áp diff lại phải tái tạo newText.
// ---------------------------------------------------------------------------

/** Mô phỏng cách provider áp WorkspaceEdit: thay [start, oldEnd) bằng newText. */
function applyEdit(oldText: string, diff: MinimalEdit): string {
  return oldText.slice(0, diff.start) + diff.newText + oldText.slice(diff.oldEnd);
}

interface EditCase {
  name: string;
  oldText: string;
  newText: string;
  expect: MinimalEdit | null;
}

const editCases: EditCase[] = [
  { name: 'edit: hai chuỗi rỗng → no-op', oldText: '', newText: '', expect: null },
  { name: 'edit: oldText === newText → no-op', oldText: 'abc', newText: 'abc', expect: null },
  { name: 'edit: chèn vào chuỗi rỗng', oldText: '', newText: 'hello', expect: { start: 0, oldEnd: 0, newText: 'hello' } },
  { name: 'edit: xóa toàn bộ về rỗng', oldText: 'hello', newText: '', expect: { start: 0, oldEnd: 5, newText: '' } },
  { name: 'edit: thêm ở giữa', oldText: 'abcf', newText: 'abcdef', expect: { start: 3, oldEnd: 3, newText: 'de' } },
  { name: 'edit: xóa ở giữa', oldText: 'abcdef', newText: 'abcf', expect: { start: 3, oldEnd: 5, newText: '' } },
  { name: 'edit: thay ở giữa', oldText: 'abXYef', newText: 'abZef', expect: { start: 2, oldEnd: 4, newText: 'Z' } },
  { name: 'edit: prefix chồng lấn với suffix (aaa→aa)', oldText: 'aaa', newText: 'aa', expect: { start: 2, oldEnd: 3, newText: '' } },
  { name: 'edit: prefix/suffix trùng ký tự (xx→xxx)', oldText: 'xx', newText: 'xxx', expect: { start: 2, oldEnd: 2, newText: 'x' } },
  {
    // 'e' + combining grave (2 code unit) → 'e' + combining acute: chỉ dấu đổi.
    name: 'edit: tiếng Việt tổ hợp (combining) thay dấu',
    oldText: 'e\u0300', // e + combining grave
    newText: 'e\u0301', // e + combining acute
    expect: { start: 1, oldEnd: 2, newText: '\u0301' },
  },
  {
    name: 'edit: surrogate pair (emoji) chèn giữa',
    oldText: 'a\u{1F600}b', // a😀b (😀 = 2 code unit)
    newText: 'a\u{1F600}\u{1F389}b', // a😀🎉b
    expect: { start: 3, oldEnd: 3, newText: '\u{1F389}' },
  },
];

for (const c of editCases) {
  const diff = computeMinimalEdit(c.oldText, c.newText);
  eq(c.name, diff, c.expect);
  // Bất biến: áp diff (nếu có) phải tái tạo đúng newText.
  const rebuilt = diff ? applyEdit(c.oldText, diff) : c.oldText;
  check(`${c.name} [tái tạo newText]`, rebuilt === c.newText, `  nhận: ${JSON.stringify(rebuilt)}`);
}

// Kiểm tra ngẫu nhiên: với mọi cặp chuỗi, áp diff phải tái tạo newText.
{
  const alphabet = 'ab😀ữ\n ';
  const rnd = (n: number) => Math.floor(Math.random() * n);
  const randStr = () => {
    let s = '';
    const len = rnd(8);
    for (let i = 0; i < len; i++) {
      s += alphabet[rnd(alphabet.length)];
    }
    return s;
  };
  let ok = true;
  for (let i = 0; i < 500; i++) {
    const a = randStr();
    const b = randStr();
    const d = computeMinimalEdit(a, b);
    const rebuilt = d ? applyEdit(a, d) : a;
    if (rebuilt !== b) {
      ok = false;
      failures.push(`--- fuzz edit ---\n  a=${JSON.stringify(a)} b=${JSON.stringify(b)} d=${JSON.stringify(d)}`);
      break;
    }
  }
  check('edit: fuzz 500 cặp — áp diff luôn tái tạo newText', ok);
}

// ---------------------------------------------------------------------------
// normalizeEol + reconcile before diffing (X-2: a CRLF document is not rewritten).
// ---------------------------------------------------------------------------

// Pure behavior of normalizeEol.
eq('eol: LF pass-through when !useCrlf', normalizeEol('# A\n\nB\n', false), '# A\n\nB\n');
eq('eol: LF -> CRLF when useCrlf', normalizeEol('# A\n\nB\n', true), '# A\r\n\r\nB\r\n');
eq('eol: idempotent — existing CRLF not doubled to \\r\\r\\n', normalizeEol('# A\r\n\r\nB\r\n', true), '# A\r\n\r\nB\r\n');
eq('eol: mixed \\r\\n + \\n -> all CRLF', normalizeEol('a\r\nb\nc', true), 'a\r\nb\r\nc');

// Core X-2: same CRLF-doc vs LF-newText pair.
// - WITHOUT reconcile → the diff mismatches at the first \r → span ~= whole document (bug).
// - WITH reconcile → minimal span around "B"->"B!", and reapplying stays all-CRLF.
{
  const crlfDoc = '# A\r\n\r\nB\r\n';
  const lfNewText = '# A\n\nB!\n'; // webview serialize() is always LF, only appends '!' after B.

  // Control (no normalize): reproduces the bug — the edit spans almost the whole document.
  const buggy = computeMinimalEdit(crlfDoc, lfNewText);
  const buggySpan = buggy ? buggy.oldEnd - buggy.start : 0;
  check(
    'eol[X-2]: NO reconcile → span = whole-doc (bug)',
    buggySpan > crlfDoc.length / 2,
    `  span=${buggySpan} / docLen=${crlfDoc.length}`
  );

  // Fix: reconcile the LF newText to CRLF before diffing.
  const reconciled = normalizeEol(lfNewText, true);
  const fixed = computeMinimalEdit(crlfDoc, reconciled);
  const fixedSpan = fixed ? fixed.oldEnd - fixed.start : 0;
  check(
    'eol[X-2]: reconcile → minimal span (no whole-file rewrite)',
    fixed !== null && fixedSpan <= 2,
    `  span=${fixedSpan} diff=${JSON.stringify(fixed)}`
  );

  // Reapplying the reconciled edit → result is still all-CRLF, no bare LF mixed in.
  const rebuilt = fixed ? applyEdit(crlfDoc, fixed) : crlfDoc;
  eq('eol[X-2]: reapply keeps CRLF', rebuilt, '# A\r\n\r\nB!\r\n');
  check('eol[X-2]: result has no bare LF', !/(^|[^\r])\n/.test(rebuilt), `  got: ${JSON.stringify(rebuilt)}`);
}

// X-2 (caret half): the echo-suppression key must match the document's EOL.
// provider.ts import 'vscode' → can't load here; MODEL the echo decision of
// case 'edit' + changeSubscription. The webview always posts LF; applyMinimalEdit
// writes the reconciled (CRLF-on-a-CRLF-doc) text. If `lastTextFromWebview` keeps
// the raw LF, getText() (CRLF) never equals it → a full 'update' re-renders
// #content on EVERY keystroke → lost caret. Reconciling the key suppresses it.
{
  function makeCrlfHost(reconcileEchoKey: boolean) {
    const useCrlf = true;
    let doc = '# A\r\n\r\nB\r\n'; // CRLF document (tool-generated / Windows file)
    let lastTextFromWebview: string | undefined;
    let updatesPosted = 0; // each one = a full renderDocument() → caret loss

    // changeSubscription: echo-check only (provider.ts:522).
    function onChange(newDocText: string): void {
      doc = newDocText;
      if (newDocText === lastTextFromWebview) {
        return; // echo of our own edit → no re-render
      }
      lastTextFromWebview = undefined;
      updatesPosted++;
    }

    // case 'edit' (provider.ts:642 + applyMinimalEdit). `text` is the LF serialize.
    function edit(lfText: string): void {
      lastTextFromWebview = reconcileEchoKey ? normalizeEol(lfText, useCrlf) : lfText;
      const reconciled = normalizeEol(lfText, useCrlf); // applyMinimalEdit always writes this
      const diff = computeMinimalEdit(doc, reconciled);
      onChange(diff ? applyEdit(doc, diff) : doc);
    }
    return {
      edit,
      external: onChange, // git/format/external editor: a change with no matching echo key
      get updates() { return updatesPosted; },
      get docText() { return doc; },
    };
  }

  // Reproduce-first: raw LF key → every keystroke on a CRLF doc posts an update.
  const buggy = makeCrlfHost(false);
  buggy.edit('# A\n\nB!\n'); // type "!" after B
  buggy.edit('# A\n\nB!?\n'); // type "?" — a second keystroke
  check('eol[X-2 caret]: raw LF echo-key → update on every keystroke (bug)', buggy.updates === 2, `  updates=${buggy.updates}`);

  // Fix: reconcile the echo key → no update echoed back → no re-render → caret kept.
  const fixed = makeCrlfHost(true);
  fixed.edit('# A\n\nB!\n');
  fixed.edit('# A\n\nB!?\n');
  check('eol[X-2 caret]: reconciled echo-key → zero echo updates (fix)', fixed.updates === 0, `  updates=${fixed.updates}`);
  eq('eol[X-2 caret]: document stays CRLF through the edits', fixed.docText, '# A\r\n\r\nB!?\r\n');

  // Regression guard: a genuine external edit (git/format) must still post an update.
  const ext = makeCrlfHost(true);
  ext.external('# A\r\n\r\nC\r\n');
  check('eol[X-2 caret]: real external edit still posts update (no over-suppress)', ext.updates === 1);
}

// ---------------------------------------------------------------------------
// normalizeForSearch
// ---------------------------------------------------------------------------

eq('norm: bỏ dấu tiếng Việt', normalizeForSearch('Đăng ký sự kiện'), 'dang-ky-su-kien');
eq('norm: đ → d', normalizeForSearch('đường Đỏ'), 'duong-do');
eq('norm: ký tự đặc biệt → "-" và trim', normalizeForSearch('  Hello, World!!  '), 'hello-world');
eq('norm: chỉ ký tự đặc biệt → rỗng', normalizeForSearch('___!!!'), '');
eq('norm: giữ số', normalizeForSearch('Bản 2 (final)'), 'ban-2-final');
eq('norm: gộp nhiều ký tự phân tách liền nhau', normalizeForSearch('a---b...c'), 'a-b-c');

// ---------------------------------------------------------------------------
// relativePath
// ---------------------------------------------------------------------------

eq('rel: cùng thư mục', relativePath('/w/docs', '/w/docs/a.md'), 'a.md');
eq('rel: xuống thư mục con', relativePath('/w/docs', '/w/docs/sub/a.md'), 'sub/a.md');
eq('rel: đi lên một cấp', relativePath('/w/docs/sub', '/w/docs/a.md'), '../a.md');
eq('rel: đi lên nhiều cấp', relativePath('/w/a/b/c', '/w/x.md'), '../../../x.md');
eq('rel: khác nhánh', relativePath('/w/a/b', '/w/c/d/e.md'), '../../c/d/e.md');
eq('rel: from là gốc', relativePath('/', '/w/a.md'), 'w/a.md');

// relativePath case-fold (X-8) — chỉ fold khi so khớp prefix, output GIỮ casing gốc.
// Default (case-sensitive) giữ nguyên hành vi Linux/byte-identical.
eq('rel[X-8]: default không fold — C: vs c: khác nhánh',
  relativePath('/C:/Proj/docs', '/c:/Proj/assets/img.png'),
  '../../../c:/Proj/assets/img.png');
eq('rel[X-8]: caseInsensitive fold C:/c: → path đúng, giữ casing gốc của target',
  relativePath('/C:/Proj/docs', '/c:/Proj/assets/img.png', true),
  '../assets/img.png');
eq('rel[X-8]: fold lệch case ở nhánh giữa',
  relativePath('/Users/h/Proj/Docs', '/users/h/proj/Assets/x.png', true),
  '../Assets/x.png');
eq('rel[X-8]: fold nhưng output vẫn nguyên hoa/thường segment cuối',
  relativePath('/w/a', '/W/A/Report.PDF', true),
  'Report.PDF');
eq('rel[X-8]: caseInsensitive không đổi kết quả khi đã cùng case',
  relativePath('/w/docs', '/w/docs/sub/a.md', true),
  'sub/a.md');

// ---------------------------------------------------------------------------
// normalizeCustomFolderPath (X-8) — chuẩn hoá setting customFolderPath khi đọc
// ---------------------------------------------------------------------------

eq('normCFP: backslash → forward-slash', normalizeCustomFolderPath('c:\\users\\h\\assets'), 'c:/users/h/assets');
eq('normCFP: bỏ separator cuối', normalizeCustomFolderPath('c:/a/b/'), 'c:/a/b');
eq('normCFP: bỏ nhiều separator cuối + trim', normalizeCustomFolderPath('  assets\\\\  '), 'assets');
eq('normCFP: idempotent', normalizeCustomFolderPath(normalizeCustomFolderPath('C:\\A\\B\\')), 'C:/A/B');
eq('normCFP: rỗng', normalizeCustomFolderPath('   '), '');
// Drive-root / POSIX-root must survive the trailing-separator strip, else a bare
// `c:` is misread as a relative folder named "c:" inside the workspace (review).
eq('normCFP: drive-root c:\\ giữ được là c:/', normalizeCustomFolderPath('c:\\'), 'c:/');
eq('normCFP: drive-root c:/ giữ nguyên', normalizeCustomFolderPath('c:/'), 'c:/');
eq('normCFP: gõ bare drive c: → thành c:/', normalizeCustomFolderPath('c:'), 'c:/');
eq('normCFP: POSIX root / giữ nguyên', normalizeCustomFolderPath('/'), '/');

// ---------------------------------------------------------------------------
// driveMismatchHint (X-8) — gợi ý cụ thể khi custom folder khác ổ đĩa
// ---------------------------------------------------------------------------

eq('driveHint: khác ổ đĩa (Windows) → nêu D: vs C:',
  driveMismatchHint('d:/assets', '/c:/Proj'),
  ' It is on drive D: but the workspace is on drive C:; choose a folder on the same drive.');
eq('driveHint: cùng ổ đĩa (khác case) → rỗng',
  driveMismatchHint('C:/Proj/assets', '/c:/Proj'), '');
eq('driveHint: custom có drive, workspace không (path Windows trên macOS) → nêu là Windows path',
  driveMismatchHint('c:/users/x/assets', '/Users/h/Proj'),
  ' It looks like a Windows path (drive C:) that is not inside this workspace.');
eq('driveHint: cả hai không có drive → rỗng',
  driveMismatchHint('/Users/h/other', '/Users/h/Proj'), '');

// ---------------------------------------------------------------------------
// sameDocumentUri (X-8) — loại trừ file đang mở khỏi gợi ý, fold trên FS không phân biệt hoa thường
// ---------------------------------------------------------------------------

eq('sameUri: fold=false, khác case → KHÔNG bằng',
  sameDocumentUri('file:///w/Doc.md', 'file:///w/doc.md', false), false);
eq('sameUri: fold=true, khác case → bằng (cùng file trên FS không phân biệt hoa thường)',
  sameDocumentUri('file:///w/Doc.md', 'file:///w/doc.md', true), true);
eq('sameUri: fold=true, thật sự khác file → KHÔNG bằng',
  sameDocumentUri('file:///w/a.md', 'file:///w/b.md', true), false);
eq('sameUri: fold=false, trùng khít → bằng',
  sameDocumentUri('file:///w/a.md', 'file:///w/a.md', false), true);

// ---------------------------------------------------------------------------
// imageNamePrefix — prefix tên ảnh dán (C4: dọn ảnh mồ côi khi save)
// ---------------------------------------------------------------------------

eq('prefix: basename thường', imageNamePrefix('Requirement Doc'), 'requirement-doc');
eq('prefix: bỏ dấu tiếng Việt như normalizeForSearch', imageNamePrefix('Đăng ký sự kiện'), 'dang-ky-su-kien');
eq('prefix: chỉ ký tự CJK → rỗng (fallback không prefix)', imageNamePrefix('日本語'), '');
check('prefix: giới hạn độ dài 40 ký tự', imageNamePrefix('a'.repeat(100)).length === 40);

// ---------------------------------------------------------------------------
// orphanAssetNames (X-1) — orphan-cleanup classifier. A tracked asset whose
// on-disk name is percent-encoded / NFC≠NFD in the .md href must NOT be seen
// as orphan and hard-deleted. Compares normalized basenames, not substrings.
// ---------------------------------------------------------------------------

// Diacritic + space + parens: dropped `Tài liệu (2).pdf` → encoded href. Kept.
eq(
  'orphan: diacritic+space+parens encoded href → referenced (kept)',
  orphanAssetNames(['Tài liệu (2).pdf'], '[x](assets/T%C3%A0i%20li%E1%BB%87u%20%282%29.pdf)'),
  [],
);
// `&` force-encoded to %26 by encodeLinkPath. Kept.
eq(
  'orphan: & in name (%26) → referenced (kept)',
  orphanAssetNames(['R&D.png'], '![x](assets/R%26D.png)'),
  [],
);
// macOS dir entry is NFD, typed link is NFC — same file, must match.
eq(
  'orphan: NFD on-disk vs NFC href → referenced (kept)',
  orphanAssetNames(['Đăng.png'.normalize('NFD')], '[x](assets/Đăng.png)'.normalize('NFC')),
  [],
);
// Genuinely unreferenced → still deleted (no hoarding regression).
eq(
  'orphan: unreferenced name → orphan (deleted)',
  orphanAssetNames(['old.png'], '[keep](assets/new.png)'),
  ['old.png'],
);
// Basename set, not substring: `img.png` must not be spared by `myimg.png`.
eq(
  'orphan: substring false-match guard (img.png vs myimg.png)',
  orphanAssetNames(['img.png'], '[x](assets/myimg.png)'),
  ['img.png'],
);
// Malformed percent in the raw pool name → guarded decode keeps it; converges.
eq(
  'orphan: malformed % in name → referenced (kept, no throw)',
  orphanAssetNames(['50%off.png'], '[x](assets/50%25off.png)'),
  [],
);
// Display text repeating the raw name must NOT keep the file — only the target.
eq(
  'orphan: reference is the target, not display text',
  orphanAssetNames(['gone.png'], '[gone.png](assets/other.png)'),
  ['gone.png'],
);
// referencedAssetBasenames: <angle> target and " title" suffix are tolerated.
eq(
  'orphan: angle-bracket target + title parsed to basename',
  [...referencedAssetBasenames('[x](<assets/a b.png> "t")')],
  ['a b.png'],
);
// normalizeAssetName: case-fold only when caseInsensitive is set.
eq('orphan: normalizeAssetName folds case when asked', normalizeAssetName('Report.PNG', true), 'report.png');
eq('orphan: normalizeAssetName keeps case by default', normalizeAssetName('Report.PNG', false), 'Report.PNG');
// Case-insensitive FS: differently-cased href still spares the file.
eq(
  'orphan: case-insensitive fold → Report.png kept by report.png href',
  orphanAssetNames(['Report.png'], '[x](assets/report.png)', true),
  [],
);
// Pasted/sized image is stored as raw <img src width> HTML, not markdown — must
// still be recognized as referenced (else hard-deleted on next save).
eq(
  'orphan: <img src width> HTML reference → kept',
  orphanAssetNames(['doc-pasted-image-abc.png'], '<img src="assets/doc-pasted-image-abc.png" alt="" width="800">'),
  [],
);
// Table-cell drop uses style="width:100%" — same raw-HTML path.
eq(
  'orphan: <img src style> (table cell) → kept',
  orphanAssetNames(['x-pasted-image-y.png'], '<img src="assets/x-pasted-image-y.png" alt="" style="width:100%">'),
  [],
);
// <a href> to a tracked file is a reference too.
eq(
  'orphan: <a href> HTML reference → kept',
  orphanAssetNames(['file.pdf'], '<a href="assets/file.pdf">doc</a>'),
  [],
);
// Linked image [![](inner)](outer): BOTH targets must be captured.
eq(
  'orphan: nested linked image captures inner + outer',
  orphanAssetNames(['inner.png', 'outer.png'], '[![a](assets/inner.png)](assets/outer.png)'),
  [],
);
// Reference-style definition [label]: target.
eq(
  'orphan: reference-style definition → kept',
  orphanAssetNames(['ref.png'], '[r]: assets/ref.png'),
  [],
);
// Dropped name with a literal, valid-hex %NN: on-disk name is NOT decoded, so
// it converges with the href (encodeLinkPath emitted %2520 → decodes to %20).
eq(
  'orphan: literal %20 in dropped name → kept (pool side not decoded)',
  orphanAssetNames(['report%20final.pdf'], '[x](assets/report%2520final.pdf)'),
  [],
);

// ---------------------------------------------------------------------------
// sanitizeDroppedFileName (US-17.6, M4) — client-controlled File.name must
// not be trusted as a filesystem path when saving a dropped file to assets/.
// ---------------------------------------------------------------------------
eq('dropFileName: tên bình thường giữ nguyên', sanitizeDroppedFileName('report.pdf'), 'report.pdf');
check(
  'dropFileName: path traversal bị trung hoà (không còn dấu / nào, không thể đi lên thư mục cha)',
  !sanitizeDroppedFileName('../../etc/passwd').includes('/')
);
check(
  'dropFileName: backslash (Windows-style) cũng bị trung hoà',
  !sanitizeDroppedFileName('..\\..\\secrets.txt').includes('\\')
);
eq('dropFileName: dấu chấm dẫn đầu (hidden file / thư mục hiện tại) bị bỏ', sanitizeDroppedFileName('.htaccess'), 'htaccess');
eq('dropFileName: rỗng sau khi làm sạch → fallback "file"', sanitizeDroppedFileName('...'), 'file');
eq('dropFileName: rỗng ngay từ đầu → fallback "file"', sanitizeDroppedFileName(''), 'file');

// X-9 — a 100+ char browser-supplied name crosses MAX_PATH under a long
// OneDrive root; the stem is capped, the extension preserved.
eq(
  'dropFileName[X-9]: stem dài bị cắt còn 60 ký tự, giữ nguyên đuôi',
  sanitizeDroppedFileName('a'.repeat(120) + '.pdf'),
  'a'.repeat(60) + '.pdf'
);
eq(
  'dropFileName[X-9]: tên ngắn không bị đụng vào',
  sanitizeDroppedFileName('short-report.pdf'),
  'short-report.pdf'
);
eq(
  'dropFileName[X-9]: không có đuôi → toàn bộ là stem, cắt còn 60',
  sanitizeDroppedFileName('b'.repeat(80)),
  'b'.repeat(60)
);
eq(
  'dropFileName[X-9]: dấu chấm ở đầu (đuôi giả) vẫn được cắt như stem',
  sanitizeDroppedFileName('c'.repeat(70) + '.tar.gz'),
  'c'.repeat(60) + '.gz'
);

// X-9 — path-length failures are recognized so a specific message can name
// MAX_PATH / LongPathsEnabled instead of a generic "Failed to save".
check('pathTooLong[X-9]: ENAMETOOLONG code', isPathTooLongError({ code: 'ENAMETOOLONG' }));
check('pathTooLong[X-9]: ERROR_PATH_NOT_FOUND code', isPathTooLongError({ code: 'ERROR_PATH_NOT_FOUND' }));
check('pathTooLong[X-9]: message text', isPathTooLongError(new Error('ENAMETOOLONG: name too long')));
check('pathTooLong[X-9]: lỗi thường không khớp', !isPathTooLongError({ code: 'EACCES' }));
check('pathTooLong[X-9]: null an toàn', !isPathTooLongError(null));

// ---------------------------------------------------------------------------
// classifyLink — allowlist scheme
// ---------------------------------------------------------------------------

eq('link: rỗng', classifyLink(''), { kind: 'empty' });
eq('link: http hợp lệ', classifyLink('http://example.com'), { kind: 'absolute', scheme: 'http', safe: true });
eq('link: https hợp lệ', classifyLink('https://example.com'), { kind: 'absolute', scheme: 'https', safe: true });
eq('link: mailto hợp lệ', classifyLink('mailto:a@b.com'), { kind: 'absolute', scheme: 'mailto', safe: true });
eq('link: HTTPS hoa vẫn an toàn (giữ scheme gốc)', classifyLink('HTTPS://x'), { kind: 'absolute', scheme: 'HTTPS', safe: true });
eq('link: command: bị chặn', classifyLink('command:foo'), { kind: 'absolute', scheme: 'command', safe: false });
eq('link: javascript: bị chặn', classifyLink('javascript:alert(1)'), { kind: 'absolute', scheme: 'javascript', safe: false });
eq('link: file: bị chặn', classifyLink('file:///etc/passwd'), { kind: 'absolute', scheme: 'file', safe: false });
eq('link: vscode: bị chặn', classifyLink('vscode://x'), { kind: 'absolute', scheme: 'vscode', safe: false });
eq('link: đường dẫn tương đối', classifyLink('./other.md#sec'), { kind: 'relative' });
eq('link: đường dẫn tuyệt đối trong workspace (không scheme)', classifyLink('/docs/a.md'), { kind: 'relative' });
// X-7: a Windows drive path is a local target, not the unsafe scheme `c:`.
eq('link: Windows drive path backslash → local (X-7)', classifyLink('C:\\docs\\x.md'), { kind: 'relative' });
eq('link: Windows drive path forward-slash → local (X-7)', classifyLink('c:/docs/x.md'), { kind: 'relative' });

// ---------------------------------------------------------------------------
// link-scheme predicates (src/shared/link-scheme.ts) — the ONE answer for X-7
// ---------------------------------------------------------------------------

eq('drivePath: C:\\ backslash', isWindowsDrivePath('C:\\docs\\x.md'), true);
eq('drivePath: c:/ forward slash', isWindowsDrivePath('c:/docs/x.md'), true);
eq('drivePath: http không phải drive', isWindowsDrivePath('http://x'), false);
eq('drivePath: bare c: (thiếu separator) không match', isWindowsDrivePath('c:foo'), false);
eq('drivePath: đường dẫn tương đối không phải drive', isWindowsDrivePath('./a.md'), false);
eq('scheme: http là scheme', hasUrlScheme('http://x'), true);
eq('scheme: mailto là scheme', hasUrlScheme('mailto:a@b'), true);
eq('scheme: drive path KHÔNG phải scheme (X-7)', hasUrlScheme('C:\\x.md'), false);
eq('scheme: đường dẫn tương đối KHÔNG phải scheme', hasUrlScheme('./a.md'), false);
eq('scheme: anchor thuần KHÔNG phải scheme', hasUrlScheme('#heading'), false);

// ---------------------------------------------------------------------------
// message contract (src/shared/messages.ts) — kiểm tra ở mức TYPE. Nếu hình
// dạng message đổi mà quên cập nhật, các gán dưới đây sẽ không biên dịch (tsc).
// ---------------------------------------------------------------------------

const fromWebview: WebviewToHost[] = [
  { type: 'ready' },
  { type: 'edit', text: 'x' },
  { type: 'openLink', href: 'https://x' },
  { type: 'searchFiles', query: 'q', requestId: 1 },
  { type: 'copyFileMention' },
  { type: 'viewSource' },
  { type: 'crossFileSearch:request', requestId: 1, query: 'q', scope: 'markdown', matchCase: false, wholeWord: true },
  { type: 'crossFileSearch:openResult', uri: 'file:///a.md', line: 0, character: 0, length: 1, matchText: 'x' },
  { type: 'crossFileSearch:openInSearchPanel', query: 'q', scope: 'allFiles' },
  { type: 'pasteImage', requestId: 1, mime: 'image/png', dataBase64: 'AA==' },
  { type: 'dropFile', requestId: 1, name: 'report.pdf', dataBase64: 'AA==' },
  { type: 'zenChanged', zen: true },
  { type: 'readingModeChanged', enabled: true, mode: 'sepia' },
];

const readabilityFixture = {
  enabled: false, mode: 'standard',
  fontFamily: '', zen: false,
} as const;
const triggerFixture: TriggerConfig = { dateFormat: 'YYYY-MM-DD', executeCommands: [], mode: 'advanced' };
const toWebview: HostToWebview[] = [
  { type: 'init', text: 'x', docUri: 'file:///a.md', config: {
    breaks: false, linkify: true, wordWrap: false, fontSize: 14,
    lineHeight: 1.6, fontFamily: 'sans', autoOpenToc: true, showLineNumbers: true, caseInsensitiveFs: false,
    crossFileSearchScope: 'markdown', readability: readabilityFixture, trigger: triggerFixture,
    plantumlEngineUri: 'vscode-resource://plantuml-engine.js', scriptNonce: 'n0nce',
  } },
  { type: 'init', text: 'x', docUri: 'file:///a.md', config: {
    breaks: false, linkify: true, wordWrap: false, fontSize: 14,
    lineHeight: 1.6, fontFamily: 'sans', autoOpenToc: true, showLineNumbers: true, caseInsensitiveFs: false,
    crossFileSearchScope: 'markdown', readability: readabilityFixture, trigger: triggerFixture,
    plantumlEngineUri: 'vscode-resource://plantuml-engine.js', scriptNonce: 'n0nce',
  }, reveal: { line: 0, character: 0, length: 1 } },
  { type: 'update', text: 'x' },
  { type: 'fileSearchResult', requestId: 1, files: [{ path: 'a.md', name: 'a.md', dir: '.' }] },
  { type: 'configUpdate', autoOpenToc: true, showLineNumbers: true, triggerMode: 'advanced' },
  { type: 'crossFileSearch:result', requestId: 1, groups: [], truncated: false, usedFallback: false },
  { type: 'scrollToPosition', line: 0, character: 0, length: 1 },
  { type: 'pasteImageResult', requestId: 1, relativePath: 'images/a.png' },
  { type: 'dropFileResult', requestId: 1, relativePath: 'assets/report.pdf' },
  { type: 'zenChanged', zen: true },
  { type: 'readingModeChanged', enabled: true, mode: 'sepia' },
];
check('contract: WebviewToHost phủ đủ 13 biến thể', fromWebview.length === 13);
check('contract: HostToWebview phủ đủ 11 biến thể (init có/không reveal + scrollToPosition + pasteImage + dropFile + zenChanged + readingModeChanged)', toWebview.length === 11);

// ---------------------------------------------------------------------------
// findTextMatches (src/shared/text-match.ts) — lõi so khớp THUẦN dùng chung cho
// Ctrl+F/Feature B (webview) và host provider. Case tiếng Việt có dấu là lý do
// cấm \b/\w (chỉ nhận [A-Za-z0-9_]).
// ---------------------------------------------------------------------------

const OPT = (matchCase: boolean, wholeWord: boolean): MatchOptions => ({ matchCase, wholeWord });

// Substring, case-insensitive mặc định (matchCase:false) — query lệch hoa/thường vẫn khớp.
eq(
  'match: substring case-insensitive mặc định',
  findTextMatches('Hello WORLD hello', 'hello', OPT(false, false)),
  [{ start: 0, end: 5 }, { start: 12, end: 17 }]
);

// matchCase:true — chỉ khớp đúng hoa/thường; occurrence lệch case KHÔNG khớp.
eq(
  'match: matchCase phân biệt hoa/thường',
  findTextMatches('Editor editor EDITOR', 'editor', OPT(true, false)),
  [{ start: 7, end: 13 }]
);

// wholeWord:true — query đứng như từ trọn vẹn khớp; nằm trong từ lớn hơn thì KHÔNG.
eq(
  'match: wholeWord chỉ khớp từ trọn vẹn',
  findTextMatches('MarkdownEditor and Editor', 'Editor', OPT(false, true)),
  [{ start: 19, end: 25 }]
);

// wholeWord:false — cùng query DO khớp cả bên trong từ lớn hơn.
eq(
  'match: wholeWord tắt vẫn khớp bên trong từ lớn',
  findTextMatches('MarkdownEditor and Editor', 'Editor', OPT(false, false)),
  [{ start: 8, end: 14 }, { start: 19, end: 25 }]
);

// Ranh giới từ tiếng Việt có dấu — ĐÂY LÀ LÝ DO CẤM \b/\w. Query "ường" là
// substring của cả "đường" (đứng trước là 'đ') lẫn "trường" (đứng trước là 'r').
// 'đ' và 'r' đều là CHỮ CÁI ⇒ với ranh giới Unicode-aware, "ường" KHÔNG phải từ
// trọn vẹn ở đâu cả ⇒ wholeWord trả về RỖNG. (\b/\w naive sẽ SAI: coi 'đ' là
// ký tự non-word nên tưởng có ranh giới trước "ường" trong "đường".)
eq(
  'match: wholeWord — "đ" là ký tự từ nên "ường" không khớp (chống \\b sai)',
  findTextMatches('đường trường', 'ường', OPT(false, true)),
  []
);
// Đối chứng: wholeWord:false thì cả hai lần xuất hiện đều khớp.
eq(
  'match: substring bắt cả "ường" trong "đường" lẫn "trường"',
  findTextMatches('đường trường', 'ường', OPT(false, false)),
  [{ start: 1, end: 5 }, { start: 8, end: 12 }]
);
// "trường" như một từ trọn vẹn (giữa 2 khoảng trắng) vẫn khớp dù có dấu.
eq(
  'match: wholeWord khớp "trường" trọn vẹn (có dấu)',
  findTextMatches('đi trên trường', 'trường', OPT(false, true)),
  [{ start: 8, end: 14 }]
);
// "đường" đứng riêng (đầu chuỗi) khớp wholeWord — chứng minh nhánh find-được.
eq(
  'match: wholeWord khớp "đường" đứng riêng',
  findTextMatches('đường trường', 'đường', OPT(false, true)),
  [{ start: 0, end: 5 }]
);

// Ranh giới = mép chuỗi (không phải ký tự) — từ đầu và từ cuối vẫn khớp wholeWord.
eq(
  'match: wholeWord ở đầu chuỗi',
  findTextMatches('cat and dog', 'cat', OPT(false, true)),
  [{ start: 0, end: 3 }]
);
eq(
  'match: wholeWord ở cuối chuỗi',
  findTextMatches('a lazy dog', 'dog', OPT(false, true)),
  [{ start: 7, end: 10 }]
);

// Không chồng lấn + tôn trọng cap maxMatches.
eq(
  'match: không chồng lấn, cap maxMatches',
  findTextMatches('aaaa', 'aa', OPT(false, false), 5),
  [{ start: 0, end: 2 }, { start: 2, end: 4 }]
);
eq(
  'match: cap maxMatches cắt đúng số lượng',
  findTextMatches('x x x x', 'x', OPT(false, false), 2),
  [{ start: 0, end: 1 }, { start: 2, end: 3 }]
);

// Query rỗng ⇒ không match; wholeWord với ký tự "_" coi là ký tự từ.
eq('match: query rỗng ⇒ rỗng', findTextMatches('abc', '', OPT(false, true)), []);
eq(
  'match: "_" là ký tự từ nên foo_bar không khớp wholeWord "foo"',
  findTextMatches('foo_bar foo', 'foo', OPT(false, true)),
  [{ start: 8, end: 11 }]
);

// ---------------------------------------------------------------------------
// detectBlockStyle (US-18.4a heading axis + US-18.4b remaining axes) — detect a
// block's original syntax variant from its mdSlice. `style()` fills the all-null
// default so each case states only the axes it cares about.
// ---------------------------------------------------------------------------

function style(over: Partial<StyleOverride>): StyleOverride {
  return {
    heading: null,
    headingUnderlineLength: null,
    bullet: null,
    code: null,
    em: null,
    strong: null,
    hr: null,
    tableSeparator: null,
    ...over,
  };
}

// Heading: Setext (underline) vs ATX (#). H1 '=', H2 '-'. Underline length kept.
eq('style: Setext H1 → setext, keep length', detectBlockStyle('Title\n=====', 'heading'), style({ heading: 'setext', headingUnderlineLength: 5 }));
eq('style: Setext H2 → setext, keep length', detectBlockStyle('Title\n---', 'heading'), style({ heading: 'setext', headingUnderlineLength: 3 }));
eq('style: ATX H1 → atx', detectBlockStyle('# Title', 'heading'), style({ heading: 'atx' }));
eq('style: ATX H2 → atx', detectBlockStyle('## Title', 'heading'), style({ heading: 'atx' }));
// ATX text containing '=' or '-' must NOT be misread as Setext (single-line slice).
eq('style: ATX text with "=" → atx', detectBlockStyle('# Title = Draft', 'heading'), style({ heading: 'atx' }));
eq('style: ATX text with "-" → atx', detectBlockStyle('## Section - notes', 'heading'), style({ heading: 'atx' }));
// Heading axis not applicable to a non-heading block → null.
eq('style: paragraph → heading null', detectBlockStyle('just a paragraph', 'paragraph'), style({}));
eq('style: canonical hr block → all axes null', detectBlockStyle('---', 'hr'), style({}));

// Bullet axis: single variant, mixed markers (first wins), ordered-only → null,
// inapplicable block type → null (no crash).
eq('style: "+" list → bullet "+"', detectBlockStyle('+ one\n+ two', 'list').bullet, '+');
eq('style: "-" list → bullet "-"', detectBlockStyle('- one', 'list').bullet, '-');
eq('style: "*" list → bullet "*" (default, unstamped later)', detectBlockStyle('* one', 'list').bullet, '*');
eq('style: mixed markers → first-encountered wins', detectBlockStyle('- a\n  * b\n  + c', 'list').bullet, '-');
eq('style: purely ordered list → bullet null', detectBlockStyle('1. a\n2. b', 'list').bullet, null);
eq('style: bullet detector on heading → null', detectBlockStyle('# Title', 'heading').bullet, null);

// Code axis: single check on the first non-blank line.
eq('style: 4-space code → indented', detectBlockStyle('    line1\n    line2', 'code').code, 'indented');
eq('style: tab code → indented-tab (tabs kept on re-emit)', detectBlockStyle('\tline1', 'code').code, 'indented-tab');
eq('style: ~~~ fence → fence-tilde', detectBlockStyle('~~~js\ncode\n~~~', 'code').code, 'fence-tilde');
eq('style: backtick fence → default (null)', detectBlockStyle('```js\ncode\n```', 'code').code, null);
eq('style: code detector on paragraph → null', detectBlockStyle('    not code type', 'paragraph').code, null);

// Em/strong axes: `_`/`__` win only when encountered before `*`/`**`; backtick
// code spans are stripped before scanning; intraword `_` never counts.
eq('style: "_em_" → em "_"', detectBlockStyle('has _em_ here', 'paragraph').em, '_');
eq('style: "*em*" → em default (null)', detectBlockStyle('has *em* here', 'paragraph').em, null);
eq('style: "*a*" before "_b_" → first wins (null)', detectBlockStyle('*a* then _b_', 'paragraph').em, null);
eq('style: "__strong__" → strong "__"', detectBlockStyle('has __strong__ here', 'paragraph').strong, '__');
eq('style: "**strong**" → strong default (null)', detectBlockStyle('has **strong**', 'paragraph').strong, null);
eq('style: "_" inside code span ignored', detectBlockStyle('`_x_` only code', 'paragraph').em, null);
eq('style: intraword "_" (snake_case) ignored', detectBlockStyle('snake_case_name', 'paragraph').em, null);
eq('style: em detector on code block → null', detectBlockStyle('_not_ emphasis', 'code').em, null);

// HR axis: raw line kept verbatim (incl. legal leading indent); `---` → null.
eq('style: "***" hr → raw line kept', detectBlockStyle('***', 'hr').hr, '***');
eq('style: "___" hr → raw line kept', detectBlockStyle('___', 'hr').hr, '___');
eq('style: "- - -" hr → raw line kept', detectBlockStyle('- - -', 'hr').hr, '- - -');
eq('style: "  ***" hr → leading indent kept', detectBlockStyle('  ***', 'hr').hr, '  ***');
eq('style: hr detector on paragraph → null', detectBlockStyle('***', 'paragraph').hr, null);

// Detection hardening (US-18.4b review round): container blocks, false
// delimiter evidence, triple-delimiter runs.
eq('style: blockquoted "-" list → bullet "-"', detectBlockStyle('> - quoted\n> - more', 'blockquote').bullet, '-');
eq('style: blockquote without list → bullet null', detectBlockStyle('> plain quote', 'blockquote').bullet, null);
eq(
  'style: "- " inside fenced diff not marker evidence',
  detectBlockStyle('1. step\n\n   ```diff\n   - removed\n   ```\n\n   * sub', 'list').bullet,
  '*'
);
eq('style: "___x___" → em "_" (triple run opens em+strong)', detectBlockStyle('a ___x___ b', 'paragraph').em, '_');
eq('style: "___x___" → strong "__"', detectBlockStyle('a ___x___ b', 'paragraph').strong, '__');
eq('style: "***x***" before "_y_" → em default (null)', detectBlockStyle('***x*** then _y_', 'paragraph').em, null);
eq('style: literal "2*4" not star evidence → em "_"', detectBlockStyle('Buy 2*4 lumber and _nails_.', 'paragraph').em, '_');
eq('style: "_" in link URL not em evidence', detectBlockStyle('[doc](https://ex.com/_v2_) and *note*', 'paragraph').em, null);
eq('style: intraword "_" after non-ASCII letter ignored', detectBlockStyle('chữ_ký here and *em*', 'paragraph').em, null);
eq('style: escaped backslash before "_" → em "_"', detectBlockStyle('C:\\\\_dir_ here', 'paragraph').em, '_');
eq('style: backtick-run span strips fully → em null', detectBlockStyle('Use ``x `_foo` y`` here', 'paragraph').em, null);

// ---------------------------------------------------------------------------
// reading-stats (US-10.7) — word count (CJK char = 1 word), read-time
// estimate (200 WPM, 0 words → 0 min), hardcoded thousands separator.
// ---------------------------------------------------------------------------

eq('countWords: mixed non-CJK + CJK → 2 words + 5 chars = 7', countWords('Hello world こんにちは'), 7);
// Supplementary-plane Han (CJK Extension B, U+20000) is still one word each,
// not collapsed into a single run — a plain BMP-only regex would miss these.
eq('countWords: supplementary-plane Han counts per character', countWords(String.fromCodePoint(0x20000, 0x20001, 0x20002)), 3);
eq('estimateReadMinutes: 0 words → 0 min', estimateReadMinutes(0), 0);
eq('estimateReadMinutes: 7 words → 1 min (floor never shown for real content)', estimateReadMinutes(7), 1);
eq('formatCount: hardcoded comma, not toLocaleString', formatCount(1860), '1,860');

// ---------------------------------------------------------------------------
// Security tripwires (src/provider.ts) — khoá các bất biến từ security review
// 2026-07-17 (xem Plan/Optimization Notes.md § Security hardening). Đọc source
// dạng text vì provider.ts import 'vscode', không mock được trong test này.
// ---------------------------------------------------------------------------

const providerSrc = fs.readFileSync(path.join(process.cwd(), 'src/provider.ts'), 'utf8');

// CSP lock — mọi nới lỏng directive phải sửa test này một cách CÓ CHỦ ĐÍCH,
// không thể vô tình lọt qua.
// US-2.8: script-src thêm 'wasm-unsafe-eval' CÓ CHỦ ĐÍCH — engine PlantUML
// client-side (Viz.js = Graphviz qua Emscripten) cần biên dịch WebAssembly. Pin
// nguyên chuỗi đầy đủ chứ không chỉ phần 'nonce-...': includes() khớp chuỗi con,
// nên nếu chỉ pin phần nonce thì mọi lần nới lỏng thêm sau này đều lọt qua.
const REQUIRED_CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'nonce-${nonce}' 'wasm-unsafe-eval'",
  "base-uri ${webview.cspSource}",
  "form-action 'none'",
  "frame-src 'none'",
];
for (const directive of REQUIRED_CSP_DIRECTIVES) {
  check(`security: CSP giữ directive "${directive}"`, providerSrc.includes(directive));
}
// 'wasm-unsafe-eval' chỉ cho phép biên dịch WASM. 'unsafe-eval' (bật eval()/
// new Function() cho JS) là chuyện khác hẳn và phải luôn vắng mặt — regex loại
// trừ đúng token 'wasm-unsafe-eval' để không tự khớp nhầm phần đuôi của nó.
check(
  'security: script-src KHÔNG có "unsafe-eval" (chỉ wasm-unsafe-eval mới được phép)',
  !/script-src[^\n]*(?<!wasm-)'unsafe-eval'/.test(providerSrc)
);
check(
  'security: img-src KHÔNG có "https:" (chặn ảnh remote/exfil qua .md độc hại)',
  /img-src[^\n]*data:/.test(providerSrc) && !/img-src[^\n]*https:/.test(providerSrc)
);
check(
  'security: script-src KHÔNG có "unsafe-inline" (chặn inline script tiêm từ .md)',
  !/script-src[^\n]*unsafe-inline/.test(providerSrc)
);

// Security hardening (Plan/Optimization Notes.md § Security hardening) — S-1/S-2
// đã fix: message boundary webview→host phải whitelist/gate trước khi dùng giá
// trị. Scan trực tiếp source provider.ts để bám sát fix thật.
const readingModeCaseBody =
  providerSrc.match(/case 'readingModeChanged': \{([\s\S]*?)\n        \}/)?.[1] ?? '';
check(
  'security S-1: readingModeChanged whitelist mode trước khi lưu',
  /READING_MODES/.test(readingModeCaseBody) && /msg\.mode/.test(readingModeCaseBody)
);

// Anchor vào ĐỊNH NGHĨA method (không phải chỗ gọi cùng tên đứng trước nó).
const openResultBody = providerSrc.match(/private async openCrossFileSearchResult\([\s\S]*?\n  \}/)?.[0] ?? '';
check(
  'security S-2: crossFileSearch:openResult gate qua isInsideAllowedRoots trước khi mở',
  /isInsideAllowedRoots/.test(openResultBody)
);

// Bug 1 (2026-07-18): file kéo-thả (không phải ảnh) giờ được orphan-cleanup như
// ảnh dán — saveDroppedFile phải theo dõi file, cleanupOrphanImages phải gộp tập
// theo dõi, và restore qua undo phải re-track. Scan source (host-fs, không có
// harness vscode) — cùng kiểu guard như S-1/S-2.
const saveDroppedBody = providerSrc.match(/private async saveDroppedFile\([\s\S]*?\n  \}/)?.[0] ?? '';
check('bug1: saveDroppedFile theo dõi asset để dọn khi mồ côi', /trackDroppedAsset/.test(saveDroppedBody));
const cleanupBody = providerSrc.match(/private async cleanupOrphanImages\([\s\S]*?\n  \}/)?.[0] ?? '';
check('bug1: cleanupOrphanImages gộp file kéo-thả đã theo dõi', /droppedAssetsByDoc/.test(cleanupBody));
const restoreBody = providerSrc.match(/private async restoreUndoneImageDeletions\([\s\S]*?\n  \}/)?.[0] ?? '';
check('bug1: undo khôi phục file kéo-thả re-track để dọn tiếp', /trackDroppedAsset/.test(restoreBody));

// headingSiblingGaps (bug_General #2 follow-up): same-level/same-parent heading move scope.
// Pure outline math on level arrays (null = non-heading block) — mirrors the I/O matrix cases.
{
  // #H1 / ##A + content / ##B  →  A(idx1) siblings = {A@1, B@3}; scope end = doc end.
  const g = headingSiblingGaps([1, 2, null, 2], 1);
  check('sibling: H2 siblings under one H1', JSON.stringify(g.siblingStarts) === '[1,3]', JSON.stringify(g));
  check('sibling: scope end = doc end (no closing heading)', g.scopeEndGap === 4);
  check('sibling: first sibling has no Move Up', g.moveUpGap === null);
  check('sibling: Move Down past next sibling → scope end', g.moveDownGap === 4);
}
{
  // Move the second sibling B up over A: [#H1, ##A, ##B] moving B(idx2).
  const g = headingSiblingGaps([1, 2, 2], 2);
  check('sibling: last sibling Move Up = previous sibling start', g.moveUpGap === 1);
  check('sibling: last sibling has no Move Down', g.moveDownGap === null);
}
{
  // Only child: #H1 / ##A  → A(idx1) has no sibling to swap with (immovable within scope).
  const g = headingSiblingGaps([1, 2], 1);
  check('sibling: only child has just itself', JSON.stringify(g.siblingStarts) === '[1]');
  check('sibling: only child cannot Move Up/Down', g.moveUpGap === null && g.moveDownGap === null);
}
{
  // Top-level H1s (parent = root): #A / #B / #C → all reorder among each other, scope = whole doc.
  const g = headingSiblingGaps([1, 1, 1], 1);
  check('sibling: top-level H1s are all siblings', JSON.stringify(g.siblingStarts) === '[0,1,2]');
  check('sibling: top-level scope = whole doc', g.scopeEndGap === 3);
  check('sibling: middle H1 Move Up=0, Move Down=3', g.moveUpGap === 0 && g.moveDownGap === 3);
}
{
  // Different parents: #H1a / ##x / #H1b / ##y  → ##x(idx1) parent = H1a; ##y is NOT its sibling.
  const g = headingSiblingGaps([1, 2, 1, 2], 1);
  check('sibling: different-parent H2 excluded (scope ends at next H1)', JSON.stringify(g.siblingStarts) === '[1]' && g.scopeEndGap === 2, JSON.stringify(g));
}
{
  // Nested levels: #H1 / ##A / ###a1 / ##B  → A(idx1) siblings under H1 = {A@1, B@3}; a1 is A's child.
  const g = headingSiblingGaps([1, 2, 3, 2], 1);
  check('sibling: nested child (###) is not a sibling of its parent (##)', JSON.stringify(g.siblingStarts) === '[1,3]', JSON.stringify(g));
  check('sibling: A Move Down past its own [A, a1] section → scope end', g.moveDownGap === 4);
}

{
  // Malformed outline: #H1 / ###X / ##Y  → X(idx1, H3) has NO same-level sibling. Its scope must
  // END at the following H2 (level 2 < 3), so it can't be dragged below the H2 and nest under it.
  const g = headingSiblingGaps([1, 3, 2], 1);
  check('sibling: H3 scope stops at a following shallower H2 (no nest-under)', g.scopeEndGap === 2, JSON.stringify(g));
  check('sibling: lone H3 among different levels is immovable', JSON.stringify(g.siblingStarts) === '[1]' && g.moveUpGap === null && g.moveDownGap === null);
}
{
  // Skipped-level, two siblings: #H1 / ###A / ###B / ##C  → A,B are H3 siblings under H1; the
  // trailing H2 (level 2 < 3) must bound the scope so Move Down keeps them BEFORE the H2, never
  // nesting into it (blind review F1 repro B).
  const g = headingSiblingGaps([1, 3, 3, 2], 1);
  check('sibling: skipped-level scope ends at trailing shallower heading', g.scopeEndGap === 3, JSON.stringify(g));
  check('sibling: first of two H3 siblings Move Down stays before the H2', g.moveDownGap === 3);
}
{
  // Doc starting shallower-then-deeper reversed: ##A / #B  → A(idx0, H2) at root has no sibling and
  // must not be draggable below the H1 (would nest under it). scope ends at the H1 (level 1 < 2).
  const g = headingSiblingGaps([2, 1], 0);
  check('sibling: top H2 before an H1 is immovable (scope ends at the H1)', g.scopeEndGap === 1 && JSON.stringify(g.siblingStarts) === '[0]' && g.moveDownGap === null, JSON.stringify(g));
}

// ---------------------------------------------------------------------------
// EntityIndex (Req 21 US-21.2) — host-side workspace entity index. Pure module
// (no 'vscode' import) so it bundles into this node harness like text-utils.
// ---------------------------------------------------------------------------

// caption:: parse — namespace = leading letters, id = remainder.
{
  const rows: IndexedEntity[] = parseEntities('file:///a.md', '## Login flow\n\ncaption::UC01\n');
  eq('entity: caption parses namespace/id/title', rows, [
    { namespace: 'UC', id: '01', file: 'file:///a.md', line: 2, title: 'Login flow', preview: '', label: '' },
  ]);
}

// entityFollowingPreview (Req 21 hover tooltip) — shared truncation rule.
{
  eq('preview: short following text passes through trimmed', entityFollowingPreview(' Submit Leave Request'), 'Submit Leave Request');
  eq('preview: empty when nothing follows', entityFollowingPreview(''), '');
  eq('preview: whitespace-only follows -> empty', entityFollowingPreview('   '), '');
  eq('preview: over 20 chars is capped with an ellipsis', entityFollowingPreview(' A very long description here'), 'A very long descript…');
  eq('preview: stops at a colon (no ellipsis on a delimiter cut)', entityFollowingPreview(' Login: then more'), 'Login');
  eq('preview: stops at a semicolon', entityFollowingPreview(' Login; then more'), 'Login');
  eq('preview: stops at a backtick (inline code / command)', entityFollowingPreview(' run `cmd` now'), 'run');
  eq('preview: stops at a newline', entityFollowingPreview(' first line\nsecond'), 'first line');
  // Code-point-safe cap: an emoji straddling the 20th unit is not split into a broken half.
  eq('preview: caps on code points, not UTF-16 units', entityFollowingPreview('1234567890123456789😀X'), '1234567890123456789😀…');
}

// entityFollowingLabel (Req 21 mention display) — same delimiter rule as the
// preview but UNCAPPED (the entity's full human name), so a long label is kept.
{
  eq('label: passes the full following text through trimmed', entityFollowingLabel(' Submit Leave Request'), 'Submit Leave Request');
  eq('label: NOT capped at 20 chars (unlike the preview)', entityFollowingLabel(' A very long description here'), 'A very long description here');
  eq('label: empty when nothing follows', entityFollowingLabel('   '), '');
  eq('label: stops at the same break delimiters', entityFollowingLabel(' Login: then more'), 'Login');
}

// parseEntities preview alignment: inline code BEFORE the caption must not shift
// the following-text slice (stripInlineCode is length-preserving).
{
  const rows = parseEntities('file:///pv2.md', 'See `foo()` caption::UC01 The login flow\n');
  eq('entity: preview correct when inline code precedes the caption', rows.map((r) => `${r.namespace}${r.id}=${r.preview}`), ['UC01=The login flow']);
}

// parseEntities carries the following-text preview per declaration.
{
  const rows = parseEntities('file:///pv.md', 'caption::UC01 Submit Leave Request\ncaption::BR05\n');
  eq('entity: preview = text following the token', rows.map((r) => r.preview), ['Submit Leave Request', '']);
  eq('entity: label = full following text (uncapped) per declaration', rows.map((r) => r.label), ['Submit Leave Request', '']);
}

// id match (both full id and partial) + title match — proves id-OR-title query.
{
  const idx = new EntityIndex();
  idx.build([{ uri: 'file:///a.md', text: '## Login flow\n\ncaption::UC01\n' }]);
  check('entity: query by full id UC01', idx.query('UC01').length === 1);
  check('entity: query by partial id 01', idx.query('01').length === 1);
  check('entity: query by title token "login"', idx.query('login').length === 1);
  check('entity: query by full title "Login flow"', idx.query('Login flow').length === 1);
  check('entity: non-matching query returns nothing', idx.query('zzz').length === 0);
  const q = idx.query('UC01')[0];
  check('entity: namespace parsed as UC, id 01', q.namespace === 'UC' && q.id === '01');
}

// Bug C1 — a short token must not match mid-word inside a title. Typing `UC`
// used to return `BR05`/`NAMESPACE_ID` because their titles contain "strUCtured".
{
  const idx = new EntityIndex();
  idx.build([
    { uri: 'file:///a.md', text: '# Login flow\ncaption::UC01\n' },
    { uri: 'file:///b.md', text: '# Structured Entity Reference System\ncaption::BR05\n' },
    { uri: 'file:///c.md', text: '# 21 Structured Entity Reference\ncaption::NAMESPACE_ID\n' },
  ]);
  const uc = idx.query('UC');
  check('entity: query "UC" excludes mid-word title hits (BR05/NAMESPACE_ID)', uc.length === 1 && uc[0].namespace === 'UC');
  check('entity: title word-start search still matches ("structured")', idx.query('structured').length === 2);
}

// Empty/malformed declarations are refused (US-21.1 empty-id).
{
  const rows = parseEntities('file:///m.md', 'caption::\ncaption::UC02\ncaption::123\n');
  eq('entity: empty id + no-namespace declarations skipped', rows.map((r) => r.namespace + r.id), ['UC02']);
}

// Trailing punctuation the `\S+` capture absorbed from prose/markdown is stripped.
{
  const rows = parseEntities('file:///p.md', 'caption::UC01`,\ncaption::BR05).\ncaption::UC02\n');
  eq('entity: trailing punctuation stripped from parsed token', rows.map((r) => r.namespace + r.id), ['UC01', 'BR05', 'UC02']);
}

// nearestEnclosingHeading — nesting, fence-immunity, above-any-heading.
{
  const lines = '# Top\n\n## Mid\n\ncaption::UC01\n\n### Deep\ncaption::UC02\n'.split('\n');
  eq('entity: nearest heading picks the immediately-enclosing ## Mid', nearestEnclosingHeading(lines, 4), 'Mid');
  eq('entity: nearest heading updates to ### Deep further down', nearestEnclosingHeading(lines, 7), 'Deep');
}
{
  const lines = '# Real\n\n```\n# NotAHeading\n```\ncaption::UC01\n'.split('\n');
  eq('entity: a "#"-looking line inside a fence is not a heading', nearestEnclosingHeading(lines, 5), 'Real');
}
{
  const lines = 'caption::UC01\n\n# Later\n'.split('\n');
  eq('entity: caption above any heading -> empty title', nearestEnclosingHeading(lines, 0), '');
}

// caption inside a fence is not indexed.
{
  const rows = parseEntities('file:///f.md', '# H\n\n```\ncaption::UC99\n```\ncaption::UC01\n');
  eq('entity: caption inside a fence is skipped', rows.map((r) => r.id), ['01']);
}

// Bug D2 — a caption:: written inside an inline code span (backticks) is
// documentation/example syntax, not a live declaration, so it is NOT indexed
// (matches the webview's CODE-ancestor skip; PO 2026-07-22). Reproduces the
// Requirement 21 file's `declare inline (`caption::UC01`)` examples.
{
  const rows = parseEntities('file:///d2.md', 'declare a named entity inline (`caption::UC01`) here\n');
  eq('entity D2: caption inside inline code span is not indexed', rows.map((r) => r.namespace + r.id), []);
}
{
  const rows = parseEntities('file:///d2.md', 'code `caption::UC01` but plain caption::RE02 counts\n');
  eq('entity D2: only the plain caption on a mixed line is indexed', rows.map((r) => r.namespace + r.id), ['RE02']);
}
{
  const rows = parseEntities('file:///d2.md', 'caption::UC01\n');
  eq('entity D2: a plain (non-backticked) declaration is still indexed', rows.map((r) => r.namespace + r.id), ['UC01']);
}
{
  // A lone backtick that never closes is not a code span — the token survives.
  const rows = parseEntities('file:///d2.md', 'caption::UC01`, and more\n');
  eq('entity D2: unmatched backtick is literal, token still indexed', rows.map((r) => r.namespace + r.id), ['UC01']);
}

// Incremental update — onFileChanged replaces just that file's rows.
{
  const idx = new EntityIndex();
  idx.build([{ uri: 'file:///a.md', text: '# H\ncaption::UC01\n' }]);
  check('entity: initial row present', idx.query('UC01').length === 1);
  idx.onFileChanged('file:///a.md', '# H\ncaption::UC02\n');
  check('entity: old row gone after incremental update', idx.query('UC01').length === 0);
  check('entity: new row present after incremental update', idx.query('UC02').length === 1);
  idx.onFileChanged('file:///a.md', ''); // deleted / emptied file drops its rows.
  check('entity: emptied file drops all its rows', idx.query('UC02').length === 0);
}

// Indexing state — isReady() false before build, true after.
{
  const idx = new EntityIndex();
  check('entity: fresh index is not ready (indexing state)', idx.isReady() === false);
  idx.build([]);
  check('entity: index is ready after build', idx.isReady() === true);
}

// namespaces() — count-desc sort + case-insensitive fold to first-seen casing.
{
  const idx = new EntityIndex();
  idx.build([
    { uri: 'file:///a.md', text: 'caption::UC01\ncaption::UC02\ncaption::BR01\n' },
    { uri: 'file:///b.md', text: 'caption::uc03\n' }, // case variant of UC.
  ]);
  const ns = idx.namespaces();
  eq('entity: namespaces fold case-insensitively, sort by count desc', ns, [
    { name: 'UC', count: 3 },
    { name: 'BR', count: 1 },
  ]);
}

// namespace filter narrows case-insensitively.
{
  const idx = new EntityIndex();
  idx.build([{ uri: 'file:///a.md', text: 'caption::UC01\ncaption::BR01\n' }]);
  check('entity: namespace filter narrows (case-insensitive)', idx.query('', { namespace: 'uc' }).length === 1);
  check('entity: empty query returns all when no namespace filter', idx.query('').length === 2);
}

// lookup() — EXACT id resolver for broken-reference existence (Req 21 US-21.3).
{
  const idx = new EntityIndex();
  idx.build([{ uri: 'file:///a.md', text: 'caption::UC01\ncaption::BR02\n' }]);
  check('entity: lookup exact id hits', idx.lookup('UC01').length === 1);
  check('entity: lookup namespace is case-insensitive', idx.lookup('uc01').length === 1);
  check('entity: lookup id is case-sensitive / exact (no fuzzy)', idx.lookup('UC0').length === 0);
  check('entity: lookup empty id half returns none', idx.lookup('UC').length === 0);
  check('entity: lookup unknown id returns none', idx.lookup('XX99').length === 0);
}

// canonicalEntityId — ns folded to lower, id kept; invalid tokens rejected.
{
  eq('occurrence: canonical folds ns to lower', canonicalEntityId('UC01'), 'uc01');
  check('occurrence: canonical rejects all-letters (empty id)', canonicalEntityId('readme') === null);
  check('occurrence: canonical rejects no-letter-prefix', canonicalEntityId('01') === null);
}

// scanEntityOccurrences — reference links only, fence-aware, canonical ids.
{
  const occ = scanEntityOccurrences('See [UC01](#UC01) and [again](other.md#uc01).\n\n[x](https://a.com)\n');
  eq('occurrence: entity-ref links found (canonical), non-entity links skipped', occ, [
    { id: 'uc01', line: 0 },
    { id: 'uc01', line: 0 },
  ]);
  const fenced = scanEntityOccurrences('```\n[UC01](#UC01)\n```\n[BR02](#BR02)\n');
  eq('occurrence: links inside a fence are skipped', fenced, [{ id: 'br02', line: 3 }]);
}

// X-5: a non-ASCII namespace can reach the host percent-encoded (markdown-it /
// turndown persist it that way) and in either Unicode form — the host must
// decode+NFC before NAMESPACE_RE, on both the occurrence and the lookup paths.
{
  const canon = 'Yêu01'.normalize('NFC').toLowerCase();
  // canonicalEntityId decodes a percent-encoded fragment before parsing the ns
  // (raw `Y%C3%Aau01` would otherwise let NAMESPACE_RE match only the leading `Y`).
  eq('occurrence x5: canonical decodes percent-encoded non-ASCII ns', canonicalEntityId('Y%C3%Aau01'), canon);
  // Scan-key (from raw .md) and query key (from the webview id) both go through
  // canonicalEntityId, so a percent-encoded link is found under the same key.
  eq('occurrence x5: percent-encoded non-ASCII link found', scanEntityOccurrences('See [Yêu01](#Y%C3%Aau01) here.\n'), [
    { id: canon, line: 0 },
  ]);

  const idx = new EntityIndex();
  idx.build([{ uri: 'file:///a.md', text: 'caption::Yêu01\n' }]);
  check('entity x5: lookup resolves a percent-encoded non-ASCII query', idx.lookup('Y%C3%Aau01').length === 1);
  // An NFD-form mention query resolves against the NFC-authored declaration
  // (decodeEntityFragment folds the query to NFC). An NFD-authored *declaration*
  // is out of scope — parseEntities mis-splits it at the combining mark; deferred.
  check('entity x5: lookup resolves an NFD query against an NFC declaration', idx.lookup('Yêu01'.normalize('NFD')).length === 1);
}

// truncateDisplay — Bug 11: cap @ result label/detail at 30 chars + ellipsis.
{
  check('truncate: short text unchanged', truncateDisplay('BR02') === 'BR02');
  check('truncate: exactly 20 chars unchanged', truncateDisplay('a'.repeat(20)) === 'a'.repeat(20));
  eq('truncate: >30 chars → 30 chars + ellipsis', truncateDisplay('Requirement: 21. Structured Entity Reference System'), 'Requirement: 21. Structured En…');
  check('truncate: result length is 30 + ellipsis', truncateDisplay('b'.repeat(50)) === 'b'.repeat(30) + '…');
  check('truncate: empty string unchanged', truncateDisplay('') === '');
  check('truncate: does not split a surrogate pair at the boundary', truncateDisplay('😀'.repeat(40)) === '😀'.repeat(30) + '…');
}

// ---------------------------------------------------------------------------
// Bug #3 — echo-suppression cho applyEditBreakingCoalesce. provider.ts import
// 'vscode' nên không nạp được ở đây; MÔ PHỎNG đúng quyết định echo của
// changeSubscription + case 'edit' (giống model applyEdit ở đầu file). Nhánh
// nghịch đảo áp HAI applyEdit → hai sự kiện đổi; sự kiện TRUNG GIAN mới là thứ
// rò filter-text nếu không có guard breakingEditInProgress.
// ---------------------------------------------------------------------------
{
  // Bám sát applyEditBreakingCoalesce (src/provider.ts): phát sự kiện đổi cho
  // trạng thái GIỮA rồi trạng thái CUỐI, đúng cấu trúc nhánh của hàm thật.
  function emitBreakingChanges(before: string, after: string, onChange: (t: string) => void): void {
    const diff = computeMinimalEdit(before, after);
    if (!diff) {
      return;
    }
    const { start, oldEnd, newText: ins } = diff;
    if (ins === '' && oldEnd - start >= 2) {
      const mid = start + Math.floor((oldEnd - start) / 2);
      onChange(before.slice(0, mid) + before.slice(oldEnd)); // xoá nửa sau (giữa)
      onChange(after); // xoá nửa đầu (cuối)
      return;
    }
    if (ins !== '' && oldEnd > start) {
      onChange(before.slice(0, start) + before.slice(oldEnd)); // đã xoá, chưa chèn (giữa)
      onChange(after);
      return;
    }
    onChange(after); // chèn thuần / xoá 1 ký tự: một sự kiện
  }

  function makeHost(withGuard: boolean) {
    let lastTextFromWebview: string | undefined;
    let prevEditBeforeText: string | undefined;
    let breakingEditInProgress = false;
    let doc = '';
    let updatesPosted = 0;

    // changeSubscription: chỉ phần quyết định echo (bỏ nhánh undo/redo).
    function onChange(newText: string): void {
      doc = newText;
      if (withGuard && breakingEditInProgress) {
        return; // Bug #3 guard
      }
      if (newText === lastTextFromWebview) {
        return; // echo của chính webview (khớp text cuối)
      }
      lastTextFromWebview = undefined;
      updatesPosted++; // lên lịch 'update' debounce → echo về webview
    }

    // case 'edit'.
    function edit(text: string): void {
      const beforeThis = doc;
      const isInverseOfPrev =
        prevEditBeforeText !== undefined && text === prevEditBeforeText && text !== beforeThis;
      lastTextFromWebview = text;
      if (isInverseOfPrev) {
        breakingEditInProgress = true;
        try {
          emitBreakingChanges(beforeThis, text, onChange);
        } finally {
          breakingEditInProgress = false;
        }
      } else {
        onChange(text); // applyMinimalEdit: một sự kiện
      }
      prevEditBeforeText = beforeThis;
    }

    return { edit, external: onChange, get updates() { return updatesPosted; } };
  }

  // Kịch bản rò (Bug #3): sau "foo" gõ "/De" rồi commit trigger xoá "/De" về
  // "foo". prevEditBeforeText là doc-state TRƯỚC edit liền trước, nên phải seed
  // "foo" bằng một edit rồi mới gõ "/De" — khi đó commit về "foo" mới là nghịch
  // đảo chính xác của edit trước → chạy nhánh breaking (HAI applyEdit).
  function runScenario(withGuard: boolean): number {
    const h = makeHost(withGuard);
    h.edit('foo'); // seed
    h.edit('foo/De'); // gõ trigger + filter (edit thường)
    h.edit('foo'); // commit delete-only (inverse-of-prev → breaking)
    return h.updates;
  }
  check('bug3: commit nghịch đảo KHÔNG post update khi có guard', runScenario(true) === 0);
  // Reproduce-first: bỏ guard → ít nhất một 'update' thừa bị lên lịch (sự kiện
  // trung gian ≠ text cuối vượt echo-check rồi clear lastTextFromWebview). Số
  // đếm chính xác tuỳ debounce gộp — bất biến then chốt là >0 so với 0 khi có guard.
  check('bug3: KHÔNG guard → có update thừa bị lên lịch (reproduce)', runScenario(false) > 0);

  // Edit ngoài thật (git/format...) vẫn phải post update.
  const ext = makeHost(true);
  ext.external('bar'); // thay đổi không do webview
  check('bug3: edit ngoài thật vẫn post update (không over-suppress)', ext.updates === 1);
}

console.log(`\n${pass} pass, ${fail} fail`);
if (failures.length) {
  console.log('\n' + failures.join('\n\n'));
  process.exit(1);
}
