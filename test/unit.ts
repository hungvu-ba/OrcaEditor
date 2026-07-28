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
import { isWindowsDrivePath, isWindowsUncPath, hasUrlScheme } from '../src/shared/link-scheme';
import type { HostToWebview, TriggerConfig, WebviewToHost } from '../src/shared/messages';
import { EntityIndex, parseEntities, nearestEnclosingHeading, type IndexedEntity } from '../src/entity-index';
import { canonicalEntityId, scanEntityOccurrences } from '../src/occurrence-scan';
import { findTextMatches, type MatchOptions } from '../src/shared/text-match';
import { detectBlockStyle, type StyleOverride } from '../media/webview/block-style';
import { truncateDisplay } from '../media/webview/trigger-popup';
import { headingSiblingGaps } from '../media/webview/drag-drop';
import { buildGroups } from '../media/webview/comment-gutter';
import { orphanKindLabel } from '../media/webview/comment-panel';
import type { ThreadAnchor } from '../media/webview/comment-resolve';
import {
  anchorUpdateRejection,
  authorNamePromptRejection,
  commentThreadLine,
  copyConfirmationMessage,
  createCommentRejection,
  deleteRejection,
  editRejection,
  nextAuthoritativePanel,
  replyRejection,
  resolveCommentAuthor,
  commentThreadContextValue,
  statusChangeRejection,
  STATUS_CHANGE_TARGET,
  type AnchorUpdateMessage,
  type CreateCommentMessage,
  type DeleteCommentMessage,
  type EditCommentMessage,
  type ReplyMessage,
  type StatusChangeMessage,
} from '../src/comments/comment-utils';
import {
  buildSnippetLine,
  copyDisabledReason,
  escapeMarkdownInline,
  formatExportTimestamp,
  renderCommentsMarkdown,
  type ExportSnapshot,
  type ExportThread,
} from '../media/webview/comment-copy-markdown';
import {
  buildAnchorUpdateLine,
  buildCommentLine,
  buildDeleteLine,
  buildEditLine,
  buildReplyLine,
  buildStatusChangeLine,
  foldSidecarRecords,
  isSidecarName,
  mdNameForSidecar,
  sidecarBelongsToDocument,
  parseSidecarText,
  serializeSidecarLine,
  sameAuthor,
  sidecarBackupNameFor,
  sidecarNameFor,
  sidecarNameMatches,
  type AnchorUpdateLine,
  type CommentLine,
  type CommentStatus,
  type DeleteLine,
  type EditLine,
  type SidecarThread,
  type ReplyLine,
  type StatusChangeLine,
} from '../src/comments/sidecar-format';
import { sidecarShareWarning } from '../src/comments/sidecar-git';
import {
  clipCommentBodyToLimit,
  commentBodyCodePointLength,
  neutralizeCommentBody,
  normalizeCommentBodyEol,
  COMMENT_BODY_COUNTER_THRESHOLD,
  COMMENT_BODY_MAX_CODEPOINTS,
} from '../src/comments/comment-body-limit';
import {
  anchorTextRetention,
  anchorThresholdFor,
  driftBandFor,
  levenshtein,
  normalizeAnchorText,
  pickAnchorCandidate,
  rankReattachTargets,
  similarity,
  type AnchorCandidate,
} from '../media/webview/comment-anchor';
import { countWords, estimateReadMinutes, formatCount } from '../media/webview/reading-stats';
import { neutralizeBodyText, normalizeBodyEol } from '../media/webview/dom-utils';
import {
  collectClassConstants,
  exportedConstants,
  findAmbiguousConstants,
  readTransientClassIdentifiers,
  scanStampedClasses,
  OUTSIDE_CONTENT_CLASSES,
  UNRESOLVED_STAMP_EXEMPTIONS,
  type SourceFile,
  type StampSite,
} from './transient-class-scan';

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

// X-21: default (caseInsensitive) lowercases as before; on a case-sensitive FS
// case is preserved so `Report` and `report` no longer alias to one prefix.
eq('prefix X-21: mặc định caseInsensitive → lowercase như cũ', imageNamePrefix('Report'), 'report');
eq('prefix X-21: caseInsensitive=true tường minh → lowercase', imageNamePrefix('Report', true), 'report');
eq('prefix X-21: case-sensitive → giữ hoa', imageNamePrefix('Report', false), 'Report');
check('prefix X-21: case-sensitive không alias Report vs report',
  imageNamePrefix('Report', false) !== imageNamePrefix('report', false));
eq('prefix X-21: case-sensitive vẫn bỏ dấu (đ/Đ→d/D, giữ hoa)',
  imageNamePrefix('Đăng Ký', false), 'Dang-Ky');
// normalizeForSearch output must stay byte-identical after the core extraction.
eq('normalizeForSearch: bất biến sau tách core (hoa+dấu)', normalizeForSearch('Đăng Ký Sự Kiện'), 'dang-ky-su-kien');
eq('normalizeForSearch: bất biến (ký tự đặc biệt)', normalizeForSearch('A_B[1]*C'), 'a-b-1-c');

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
// X-7 follow-up: the REAL runtime href — markdown-it encodes `\`→`%5C`, so the
// click/marker path classifies `C:%5C…`, which must still be local, not scheme c:.
eq('link: drive path %5C-encoded (markdown-it href) → local (X-7)', classifyLink('C:%5Cdocs%5Cx.md'), { kind: 'relative' });
eq('link: drive path %2F-encoded → local (X-7)', classifyLink('C:%2Fdocs%2Fx.md'), { kind: 'relative' });

// ---------------------------------------------------------------------------
// link-scheme predicates (src/shared/link-scheme.ts) — the ONE answer for X-7
// ---------------------------------------------------------------------------

eq('drivePath: C:\\ backslash', isWindowsDrivePath('C:\\docs\\x.md'), true);
eq('drivePath: c:/ forward slash', isWindowsDrivePath('c:/docs/x.md'), true);
eq('drivePath: %5C-encoded backslash (markdown-it href) match (X-7)', isWindowsDrivePath('C:%5Cdocs%5Cx.md'), true);
eq('drivePath: %2F-encoded forward slash match (X-7)', isWindowsDrivePath('c:%2Fdocs%2Fx.md'), true);
eq('drivePath: http không phải drive', isWindowsDrivePath('http://x'), false);
eq('drivePath: bare c: (thiếu separator) không match', isWindowsDrivePath('c:foo'), false);
eq('drivePath: đường dẫn tương đối không phải drive', isWindowsDrivePath('./a.md'), false);
eq('scheme: http là scheme', hasUrlScheme('http://x'), true);
eq('scheme: mailto là scheme', hasUrlScheme('mailto:a@b'), true);
eq('scheme: drive path KHÔNG phải scheme (X-7)', hasUrlScheme('C:\\x.md'), false);
eq('scheme: %5C-encoded drive path KHÔNG phải scheme (X-7)', hasUrlScheme('C:%5Cx.md'), false);
eq('scheme: đường dẫn tương đối KHÔNG phải scheme', hasUrlScheme('./a.md'), false);
eq('scheme: anchor thuần KHÔNG phải scheme', hasUrlScheme('#heading'), false);

// X-7 (root cause B): UNC network path `\\server\share\…` is a local absolute
// target, not a URL scheme and not workspace-relative. Both 1 AND 2 leading
// backslashes must match — CommonMark's backslash-escape rule collapses a
// hand-typed `\\server\...` (2 raw chars) down to 1 backslash in the parsed
// href, so requiring exactly 2 here would never classify a naturally-authored
// UNC link as UNC (see render.ts's normalizeLink override + turndown.ts's
// linkHrefBackslashEscape rule, which together keep the doubled form stable
// across round-trips when the DOM genuinely holds 2 backslashes).
eq('unc: \\\\server\\share (2 backslash, doubled-in-DOM case) match', isWindowsUncPath('\\\\server\\share\\x.md'), true);
eq('unc: \\server\\x.md (1 backslash, hand-typed-then-CommonMark-collapsed case) match', isWindowsUncPath('\\server\\x.md'), true);
eq('unc: forward-slash //server KHÔNG phải UNC (protocol-relative URL)', isWindowsUncPath('//server/share/x.md'), false);
eq('unc: drive path không phải UNC', isWindowsUncPath('C:\\x.md'), false);
eq('unc: đường dẫn tương đối không phải UNC', isWindowsUncPath('./a.md'), false);
eq('scheme: UNC KHÔNG phải scheme', hasUrlScheme('\\\\server\\share\\x.md'), false);

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
    crossFileSearchScope: 'markdown', tableFitMode: false, readability: readabilityFixture, trigger: triggerFixture,
    plantumlEngineUri: 'vscode-resource://plantuml-engine.js', scriptNonce: 'n0nce',
    commentAuthorName: 'hungvu', docRelativePath: 'a.md', commentHighlightOn: false,
  } },
  { type: 'init', text: 'x', docUri: 'file:///a.md', config: {
    breaks: false, linkify: true, wordWrap: false, fontSize: 14,
    lineHeight: 1.6, fontFamily: 'sans', autoOpenToc: true, showLineNumbers: true, caseInsensitiveFs: false,
    crossFileSearchScope: 'markdown', tableFitMode: false, readability: readabilityFixture, trigger: triggerFixture,
    plantumlEngineUri: 'vscode-resource://plantuml-engine.js', scriptNonce: 'n0nce',
    commentAuthorName: 'hungvu', docRelativePath: 'a.md', commentHighlightOn: false,
  }, reveal: { line: 0, character: 0, length: 1 } },
  { type: 'update', text: 'x' },
  { type: 'fileSearchResult', requestId: 1, files: [{ path: 'a.md', name: 'a.md', dir: '.' }] },
  { type: 'configUpdate', autoOpenToc: true, showLineNumbers: true, triggerMode: 'advanced', commentAuthorName: 'hungvu' },
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

// P2 — search haystacks are rebuilt on incremental update: a diacritic-stripped
// query must match a Vietnamese-diacritic title introduced via onFileChanged.
{
  const idx = new EntityIndex();
  idx.build([{ uri: 'file:///a.md', text: '# H\ncaption::UC01\n' }]);
  idx.onFileChanged('file:///a.md', '# UC-02 Đăng nhập hệ thống\ncaption::UC-02 Đăng nhập hệ thống\n');
  const hits = idx.query('dang-nhap');
  check('entity P2: diacritic-stripped query matches title after incremental re-parse', hits.length === 1 && hits[0].id === '-02');
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
  // (decodeEntityFragment folds the query to NFC).
  check('entity x5: lookup resolves an NFD query against an NFC declaration', idx.lookup('Yêu01'.normalize('NFD')).length === 1);

  // X-5 (deferred follow-up): an NFD-authored DECLARATION now parses correctly —
  // parseEntities NFCs the token before NAMESPACE_RE, so `caption::Yêu01` written
  // in NFD recomposes to namespace `Yêu`, id `01` instead of splitting at the
  // combining mark (namespace `Ye`). Both NFC and NFD queries then resolve it.
  {
    const nfdDecl = new EntityIndex();
    nfdDecl.build([{ uri: 'file:///nfd.md', text: `caption::${'Yêu01'.normalize('NFD')}\n` }]);
    const rows = nfdDecl.lookup('Yêu01');
    check('entity x5: NFD declaration parses namespace whole (NFC query resolves)', rows.length === 1);
    check('entity x5: NFD declaration namespace recomposed to "Yêu"', rows[0]?.namespace === 'Yêu' && rows[0]?.id === '01');
    check('entity x5: NFD declaration resolves an NFD query too', nfdDecl.lookup('Yêu01'.normalize('NFD')).length === 1);
  }
  // A parseEntities-level check on the stored row shape (namespace not split at
  // the combining mark).
  {
    const rows = parseEntities('file:///nfd2.md', `caption::${'Đăng01'.normalize('NFD')} label\n`);
    eq('entity x5: NFD declaration stored namespace is NFC-whole', rows.map((r) => r.namespace + r.id), ['Đăng01']);
  }
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

// --- Req 23 US-23.1: comment author + createComment payload validation --------
{
  const msg = (over: Partial<CreateCommentMessage> = {}): CreateCommentMessage => ({
    type: 'createComment',
    requestId: 1,
    docUri: 'file:///a.md',
    threadId: 'thread-1',
    anchorId: 'comment-anchor-1',
    offsetStart: 0,
    offsetEnd: 5,
    line: 3,
    body: 'Why this wording?',
    recordedText: 'AC-2 — The held queue drains in enqueue order.',
    nearestHeading: 'Acceptance criteria',
    ...over,
  });

  check('comment author: setting wins over the OS username', resolveCommentAuthor('reviewer', 'osuser') === 'reviewer');
  check('comment author: unset setting falls back to the OS username', resolveCommentAuthor(undefined, 'osuser') === 'osuser');
  check('comment author: whitespace-only setting is treated as unset', resolveCommentAuthor('   ', 'osuser') === 'osuser');

  check('createComment: a well-formed request is accepted', createCommentRejection(msg(), 'file:///a.md') === null);
  check(
    'createComment: a message for another document is refused (tab switch)',
    createCommentRejection(msg(), 'file:///b.md') !== null
  );
  check('createComment: an empty body never creates a thread', createCommentRejection(msg({ body: '' }), 'file:///a.md') !== null);
  check(
    'createComment: a whitespace-only body never creates a thread',
    createCommentRejection(msg({ body: ' \n\t ' }), 'file:///a.md') !== null
  );
  check('createComment: a missing anchor id is refused', createCommentRejection(msg({ anchorId: '' }), 'file:///a.md') !== null);
  check(
    'createComment: a reversed offset pair is refused',
    createCommentRejection(msg({ offsetStart: 9, offsetEnd: 2 }), 'file:///a.md') !== null
  );
  check(
    'createComment: a negative offset is refused',
    createCommentRejection(msg({ offsetStart: -1 }), 'file:///a.md') !== null
  );
  check('createComment: a thread with no id is refused (it could never be addressed again)',
    createCommentRejection(msg({ threadId: '' }), 'file:///a.md') !== null);
  check('createComment: a collapsed caret anchor is accepted', createCommentRejection(msg({ offsetStart: 4, offsetEnd: 4 }), 'file:///a.md') === null);

  // 1-based webview line -> 0-based vscode.Range line; 0 means "maps to no source line".
  check('comment thread line: 1-based source line becomes 0-based', commentThreadLine(3) === 2);
  check('comment thread line: an unmapped anchor lands on line 0', commentThreadLine(0) === 0);
}

// --- Req 23 US-23.10 AC4: author-prompt name validation ----------------------
{
  check('author prompt: a plain name is accepted', authorNamePromptRejection('Alice') === null);
  check('author prompt: leading/trailing whitespace is trimmed before validating',
    authorNamePromptRejection('  Alice  ') === null);
  check('author prompt: empty-after-trim is rejected', authorNamePromptRejection('   ') !== null);
  check('author prompt: empty string is rejected', authorNamePromptRejection('') !== null);
  check('author prompt: NFD and NFC forms both validate the same way',
    (authorNamePromptRejection('Nhật'.normalize('NFD')) === null) === (authorNamePromptRejection('Nhật'.normalize('NFC')) === null));
  check('author prompt: a newline is rejected', authorNamePromptRejection('Alice\nBob') !== null);
  check('author prompt: a control character (NUL) is rejected', authorNamePromptRejection(`Alice${String.fromCharCode(0)}`) !== null);
  check('author prompt: exactly 100 characters is accepted', authorNamePromptRejection('a'.repeat(100)) === null);
  check('author prompt: 101 characters is rejected', authorNamePromptRejection('a'.repeat(101)) !== null);
}

// --- Req 23 US-23.10 AC7: sidecar refusalFor's three-reason completeness ----
// sidecar-store.ts imports 'vscode' so it cannot be loaded here — MODELED
// against its own `outsideRootRejection` (untitled -> non-file scheme ->
// outside-allowed-root via the injected guard), same convention as the Bug #3
// echo-suppression model above.
{
  interface FakeDoc {
    isUntitled: boolean;
    scheme: string;
  }
  // Synchronous model: the real `outsideRootRejection` awaits the injected
  // `guard`, but nothing here depends on that being genuinely asynchronous —
  // `insideAllowedRoots` stands in for its already-resolved answer.
  function modelRefusalFor(doc: FakeDoc, insideAllowedRoots: boolean): string | null {
    if (doc.isUntitled) {
      return 'Save the file first to comment on it.';
    }
    if (doc.scheme !== 'file') {
      return 'Comments need a file on disk; this document is on a virtual filesystem.';
    }
    if (!insideAllowedRoots) {
      return 'The comment sidecar would be written outside the allowed workspace.';
    }
    return null;
  }

  const saved = { isUntitled: false, scheme: 'file' };
  check('refusalFor: untitled is refused', modelRefusalFor({ isUntitled: true, scheme: 'file' }, true) !== null);
  check('refusalFor: a non-file scheme is refused', modelRefusalFor({ isUntitled: false, scheme: 'untitled' }, true) !== null);
  check('refusalFor: outside the allowed workspace roots is refused (US-23.10 AC7 — the third, previously-missing case)',
    modelRefusalFor(saved, false) !== null);
  check('refusalFor: a saved, file-scheme, in-root document is accepted', modelRefusalFor(saved, true) === null);
  // The three reasons must be distinct — a caller wiring the specific reason
  // into the UI (AC7) needs to tell them apart, not just "refused".
  const untitled = modelRefusalFor({ isUntitled: true, scheme: 'file' }, true);
  const nonFile = modelRefusalFor({ isUntitled: false, scheme: 'untitled' }, true);
  const outsideRoot = modelRefusalFor(saved, false);
  check('refusalFor: the three reasons are pairwise distinct',
    untitled !== nonFile && nonFile !== outsideRoot && untitled !== outsideRoot);
}

// --- Req 23 US-23.20 AC2/AC8: unconditional-newline append, backup naming ---
// sidecar-store.ts imports 'vscode' so `append`/`planRename` aren't reachable
// here — but the AC8 helper (`sidecarBackupNameFor`) lives in sidecar-format.ts
// with no vscode import, so it's real-unit-tested, not modeled. AC2's payload
// composition is now trivial (no more endsWithNewline branch to model either).
{
  const anchor = {
    offset_start: 0,
    offset_end: 5,
    recorded_text: 'AC-2 — the newline',
    last_known_line: 1,
    nearest_heading: '',
  };
  const line = buildCommentLine({
    id: 'c1',
    author: 'reviewer',
    timestamp: '2026-07-27T21:11:40.000Z',
    body: 'why?',
    anchor,
  });
  const payload = '\n' + serializeSidecarLine(line);
  check('append payload (AC2): always starts with a newline, regardless of any prior tail state',
    payload.startsWith('\n'));
  check('append payload (AC2): still ends with the line’s own terminating newline from serializeSidecarLine',
    payload.endsWith('\n') && payload.slice(1, -1) === JSON.stringify(line));

  check('sidecarBackupNameFor: appends the stamp and .bak suffix beside the sidecar name',
    sidecarBackupNameFor('foo.md.orca-comments.jsonl', '2026-07-27T21-11-40-000Z')
      === 'foo.md.orca-comments.jsonl.2026-07-27T21-11-40-000Z.bak');
  check('sidecarBackupNameFor: the stamp is carried through unchanged (caller derives a filesystem-safe one)',
    sidecarBackupNameFor('x', '2026-07-27T21-11-40-000Z').includes('2026-07-27T21-11-40-000Z'));
  check('sidecarBackupNameFor: always ends with .bak',
    sidecarBackupNameFor('foo.md.orca-comments.jsonl', 'stamp').endsWith('.bak'));
}

// --- Req 24 US-23.19: save-first gate — refusalFor -> isDirty -> save() -----
// commentController.ts's real `saveBeforeAppend` imports 'vscode' so it isn't
// reachable here — MODELED as a synchronous shadow of its control flow, same
// convention as `modelRefusalFor` above (nothing here depends on genuine
// asynchrony; `saveSucceeds`/`insideAllowedRoots` stand in for already-resolved
// answers). `log` records which steps actually ran, so a test can assert what
// did NOT happen (no save on a clean document, no save on a refused document).
{
  interface FakeDirtyDoc {
    isUntitled: boolean;
    scheme: string;
    isDirty: boolean;
  }

  function modelSaveBeforeAppend(
    doc: FakeDirtyDoc,
    insideAllowedRoots: boolean,
    saveSucceeds: boolean,
    log: string[]
  ): string | null {
    log.push('refusalFor');
    if (doc.isUntitled) {
      return 'Save the file first to comment on it.';
    }
    if (doc.scheme !== 'file') {
      return 'Comments need a file on disk; this document is on a virtual filesystem.';
    }
    if (!insideAllowedRoots) {
      return 'The comment sidecar would be written outside the allowed workspace.';
    }
    if (doc.isDirty) {
      log.push('save');
      if (!saveSucceeds) {
        return 'Could not save the file before recording the comment.';
      }
    }
    return null;
  }

  const clean = { isUntitled: false, scheme: 'file', isDirty: false };
  const dirty = { isUntitled: false, scheme: 'file', isDirty: true };

  const cleanLog: string[] = [];
  check('save-first gate (AC3): a clean document never calls save',
    modelSaveBeforeAppend(clean, true, true, cleanLog) === null && !cleanLog.includes('save'));

  const dirtySavedLog: string[] = [];
  check('save-first gate (AC1): a dirty document is saved, in order, before the append would run',
    modelSaveBeforeAppend(dirty, true, true, dirtySavedLog) === null && dirtySavedLog.join(',') === 'refusalFor,save');

  const dirtyFailedLog: string[] = [];
  check('save-first gate (AC2): a failed save is reported and the caller never reaches append',
    modelSaveBeforeAppend(dirty, true, false, dirtyFailedLog) === 'Could not save the file before recording the comment.');

  const untitledLog: string[] = [];
  check('save-first gate (AC5): untitled is refused by the existing refusalFor check before isDirty/save ever run',
    modelSaveBeforeAppend({ isUntitled: true, scheme: 'file', isDirty: true }, true, true, untitledLog)
      === 'Save the file first to comment on it.' && !untitledLog.includes('save'));
}

// --- Req 23 US-23.10 AC9: body neutralization + EOL reconciliation ----------
{
  check('neutralizeBodyText: plain text is unchanged', neutralizeBodyText('Why this wording?') === 'Why this wording?');
  check('neutralizeBodyText: a newline is kept (multi-line body)', neutralizeBodyText('line one\nline two') === 'line one\nline two');
  check('neutralizeBodyText: a tab is kept', neutralizeBodyText('a\tb') === 'a\tb');
  check('neutralizeBodyText: a right-to-left override (RLO) is stripped',
    neutralizeBodyText(`safe${String.fromCharCode(0x202e)}evil`) === 'safeevil');
  check('neutralizeBodyText: every bidi override/isolate control char is stripped',
    neutralizeBodyText([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((c) => String.fromCharCode(c)).join('x')) === 'xxxxxxxx');
  check('neutralizeBodyText: a NUL byte is stripped', neutralizeBodyText(`a${String.fromCharCode(0)}b`) === 'ab');
  check('neutralizeBodyText: DEL is stripped', neutralizeBodyText(`a${String.fromCharCode(0x7f)}b`) === 'ab');

  check('normalizeBodyEol: CRLF becomes LF', normalizeBodyEol('line one\r\nline two') === 'line one\nline two');
  check('normalizeBodyEol: a lone CR becomes LF', normalizeBodyEol('line one\rline two') === 'line one\nline two');
  check('normalizeBodyEol: LF-only text is unchanged', normalizeBodyEol('line one\nline two') === 'line one\nline two');
}

// --- Req 23 US-23.4: tier-2 anchor matching + anchor-update validation -------
{
  const candidate = (text: string, line: number, heading = '', depth = 1): AnchorCandidate => ({
    text,
    line,
    heading,
    depth,
  });

  check('anchor text: whitespace runs collapse so a re-wrapped paragraph still matches',
    normalizeAnchorText('The held  queue\n  drains') === 'The held queue drains');
  check('anchor text: normalization is NFC', normalizeAnchorText('Nhật'.normalize('NFD')) === 'Nhật'.normalize('NFC'));
  check('levenshtein: identical strings cost nothing', levenshtein('queue', 'queue') === 0);
  check('levenshtein: one substitution costs one', levenshtein('Done', 'Dome') === 1);
  check('similarity: a line-break reflow scores a perfect match',
    similarity('The held queue drains', 'The held\nqueue   drains') === 1);
  check('similarity: NFC and NFD forms of the same prose score a perfect match',
    similarity('Nhật ký'.normalize('NFC'), 'Nhật ký'.normalize('NFD')) === 1);

  check('threshold: ordinary text uses 0.8', anchorThresholdFor('AC-2 — the held queue drains') === 0.8);
  check('threshold: text under 15 chars uses 0.95', anchorThresholdFor('Done') === 0.95);

  const recorded = 'AC-2 — The held queue drains in enqueue order.';
  const hit = pickAnchorCandidate(
    recorded,
    [candidate('AC-1 — Refund requests are held for replay.', 11), candidate('AC-2 — The held queue\ndrains in enqueue order.', 12)],
    { lastKnownLine: 12, nearestHeading: '' }
  );
  check('tier 2: the reflowed original wins', hit?.index === 1 && hit.score === 1);

  check('tier 2: a short recorded text does not settle for a near miss',
    pickAnchorCandidate('Done', [candidate('Dome', 4)], { lastKnownLine: 4, nearestHeading: '' }) === null);
  check('tier 2: a short recorded text still matches itself',
    pickAnchorCandidate('Done', [candidate('Done', 9)], { lastKnownLine: 4, nearestHeading: '' })?.index === 0);
  check('tier 2: nothing above the threshold is a miss, not a best guess',
    pickAnchorCandidate('The held queue drains in enqueue order',
      [candidate('Totally unrelated sentence about refunds', 3)], { lastKnownLine: 3, nearestHeading: '' }) === null);
  check('tier 2: an empty recorded text never matches',
    pickAnchorCandidate('   ', [candidate('anything', 1)], { lastKnownLine: 1, nearestHeading: '' }) === null);

  // Two structurally identical bullets in different sections — the score alone
  // cannot separate them, so the recorded context has to.
  const twins = [candidate('Each entry records a reason code.', 8, 'Refunds'), candidate('Each entry records a reason code.', 40, 'Payouts')];
  check('tier 2 tie-break: the recorded heading picks the right twin',
    pickAnchorCandidate('Each entry records a reason code.', twins, { lastKnownLine: 41, nearestHeading: 'Refunds' })?.index === 0);
  check('tier 2 tie-break: with no heading to go on, the nearest line wins',
    pickAnchorCandidate('Each entry records a reason code.', twins, { lastKnownLine: 39, nearestHeading: '' })?.index === 1);
  check('tier 2 tie-break: still ambiguous means fall through to tier 3, not a guess',
    pickAnchorCandidate('Each entry records a reason code.',
      [candidate('Each entry records a reason code.', 8), candidate('Each entry records a reason code.', 8)],
      { lastKnownLine: 0, nearestHeading: '' }) === null);

  // A blockquote and its only paragraph read identically and report the same
  // line — depth is the only thing left that can separate them.
  const nested = [candidate('Quoted claim.', 3, '', 1), candidate('Quoted claim.', 3, '', 2)];
  check('tier 2 tie-break: the innermost of two identical nested nodes wins',
    pickAnchorCandidate('Quoted claim.', nested, { lastKnownLine: 3, nearestHeading: '' })?.index === 1);
  check('tier 2 tie-break: the heading comparison is normalized, not raw',
    pickAnchorCandidate(
      'Each entry records a reason code.',
      [candidate('Each entry records a reason code.', 8, 'Nhật ký'.normalize('NFD')),
       candidate('Each entry records a reason code.', 40, 'Payouts')],
      { lastKnownLine: 41, nearestHeading: 'Nhật ký'.normalize('NFC') }
    )?.index === 0);
  // A candidate whose length alone puts it out of reach, and does not contain
  // the recorded text at all, is rejected without running the O(n*m) distance.
  check('tier 2: a candidate too different in length AND unrelated in content is skipped',
    pickAnchorCandidate('The held queue drains in enqueue order.',
      [candidate('Something else entirely, padded out with unrelated words. ' + 'x'.repeat(60), 3)],
      { lastKnownLine: 3, nearestHeading: '' }) === null);
  // Req 24 US-23.13 AC4: a merge (Backspace joining two paragraphs) grows a
  // node's text around what was already there — the recorded snapshot still
  // survives verbatim, so this now matches even though the length ratio alone
  // would fail the usual threshold. Revises the pre-US-23.13 expectation above
  // (a same-shaped padded candidate) since that shape is exactly what a merge
  // produces.
  check('tier 2 / US-23.13 AC4: a merged (grown) node still matches when the recorded text survives as a verbatim substring',
    pickAnchorCandidate('The held queue drains in enqueue order.',
      [candidate('The held queue drains in enqueue order. Another paragraph joined onto it.', 3)],
      { lastKnownLine: 3, nearestHeading: '' })?.score === 1);
  // US-23.13 AC4 review finding: the containment shortcut must not bypass the
  // short-text threshold — a short recorded string turning up as a substring
  // of some UNRELATED, longer block elsewhere in the document (not a merge of
  // that block with the comment's own paragraph) must still be rejected, the
  // same as before this AC existed.
  check('tier 2 / US-23.13 AC4: a short recorded text appearing inside an unrelated longer block is still rejected, not containment-matched',
    pickAnchorCandidate('Done.',
      [candidate('Something unrelated. Done. Something else unrelated still.', 9)],
      { lastKnownLine: 9, nearestHeading: '' }) === null);

  const update = (over: Partial<AnchorUpdateMessage> = {}): AnchorUpdateMessage => ({
    type: 'commentAnchorUpdate',
    docUri: 'file:///a.md',
    threadId: 'thread-1',
    anchorId: 'comment-anchor-1',
    line: 12,
    state: 'approximate',
    offsetStart: 0,
    offsetEnd: 0,
    recordedText: '',
    nearestHeading: '',
    ...over,
  });
  check('anchorUpdate: a well-formed update is accepted', anchorUpdateRejection(update(), 'file:///a.md') === null);
  check('anchorUpdate: an update for another document is refused',
    anchorUpdateRejection(update(), 'file:///b.md') !== null);
  check('anchorUpdate: an update naming no thread is refused',
    anchorUpdateRejection(update({ threadId: '' }), 'file:///a.md') !== null);
  // 0 is the "maps to no source line" value createComment already accepts, so
  // refusing it here would leave whole-document anchors unable to relocate.
  check('anchorUpdate: line 0 (an unmapped anchor) is accepted',
    anchorUpdateRejection(update({ line: 0 }), 'file:///a.md') === null);
  check('anchorUpdate: a negative line is refused',
    anchorUpdateRejection(update({ line: -1 }), 'file:///a.md') !== null);
  check('anchorUpdate: an unknown resolution state is refused',
    anchorUpdateRejection(update({ state: 'resolved' as AnchorUpdateMessage['state'] }), 'file:///a.md') !== null);
}

// --- Req 23 US-23.2: reply/delete validation + sidecar line shapes ----------
{
  const reply = (over: Partial<ReplyMessage> = {}): ReplyMessage => ({
    type: 'replyToComment',
    requestId: 1,
    docUri: 'file:///a.md',
    threadId: 'thread-1',
    body: 'Fixed, please re-check.',
    ...over,
  });
  check('reply: a well-formed reply to an Open thread is accepted',
    replyRejection(reply(), 'file:///a.md', 'Open') === null);
  check('reply: a reply to a Resolved thread is still accepted',
    replyRejection(reply(), 'file:///a.md', 'Resolved') === null);
  // AC: "Replying is blocked while the thread is Closed".
  check('reply: a reply to a Closed thread is refused',
    replyRejection(reply(), 'file:///a.md', 'Closed') !== null);
  check('reply: an empty body is refused',
    replyRejection(reply({ body: '' }), 'file:///a.md', 'Open') !== null);
  check('reply: a whitespace-only body is refused',
    replyRejection(reply({ body: '   \n\t ' }), 'file:///a.md', 'Open') !== null);
  check('reply: a reply for another document is refused',
    replyRejection(reply(), 'file:///b.md', 'Open') !== null);
  check('reply: a reply naming no thread is refused',
    replyRejection(reply({ threadId: '' }), 'file:///a.md', 'Open') !== null);
  check('reply: a reply to an unknown thread is refused',
    replyRejection(reply(), 'file:///a.md', undefined) !== null);

  const del = (over: Partial<DeleteCommentMessage> = {}): DeleteCommentMessage => ({
    type: 'deleteComment',
    requestId: 1,
    docUri: 'file:///a.md',
    threadId: 'thread-1',
    ...over,
  });
  check('delete: the content author may delete their own content',
    deleteRejection(del(), 'file:///a.md', { author: 'hungvu' }, 'hungvu') === null);
  // The soft, non-authenticated nudge — not a security boundary (US-23.3 AC6).
  check('delete: another author is refused',
    deleteRejection(del(), 'file:///a.md', { author: 'someone-else' }, 'hungvu') !== null);
  // The same name typed on macOS (NFD) and Windows (NFC) is one person — the
  // two literals below are genuinely different strings before normalization.
  check('delete: the NFD and NFC author names are genuinely different strings',
    'Nguyễn'.normalize('NFD') !== 'Nguyễn'.normalize('NFC'));
  check('delete: author matching is NFC-normalized',
    deleteRejection(del(), 'file:///a.md', { author: 'Nguyễn'.normalize('NFD') }, 'Nguyễn'.normalize('NFC')) === null);
  check('delete: a vanished target is refused',
    deleteRejection(del(), 'file:///a.md', undefined, 'hungvu') !== null);
  check('delete: a delete for another document is refused',
    deleteRejection(del(), 'file:///b.md', { author: 'hungvu' }, 'hungvu') !== null);
  check('delete: a delete naming no thread is refused',
    deleteRejection(del({ threadId: '' }), 'file:///a.md', { author: 'hungvu' }, 'hungvu') !== null);

  // The field sets are frozen by the requirement's "Sidecar Schema Decision"
  // section — a drift here is a data-format break, not a cosmetic one.
  const replyLine = buildReplyLine({
    id: 'e8a2f4d1',
    parentCommentId: 'b3f1c2a0',
    author: 'otheruser',
    timestamp: '2026-07-26T14:03:11.900Z',
    body: 'Fixed, please re-check.',
  });
  check('reply line: carries exactly the declared field set',
    JSON.stringify(Object.keys(replyLine).sort()) ===
      JSON.stringify(['author', 'body', 'id', 'parent_comment_id', 'schema_version', 'timestamp', 'type'].sort()));
  check('reply line: type is "reply" and it names its parent',
    replyLine.type === 'reply' && replyLine.parent_comment_id === 'b3f1c2a0');

  const deleteLine = buildDeleteLine({
    id: '4a71e990',
    targetId: 'e8a2f4d1',
    author: 'otheruser',
    timestamp: '2026-07-26T16:05:00.000Z',
  });
  check('delete line: carries exactly the declared field set',
    JSON.stringify(Object.keys(deleteLine).sort()) ===
      JSON.stringify(['author', 'id', 'schema_version', 'target_id', 'timestamp', 'type'].sort()));
  check('delete line: type is "delete" and it names its target',
    deleteLine.type === 'delete' && deleteLine.target_id === 'e8a2f4d1');
}

// --- Req 23 US-23.3: two-step resolve (Open -> Resolved -> Closed) ----------
{
  const statusLine = buildStatusChangeLine({
    id: '9c40aa77',
    parentCommentId: 'b3f1c2a0',
    author: 'hungvu',
    timestamp: '2026-07-26T15:10:00.000Z',
    fromStatus: 'Open',
    toStatus: 'Resolved',
  });
  check('status-change line: carries exactly the declared field set',
    JSON.stringify(Object.keys(statusLine).sort()) ===
      JSON.stringify(
        ['author', 'from_status', 'id', 'parent_comment_id', 'schema_version', 'timestamp', 'to_status', 'type'].sort()
      ));
  check('status-change line: type is "status-change" and it names its parent and both ends of the move',
    statusLine.type === 'status-change' &&
      statusLine.parent_comment_id === 'b3f1c2a0' &&
      statusLine.from_status === 'Open' &&
      statusLine.to_status === 'Resolved');
  // A Reopen has to say which of Resolved/Closed it undid (AC5) — the fold only
  // reads to_status, so from_status exists purely to keep the history readable.
  check('status-change line: a Reopen records which status it undid',
    buildStatusChangeLine({
      id: 's9',
      parentCommentId: 'c1',
      author: 'mai',
      timestamp: '2026-07-26T16:00:00.000Z',
      fromStatus: 'Closed',
      toStatus: 'Open',
    }).from_status === 'Closed');

  const move = (over: Partial<StatusChangeMessage> = {}): StatusChangeMessage => ({
    type: 'changeCommentStatus',
    requestId: 1,
    docUri: 'file:///a.md',
    threadId: 't1',
    action: 'resolve',
    ...over,
  });
  // US-23.11 AC1: every transition is legal for WHOEVER is at the keyboard. The
  // thread's recorded author is no longer an input to the validator at all —
  // which is exactly what the arity check below pins.
  const close = move({ action: 'close' });
  const reopen = move({ action: 'reopen' });
  check('US-23.11 AC1: identity is not an input — the validator takes no author',
    statusChangeRejection.length === 3);
  check('US-23.11 AC1: an Open thread may be resolved, whoever is asking',
    statusChangeRejection(move(), 'file:///a.md', 'Open') === null);
  check('US-23.11 AC1: the thread author may close a Resolved thread',
    statusChangeRejection(close, 'file:///a.md', 'Resolved') === null);
  check('US-23.11 AC1: the thread author may reopen their own Resolved thread',
    statusChangeRejection(reopen, 'file:///a.md', 'Resolved') === null);
  check('US-23.11 AC1: the thread author may reopen their own Closed thread — no lockout',
    statusChangeRejection(reopen, 'file:///a.md', 'Closed') === null);

  // US-23.11 AC5: the full matrix, enforced on the status axis alone.
  // Open -> Resolve only; Resolved -> Close and Reopen; Closed -> Reopen.
  const MATRIX: Record<CommentStatus, StatusChangeMessage['action'][]> = {
    Open: ['resolve'],
    Resolved: ['close', 'reopen'],
    Closed: ['reopen'],
  };
  check('US-23.11 AC5: exactly the legal action set is permitted from each status',
    (['Open', 'Resolved', 'Closed'] as const).every((status) =>
      (['resolve', 'close', 'reopen'] as const).every(
        (act) =>
          (statusChangeRejection(move({ action: act }), 'file:///a.md', status) === null) ===
          MATRIX[status].includes(act)
      )
    ));
  // The status reason must still name the workflow step, not a permission.
  check('close: an Open thread reports the status reason',
    statusChangeRejection(close, 'file:///a.md', 'Open') ===
      'Resolve the thread before closing it.');
  // AC7's second half, and the reason no transition can be appended twice: no
  // action is legal from the status it produces.
  check('status change: no action is legal from the status it produces',
    (['resolve', 'close', 'reopen'] as const).every(
      (act) =>
        statusChangeRejection(move({ action: act }), 'file:///a.md', STATUS_CHANGE_TARGET[act]) !==
        null
    ));
  // Reopen must land on Open in ONE step (AC5) — not Closed -> Resolved -> Open.
  check('status change: reopen from either Resolved or Closed lands on Open in one step',
    STATUS_CHANGE_TARGET.reopen === 'Open' &&
      statusChangeRejection(reopen, 'file:///a.md', 'Resolved') === null &&
      statusChangeRejection(reopen, 'file:///a.md', 'Closed') === null);

  // Same untrusted-input rules every other comment validator carries.
  check('status change: a request for another document is refused',
    statusChangeRejection(move(), 'file:///b.md', 'Open') !== null);
  check('status change: a request naming no thread is refused',
    statusChangeRejection(move({ threadId: '' }), 'file:///a.md', 'Open') !== null);
  check('status change: a vanished thread is refused',
    statusChangeRejection(move(), 'file:///a.md', undefined) !== null);
  // An unknown action must be refused outright: falling through would look up
  // `undefined` as the target status and append a malformed sidecar line.
  check('status change: an unknown action is refused',
    statusChangeRejection(
      move({ action: 'archive' as StatusChangeMessage['action'] }),
      'file:///a.md',
      'Open'
    ) !== null);

  // --- contextValue <-> package.json `when` clauses ------------------------
  //
  // The native Resolve/Close/Reopen actions are visible only when the thread's
  // contextValue matches its command's `when` regex. A typo on EITHER side removes
  // all three from the Comments UI with nothing failing anywhere, so the two are
  // pinned against each other here rather than trusted to stay in sync.
  // `process.cwd()`, matching the `src/provider.ts` read above: this suite is
  // compiled into `dist/test/`, so `__dirname` would resolve to `dist/`.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
  ) as { contributes: { menus: Record<string, Array<{ command: string; when: string }>> } };
  const threadMenu = pkg.contributes.menus['comments/commentThread/context'];
  const whenFor = (command: string): string =>
    threadMenu.find((entry) => entry.command === `orcaEditor.${command}Comment`)?.when ?? '';
  /** The `commentThread =~ /…/` half of a `when` clause, as a live RegExp. */
  const clauseRegex = (command: string): RegExp => {
    const source = /commentThread\s*=~\s*\/(.+?)\//.exec(whenFor(command))?.[1];
    return new RegExp(source ?? '(?!)');
  };

  check('contextValue: every status/anchor pair carries both axes',
    (['exact', 'approximate', 'floating'] as const).every((anchorState) =>
      (['Open', 'Resolved', 'Closed'] as const).every((status) => {
        const value = commentThreadContextValue(anchorState, status);
        return value.includes(`anchor-${anchorState}`) && value.includes(`status-${status.toLowerCase()}`);
      })
    ));
  // The matrix the two-step flow depends on: exactly which of the three actions
  // the native menu offers per status (anchor state must never affect it).
  const offered = (status: 'Open' | 'Resolved' | 'Closed'): string[] =>
    (['resolve', 'close', 'reopen'] as const).filter((command) =>
      clauseRegex(command).test(commentThreadContextValue('exact', status))
    );
  check('contextValue: an Open thread offers Resolve only',
    JSON.stringify(offered('Open')) === JSON.stringify(['resolve']));
  check('contextValue: a Resolved thread offers Close and Reopen',
    JSON.stringify(offered('Resolved')) === JSON.stringify(['close', 'reopen']));
  check('contextValue: a Closed thread offers Reopen only',
    JSON.stringify(offered('Closed')) === JSON.stringify(['reopen']));
  // The anchor half must not leak into the status clauses — a drifted or floating
  // thread still needs its transitions.
  check('contextValue: the anchor state never changes which actions are offered',
    (['approximate', 'floating'] as const).every((anchorState) =>
      (['Open', 'Resolved', 'Closed'] as const).every((status) => {
        const drifted = (['resolve', 'close', 'reopen'] as const).filter((command) =>
          clauseRegex(command).test(commentThreadContextValue(anchorState, status))
        );
        return JSON.stringify(drifted) === JSON.stringify(offered(status));
      })
    ));
  // Every one of the three must be palette-hidden: they take a `CommentReply`
  // argument and throw on a bare invocation.
  check('contextValue: all three commands are hidden from the Command Palette',
    (['resolve', 'close', 'reopen'] as const).every((command) =>
      pkg.contributes.menus.commandPalette.some(
        (entry) => entry.command === `orcaEditor.${command}Comment` && entry.when === 'false'
      )
    ));
}

// --- Req 24 US-23.13 AC6: cross-panel resolver authority --------------------
{
  check('nextAuthoritativePanel: an empty set has no survivor',
    nextAuthoritativePanel([]) === undefined);
  check('nextAuthoritativePanel: a single remaining panel is picked',
    nextAuthoritativePanel(['panelA']) === 'panelA');
  check('nextAuthoritativePanel: several remaining panels pick the first in iteration order',
    nextAuthoritativePanel(new Set(['panelA', 'panelB', 'panelC'])) === 'panelA');
  check('nextAuthoritativePanel: does not depend on array vs Set — same order either way',
    nextAuthoritativePanel(['panelB', 'panelA']) === 'panelB');
}

// --- Req 23 US-23.11 AC3: the one-directional content-drift measure ---------
{
  const RECORDED = 'The refund drains the queued session before the retry window closes.';
  const band = driftBandFor(RECORDED);
  /** The enter edge, i.e. a thread that is not currently latched into drift. */
  const drifted = (recorded: string, current: string): boolean => {
    const enter = driftBandFor(recorded).enter;
    return anchorTextRetention(recorded, current, enter) < enter;
  };
  /** Retention measured at a threshold low enough that the early bail never fires. */
  const retentionOf = (recorded: string, current: string): number =>
    anchorTextRetention(recorded, current, 0);

  check('drift: identical text is fully retained',
    retentionOf(RECORDED, RECORDED) === 1);
  // Re-wrapping a paragraph changes no words, so it must not read as drift.
  check('drift: re-wrapped whitespace is fully retained',
    retentionOf(RECORDED, RECORDED.replace(/ /g, '\n  ')) === 1);
  // THE bug US-23.11 AC3 exists for: text typed into the paragraph AFTER the
  // comment was written is text outside the comment and is not drift, however
  // much of it there is. The old symmetric score divided by the longer string,
  // so this read as drift.
  check('drift: appending a whole sentence is not drift',
    retentionOf(RECORDED, `${RECORDED} A brand new sentence follows it now.`) === 1 &&
      !drifted(RECORDED, `${RECORDED} A brand new sentence follows it now.`));
  check('drift: a one-word tweak is not drift',
    !drifted(RECORDED, RECORDED.replace('drains', 'clears')));
  // ...but removing or rewriting the recorded text is, one-directionally.
  check('drift: half the paragraph rewritten is drift',
    drifted(RECORDED, 'The refund drains the queued session ' + 'and then something else entirely happens here.'));
  check('drift: a rewritten sentence is drift',
    drifted(RECORDED, 'Totally different prose about something else entirely here.'));
  check('drift: deleted-to-nothing retains none of the snapshot',
    retentionOf(RECORDED, '') === 0 && drifted(RECORDED, ''));
  // An empty recorded text has nothing to drift from — never report drift on it,
  // or every bare-caret anchor would show the strip forever.
  check('drift: an empty recorded text is always fully retained',
    retentionOf('', 'anything at all') === 1);
  // The same prose typed on macOS vs Windows differs only by Unicode form.
  check('drift: NFD vs NFC of the same prose is not drift',
    retentionOf('Nguyễn Văn A'.normalize('NFD'), 'Nguyễn Văn A'.normalize('NFC')) === 1);

  // AC3: the drift band is the drift check's OWN, not tier 2's relocation pair.
  check('drift: the band is independent of tier 2 thresholds',
    band.enter !== anchorThresholdFor(RECORDED) && band.enter < band.exit);
  // Short text gets a MORE permissive band, not tier 2's stricter one: one
  // character edited in a ten-character heading is not "the text may have
  // changed", while half of it rewritten is.
  const short = driftBandFor('Done');
  check('drift: short text uses a more permissive band than ordinary text',
    short.enter < band.enter && short.enter < short.exit);
  check('drift: a one-character change to a short heading is not drift',
    !drifted('Session expiry', 'Session expiries'));
  check('drift: a short heading rewritten IS drift',
    drifted('Done', 'Not applicable'));

  // AC3's hysteresis, exercised as `applyStatusIndicators` runs it: the edge in
  // play depends on the state the thread is ALREADY in, so a retention sitting
  // between the two edges holds that state instead of flickering.
  const latch = (recorded: string, current: string, wasDrifted: boolean): boolean => {
    const band = driftBandFor(recorded);
    const threshold = wasDrifted ? band.exit : band.enter;
    return anchorTextRetention(recorded, current, threshold) < threshold;
  };
  const HYSTERESIS = 'A short paragraph of prose that a single keystroke can nudge across the line.';
  const edge = HYSTERESIS.slice(0, Math.round(HYSTERESIS.length * 0.92));
  const retention = retentionOf(HYSTERESIS, edge);
  check('drift: the band leaves room between enter and exit for hysteresis',
    retention > driftBandFor(HYSTERESIS).enter && retention < driftBandFor(HYSTERESIS).exit);
  check('drift: inside the band an undrifted thread stays undrifted',
    !latch(HYSTERESIS, edge, false));
  check('drift: inside the band a drifted thread stays drifted',
    latch(HYSTERESIS, edge, true));
  // ...and both edges still resolve outside the band, so the latch is hysteresis
  // and not a state that can never be left.
  check('drift: a full restore clears drift even from the latched state',
    !latch(HYSTERESIS, HYSTERESIS, true));
  check('drift: a heavy deletion enters drift even from the clean state',
    latch(HYSTERESIS, HYSTERESIS.slice(0, 20), false));

  // The early bail must never change the ANSWER, only the work: a current text
  // too short to clear the threshold returns its own upper bound, which is below
  // the threshold exactly when the full pass would have been.
  const BAIL = 'The refund drains the queued session before the retry window closes.';
  check('drift: the length bail agrees with the full pass',
    (anchorTextRetention(BAIL, BAIL.slice(0, 10), 0.9) < 0.9) ===
      (retentionOf(BAIL, BAIL.slice(0, 10)) < 0.9));
  // Text inserted BEFORE the snapshot, past the compare cap, is still not drift —
  // capping both sides at the same absolute prefix used to cut the snapshot's own
  // tail out of the window and report drift for an edit that removed nothing.
  const LONG = 'x'.repeat(400);
  check('drift: a long insertion BEFORE the snapshot is not drift',
    !drifted(LONG, `${'y'.repeat(200)} ${LONG}`));
}

// --- Req 23 US-23.2 AC1: gutter-pin line clustering -------------------------
{
  const at = (line: number, threadId = `t${line}`): ThreadAnchor =>
    ({ threadId, lastKnownLine: line, replies: [] }) as unknown as ThreadAnchor;
  const lines = (groups: ThreadAnchor[][]): number[][] => groups.map((g) => g.map((a) => a.lastKnownLine));

  check('pin cluster: one thread is its own group',
    JSON.stringify(lines(buildGroups([at(3)]))) === JSON.stringify([[3]]));
  // "within 1 blank line of each other" = a line gap of at most 2.
  check('pin cluster: lines 2 apart (one blank line between) chain into one group',
    JSON.stringify(lines(buildGroups([at(3), at(5), at(7)]))) === JSON.stringify([[3, 5, 7]]));
  check('pin cluster: a 3-line gap starts a new group',
    JSON.stringify(lines(buildGroups([at(3), at(6)]))) === JSON.stringify([[3], [6]]));
  check('pin cluster: two threads on the SAME line are one group',
    JSON.stringify(lines(buildGroups([at(4, 'a'), at(4, 'b')]))) === JSON.stringify([[4, 4]]));
  check('pin cluster: input order does not matter',
    JSON.stringify(lines(buildGroups([at(7), at(3), at(5)]))) === JSON.stringify([[3, 5, 7]]));
  // Line 0 is `commentAnchorLine`'s "maps to no source line" fallback, NOT line
  // zero: grouping those by value collapsed unrelated threads from opposite ends
  // of the document onto one pin and left the others with no marker at all.
  check('pin cluster: unknown-line (0) threads each keep their own group',
    JSON.stringify(lines(buildGroups([at(0, 'a'), at(0, 'b')]))) === JSON.stringify([[0], [0]]));
  check('pin cluster: an unknown-line thread never joins a real-line group',
    JSON.stringify(lines(buildGroups([at(0, 'a'), at(1)]))) === JSON.stringify([[0], [1]]));
}

// --- Req 23 US-23.4 AC4: Re-attach... picker ranking ------------------------
{
  const candidate = (text: string, line: number, heading = '', depth = 1): AnchorCandidate => ({
    text,
    line,
    heading,
    depth,
  });
  const nodes = [
    candidate('REQ-118 — Session Expiry', 1, '', 1),
    candidate('AC-1 — Refund requests raised against an expired session are held.', 11, 'Acceptance criteria'),
    candidate('AC-2 — The held queue drains in enqueue order.', 12, 'Acceptance criteria'),
    candidate('AC-3 — Each entry records a reason code.', 13, 'Acceptance criteria'),
  ];
  const recorded = 'AC-2 — The held queue drains in enqueue order.';

  const ranked = rankReattachTargets(recorded, nodes, '');
  check('re-attach: every node is offered when the filter is empty', ranked.all.length === 4);
  check('re-attach: the closest node is suggested first', ranked.suggested[0]?.index === 2);
  check('re-attach: the exact node scores 100%', Math.round((ranked.suggested[0]?.score ?? 0) * 100) === 100);
  check('re-attach: suggestions are capped', rankReattachTargets(recorded, nodes, '', 2).suggested.length === 2);
  // Suggestions are ranked, never applied — the picker always leaves the choice
  // to the author, which is why every candidate stays listed under Suggested.
  check('re-attach: a runner-up is still offered, not discarded', (ranked.suggested[1]?.index ?? -1) !== -1);

  const filtered = rankReattachTargets(recorded, nodes, 'QUEUE');
  check('re-attach: the filter is case-insensitive', filtered.all.length === 1 && filtered.all[0].index === 2);
  check('re-attach: a filter matching nothing yields no rows',
    rankReattachTargets(recorded, nodes, 'zzz').all.length === 0);
  check('re-attach: the filter is normalized like every other text comparison',
    rankReattachTargets('x', [candidate('Nhật ký phiên'.normalize('NFD'), 3)], 'Nhật'.normalize('NFC')).all.length === 1);
  check('re-attach: no candidates means no rows', rankReattachTargets(recorded, [], '').all.length === 0);
  check('re-attach: an empty recorded text still lists every node, just unranked',
    rankReattachTargets('', nodes, '').all.length === 4 && rankReattachTargets('', nodes, '').suggested.length === 0);
}

// --- Req 23 US-23.5: .orca-comments.jsonl sidecar format --------------------
{
  const anchor = {
    offset_start: 0,
    offset_end: 5,
    recorded_text: 'AC-1 — held',
    last_known_line: 88,
    nearest_heading: 'Acceptance criteria',
  };
  const comment = (over: Partial<CommentLine> = {}): CommentLine => ({
    ...buildCommentLine({
      id: 'c1',
      author: 'reviewer',
      timestamp: '2026-07-26T10:00:00.000Z',
      body: 'why?',
      anchor,
    }),
    ...over,
  });
  const reply = (over: Partial<ReplyLine> = {}): ReplyLine => ({
    schema_version: 1,
    type: 'reply',
    id: 'r1',
    parent_comment_id: 'c1',
    author: 'author',
    timestamp: '2026-07-26T11:00:00.000Z',
    body: 'fixed',
    ...over,
  });
  const statusChange = (over: Partial<StatusChangeLine> = {}): StatusChangeLine => ({
    schema_version: 1,
    type: 'status-change',
    id: 's1',
    parent_comment_id: 'c1',
    author: 'author',
    timestamp: '2026-07-26T12:00:00.000Z',
    from_status: 'Open',
    to_status: 'Resolved',
    ...over,
  });
  const tombstone = (over: Partial<DeleteLine> = {}): DeleteLine => ({
    schema_version: 1,
    type: 'delete',
    id: 'd1',
    target_id: 'r1',
    author: 'author',
    timestamp: '2026-07-26T13:00:00.000Z',
    ...over,
  });

  // AC1/AC3: 1:1 sibling name, and every append ends the line so two concurrent
  // appends land as separate diff hunks instead of colliding on one line region.
  check('sidecar: the file is a 1:1 sibling of the .md', sidecarNameFor('foo.md') === 'foo.md.orca-comments.jsonl');
  const serialized = serializeSidecarLine(comment());
  check('sidecar: a serialized line ends with a newline', serialized.endsWith('\n'));
  check('sidecar: a serialized record is exactly one physical line',
    serialized.slice(0, -1).includes('\n') === false);
  // A multi-line body must not break the line-oriented format.
  check('sidecar: a body containing newlines still serializes to one line',
    serializeSidecarLine(comment({ body: 'line one\nline two' })).slice(0, -1).includes('\n') === false);
  check('sidecar: a serialized line round-trips',
    parseSidecarText(serialized).lines.length === 1 &&
      (parseSidecarText(serialized).lines[0] as CommentLine).body === 'why?');
  check('sidecar: no status is stored on the comment line',
    Object.prototype.hasOwnProperty.call(comment(), 'status') === false);
  check('sidecar: the session-scoped structural id is never persisted',
    Object.prototype.hasOwnProperty.call(comment().anchor, 'anchorId') === false &&
      Object.prototype.hasOwnProperty.call(comment().anchor, 'structuralId') === false);

  // AC4: an unparseable line is skipped with a warning, never aborting the load —
  // a crashed append leaves at most one truncated final line.
  const withGarbage = `${serializeSidecarLine(comment())}{"schema_version":1,"type":"comm\n${serializeSidecarLine(comment({ id: 'c2' }))}`;
  const parsedGarbage = parseSidecarText(withGarbage);
  check('sidecar: a corrupt line is skipped, the rest still load', parsedGarbage.lines.length === 2);
  check('sidecar: a skipped line is reported', parsedGarbage.warnings.length === 1);
  check('sidecar: a blank line is not a warning', parseSidecarText('\n\n').warnings.length === 0);
  // JSON that parses but is not a record must not reach the fold.
  check('sidecar: valid JSON of the wrong shape is skipped',
    parseSidecarText('{"type":"comment","id":"x"}\n').lines.length === 0);
  check('sidecar: a record with no id is skipped',
    parseSidecarText(serializeSidecarLine(comment({ id: '' }))).lines.length === 0);
  check('sidecar: an unknown line type is skipped',
    parseSidecarText('{"schema_version":1,"type":"reaction","id":"x","author":"a","timestamp":"2026-01-01T00:00:00Z"}\n')
      .lines.length === 0);

  // Req 24 US-23.15 AC4: a conflicted merge is a stated failure, not a silently
  // partial list — the markers are skipped like any unparseable line, but the
  // file is FLAGGED so the caller can say "unresolved merge" rather than "damaged".
  const conflicted = parseSidecarText(
    [
      '<<<<<<< HEAD',
      serializeSidecarLine(comment()).trimEnd(),
      '=======',
      serializeSidecarLine(comment({ id: 'c2' })).trimEnd(),
      '>>>>>>> feature/other',
      '',
    ].join('\n')
  );
  check('sidecar: conflict markers are skipped and both sides still load', conflicted.lines.length === 2);
  check('sidecar: a conflicted sidecar is flagged', conflicted.conflicted === true);
  check('sidecar: each conflict marker is reported as its own loss', conflicted.warnings.length === 3);
  // The marker count is what keeps AC3's "N line(s) could not be read" honest: a
  // marker carries no comment data, so all three warnings here describe a merge in
  // which nothing was actually lost.
  check('sidecar: marker lines are counted separately from real losses', conflicted.conflictMarkers === 3);
  const diff3 = parseSidecarText(
    ['<<<<<<< HEAD', '||||||| base', '=======', serializeSidecarLine(comment()).trimEnd(), '>>>>>>> other', ''].join('\n')
  );
  check("sidecar: diff3's ||||||| base marker is a marker, not bad JSON", diff3.conflictMarkers === 4);
  check('sidecar: diff3 style still loads the surviving record', diff3.lines.length === 1);
  check('sidecar: a conflict marker is named as one, not as bad JSON',
    conflicted.warnings.every((w) => w.includes('git conflict marker')));
  check('sidecar: a clean sidecar is not flagged as conflicted',
    parseSidecarText(serializeSidecarLine(comment())).conflicted === undefined);
  // Only at the START of a line: `=======` inside a comment body is prose, and the
  // body is inside a JSON string, so the line must still parse.
  check('sidecar: a body containing a conflict marker still parses',
    parseSidecarText(serializeSidecarLine(comment({ body: '======= not a marker' }))).lines.length === 1);
  check('sidecar: a body containing a conflict marker does not flag the file',
    parseSidecarText(serializeSidecarLine(comment({ body: '<<<<<<< nope' }))).conflicted === undefined);

  // Req 24 US-23.15 AC5: git state → the warning the user reads. `shared` is the
  // healthy case; outside a repository (or with no usable `git`) AC5 is a no-op.
  check('sidecar git: an ignored sidecar warns about the ignore rule',
    (sidecarShareWarning('ignored', 'a.md.orca-comments.jsonl') ?? '').includes('gitignore'));
  check('sidecar git: an untracked sidecar warns to add it',
    (sidecarShareWarning('untracked', 'a.md.orca-comments.jsonl') ?? '').includes('git add'));
  check('sidecar git: a warning names the sidecar',
    (sidecarShareWarning('untracked', 'a.md.orca-comments.jsonl') ?? '').includes('a.md.orca-comments.jsonl'));
  check('sidecar git: a tracked sidecar says nothing', sidecarShareWarning('shared', 'a.jsonl') === null);
  check('sidecar git: outside a git repository says nothing', sidecarShareWarning('no-repo', 'a.jsonl') === null);
  check('sidecar git: an unusable git says nothing', sidecarShareWarning('unknown', 'a.jsonl') === null);
  // The blocker this review caught: git answers "untracked" for a path that does
  // not exist, so without its own state every never-commented document would be
  // told to `git add` a file nobody has created.
  check('sidecar git: a document with no sidecar yet says nothing',
    sidecarShareWarning('no-sidecar', 'a.jsonl') === null);

  // AC5's state machine itself is async, and this runner is CJS with no
  // top-level await — it is driven (through the same injectable runner, plus a
  // real `git init`) in `test/host/sidecar-reload.test.ts`.

  // AC4: timestamp order, not on-disk order — a git merge can interleave lines.
  const shuffled = foldSidecarRecords([
    comment(),
    reply({ id: 'r2', timestamp: '2026-07-26T11:30:00.000Z', body: 'second' }),
    reply({ id: 'r1', timestamp: '2026-07-26T11:00:00.000Z', body: 'first' }),
  ]);
  check('sidecar: replies are ordered by timestamp, not disk order',
    shuffled.threads[0].replies.map((r) => r.body).join(',') === 'first,second');

  // AC3 (third rule): a reply/status-change/anchor-update is never ordered
  // before its own parent regardless of its timestamp — each is stored in its
  // own per-thread array, never interleaved with the parent `comment`, so an
  // earlier-than-parent timestamp cannot misplace it ahead of its own thread.
  const replyBeforeParent = foldSidecarRecords([
    comment(), // created 2026-07-26T10:00:00.000Z
    reply({ timestamp: '2026-07-26T05:00:00.000Z', body: 'timestamped before its own parent comment' }),
  ]);
  check('sidecar: a reply timestamped before its own parent still folds into that parent\'s thread',
    replyBeforeParent.threads.length === 1 &&
      replyBeforeParent.threads[0].replies.length === 1 &&
      replyBeforeParent.threads[0].replies[0].body === 'timestamped before its own parent comment' &&
      replyBeforeParent.orphans.length === 0);

  // AC4: first-seen wins on a duplicate id, and the rest are flagged.
  const duplicated = foldSidecarRecords([comment({ body: 'first' }), comment({ body: 'second' })]);
  check('sidecar: a duplicate comment id keeps the first-seen line',
    duplicated.threads.length === 1 && duplicated.threads[0].comment.body === 'first');
  check('sidecar: a duplicate comment id is flagged', duplicated.warnings.length === 1);

  // AC4: an unmatched parent routes to orphans instead of being dropped.
  const orphaned = foldSidecarRecords([comment(), reply({ parent_comment_id: 'missing' })]);
  check('sidecar: a reply with no parent routes to orphans',
    orphaned.orphans.length === 1 && orphaned.threads[0].replies.length === 0);
  check('sidecar: a status change with no parent routes to orphans',
    foldSidecarRecords([statusChange({ parent_comment_id: 'missing' })]).orphans.length === 1);
  // AC7's literal example: a reply whose parent_comment_id names ANOTHER
  // reply (not a comment) — reply-to-reply nesting is exactly one level too
  // deep, so it orphans the same way a missing/unknown parent does.
  check('sidecar: a reply-to-reply (parent names another reply, not a comment) routes to orphans',
    foldSidecarRecords([comment(), reply({ id: 'r1' }), reply({ id: 'r2', parent_comment_id: 'r1' })]).orphans.length === 1);

  // Status is derived by folding status-change lines, never stored.
  check('sidecar: a thread with no status change defaults to Open',
    foldSidecarRecords([comment()]).threads[0].status === 'Open');
  check('sidecar: status folds to the last change by timestamp',
    foldSidecarRecords([
      comment(),
      statusChange({ id: 's2', timestamp: '2026-07-26T14:00:00.000Z', from_status: 'Resolved', to_status: 'Closed' }),
      statusChange(),
    ]).threads[0].status === 'Closed');
  check('sidecar: a reopen folds back to Open',
    foldSidecarRecords([
      comment(),
      statusChange(),
      statusChange({ id: 's3', timestamp: '2026-07-26T15:00:00.000Z', from_status: 'Resolved', to_status: 'Open' }),
    ]).threads[0].status === 'Open');

  // US-23.11 AC6: `from_status` is a guard, not a note. A line whose recorded
  // origin disagrees with what the strictly-earlier lines folded to is SKIPPED —
  // a hand-edited file or a git merge cannot land an illegal Open -> Closed jump
  // that no control would ever have offered.
  const illegalJump = foldSidecarRecords([
    comment(),
    statusChange({ id: 'sX', from_status: 'Resolved', to_status: 'Closed' }),
  ]);
  check('US-23.11 AC6: a status-change from the wrong status is skipped, not applied',
    illegalJump.threads[0].status === 'Open');
  check('US-23.11 AC6: the skipped transition is still flagged',
    illegalJump.warnings.length === 1);
  check('US-23.11 AC6: a skipped transition is dropped from the thread trail',
    illegalJump.threads[0].statusChanges.length === 0);
  // ...and the fold carries on: a legal line AFTER a skipped one still applies,
  // measured against the status the skip preserved.
  const skipThenApply = foldSidecarRecords([
    comment(),
    statusChange({ id: 'sX', timestamp: '2026-07-26T12:00:00.000Z', from_status: 'Closed', to_status: 'Open' }),
    statusChange({ id: 'sY', timestamp: '2026-07-26T13:00:00.000Z', from_status: 'Open', to_status: 'Resolved' }),
  ]);
  check('US-23.11 AC6: a legal transition after a skipped one still applies',
    skipThenApply.threads[0].status === 'Resolved' &&
      skipThenApply.threads[0].statusChanges.length === 1);
  // AC2 reads this list straight through to the popover, so its order and
  // contents are part of the loader's contract.
  const trail = foldSidecarRecords([
    comment(),
    statusChange({ id: 's3', timestamp: '2026-07-26T15:00:00.000Z', from_status: 'Resolved', to_status: 'Closed', author: 'mai' }),
    statusChange({ id: 's1', timestamp: '2026-07-26T12:00:00.000Z', from_status: 'Open', to_status: 'Resolved', author: 'hungvu' }),
  ]).threads[0].statusChanges;
  check('US-23.11 AC2: the whole applied trail survives the fold, oldest first',
    trail.length === 2 &&
      trail[0].to_status === 'Resolved' && trail[0].author === 'hungvu' &&
      trail[1].to_status === 'Closed' && trail[1].author === 'mai');

  // Tombstones: applied last, cascade for a comment, single for a reply.
  const replyDeleted = foldSidecarRecords([comment(), reply(), reply({ id: 'r2' }), tombstone()]);
  check('sidecar: deleting a reply leaves the thread and its siblings',
    replyDeleted.threads.length === 1 && replyDeleted.threads[0].replies.length === 1 &&
      replyDeleted.threads[0].replies[0].id === 'r2');
  const threadDeleted = foldSidecarRecords([
    comment(),
    reply(),
    statusChange(),
    tombstone({ target_id: 'c1', author: 'reviewer' }),
  ]);
  check('sidecar: deleting a comment cascades to its replies and status changes',
    threadDeleted.threads.length === 0 && threadDeleted.orphans.length === 0);
  // AC8: no authority check — a delete from a different author than its target
  // is still applied (the same PO call US-23.11 already made for status-change).
  check('sidecar: a delete from a different author than the target is still applied (AC8)',
    foldSidecarRecords([comment(), reply(), tombstone({ author: 'someone-else' })]).threads[0].replies.length === 0);

  // US-23.11 AC9: the one author normalizer — decode, trim, NFC, case-fold — and
  // a blank side that never matches anything. Nothing in the FOLD runs this
  // comparison any more (AC1/US-23.16 AC8 removed both gates it used to guard);
  // it survives only for `comment-utils.ts`'s UI-level delete popover gate.
  check('US-23.11 AC9: the same name matches itself',
    sameAuthor('hungvu', 'hungvu'));
  check('US-23.11 AC9: a trailing space in the setting still matches',
    sameAuthor('hungvu ', 'hungvu'));
  check('US-23.11 AC9: case differences still match',
    sameAuthor('HungVu', 'hungvu'));
  check('US-23.11 AC9: NFD and NFC of the same name match',
    sameAuthor('Nguyễn'.normalize('NFD'), 'Nguyễn'.normalize('NFC')));
  check('US-23.11 AC9: a percent-encoded name matches its decoded form',
    sameAuthor('nguy%E1%BB%85n', 'nguyễn'));
  check('US-23.11 AC9: a malformed percent escape falls back to the literal text',
    sameAuthor('100%', '100%'));
  check('US-23.11 AC9: an unconfigured (empty) name matches no real author',
    !sameAuthor('', 'hungvu') && !sameAuthor('hungvu', ''));
  // AC9's "an empty authorName never matches any stored author" is scoped to the
  // CURRENT USER's name, and `resolveCommentAuthor` is what enforces it: a blank
  // setting is replaced by the OS username before it is ever compared, so the
  // blank identity never reaches `sameAuthor` from the live path at all.
  check('US-23.11 AC9: a blank configured name never becomes an identity',
    resolveCommentAuthor('', 'os-user') === 'os-user' &&
      resolveCommentAuthor('   ', 'os-user') === 'os-user');
  // Two blank STORED authors still compare equal on purpose: the loader's
  // tombstone check compares two recorded names, and refusing that match would
  // stop a `delete` line from deleting its target — resurrecting, on the next
  // load, a comment the user had removed.
  check('US-23.11 AC9: two blank stored authors still match, so a tombstone still applies',
    sameAuthor('', '') && sameAuthor('   ', ''));
  // Case-folding can itself denormalize (İ U+0130 lowercases to `i` + a combining
  // dot), so the normalizer re-normalizes afterwards — without that, the NFD and
  // NFC spellings of such a name compare unequal.
  check('US-23.11 AC9: a name whose case-folding denormalizes still matches its NFD form',
    sameAuthor('İlker', 'İlker'.normalize('NFD')));
  check('US-23.11 AC9: different names still do not match',
    !sameAuthor('hungvu', 'mai.tran'));
  // A stray delete from a race between two sessions must not error the load.
  // Distinct ids: three independent stray deletes, not the same line repeated
  // (a shared default id would be caught by AC1's cross-type dedup instead).
  const strayDelete = foldSidecarRecords([
    comment(),
    tombstone({ id: 'd1', target_id: 'nope' }),
    tombstone({ id: 'd2', target_id: 'also-nope' }),
    tombstone({ id: 'd3', target_id: 'still-nope' }),
  ]);
  check('sidecar: a delete naming an unknown target is a silent no-op',
    strayDelete.threads.length === 1 && strayDelete.warnings.length === 0);
  check('sidecar: a delete naming an unknown target routes to orphans (AC7)',
    strayDelete.orphans.length === 3);

  // Regression (review 2026-07-26): duplicate ids were deduped for `comment` only.
  // A merge that lands one reply twice displayed it twice — and since
  // `deletedReplies` is keyed by id, ONE tombstone removed BOTH copies even when
  // their authors differed.
  const dupReply = foldSidecarRecords([comment(), reply({ body: 'one' }), reply({ body: 'two' })]);
  check('sidecar: a duplicate reply id keeps the first-seen line',
    dupReply.threads[0].replies.length === 1 && dupReply.threads[0].replies[0].body === 'one');
  check('sidecar: a duplicate reply id is flagged', dupReply.warnings.length === 1);
  check('sidecar: a duplicate status-change id keeps the first-seen line',
    foldSidecarRecords([comment(), statusChange(), statusChange({ to_status: 'Closed' })]).threads[0].status === 'Resolved');
  // AC8: no authority check — the surviving (first-seen) duplicate is
  // deletable by any author, not just its own.
  check('sidecar: a duplicate reply id\'s surviving copy is deletable by any author (AC8)',
    foldSidecarRecords([
      comment(),
      reply({ author: 'A', body: "A's" }),
      reply({ author: 'B', body: "B's" }),
      tombstone({ author: 'B' }),
    ]).threads[0].replies.length === 0);

  // AC1/AC2: dedup applies ACROSS types too, not just within one — a `reply`
  // and a `status-change` sharing one `id` (a pathological merge/cherry-pick)
  // resolve by the same lowest-timestamp rule, regardless of type. The reply's
  // earlier timestamp wins, so the status-change never applies.
  const crossTypeDup = foldSidecarRecords([
    comment(),
    reply({ id: 'x1', timestamp: '2026-07-26T09:00:00.000Z', body: 'reply wins (earlier timestamp)' }),
    statusChange({ id: 'x1', timestamp: '2026-07-26T10:00:00.000Z' }),
  ]);
  check('sidecar: a cross-type id collision keeps the lowest-timestamp line regardless of type',
    crossTypeDup.threads[0].replies.length === 1 &&
      crossTypeDup.threads[0].replies[0].body === 'reply wins (earlier timestamp)' &&
      crossTypeDup.threads[0].status === 'Open');
  check('sidecar: a cross-type id collision is flagged',
    crossTypeDup.warnings.some((w) => w.includes('x1')));
  // An unparseable timestamp is treated as the oldest possible value in a
  // dedup tie too (AC2), same rule `byTimestamp` already applies to ordering.
  const garbageTimestampDup = foldSidecarRecords([
    comment({ body: 'has a real timestamp' }),
    reply({ id: 'r9', timestamp: 'not-a-date', body: 'garbage timestamp — treated as oldest, wins the tie' }),
    reply({ id: 'r9', timestamp: '2026-07-26T11:00:00.000Z', body: 'real timestamp — loses to the garbage one' }),
  ]);
  check('sidecar: an unparseable timestamp wins a dedup tie as the oldest value',
    garbageTimestampDup.threads[0].replies[0].body === 'garbage timestamp — treated as oldest, wins the tie');
  // `delete` lines dedup by id too (previously the only type with none at all).
  const dupDelete = foldSidecarRecords([
    comment(),
    reply(),
    reply({ id: 'r2' }),
    tombstone({ id: 'dup', target_id: 'r1', timestamp: '2026-07-26T13:00:00.000Z' }),
    tombstone({ id: 'dup', target_id: 'r2', timestamp: '2026-07-26T14:00:00.000Z' }),
  ]);
  check('sidecar: a duplicate delete id keeps only the first-seen line\'s effect',
    dupDelete.threads[0].replies.length === 1 && dupDelete.threads[0].replies[0].id === 'r2');

  // Req 24 US-23.13 AC1/AC2: `anchor-update` persists a re-attached or
  // auto-resolved anchor. Its fold is the one line type that resolves
  // last-one-wins by FILE/APPEND order, never by `timestamp` (a fast retry or a
  // clock with coarse resolution must never decide the winner).
  const anchorUpdate = (over: Partial<AnchorUpdateLine> = {}): AnchorUpdateLine => ({
    ...buildAnchorUpdateLine({
      id: 'u1',
      parentCommentId: 'c1',
      author: 'author',
      timestamp: '2026-07-28T10:00:00.000Z',
      origin: 'manual',
      anchor: { offset_start: 0, offset_end: 0, recorded_text: 'moved here', last_known_line: 5, nearest_heading: '' },
    }),
    ...over,
  });
  check('sidecar: with no anchor-update line, a thread keeps its creation-time anchor',
    foldSidecarRecords([comment()]).threads[0].anchor === anchor);
  check('sidecar: a single anchor-update replaces the thread\'s anchor',
    foldSidecarRecords([comment(), anchorUpdate()]).threads[0].anchor.recorded_text === 'moved here');
  check('sidecar: anchor-update last-one-wins resolves by FILE order, not timestamp',
    foldSidecarRecords([
      comment(),
      anchorUpdate({ id: 'u1', timestamp: '2026-07-28T11:00:00.000Z', anchor: { ...anchorUpdate().anchor, recorded_text: 'first-in-file-later-timestamp' } }),
      anchorUpdate({ id: 'u2', timestamp: '2026-07-28T09:00:00.000Z', anchor: { ...anchorUpdate().anchor, recorded_text: 'second-in-file-earlier-timestamp' } }),
    ]).threads[0].anchor.recorded_text === 'second-in-file-earlier-timestamp');
  check('sidecar: a manual re-attach followed by an automatic resolve — the later one (in file order) wins regardless of origin',
    foldSidecarRecords([
      comment(),
      anchorUpdate({ id: 'u1', origin: 'manual', anchor: { ...anchorUpdate().anchor, recorded_text: 'manual' } }),
      anchorUpdate({ id: 'u2', origin: 'resolved', anchor: { ...anchorUpdate().anchor, recorded_text: 'resolved' } }),
    ]).threads[0].anchor.recorded_text === 'resolved');
  check('sidecar: a duplicate anchor-update id keeps the first-seen line',
    foldSidecarRecords([
      comment(),
      anchorUpdate({ anchor: { ...anchorUpdate().anchor, recorded_text: 'first' } }),
      anchorUpdate({ anchor: { ...anchorUpdate().anchor, recorded_text: 'second' } }),
    ]).threads[0].anchor.recorded_text === 'first');
  check('sidecar: a duplicate anchor-update id is flagged',
    foldSidecarRecords([comment(), anchorUpdate(), anchorUpdate()]).warnings.length === 1);
  // AC7: unlike reply/status-change, an anchor-update whose parent doesn't
  // resolve used to be a silent no-op — now it routes to orphans like every
  // other line type.
  check('sidecar: an anchor-update with no parent routes to orphans',
    foldSidecarRecords([comment(), anchorUpdate({ parent_comment_id: 'missing' })]).orphans.length === 1);
  // Review finding (2026-07-28): a dedup winner that is NOT its id's
  // first on-disk occurrence must still take its OWN true on-disk position in
  // the deduped stream — not the position of that id's first occurrence —
  // or `anchor-update`'s last-one-wins fold can pick the wrong line. Here
  // 'a1' wins dedup (lower timestamp) despite being appended LAST, after 'a2'.
  const orderInversion = foldSidecarRecords([
    comment(),
    anchorUpdate({ id: 'a1', timestamp: '2026-07-28T09:00:00.000Z', anchor: { ...anchorUpdate().anchor, recorded_text: 'first-occurrence-of-a1' } }),
    anchorUpdate({ id: 'a2', timestamp: '2026-07-28T10:00:00.000Z', anchor: { ...anchorUpdate().anchor, recorded_text: 'a2-appended-between' } }),
    anchorUpdate({ id: 'a1', timestamp: '2026-07-28T05:00:00.000Z', anchor: { ...anchorUpdate().anchor, recorded_text: 'a1-wins-dedup-appended-last' } }),
  ]);
  check('sidecar: a dedup winner takes its own true on-disk position, not its id\'s first-occurrence position',
    orderInversion.threads[0].anchor.recorded_text === 'a1-wins-dedup-appended-last');

  // US-23.14: an append-only correction of a comment/reply's `body`, mirroring
  // `delete`'s tombstone pattern — but UNLIKE anchor-update's pure file-order
  // fold, AC3 says the LATEST TIMESTAMP wins, tie broken by file/append order.
  const editLine = (over: Partial<EditLine> = {}): EditLine => ({
    ...buildEditLine({
      id: 'e1',
      targetId: 'c1',
      author: 'author',
      timestamp: '2026-07-28T16:00:00.000Z',
      body: 'edited body',
    }),
    ...over,
  });
  check('sidecar: with no edit line, a thread keeps its original comment body',
    foldSidecarRecords([comment()]).threads[0].comment.body === 'why?');
  check('sidecar: with no edit line, editedAt is never set',
    foldSidecarRecords([comment()]).threads[0].comment.editedAt === undefined);
  check('sidecar: a single edit line replaces the comment\'s displayed body',
    foldSidecarRecords([comment(), editLine()]).threads[0].comment.body === 'edited body');
  check('sidecar: a folded edit sets editedAt to the winning edit\'s own timestamp',
    foldSidecarRecords([comment(), editLine()]).threads[0].comment.editedAt === '2026-07-28T16:00:00.000Z');
  check('sidecar: the original author/timestamp survive an edit unchanged',
    foldSidecarRecords([comment(), editLine()]).threads[0].comment.author === 'reviewer' &&
      foldSidecarRecords([comment(), editLine()]).threads[0].comment.timestamp === '2026-07-26T10:00:00.000Z');
  check('sidecar: an edit line can also target a reply',
    foldSidecarRecords([comment(), reply(), editLine({ id: 'e2', target_id: 'r1', body: 'fixed the typo' })])
      .threads[0].replies[0].body === 'fixed the typo');
  // AC3: latest TIMESTAMP wins — the opposite primary rule from anchor-update's
  // pure file-order fold.
  check('sidecar: edit fold — the LATER timestamp wins regardless of file order',
    foldSidecarRecords([
      comment(),
      editLine({ id: 'e1', timestamp: '2026-07-28T18:00:00.000Z', body: 'first-in-file-later-timestamp' }),
      editLine({ id: 'e2', timestamp: '2026-07-28T09:00:00.000Z', body: 'second-in-file-earlier-timestamp' }),
    ]).threads[0].comment.body === 'first-in-file-later-timestamp');
  // AC3 sub: an exact timestamp tie resolves by file/append order.
  check('sidecar: edit fold — an exact timestamp tie resolves by file/append order',
    foldSidecarRecords([
      comment(),
      editLine({ id: 'e1', timestamp: '2026-07-28T16:00:00.000Z', body: 'first-in-file' }),
      editLine({ id: 'e2', timestamp: '2026-07-28T16:00:00.000Z', body: 'second-in-file' }),
    ]).threads[0].comment.body === 'second-in-file');
  // AC5: idempotent no-op on an unknown or already-tombstoned target — the
  // same tolerance `delete` already has.
  check('sidecar: an edit naming an unknown target_id is an idempotent no-op',
    foldSidecarRecords([comment(), editLine({ target_id: 'no-such-id' })]).threads[0].comment.body === 'why?');
  check('sidecar: an edit naming an unknown target does not warn or error',
    foldSidecarRecords([comment(), editLine({ target_id: 'no-such-id' })]).warnings.length === 0);
  // AC7: an unresolvable target now routes to orphans instead of vanishing —
  // an already-tombstoned target still resolves (the maps aren't pruned by
  // deletion), so that ordinary race stays a quiet no-op, untouched below.
  check('sidecar: an edit naming an unknown target routes to orphans',
    foldSidecarRecords([comment(), editLine({ target_id: 'no-such-id' })]).orphans.length === 1);
  check('sidecar: an edit naming a tombstoned target is a no-op, load does not error',
    foldSidecarRecords([comment(), tombstone({ target_id: 'c1', author: 'reviewer' }), editLine()]).threads.length === 0);
  check('sidecar: an edit naming a tombstoned target is NOT an orphan (ordinary race, not unresolvable)',
    foldSidecarRecords([comment(), tombstone({ target_id: 'c1', author: 'reviewer' }), editLine()]).orphans.length === 0);
  // Review finding (2026-07-28): a delete/edit whose target is ITSELF an
  // orphaned reply (its own parent doesn't resolve) must not be silently
  // "applied and hidden" — both the orphaned reply and the delete/edit line
  // must surface in `orphans`, never vanish without a trace.
  const deleteTargetsOrphanedReply = foldSidecarRecords([
    reply({ id: 'ghost-reply', parent_comment_id: 'no-such-comment' }),
    tombstone({ target_id: 'ghost-reply' }),
  ]);
  check('sidecar: a delete naming an orphaned reply routes BOTH lines to orphans, neither vanishes',
    deleteTargetsOrphanedReply.orphans.length === 2 &&
      deleteTargetsOrphanedReply.orphans.some((l) => l.type === 'reply' && l.id === 'ghost-reply') &&
      deleteTargetsOrphanedReply.orphans.some((l) => l.type === 'delete' && l.target_id === 'ghost-reply'));
  const editTargetsOrphanedReply = foldSidecarRecords([
    reply({ id: 'ghost-reply', parent_comment_id: 'no-such-comment' }),
    editLine({ target_id: 'ghost-reply' }),
  ]);
  check('sidecar: an edit naming an orphaned reply routes BOTH lines to orphans, neither vanishes',
    editTargetsOrphanedReply.orphans.length === 2 &&
      editTargetsOrphanedReply.orphans.some((l) => l.type === 'reply' && l.id === 'ghost-reply') &&
      editTargetsOrphanedReply.orphans.some((l) => l.type === 'edit' && l.target_id === 'ghost-reply'));
  // AC8: no authority check — any author's edit line is accepted for any target.
  check('sidecar: an edit is accepted regardless of whose name is on it (no authority check)',
    foldSidecarRecords([comment(), editLine({ author: 'someone-else' })]).threads[0].comment.body === 'edited body');
  // Same first-seen-wins defensive pattern every other line type has.
  check('sidecar: a duplicate edit id keeps the first-seen line',
    foldSidecarRecords([comment(), editLine({ body: 'first' }), editLine({ body: 'second' })]).threads[0].comment.body === 'first');
  check('sidecar: a duplicate edit id is flagged',
    foldSidecarRecords([comment(), editLine(), editLine()]).warnings.length === 1);

  // AC7 clause 2 / US-23.16 AC4-AC6: does this sidecar even describe the
  // document it sits next to? Decided by CONTENT, never by the file's
  // creation date — `git clone`/`git checkout` recreate the file so its birth
  // time becomes "now" while its comments stay older, which would discard
  // every comment after any fresh clone.
  {
    const withText = (text: string, id: string): SidecarThread =>
      foldSidecarRecords([comment({ id, anchor: { ...anchor, recorded_text: text } })]).threads[0];
    const realDoc =
      '# Requirement 23\n\nThis is **bold** text in a paragraph about requirement twenty three details right here.\n\n' +
      'See the specification document for full acceptance criteria details.\n\n' +
      'This is bold text in a paragraph today for sure.\n\nSee [the spec](a.md).\n';
    const foreignDoc = '# Sprint retro notes\n\nWhat went well this iteration.\n';
    // >= BELONGING_SINGLE_THREAD_MIN_CHARS (80) normalized chars, present in realDoc.
    const single80 = 'This is bold text in a paragraph about requirement twenty three details right here';
    // >= BELONGING_MIN_DISCRIMINATING_CHARS (40) normalized chars each, both present in realDoc.
    const discA = 'This is bold text in a paragraph today for sure.';
    const discB = 'See the specification document for full acceptance criteria details.';
    // >= 40 normalized chars each, present in NEITHER doc — real evidence, just the wrong one.
    const foreignLong1 = 'Sprint retro notes about what went well and what needs improvement this whole cycle';
    const foreignLong2 = 'Retro notes covering what went well and what could improve next sprint cycle';
    // < BELONGING_MIN_DISCRIMINATING_CHARS (40) normalized chars — a "Done"/"N/A"-style short match.
    const discShort = 'nothing like this here at all';

    // --- Single-thread case: the stricter 80-char floor (AC5) ---
    check('belonging (single thread): a match clearing the 80-char floor proves belonging',
      sidecarBelongsToDocument([withText(single80, 'c1')], realDoc) === 'belongs');
    check('belonging (single thread): a below-80-char match is not discriminating enough on its own',
      sidecarBelongsToDocument([withText(discA, 'c1')], realDoc) === 'unknown');
    check('belonging (single thread): a floor-clearing text absent from the document is foreign',
      sidecarBelongsToDocument([withText(single80, 'c1')], foreignDoc) === 'foreign');
    check('belonging: no threads at all yields no claim',
      sidecarBelongsToDocument([], foreignDoc) === 'unknown');

    // --- Multi-thread case: the 40-char floor, needs MORE THAN ONE match (AC5/AC6) ---
    check('belonging (multi-thread): more than one discriminating match proves belonging',
      sidecarBelongsToDocument([withText(discA, 'c1'), withText(discB, 'c2')], realDoc) === 'belongs');
    // Exactly one hit is real evidence, but it is also exactly the
    // boilerplate-recreated-file case AC5 guards against — not proof, and not
    // evidence against belonging either, so `unknown`, never `foreign`.
    check('belonging (multi-thread): exactly one discriminating match is not enough to prove belonging',
      sidecarBelongsToDocument([withText(discA, 'c1'), withText(discShort, 'c2')], realDoc) === 'unknown');
    check('belonging (multi-thread): threads below the floor contribute no evidence either way',
      sidecarBelongsToDocument([withText(discShort, 'c1'), withText('Done', 'c2')], foreignDoc) === 'unknown');
    check('belonging (multi-thread): zero discriminating matches is foreign',
      sidecarBelongsToDocument([withText(foreignLong1, 'c1'), withText(foreignLong2, 'c2')], realDoc) === 'foreign');
    // AC6: a partial rewrite (one section's anchors no longer match) is judged
    // by the SAME discriminating-match-count rule, not a separate signal — as
    // long as more than one thread still matches, the sidecar still belongs.
    check('belonging (AC6, partial rewrite): >1 surviving match still proves belonging alongside a non-matching third thread',
      sidecarBelongsToDocument(
        [withText(discA, 'c1'), withText(discB, 'c2'), withText(foreignLong1, 'c3')],
        realDoc
      ) === 'belongs');
    // Review finding (2026-07-28): two threads recording the IDENTICAL
    // discriminating text (this repo's own template boilerplate, repeated
    // verbatim across sections) must count as ONE piece of evidence, not
    // two — else a single repeated phrase defeats the "more than one match"
    // guard AC5 exists to enforce.
    const identicalBoilerplate = 'Acceptance criteria template phrase repeated across every section of this file';
    check('belonging (multi-thread): identical text recorded by two threads counts as ONE match, not two',
      sidecarBelongsToDocument(
        [withText(identicalBoilerplate, 'c1'), withText(identicalBoilerplate, 'c2')],
        realDoc + identicalBoilerplate + '\n'
      ) === 'unknown');

    check('belonging: NFD-authored recorded text still matches an NFC document',
      sidecarBelongsToDocument(
        [withText('Yêu cầu nghiệp vụ chi tiết cho hệ thống quản lý bình luận và thảo luận nhóm dự án'.normalize('NFD'), 'c7')],
        '## Yêu cầu nghiệp vụ chi tiết cho hệ thống quản lý bình luận và thảo luận nhóm dự án'.normalize('NFC')
      ) === 'belongs');
  }

  // US-23.16 AC7: the orphan-row pill label for each of the 5 orphanable line kinds.
  check('orphanKindLabel: reply', orphanKindLabel('reply') === 'Reply');
  check('orphanKindLabel: status-change', orphanKindLabel('status-change') === 'Status');
  check('orphanKindLabel: anchor-update', orphanKindLabel('anchor-update') === 'Anchor');
  check('orphanKindLabel: delete', orphanKindLabel('delete') === 'Delete');
  check('orphanKindLabel: edit', orphanKindLabel('edit') === 'Edit');

  // Regression (review 2026-07-26): an unparseable timestamp sorted LAST, so one
  // malformed field outranked every valid one and froze a thread's status.
  check('sidecar: a garbage timestamp cannot outrank a real later transition',
    foldSidecarRecords([
      comment(),
      statusChange({ id: 's1', timestamp: 'soon', to_status: 'Closed' }),
      statusChange({ id: 's2', timestamp: '2026-07-26T12:00:00.000Z', from_status: 'Closed', to_status: 'Open' }),
    ]).threads[0].status === 'Open');

  // AC5: name drift a rename event never reports. Never a raw `===` — decode →
  // NFC → separator → optional case-fold (CLAUDE.md's cross-platform trap).
  const nfcName = sidecarNameFor('Yêu cầu.md'.normalize('NFC'));
  const nfdName = sidecarNameFor('Yêu cầu.md'.normalize('NFD'));
  check('sidecar drift: the NFD and NFC names are genuinely different strings', nfcName !== nfdName);
  check('sidecar drift: NFD and NFC names match', sidecarNameMatches(nfdName, nfcName, false));
  check('sidecar drift: case drift matches on a case-insensitive FS',
    sidecarNameMatches(sidecarNameFor('Foo.md'), sidecarNameFor('foo.md'), true));
  check('sidecar drift: case drift does NOT match on a case-sensitive FS',
    sidecarNameMatches(sidecarNameFor('Foo.md'), sidecarNameFor('foo.md'), false) === false);
  // Regression (review 2026-07-26, 3/3 reviewers): the comparison must NOT
  // percent-decode. `a%20b.md` is a legal on-disk name, and an adopt is a
  // destructive rename — so conflating it with `a b.md` would let opening one file
  // steal the other's whole comment history. Mirrors normalizeAssetName's own rule.
  check('sidecar drift: a percent-encoded name is NOT the same file as its decoded form',
    sidecarNameMatches('a%20b.md.orca-comments.jsonl', 'a b.md.orca-comments.jsonl', false) === false);
  check('sidecar drift: a literal % that is not an escape still compares',
    sidecarNameMatches('100%.md.orca-comments.jsonl', '100%.md.orca-comments.jsonl', false));
  check('sidecar drift: the shared on-disk normalizer backs the comparison',
    sidecarNameMatches('Yêu.md.orca-comments.jsonl'.normalize('NFD'), 'Yêu.md.orca-comments.jsonl'.normalize('NFC'), false)
      && normalizeAssetName('Yêu.md'.normalize('NFD')) === normalizeAssetName('Yêu.md'.normalize('NFC')));
  // The paired-.md name is what lets adoptDrifted require an ORPHANED candidate.
  check('sidecar drift: the paired .md name is recoverable',
    mdNameForSidecar('foo.md.orca-comments.jsonl') === 'foo.md');
  check('sidecar drift: a non-sidecar has no paired .md name',
    mdNameForSidecar('foo.md') === null);
  check('sidecar drift: two unrelated names never match',
    sidecarNameMatches(sidecarNameFor('a.md'), sidecarNameFor('b.md'), true) === false);
  // The directory scan must only ever consider real sidecars.
  check('sidecar drift: a sidecar is recognised', isSidecarName('foo.md.orca-comments.jsonl'));
  check('sidecar drift: the paired .md is not a sidecar', isSidecarName('foo.md') === false);
  check('sidecar drift: an unrelated jsonl is not a sidecar', isSidecarName('data.jsonl') === false);
}

// --- Req 24 US-23.12: "Copy all as Markdown" serializer ---------------------
{
  eq('copy-markdown: timestamp format, +07:00 offset', formatExportTimestamp('2026-07-26T06:42:00.000Z', 420),
    '2026-07-26 13:42 +07:00');
  eq('copy-markdown: timestamp format, negative offset', formatExportTimestamp('2026-07-26T06:42:00.000Z', -300),
    '2026-07-26 01:42 -05:00');
  eq('copy-markdown: timestamp format, UTC (zero offset)', formatExportTimestamp('2026-07-26T06:42:00.000Z', 0),
    '2026-07-26 06:42 +00:00');
  check('copy-markdown: an unparseable timestamp is returned as-is, never "Invalid Date"',
    formatExportTimestamp('not-a-date', 0) === 'not-a-date');

  eq('copy-markdown: escapes the CommonMark punctuation set', escapeMarkdownInline('a *b* _c_ [d](e) <f> `g` h|i ~j# k'),
    'a \\*b\\* \\_c\\_ \\[d\\](e) \\<f\\> \\`g\\` h\\|i \\~j\\# k');
  eq('copy-markdown: escapes a leading dash list marker', escapeMarkdownInline('- looks like a list item'),
    '\\- looks like a list item');
  eq('copy-markdown: escapes a leading ordered-list marker', escapeMarkdownInline('1. looks ordered'),
    '1\\. looks ordered');
  check('copy-markdown: a mid-string dash is untouched', escapeMarkdownInline('a - b') === 'a - b');

  eq('copy-markdown: snippet collapses whitespace', buildSnippetLine('line one\n  line   two  '), '> line one line two');
  check('copy-markdown: a textless anchor omits the snippet entirely', buildSnippetLine('   ') === undefined);
  {
    const longText = 'x'.repeat(310);
    const snippet = buildSnippetLine(longText);
    check('copy-markdown: snippet is truncated at 300 code points with an ellipsis',
      snippet !== undefined && snippet === `> ${'x'.repeat(300)}…`);
  }
  {
    // Surrogate pair (a non-BMP emoji) landing exactly on the 300-char boundary
    // must never split into a lone surrogate.
    const emoji = '😀'; // 2 UTF-16 code units, 1 code point
    const longText = 'x'.repeat(299) + emoji + 'y'.repeat(10);
    const snippet = buildSnippetLine(longText) ?? '';
    check('copy-markdown: truncation never splits a surrogate pair',
      !/[\uD800-\uDBFF]$/.test(snippet.replace('…', '')) && snippet.includes(emoji));
  }

  const thread = (over: Partial<ExportThread> = {}): ExportThread => ({
    group: 'open',
    status: 'Open',
    location: { kind: 'line', line: 88, approximate: false },
    lastTransitionAuthor: 'hungvu',
    lastTransitionTimestamp: '2026-07-26T06:42:00.000Z',
    anchorText: 'the anchored text, whitespace-collapsed and truncated',
    comments: [{ author: 'hungvu', timestamp: '2026-07-26T06:42:00.000Z', body: 'Why does this contradict US-23.4?' }],
    ...over,
  });

  {
    const snapshot: ExportSnapshot = {
      docRelativePath: 'docs/Requirement - 23.md',
      exportedAtIso: '2026-07-27T07:03:00.000Z',
      foreignSidecar: false,
      threads: [thread()],
    };
    const md = renderCommentsMarkdown(snapshot);
    check('copy-markdown: header names the doc path, thread count and export time',
      md.startsWith('## Review — docs/Requirement - 23.md · 1 thread · '));
    check('copy-markdown: singular "1 thread", not "1 threads"', md.includes('· 1 thread ·'));
    check('copy-markdown: group heading with count', md.includes('### Open (1)'));
    check('copy-markdown: thread heading — status, location, author, timestamp, in order',
      md.includes('#### Open · Ln 88 · hungvu · '));
    check('copy-markdown: blockquoted snippet present for a non-floating, non-textless anchor',
      md.includes('> the anchored text, whitespace-collapsed and truncated'));
    check('copy-markdown: the opening comment is a top-level bullet',
      md.includes('- **hungvu** · ') && md.includes(' — Why does this contradict US-23.4?'));
    check('copy-markdown: ends with a trailing newline, LF only', md.endsWith('\n') && !md.includes('\r'));
  }

  {
    // AC4: two fields never appear — the thread id, and any status-change line
    // other than the last (no "trail").
    const t = thread({
      lastTransitionAuthor: 'otheruser',
      lastTransitionTimestamp: '2026-07-26T07:03:00.000Z',
      comments: [
        { author: 'hungvu', timestamp: '2026-07-26T06:42:00.000Z', body: 'Original comment.' },
        { author: 'otheruser', timestamp: '2026-07-26T07:03:00.000Z', body: 'Fixed, please re-check.' },
      ],
    });
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false, threads: [t],
    });
    check('copy-markdown: a reply is indented under the opening comment',
      md.includes('  - **otheruser** · ') && md.includes(' — Fixed, please re-check.'));
    check('copy-markdown: no thread id anywhere in the output (AC4 exclusion)', !/\bthreadId\b|\bid:\s*['"]/.test(md));
  }

  {
    // AC4: a floating thread — no blockquote, its own location wording, status kept independent of "floating".
    const t = thread({ group: 'floating', status: 'Resolved', location: { kind: 'floating' }, anchorText: 'unused' });
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false, threads: [t],
    });
    check('copy-markdown: floating group label is "Unresolved location"', md.includes('### Unresolved location (1)'));
    check('copy-markdown: floating thread heading reads "No anchor — Unresolved location", status kept',
      md.includes('#### Resolved · No anchor — Unresolved location · '));
    check('copy-markdown: no blockquote line for a floating thread', !md.includes('> unused'));
  }

  {
    // AC4: whole-document and approximate-range locations.
    const wholeDoc = thread({ location: { kind: 'wholeDocument', approximate: true } });
    const range = thread({ location: { kind: 'range', start: 12, end: 18, approximate: true } });
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false,
      threads: [wholeDoc, range],
    });
    check('copy-markdown: whole-document location with approximate marker',
      md.includes('Whole document (approximate)'));
    check('copy-markdown: multi-line range location with approximate marker', md.includes('Ln 12–18 (approximate)'));
  }

  {
    // AC3: empty groups omitted, fixed order Open -> Unresolved -> Resolved -> Closed.
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false,
      threads: [thread({ group: 'closed', status: 'Closed' }), thread({ group: 'open' })],
    });
    const openIdx = md.indexOf('### Open');
    const closedIdx = md.indexOf('### Closed');
    check('copy-markdown: Open group precedes Closed group', openIdx >= 0 && closedIdx > openIdx);
    check('copy-markdown: no empty group headings for absent groups',
      !md.includes('### Unresolved location') && !md.includes('### Resolved'));
  }

  {
    // AC4: the foreign-sidecar cause line sits directly under the document header.
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: true, threads: [thread()],
    });
    const lines = md.split('\n\n');
    check('copy-markdown: foreign-sidecar banner is the segment right after the header',
      lines[0].startsWith('## Review') && lines[1].includes('may describe a different document'));
  }

  {
    // AC4: an absent/blank author renders the literal "Unknown author".
    const t = thread({
      lastTransitionAuthor: '  ',
      comments: [{ author: '', timestamp: '2026-07-26T06:42:00.000Z', body: 'x' }],
    });
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false, threads: [t],
    });
    check('copy-markdown: blank thread-heading author renders "Unknown author"', md.includes('· Unknown author ·'));
    check('copy-markdown: blank comment author renders "Unknown author"', md.includes('**Unknown author** · '));
  }

  {
    // AC6: escaping must never alter the export's own structure — same heading
    // and top-level list-item counts whether or not the body/snippet carry
    // Markdown-significant characters.
    const headingCount = (s: string): number => (s.match(/^#{2,4} /gm) ?? []).length;
    const listItemCount = (s: string): number => (s.match(/^-\s|^  - /gm) ?? []).length;
    const plain = thread();
    const hostile = thread({
      anchorText: '# not a heading\n- not a list item',
      comments: [
        // Single-line on purpose — a multi-line body is fenced (verbatim), not
        // escaped; the fenced case is covered by its own test below.
        { author: '*bold* author', timestamp: '2026-07-26T06:42:00.000Z', body: '# fake heading - fake list `code`' },
      ],
    });
    const mdPlain = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false, threads: [plain],
    });
    const mdHostile = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false, threads: [hostile],
    });
    eq('copy-markdown round-trip: heading count unchanged by hostile body/snippet content',
      headingCount(mdHostile), headingCount(mdPlain));
    eq('copy-markdown round-trip: top-level list-item count unchanged by hostile body/snippet content',
      listItemCount(mdHostile), listItemCount(mdPlain));
    check('copy-markdown round-trip: the hostile snippet\'s "#"/"-" survive literally inside the blockquote',
      mdHostile.includes('> # not a heading - not a list item'));
    check('copy-markdown round-trip: the hostile body\'s leading "#" and its backticks are escaped',
      mdHostile.includes('\\# fake heading - fake list \\`code\\`'));
  }

  {
    // AC6: a multi-line body is fenced, never inlined — with a fence longer
    // than any backtick run already inside the body.
    const t = thread({ comments: [{ author: 'hungvu', timestamp: '2026-07-26T06:42:00.000Z', body: 'line one\n\nline two ``` still inside' }] });
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false, threads: [t],
    });
    check('copy-markdown: multi-line body is wrapped in a fence at least 4 backticks long',
      /````+\n/.test(md));
    check('copy-markdown: the fenced body text is verbatim (not escaped)',
      md.includes('line two ``` still inside'));
  }

  // AC8: the six disabled-reason causes, in priority order.
  const enabledInput = {
    sidecarProblem: undefined, loading: false, sidecarForeign: false,
    totalThreadCount: 3, exportableThreadCount: 3, hideClosed: false,
  };
  check('copy-disabled: nothing disables an ordinary exportable file',
    copyDisabledReason(enabledInput) === undefined);
  check('copy-disabled: a sidecar problem always wins first',
    copyDisabledReason({ ...enabledInput, sidecarProblem: 'The comment sidecar could not be read.' })
      === 'The comment sidecar could not be read.');
  check('copy-disabled: loading beats an empty-looking thread list',
    copyDisabledReason({ ...enabledInput, loading: true, totalThreadCount: 0, exportableThreadCount: 0 }) !== undefined);
  check('copy-disabled: foreign sidecar with zero threads names that cause',
    (copyDisabledReason({ ...enabledInput, sidecarForeign: true, totalThreadCount: 0, exportableThreadCount: 0 }) ?? '')
      .includes('may describe a different document'));
  check('copy-disabled: foreign sidecar with real threads present does NOT disable',
    copyDisabledReason({ ...enabledInput, sidecarForeign: true }) === undefined);
  check('copy-disabled: "Hide closed" hiding everything gets its own reason',
    copyDisabledReason({ ...enabledInput, exportableThreadCount: 0, hideClosed: true, totalThreadCount: 3 })
      !== undefined);
  check('copy-disabled: genuinely zero threads gets the generic no-comments reason',
    copyDisabledReason({ ...enabledInput, totalThreadCount: 0, exportableThreadCount: 0 })
      === 'No comments in this file to copy.');

  // AC1: the status-bar confirmation wording (host-side, comment-utils.ts).
  eq('copy-confirmation: singular, no hidden-closed suffix', copyConfirmationMessage(1, undefined),
    'Copied 1 thread as Markdown');
  eq('copy-confirmation: plural', copyConfirmationMessage(9, undefined), 'Copied 9 threads as Markdown');
  eq('copy-confirmation: names the excluded "Hide closed" count', copyConfirmationMessage(9, 3),
    'Copied 9 threads as Markdown (3 Closed hidden)');
  eq('copy-confirmation: a zero hidden-closed count is not named', copyConfirmationMessage(9, 0),
    'Copied 9 threads as Markdown');
}

// --- Req 24 US-23.14: editRejection (the host-side write-path validator) ------
{
  const base: EditCommentMessage = {
    type: 'editComment',
    requestId: 1,
    docUri: 'file:///a.md',
    threadId: 't1',
    body: 'a corrected body',
  };
  const rej = (over: Partial<EditCommentMessage> = {}, status: CommentStatus | undefined = 'Open', original?: string) =>
    editRejection({ ...base, ...over }, 'file:///a.md', status, original);

  check('edit-rejection: a valid edit on an Open thread is accepted', rej() === null);
  check('edit-rejection: a valid edit on a Resolved thread is accepted', rej({}, 'Resolved') === null);
  // AC1's Closed lockout, enforced on the write path (not only in the popover).
  check('edit-rejection: a Closed thread is refused',
    (rej({}, 'Closed') ?? '').includes('closed'));
  // Called directly, not through `rej`: passing `undefined` to a parameter that
  // HAS a default silently gets the default ('Open'), so the helper cannot
  // express "no such thread".
  check('edit-rejection: an unknown thread is refused',
    editRejection(base, 'file:///a.md', undefined) !== null);
  check('edit-rejection: a different document is refused',
    rej({ docUri: 'file:///other.md' }) !== null);
  check('edit-rejection: an empty threadId is refused', rej({ threadId: '' }) !== null);
  // AC7: empty/whitespace-only is what Delete is for.
  check('edit-rejection: an empty body is refused', rej({ body: '' }) !== null);
  check('edit-rejection: a whitespace-only body is refused', rej({ body: '   \n\t ' }) !== null);
  // Untrusted input: a non-string body must be refused, never reach `.trim()`
  // and throw inside the host handler (which would post no result at all).
  check('edit-rejection: a non-string body is refused, not thrown on',
    rej({ body: undefined as unknown as string }) !== null &&
      rej({ body: 42 as unknown as string }) !== null);
  // AC7's cap.
  check('edit-rejection: a body at the cap is accepted',
    rej({ body: 'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS) }) === null);
  check('edit-rejection: a body over the cap is refused',
    rej({ body: 'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS + 1) }) !== null);
  // ...but an ALREADY over-cap body (creation's own cap is unbuilt — US-23.10
  // AC10) must stay editable, and an edit must never be blamed for length it
  // did not introduce. Ceiling = max(cap, original length).
  const overLong = 'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS + 500);
  check('edit-rejection: an already-over-cap body can still be edited at its own length',
    rej({ body: overLong }, 'Open', overLong) === null);
  check('edit-rejection: an already-over-cap body can be edited DOWN',
    rej({ body: 'a'.repeat(100) }, 'Open', overLong) === null);
  check('edit-rejection: an already-over-cap body still cannot be GROWN further',
    rej({ body: 'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS + 501) }, 'Open', overLong) !== null);
  // AC8: no authority check anywhere in this validator — there is no author
  // parameter to gate on, unlike `deleteRejection`.
  check('edit-rejection: takes no author argument at all (AC8 — no authority check)',
    editRejection.length <= 4);
}

// --- Req 23 US-23.10 AC9: the shared body neutralize/EOL helpers -------------
{
  // Moved into `src/comments/comment-body-limit.ts` so the NATIVE write path
  // (US-23.14) gets the identical strip the webview already applied.
  check('body-neutralize: a bidi override (Trojan Source) is stripped',
    neutralizeCommentBody('safe‮evil') === 'safeevil');
  check('body-neutralize: a bidi isolate is stripped',
    neutralizeCommentBody('a⁦b⁩c') === 'abc');
  check('body-neutralize: a C0 control char is stripped', neutralizeCommentBody('ab') === 'ab');
  check('body-neutralize: newline and tab survive (a body is multi-line)',
    neutralizeCommentBody('a\nb\tc') === 'a\nb\tc');
  check('body-eol: CRLF and lone CR both reconcile to LF',
    normalizeCommentBodyEol('a\r\nb\rc') === 'a\nb\nc');
  // The webview's own exports must be the SAME behaviour, not a second copy.
  check('body-neutralize: dom-utils delegates to the shared implementation',
    neutralizeBodyText('x‮y') === neutralizeCommentBody('x‮y') &&
      normalizeBodyEol('x\r\ny') === normalizeCommentBodyEol('x\r\ny'));
}

// --- Req 23 US-23.10 AC10 / Req 24 US-23.14 AC7: comment-body length bound --
{
  check('body-limit: an empty string counts as 0 code points', commentBodyCodePointLength('') === 0);
  check('body-limit: plain ASCII counts one per character', commentBodyCodePointLength('hello') === 5);
  // Code-point-safe: an astral character (surrogate pair in UTF-16) counts as 1.
  check('body-limit: a surrogate-pair (astral) character counts as ONE code point',
    commentBodyCodePointLength('😀') === 1 && '😀'.length === 2);
  check('body-limit: text under the cap is returned unchanged',
    clipCommentBodyToLimit('short text') === 'short text');
  const exact = 'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS);
  check('body-limit: text exactly at the cap is unchanged', clipCommentBodyToLimit(exact) === exact);
  const over = 'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS + 50);
  const clipped = clipCommentBodyToLimit(over);
  check('body-limit: text over the cap is clipped to exactly the cap',
    commentBodyCodePointLength(clipped) === COMMENT_BODY_MAX_CODEPOINTS);
  // Never split a surrogate pair mid-character when clipping at the boundary.
  const astralOver = `${'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS - 1)}😀EXTRA`;
  const astralClipped = clipCommentBodyToLimit(astralOver);
  check('body-limit: clipping never splits a surrogate pair',
    commentBodyCodePointLength(astralClipped) === COMMENT_BODY_MAX_CODEPOINTS &&
      astralClipped.endsWith('😀'));
  check('body-limit: the counter threshold sits below the hard cap',
    COMMENT_BODY_COUNTER_THRESHOLD < COMMENT_BODY_MAX_CODEPOINTS);
}

// --- Req 24 US-23.22: an unregistered #content class fails `npm test` --------
//
// Source-scanning check, same shape (and same `process.cwd()` convention) as
// the `src/provider.ts` security tripwire above. The scan itself and the two
// exemption arrays live in `test/transient-class-scan.ts`; this block is the
// gate that runs it against the real tree, plus positive controls proving the
// scan is not silently vacuous.
{
  const WEBVIEW_DIR = path.join(process.cwd(), 'media/webview');
  // Recursive: a module moved into a subdirectory must not fall out of the scan
  // without anything saying so.
  const webviewFiles: SourceFile[] = fs
    .readdirSync(WEBVIEW_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      file: name,
      source: fs.readFileSync(path.join(WEBVIEW_DIR, name), 'utf8'),
    }));
  const scopes = collectClassConstants(webviewFiles);
  const sourceOf = (name: string): string =>
    webviewFiles.find((f) => f.file === name)?.source ?? '';

  // A floor, so a botched glob or a relocated directory reports itself instead
  // of yielding a triumphantly empty scan. The tree held 62 modules when this
  // landed; the floor is deliberately loose — it guards against collapse, not
  // against ordinary deletion.
  check(
    'transient-classes: the scan actually reached the webview modules',
    webviewFiles.length >= 50,
    `  files scanned = ${webviewFiles.length}`
  );

  const identifiers = readTransientClassIdentifiers(sourceOf('turndown.ts'));
  const turndownScope = scopes.get('turndown.ts') ?? new Map<string, string>();
  const registered = new Set<string>();
  const unresolvedIdentifiers: string[] = [];
  for (const id of identifiers) {
    const value = turndownScope.get(id);
    if (value === undefined) {
      unresolvedIdentifiers.push(id);
    } else {
      registered.add(value);
    }
  }

  check(
    'transient-classes: every TRANSIENT_CLASSES entry resolves to a class name',
    identifiers.length > 0 && unresolvedIdentifiers.length === 0,
    `  entries = ${identifiers.length}, unresolved = ${JSON.stringify(unresolvedIdentifiers)}`
  );

  // A file that declares one identifier twice with different values makes every
  // resolution in it a coin flip, so refuse to resolve rather than guess.
  const ambiguous = findAmbiguousConstants(webviewFiles);
  check(
    'transient-classes: no file declares one class constant twice with different values',
    ambiguous.length === 0,
    `  ambiguous: ${JSON.stringify(ambiguous)}`
  );

  // AC2 — one declaration site: every registered name is an EXPORTED constant in
  // constants.ts, holding the same value the strip list resolved. Matching the
  // identifier alone would pass a `FOO_CLASS` imported from elsewhere while
  // constants.ts happens to declare a different `FOO_CLASS`.
  const constantsExported = exportedConstants(sourceOf('constants.ts'));
  const notInConstants = identifiers.filter(
    (id) => constantsExported.get(id) === undefined || constantsExported.get(id) !== turndownScope.get(id)
  );
  check(
    'transient-classes (AC2): every registered name is an exported constant in constants.ts',
    notInConstants.length === 0,
    `  missing or mismatched: ${JSON.stringify(notInConstants)}`
  );

  const scan = scanStampedClasses(webviewFiles, scopes);

  // AC1 — the actual gate: a class stamped anywhere in media/webview must be
  // registered for strip, or exempted for the specific file that stamps it.
  const exemptSites = new Set(OUTSIDE_CONTENT_CLASSES);
  const unregistered: Array<{ name: string; site: StampSite }> = [];
  for (const [name, sites] of scan.names) {
    if (registered.has(name)) {
      continue;
    }
    for (const site of sites) {
      if (!exemptSites.has(`${site.file} | ${name}`)) {
        unregistered.push({ name, site });
      }
    }
  }
  check(
    'transient-classes (AC1): no unregistered class is stamped in media/webview',
    unregistered.length === 0,
    unregistered
      .map(
        ({ name, site }) =>
          `  "${name}" added at ${site.file}:${site.line}` +
          ` — register it in turndown.ts's TRANSIENT_CLASSES if it lands inside #content,` +
          ` else add "${site.file} | ${name}" to OUTSIDE_CONTENT_CLASSES in test/transient-class-scan.ts`
      )
      .join('\n')
  );

  // AC1 — "cannot resolve = fail": a computed class expression, and anything the
  // scan could not parse at all, is a failure until someone parks it on the
  // exemption array with a reason.
  const exemptExpressions = new Set(UNRESOLVED_STAMP_EXEMPTIONS);
  const rogueExpressions = scan.unresolved.filter(
    (u) => !exemptExpressions.has(`${u.file} | ${u.expr}`)
  );
  check(
    'transient-classes (AC1): no unreadable class expression is unaccounted for',
    rogueExpressions.length === 0,
    rogueExpressions
      .map(
        (u) =>
          `  ${u.file}:${u.line} stamps \`${u.expr}\`` +
          ` — resolve it to a constants.ts constant if it names a #content class,` +
          ` else add "${u.file} | ${u.expr}" to UNRESOLVED_STAMP_EXEMPTIONS in test/transient-class-scan.ts`
      )
      .join('\n')
  );

  // AC2 — a registered class must never be stamped as a bare string literal:
  // that is the second declaration site the rule exists to prevent.
  const literalRegistered = [...scan.literalNames.entries()].filter(([name]) =>
    registered.has(name)
  );
  check(
    'transient-classes (AC2): no registered class is stamped as a bare literal',
    literalRegistered.length === 0,
    literalRegistered
      .map(([name, sites]) => `  "${name}" at ${sites[0].file}:${sites[0].line}`)
      .join('\n')
  );

  // Both exemption arrays are grandfather lists, not permanent policy — an entry
  // whose stamp site is gone must be deleted, or the list quietly grows into a
  // place where a real leak can hide.
  const liveSites = new Set<string>();
  for (const [name, sites] of scan.names) {
    for (const site of sites) {
      liveSites.add(`${site.file} | ${name}`);
    }
  }
  const staleClassExemptions = OUTSIDE_CONTENT_CLASSES.filter((key) => !liveSites.has(key));
  check(
    'transient-classes: OUTSIDE_CONTENT_CLASSES has no stale entry',
    staleClassExemptions.length === 0,
    `  no longer stamped anywhere: ${JSON.stringify(staleClassExemptions)}`
  );
  const liveExpressions = new Set(scan.unresolved.map((u) => `${u.file} | ${u.expr}`));
  const staleExprExemptions = UNRESOLVED_STAMP_EXEMPTIONS.filter((k) => !liveExpressions.has(k));
  check(
    'transient-classes: UNRESOLVED_STAMP_EXEMPTIONS has no stale entry',
    staleExprExemptions.length === 0,
    `  no longer stamped anywhere: ${JSON.stringify(staleExprExemptions)}`
  );

  // The third obligation `turndown.ts`'s own comment states: registering a class
  // without a strip case leaves the registration itself unproven. Named-case and
  // clone-safety arrays there are hand-written string lists, so pin them against
  // the live strip list rather than trusting them to stay in sync.
  const stripTestSource = fs.readFileSync(
    path.join(process.cwd(), 'test/roundtrip/style-preservation.ts'),
    'utf8'
  );
  const withoutStripCase = [...registered].filter((name) => !stripTestSource.includes(`'${name}'`));
  check(
    'transient-classes: every registered class has a strip case in style-preservation.ts',
    withoutStripCase.length === 0,
    `  no roundtrip case names: ${JSON.stringify(withoutStripCase)}`
  );

  // --- Positive controls: the scan must actually see each shape it claims to.
  const probe = (source: string): ReturnType<typeof scanStampedClasses> => {
    const files: SourceFile[] = [{ file: 'probe.ts', source }];
    return scanStampedClasses(files, collectClassConstants(files));
  };

  const added = probe(`node.classList.add('brand-new-content-class');`);
  check(
    'transient-classes (control): a new classList.add literal is reported',
    added.names.has('brand-new-content-class') && added.unresolved.length === 0
  );

  const multi = probe(`node.className = 'first-class second-class';`);
  check(
    'transient-classes (control): a multi-name className assignment reports both names',
    multi.names.has('first-class') && multi.names.has('second-class')
  );

  const viaAttr = probe(`svg.setAttribute('class', 'attr-stamped-class');`);
  check(
    "transient-classes (control): setAttribute('class', …) is reported",
    viaAttr.names.has('attr-stamped-class')
  );

  const otherAttr = probe(`svg.setAttribute('viewBox', '0 0 16 16');`);
  check(
    'transient-classes (control): a non-class setAttribute is not mistaken for a stamp',
    otherAttr.names.size === 0 && otherAttr.unresolved.length === 0
  );

  const computed = probe('node.className = `mode-${current}`;');
  check(
    'transient-classes (control): a template-literal class is reported as unresolved, never silently passed',
    computed.names.size === 0 && computed.unresolved.length === 1
  );

  const viaConstant = probe(
    `const PROBE_CLASS = 'probe-resolved';\nnode.classList.add(PROBE_CLASS);`
  );
  check(
    'transient-classes (control): a constant stamp resolves to its literal, not to the identifier',
    viaConstant.names.has('probe-resolved') && !viaConstant.names.has('PROBE_CLASS')
  );

  const toggled = probe(`node.classList.toggle('toggled-class', enabled);`);
  check(
    'transient-classes (control): classList.toggle reports the class but not its force argument',
    toggled.names.has('toggled-class') && toggled.unresolved.length === 0
  );

  const compared = probe(`if (node.className === 'not-a-stamp') { return; }`);
  check(
    'transient-classes (control): a className comparison is not mistaken for a stamp',
    compared.names.size === 0 && compared.unresolved.length === 0
  );

  // --- Controls for the shapes a 2026-07-28 review found silently unscanned.
  // Every one of these returned BOTH an empty name set and an empty unresolved
  // list before the fix, i.e. the gate reported success on a stamp it never read.
  const wrappedAdd = probe(`node.classList.add(\n  'wrapped-class',\n);`);
  check(
    'transient-classes (control): a classList.add whose arguments start on the next line is still read',
    wrappedAdd.names.has('wrapped-class') && wrappedAdd.unresolved.length === 0
  );

  const wrappedTwoArgs = probe(`node.classList.add(\n  'first-wrapped',\n  'second-wrapped'\n);`);
  check(
    'transient-classes (control): a wrapped multi-argument classList.add drops neither name',
    wrappedTwoArgs.names.has('first-wrapped') && wrappedTwoArgs.names.has('second-wrapped')
  );

  const wrappedToggle = probe(`node.classList.toggle(\n  'wrapped-toggle',\n  on\n);`);
  check(
    'transient-classes (control): a wrapped classList.toggle is still read',
    wrappedToggle.names.has('wrapped-toggle') && wrappedToggle.unresolved.length === 0
  );

  const wrappedTernary = probe(`node.className = isEnd\n  ? 'ternary-a'\n  : 'ternary-b';`);
  check(
    'transient-classes (control): a wrapped ternary assignment reports one whole expression, not a truncated one',
    wrappedTernary.unresolved.length === 1 &&
      wrappedTernary.unresolved[0].expr === "isEnd ? 'ternary-a' : 'ternary-b'"
  );

  const appended = probe(`node.className += ' appended-class';`);
  check(
    'transient-classes (control): `className +=` is scanned like an assignment',
    appended.names.has('appended-class')
  );

  const replaced = probe(`node.classList.replace('replace-old', 'replace-new');`);
  check(
    'transient-classes (control): classList.replace reports both class names',
    replaced.names.has('replace-old') && replaced.names.has('replace-new')
  );

  const optionalChain = probe(`node.classList?.add('optional-chain-class');`);
  check(
    'transient-classes (control): the optional-chain spelling is scanned',
    optionalChain.names.has('optional-chain-class')
  );

  const inComment = probe(`// node.classList.add('ghost-from-comment')\nconst x = 1;`);
  check(
    'transient-classes (control): a stamp shown inside a comment is not treated as real',
    inComment.names.size === 0 && inComment.unresolved.length === 0
  );

  const inBlockComment = probe(`/* node.classList.add('ghost-from-block') */\nconst x = 1;`);
  check(
    'transient-classes (control): a stamp shown inside a block comment is not treated as real',
    inBlockComment.names.size === 0 && inBlockComment.unresolved.length === 0
  );

  const urlInString = probe(`const u = 'https://x';\nnode.classList.add('after-url-class');`);
  check(
    'transient-classes (control): a // inside a string literal does not blind the rest of the line',
    urlInString.names.has('after-url-class')
  );

  const parenInLiteral = probe(`node.classList.add('has)paren');`);
  check(
    'transient-classes (control): a parenthesis inside a class literal does not truncate the argument',
    parenInLiteral.names.has('has)paren') && parenInLiteral.unresolved.length === 0
  );

  const emptyLiteral = probe(`node.classList.add('');`);
  check(
    'transient-classes (control): an empty class literal is reported, not silently dropped',
    emptyLiteral.names.size === 0 && emptyLiteral.unresolved.length === 1
  );

  const unclosed = probe(`node.classList.add('never-closed'`);
  check(
    'transient-classes (control): an unparsable stamp is reported, not silently dropped',
    unclosed.unresolved.length === 1
  );
}


console.log(`\n${pass} pass, ${fail} fail`);
if (failures.length) {
  console.log('\n' + failures.join('\n\n'));
  process.exit(1);
}
