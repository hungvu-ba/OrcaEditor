/**
 * Feature: Toolbar insert actions & paste-image (HLR mục 4.4, 4.5, 4.10-4.12,
 * 4.20, 8.5 — xem ../../../OrcaEditor-Requirements/Requirement - 04 Formatting
 * Toolbar.md và Requirement - 08 Links & Images.md). Các thao tác toolbar này
 * chèn thẳng literal HTML (qua document.execCommand('insertHTML', ...)) hoặc
 * literal markdown (qua ctx.insertMarkdown, dùng cho math/mermaid) nên biểu
 * diễn được bằng test không cần execCommand/Selection sống:
 *  - Horizontal rule, insertCodeBlock, insertLink (nhánh caret rỗng),
 *    insertImage, paste-image insertImageAt: test kiểu DOM-outcome — dựng
 *    ĐÚNG HTML mà hàm nguồn tạo ra (đọc thẳng source, xem chú thích từng case),
 *    feed vào serializeHtml(), rồi assert markdown + tính ổn định khi
 *    render→serialize lại lần 2. insertLink()/insertImage() giờ encodeLinkPath()
 *    path tương đối (fix 2026-07-14 — bug phát hiện qua chính bộ test này: path
 *    có dấu cách không encode làm markdown đổi hình dạng ở lần render thứ 2),
 *    giữ nguyên URL tuyệt đối qua isAbsoluteUrl() (encodeLinkPath sẽ phá
 *    "://" và query string).
 *  - Math/Mermaid templates: literal markdown thật (không phải DOM giả lập)
 *    nên dùng thẳng runner.roundtrip() với đúng chuỗi hằng số trong toolbar.ts.
 *
 * KHÔNG test được (và không giả vờ test):
 *  - insertLink() nhánh vùng chọn KHÔNG collapsed → dùng
 *    document.execCommand('createLink', ...) trên Selection sống, domino
 *    (DOM giả lập Node dùng trong test) không cài execCommand/Selection thật.
 *
 * Chạy riêng: npm run test:roundtrip:toolbar-insert
 */
import { Runner, serializeHtml, renderer } from './_lib';
import { escapeAttr, encodeLinkPath } from '../../media/webview/dom-utils';

const runner = new Runner();

interface DomCase {
  name: string;
  html: string;
  expect: (md: string) => boolean;
}

const domCases: DomCase[] = [
  // ---------------------------------------------------------------------
  // 1. Horizontal rule (toolbar.ts, nút '—'):
  //    execCommand('insertHTML', false, '<hr><p><br></p>')
  //    LƯU Ý: cố ý KHÔNG test trường hợp <hr> là NỘI DUNG DUY NHẤT của toàn bộ
  //    tài liệu (vd chèn HR đầu tiên vào file .md trống) — đã xác minh thủ công
  //    trường hợp đó khiến markdown-it-front-matter (thư viện ngoài, xem
  //    render.ts) hiểu nhầm "---\n" đơn độc là front-matter rỗng (ambiguity có
  //    thật giữa "---" mở front-matter và "---" là hr, gặp ở mọi parser hỗ trợ
  //    front-matter, không riêng gì HR button) → round-trip không ổn định
  //    ("---\n" → "---\n\n---\n"). Case dưới đặt HR giữa nội dung thật (kịch
  //    bản thực tế khi dùng nút toolbar) để tránh vùng ambiguity đó; bug góc độ
  //    "file .md trống rồi chèn HR đầu tiên" nên theo dõi riêng ở HLR mục 2.7.
  // ---------------------------------------------------------------------
  {
    name: 'Horizontal rule (US-4.x) → <hr><p><br></p> serialize thành --- giữa nội dung',
    html: '<p>trước</p><hr><p><br></p><p>sau</p>',
    expect: (md) => {
      const iBefore = md.indexOf('trước');
      const iHr = md.search(/^-{3,}\s*$/m);
      const iAfter = md.indexOf('sau');
      return iBefore >= 0 && iHr > iBefore && iAfter > iHr;
    },
  },

  // ---------------------------------------------------------------------
  // 2. insertCodeBlock(lang) nhánh KHÔNG có vùng chọn (US-4.10/4.11):
  //    `<pre><code class="language-${lang}">${escapeHtml(selectedText || 'code')}</code></pre><p><br></p>`
  // ---------------------------------------------------------------------
  {
    name: 'insertCodeBlock không vùng chọn, lang=javascript → fence + nội dung mặc định "code"',
    html: '<pre><code class="language-javascript">code</code></pre><p><br></p>',
    expect: (md) => md.includes('```javascript') && md.includes('code') && md.trim().endsWith('```'),
  },
  {
    name: 'insertCodeBlock không vùng chọn, lang=plaintext → fence đúng ngôn ngữ',
    html: '<pre><code class="language-plaintext">code</code></pre><p><br></p>',
    expect: (md) => md.includes('```plaintext') && md.includes('code') && md.trim().endsWith('```'),
  },

  // ---------------------------------------------------------------------
  // 3. insertCodeBlock(lang) nhánh CÓ vùng chọn trong <p>/heading (US-4.10):
  //    tách before/pre/after — beforeBlock chỉ xuất hiện nếu beforeHtml.trim()
  //    khác rỗng; afterBlock LUÔN xuất hiện (dùng '<br>' nếu afterHtml rỗng).
  //    Case: đoạn "Hello world foo", chọn "world" giữa câu.
  // ---------------------------------------------------------------------
  {
    name: 'insertCodeBlock có vùng chọn giữa đoạn văn → tách before/pre/after 3 block',
    html: '<p>Hello </p><pre><code class="language-javascript">world</code></pre><p> foo</p>',
    expect: (md) => {
      const iHello = md.indexOf('Hello');
      const iFence = md.indexOf('```javascript');
      const iWorld = md.indexOf('world');
      const iFoo = md.indexOf('foo');
      return iHello >= 0 && iFence > iHello && iWorld > iFence && iFoo > iWorld;
    },
  },
  {
    name: 'insertCodeBlock có vùng chọn ở ĐẦU heading (before rỗng) → không có block "before"',
    html: '<pre><code class="language-python">world</code></pre><h2> foo</h2>',
    expect: (md) => md.includes('```python') && md.includes('world') && md.includes('## foo'),
  },
  {
    name: 'insertCodeBlock có vùng chọn ở CUỐI đoạn (after rỗng) → afterBlock dùng <br>, vẫn ổn định',
    html: '<p>Hello </p><pre><code class="language-javascript">world</code></pre><p><br></p>',
    expect: (md) => md.includes('Hello') && md.includes('```javascript') && md.includes('world'),
  },
  // Bug 2026-07-14: vùng chọn trải qua NHIỀU block (vd. chọn từ giữa đoạn này
  // sang giữa đoạn kế, xuyên qua một đoạn TRẮNG ở giữa — "xuống dòng có dòng
  // trắng"). Trước fix, code chỉ selectNode() đúng block ĐẦU (theo
  // range.startContainer) khi thay thế, nên đoạn trắng + đoạn thứ hai (vốn đã
  // nằm trong `codeContent` vì lấy từ sel.toString()) không hề bị xoá khỏi
  // DOM → nội dung bị nhân đôi. Sau fix, hàm dùng thêm `endBlock` (từ
  // range.endContainer) làm điểm kết afterRange/afterBlock, và
  // setStartBefore(block)/setEndAfter(endBlock) khi thay thế để xoá HẾT mọi
  // block nằm giữa (kể cả đoạn trắng) — case dưới đây mô phỏng đúng DOM mà
  // hàm đã fix tạo ra: 1 <pre> duy nhất chứa toàn bộ text đã chọn (xuyên đoạn
  // trắng), before/after mỗi bên đúng 1 lần — không còn đoạn trắng/đoạn cũ
  // sót lại phía dưới.
  {
    name: 'insertCodeBlock vùng chọn xuyên nhiều block qua 1 đoạn trắng → không nhân đôi nội dung, không còn đoạn trắng sót lại',
    html: '<p>Hello </p><pre><code class="language-javascript">world\n\nfoo</code></pre><p> bar</p>',
    expect: (md) => {
      const helloCount = (md.match(/Hello/g) ?? []).length;
      const worldCount = (md.match(/world/g) ?? []).length;
      const fooCount = (md.match(/foo/g) ?? []).length;
      const barCount = (md.match(/bar/g) ?? []).length;
      return helloCount === 1 && worldCount === 1 && fooCount === 1 && barCount === 1;
    },
  },

  // ---------------------------------------------------------------------
  // 4. insertLink() nhánh caret rỗng (collapsed) — US-8.x:
  //    execCommand('insertHTML', false,
  //      `<a href="${escapeAttr(url)}">${escapeHtml(displayText ?? url)}</a>`)
  //    Nhánh selection KHÔNG collapsed dùng execCommand('createLink', ...) —
  //    không test được trong Node (xem doc comment đầu file).
  // ---------------------------------------------------------------------
  {
    name: 'insertLink caret rỗng, URL/text đơn giản → [text](url)',
    html: '<p>Check out <a href="https://example.com">Example</a> here</p>',
    expect: (md) => md.includes('[Example](https://example.com)'),
  },
  {
    name: 'insertLink caret rỗng, URL/text có ký tự cần escape (&, <, >) → escapeAttr/escapeHtml rồi giải mã lại đúng nghĩa',
    // escapeAttr('https://example.com/search?q=a&b=1') = '...q=a&amp;b=1'
    // escapeHtml('A & B <link>') = 'A &amp; B &lt;link&gt;'
    // turndown TỰ escape "<" trong text link thành "\<" (tránh nhập nhằng với
    // thẻ HTML khi đọc lại markdown thô) — hành vi đúng, không phải bug; assert
    // đúng dạng đã escape thay vì literal "<link>" chưa escape.
    html: '<p><a href="https://example.com/search?q=a&amp;b=1">A &amp; B &lt;link&gt;</a></p>',
    expect: (md) => md.includes('https://example.com/search?q=a&b=1') && md.includes('A & B \\<link>'),
  },
  {
    // Fix 2026-07-14: insertLink() giờ encodeLinkPath() path tương đối (không
    // có scheme, kiểm bằng isAbsoluteUrl) trước khi chèn — trước fix, path có
    // dấu cách bị turndown bọc `<...>` rồi mất ổn định ở lần render thứ 2
    // (markdown-it tự percent-encode dấu cách trong `<...>`, turndown bỏ dấu
    // ngoặc không còn cần thiết → đổi hình dạng). Case dưới mô phỏng ĐÚNG HTML
    // insertLink() tạo ra SAU fix cho 1 path tương đối có dấu cách.
    name: 'insertLink caret rỗng, path tương đối có dấu cách → encodeLinkPath mã hóa %20, ổn định qua 2 lần render',
    html: `<p><a href="${escapeAttr(encodeLinkPath('my notes/Meeting notes.md'))}">Meeting notes</a></p>`,
    expect: (md) => md.includes('[Meeting notes](my%20notes/Meeting%20notes.md)'),
  },

  // ---------------------------------------------------------------------
  // 5. insertImage() (toolbar, US-8.5): `<img src="${escapeAttr(href)}" alt="">`
  //    với href = isAbsoluteUrl(src) ? src : encodeLinkPath(src) (fix
  //    2026-07-14 — trước đó KHÔNG encode gì, path tương đối có dấu cách mất
  //    ổn định qua lần render→serialize thứ 2, xem git blame toolbar.ts nếu
  //    cần xem lại hành vi cũ). Cùng cơ chế với insertImageAt() của
  //    paste-image.ts (case 6 dưới) — chỉ khác chỗ insertImage() còn phải
  //    chừa đường cho URL tuyệt đối (paste-image luôn là path tương đối).
  // ---------------------------------------------------------------------
  {
    name: 'insertImage toolbar, đường dẫn tương đối cơ bản',
    html: `<p><img src="${escapeAttr(encodeLinkPath('images/pic.png'))}" alt=""></p>`,
    expect: (md) => md.includes('![](images/pic.png)'),
  },
  {
    name: 'insertImage toolbar, đường dẫn tương đối có ký tự cần encode (&) → %26, ổn định',
    // encodeLinkPath('images/pic&1.png') = 'images/pic%261.png' (encodeURIComponent mã hóa "&")
    html: `<p><img src="${escapeAttr(encodeLinkPath('images/pic&1.png'))}" alt=""></p>`,
    expect: (md) => md.includes('![](images/pic%261.png)'),
  },
  {
    name: 'insertImage toolbar, đường dẫn tương đối có dấu cách → encodeLinkPath mã hóa %20, ổn định qua 2 lần render',
    html: `<p><img src="${escapeAttr(encodeLinkPath('my images/pic1.png'))}" alt=""></p>`,
    expect: (md) => md.includes('![](my%20images/pic1.png)'),
  },
  {
    // isAbsoluteUrl(src) === true (có scheme "https:") → GIỮ NGUYÊN, không
    // encodeLinkPath (sẽ phá "://" và query string) — path khác hẳn 3 case
    // trên (không có scheme) dù cũng có dấu cách trong query string.
    name: 'insertImage toolbar, src là URL tuyệt đối (có scheme) → KHÔNG bị encodeLinkPath phá "://"/query string',
    html: '<p><img src="https://example.com/img.png?size=large" alt=""></p>',
    expect: (md) => md.includes('![](https://example.com/img.png?size=large)'),
  },

  // ---------------------------------------------------------------------
  // 6. paste-image.ts insertImageAt (US-8.5):
  //    `<img src="${escapeAttr(encodeLinkPath(relPath))}" alt="">`
  //    — relPath đi qua encodeLinkPath TRƯỚC (mã hóa từng đoạn path bằng
  //    encodeURIComponent + escape thêm ngoặc), khác insertImage() ở trên.
  // ---------------------------------------------------------------------
  {
    name: 'paste-image insertImageAt, đường dẫn có dấu cách → encodeLinkPath mã hóa %20, round-trip về đúng path gốc',
    html: `<p><img src="${escapeAttr(encodeLinkPath('my images/pic 1.png'))}" alt=""></p>`,
    expect: (md) => md.includes('![](my%20images/pic%201.png)'),
  },
  {
    // paste-image kèm width (đo naturalWidth/devicePixelRatio để giữ kích thước
    // gốc thay vì bị max-width:100% kéo full cửa sổ). img có attribute ngoài
    // src/alt/title → turndown giữ nguyên HTML thô (rule htmlImgWithAttrs), width
    // được lưu vào .md và ổn định qua render→serialize lần 2.
    name: 'paste-image insertImageAt kèm width → serialize thành <img> HTML thô giữ width',
    html: `<p><img src="${escapeAttr(encodeLinkPath('images/pic.png'))}" alt="" width="640"></p>`,
    expect: (md) => md.includes('width="640"') && md.includes('src="images/pic.png"'),
  },
];

for (const c of domCases) {
  let ok = true;
  const problems: string[] = [];
  try {
    const md = serializeHtml(c.html);
    if (!c.expect(md)) {
      ok = false;
      problems.push(`Kết quả không như kỳ vọng: ${JSON.stringify(md)}`);
    }
    const md2 = serializeHtml(renderer.render(md).html);
    if (md2 !== md) {
      ok = false;
      problems.push(`Không ổn định: md=${JSON.stringify(md)} md2=${JSON.stringify(md2)}`);
    }
  } catch (e) {
    ok = false;
    problems.push(`Exception: ${(e as Error).stack}`);
  }
  runner.check(c.name, ok, problems.join('\n'));
}

// ---------------------------------------------------------------------------
// 7. Math templates (toolbar.ts MATH_DROPDOWN/insertInlineMath) — chèn qua
//    ctx.insertMarkdown(text), tức là literal markdown thật (không phải DOM
//    mô phỏng) → dùng checkRoundtrip (render → serialize → render → so sánh)
//    qua runner.roundtrip(). Hằng số copy nguyên văn từ toolbar.ts:
//    const MATH_FORMULA = 'x^2+y^2=z^2';
//    inline: `$${MATH_FORMULA}$`, block: `$$${MATH_FORMULA}$$`.
// ---------------------------------------------------------------------------
const MATH_FORMULA = 'x^2+y^2=z^2';
runner.roundtrip('Math inline template (toolbar MATH_DROPDOWN) round-trip ổn định', `$${MATH_FORMULA}$`);
runner.roundtrip('Math block template (toolbar MATH_DROPDOWN) round-trip ổn định', `$$${MATH_FORMULA}$$`);

// ---------------------------------------------------------------------------
// 8. Mermaid templates (toolbar.ts MERMAID_*_TEMPLATE) — cùng cơ chế
//    ctx.insertMarkdown(text) như math ở trên, literal markdown thật.
//    4 hằng số copy nguyên văn từ toolbar.ts.
// ---------------------------------------------------------------------------
const MERMAID_FLOWCHART_TEMPLATE = '```mermaid\ngraph TD; A[Start] --> B{Decision} --> C[End]\n```';
const MERMAID_SEQUENCE_TEMPLATE =
  '```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello Bob, how are you?\n  Bob-->>Alice: I am good, thanks!\n```';
const MERMAID_CLASS_TEMPLATE =
  '```mermaid\nclassDiagram\n  Animal <|-- Dog\n  Animal : +String name\n  Animal : +makeSound()\n```';
const MERMAID_STATE_TEMPLATE =
  '```mermaid\nstateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : start\n  Running --> Idle : stop\n  Running --> [*]\n```';

runner.roundtrip('Mermaid flowchart template round-trip ổn định', MERMAID_FLOWCHART_TEMPLATE);
runner.roundtrip('Mermaid sequence diagram template round-trip ổn định', MERMAID_SEQUENCE_TEMPLATE);
runner.roundtrip('Mermaid class diagram template round-trip ổn định', MERMAID_CLASS_TEMPLATE);
runner.roundtrip('Mermaid state diagram template round-trip ổn định', MERMAID_STATE_TEMPLATE);

runner.finish('toolbar-insert');
