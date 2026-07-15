/**
 * Unit test cho logic THUẦN của extension host (src/text-utils.ts) — không cần
 * VS Code runtime. Bao computeMinimalEdit, normalizeForSearch, relativePath,
 * classifyLink (scheme allowlist) và một kiểm tra type-level của message
 * contract (src/shared/messages.ts). (finding C6)
 *
 * Chạy: npm run test:unit
 */
import {
  classifyLink,
  computeMinimalEdit,
  imageNamePrefix,
  normalizeForSearch,
  relativePath,
  sanitizeDroppedFileName,
  type MinimalEdit,
} from '../src/text-utils';
import type { HostToWebview, WebviewToHost } from '../src/shared/messages';
import { findTextMatches, type MatchOptions } from '../src/shared/text-match';

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

// ---------------------------------------------------------------------------
// imageNamePrefix — prefix tên ảnh dán (C4: dọn ảnh mồ côi khi save)
// ---------------------------------------------------------------------------

eq('prefix: basename thường', imageNamePrefix('Requirement Doc'), 'requirement-doc');
eq('prefix: bỏ dấu tiếng Việt như normalizeForSearch', imageNamePrefix('Đăng ký sự kiện'), 'dang-ky-su-kien');
eq('prefix: chỉ ký tự CJK → rỗng (fallback không prefix)', imageNamePrefix('日本語'), '');
check('prefix: giới hạn độ dài 40 ký tự', imageNamePrefix('a'.repeat(100)).length === 40);

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

// ---------------------------------------------------------------------------
// message contract (src/shared/messages.ts) — kiểm tra ở mức TYPE. Nếu hình
// dạng message đổi mà quên cập nhật, các gán dưới đây sẽ không biên dịch (tsc).
// ---------------------------------------------------------------------------

const fromWebview: WebviewToHost[] = [
  { type: 'ready' },
  { type: 'edit', text: 'x' },
  { type: 'openLink', href: 'https://x' },
  { type: 'searchFiles', query: 'q', requestId: 1 },
  { type: 'addToClaudeContext' },
  { type: 'viewSource' },
  { type: 'crossFileSearch:request', requestId: 1, query: 'q', scope: 'markdown', matchCase: false, wholeWord: true },
  { type: 'crossFileSearch:openResult', uri: 'file:///a.md', line: 0, character: 0, length: 1, matchText: 'x' },
  { type: 'crossFileSearch:openInSearchPanel', query: 'q', scope: 'allFiles' },
  { type: 'pasteImage', requestId: 1, mime: 'image/png', dataBase64: 'AA==' },
  { type: 'dropFile', requestId: 1, name: 'report.pdf', dataBase64: 'AA==' },
  { type: 'zenChanged', zen: true },
];
const readabilityFixture = {
  enabled: false, preset: 'comfortable', palette: 'followTheme',
  fontFamily: '', zen: false,
} as const;
const toWebview: HostToWebview[] = [
  { type: 'init', text: 'x', config: {
    breaks: false, linkify: true, wordWrap: false, fontSize: 14,
    lineHeight: 1.6, fontFamily: 'sans', autoOpenToc: true, showLineNumbers: true,
    crossFileSearchScope: 'markdown', readability: readabilityFixture,
  } },
  { type: 'init', text: 'x', config: {
    breaks: false, linkify: true, wordWrap: false, fontSize: 14,
    lineHeight: 1.6, fontFamily: 'sans', autoOpenToc: true, showLineNumbers: true,
    crossFileSearchScope: 'markdown', readability: readabilityFixture,
  }, reveal: { line: 0, character: 0, length: 1 } },
  { type: 'update', text: 'x' },
  { type: 'fileSearchResult', requestId: 1, files: [{ path: 'a.md', name: 'a.md', dir: '.' }] },
  { type: 'configUpdate', autoOpenToc: true, showLineNumbers: true },
  { type: 'crossFileSearch:result', requestId: 1, groups: [], truncated: false, usedFallback: false },
  { type: 'scrollToPosition', line: 0, character: 0, length: 1 },
  { type: 'pasteImageResult', requestId: 1, relativePath: 'images/a.png' },
  { type: 'dropFileResult', requestId: 1, relativePath: 'assets/report.pdf' },
  { type: 'zenChanged', zen: true },
];
check('contract: WebviewToHost phủ đủ 12 biến thể', fromWebview.length === 12);
check('contract: HostToWebview phủ đủ 10 biến thể (init có/không reveal + scrollToPosition + pasteImage + dropFile + zenChanged)', toWebview.length === 10);

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

console.log(`\n${pass} pass, ${fail} fail`);
if (failures.length) {
  console.log('\n' + failures.join('\n\n'));
  process.exit(1);
}
