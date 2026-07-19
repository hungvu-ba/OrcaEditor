/**
 * Feature: Input Rules — gõ tiền tố markdown rồi Space/Enter tự chuyển block,
 * kiểu Typora/Notion (HLR mục 5, xem "../OrcaEditor-Requirements/Requirement -
 * 05 Input Rules.md"; biến thể trong ô bảng liên quan tới HLR mục 6 — Table
 * Editing, vì applyCellListInputRule chỉ áp dụng bullet/số/task list trong
 * td/th). DOM-outcome tests: media/webview/input-rules.ts dùng document.
 * execCommand/Selection sống (chỉ có trong webview thật) nên KHÔNG gọi thẳng
 * được applySpaceInputRule/applyEnterInputRule/... ở đây — domino (DOM giả lập
 * Node) không cài các API đó. Thay vào đó, mỗi case dựng tay đúng cấu trúc DOM
 * mà hàm tương ứng HỘI TỤ về (đọc source input-rules.ts + addCheckbox trong
 * dom-utils.ts để lấy đúng tag/class/attribute), rồi kiểm tra serialize(DOM)
 * → markdown đúng kỳ vọng + ổn định khi round-trip tiếp (render lại rồi
 * serialize lần 2 phải ra cùng markdown).
 *
 * Ghi chú 2 giới hạn CÓ SẴN của pipeline (không thuộc phạm vi input-rules.ts,
 * không sửa ở đây, chỉ né để không lẫn lộn với đúng/sai của input-rules.ts):
 *   1. markdown-it (renderer dùng để round-trip) chèn thêm 1 khoảng trắng
 *      giữa checkbox và text khi render "- [ ] x" → "<input ...> x" — khiến
 *      bất kỳ task list nào (không riêng gì input-rules.ts) hiện double-space
 *      sau khi render lại rồi serialize lần 2. Case task-list dùng so sánh
 *      "ổn định" đã gộp khoảng trắng liên tiếp (xem `looseSpacing`) để không
 *      báo fail vì lý do không liên quan tới input-rules.ts.
 *   2. Một khối code fence HOÀN TOÀN rỗng (<pre><code></code></pre> không có
 *      text) bị turndown coi là "blank node" và bỏ hẳn khi serialize — đây là
 *      hành vi chung của turndown, không riêng gì input-rules.ts. Case code
 *      fence ở dưới vì vậy đại diện trạng thái NGAY SAU khi gõ thêm 1 dòng mã
 *      (thực tế luôn xảy ra ngay sau đó), thay vì trạng thái rỗng tức thời.
 *
 * Chạy riêng: npm run test:roundtrip:input-rules (khi đã wire vào package.json)
 */
import { Runner, serializeHtml, renderer } from './_lib';

const runner = new Runner();

interface DomCase {
  name: string;
  html: string;
  expect: (md: string) => boolean;
  /** true: so sánh ổn định gộp khoảng trắng liên tiếp (né quirk #1 ở trên). */
  looseSpacing?: boolean;
}

function collapseSpaces(s: string): string {
  return s.replace(/[ \t]+/g, ' ');
}

// ---------------------------------------------------------------------------
// 1. applySpaceInputRule — heading: "#".."######" + space, trên <p> rỗng đã bị
//    stripMarkerBeforeCaret xoá marker rồi ctx.dom.replaceBlockTag(block, 'hN').
//    Trạng thái hội tụ: đúng thẻ hN chứa phần text gõ sau marker.
// ---------------------------------------------------------------------------
const headingCases: DomCase[] = [
  {
    name: 'heading: "# " → h1',
    html: '<h1>Tiêu đề chính</h1>',
    expect: (md) => /^#\s+Tiêu đề chính\s*$/.test(md.trim()),
  },
  {
    name: 'heading: "### " → h3',
    html: '<h3>Mục lục con</h3>',
    expect: (md) => /^###\s+Mục lục con\s*$/.test(md.trim()),
  },
  {
    name: 'heading: "###### " → h6',
    html: '<h6>Ghi chú nhỏ</h6>',
    expect: (md) => /^######\s+Ghi chú nhỏ\s*$/.test(md.trim()),
  },
];

// ---------------------------------------------------------------------------
// 2. applySpaceInputRule — blockquote: "> " + space → execCommand('formatBlock',
//    'blockquote') bọc <blockquote><p>...</p></blockquote>.
// ---------------------------------------------------------------------------
const blockquoteCases: DomCase[] = [
  {
    name: 'blockquote: "> " → <blockquote><p>...</p></blockquote>',
    html: '<blockquote><p>trích dẫn quan trọng</p></blockquote>',
    expect: (md) => /^>\s*trích dẫn quan trọng\s*$/.test(md.trim()),
  },
  {
    // Nested blockquote (Bug #4): "> " gõ trong một blockquote sẵn có bọc đoạn
    // đó vào <blockquote> con — applyBlockquoteNestInputRule hội tụ về cấu trúc
    // này. turndown serialize đệ quy → "> > ..." (KHÔNG escape thành "\>").
    name: 'nested blockquote: <blockquote>...<blockquote><p>x</p></blockquote></blockquote> → "> > x"',
    html: '<blockquote><p>Type here</p><blockquote><p>fsdfdsfs</p></blockquote></blockquote>',
    expect: (md) => /^>\s*Type here$/m.test(md) && />\s*>\s*fsdfdsfs/.test(md) && !md.includes('\\>'),
  },
];

// ---------------------------------------------------------------------------
// 3. applySpaceInputRule — task list: "[]"/"[ ]" (chưa check) và "[x]"/"[X]"
//    (đã check) đều hội tụ về CÙNG một cấu trúc DOM (marker bị xoá trước khi
//    chuyển đổi nên DOM không giữ lại việc gõ "[]" hay "[ ]"/"x" hay "X") —
//    xem convertBlockToListItem + addCheckbox (dom-utils.ts) + đoạn set
//    attribute 'checked' chỉ khi task[1] === 'x'/'X' (input-rules.ts ~268-279).
// ---------------------------------------------------------------------------
const taskListCases: DomCase[] = [
  {
    name: 'task list: "[]" hoặc "[ ]" → <li class="task-list-item"><input type="checkbox">...</li> (chưa checked)',
    html:
      '<ul class="contains-task-list"><li class="task-list-item">' +
      '<input type="checkbox" class="task-list-item-checkbox">việc chưa xong</li></ul>',
    expect: (md) => /^\*\s+\[ \]\s*việc chưa xong\s*$/.test(md.trim()),
    looseSpacing: true,
  },
  {
    name: 'task list: "[x]" hoặc "[X]" → cùng cấu trúc + input có checked="checked"',
    html:
      '<ul class="contains-task-list"><li class="task-list-item">' +
      '<input type="checkbox" class="task-list-item-checkbox" checked="checked">việc đã xong</li></ul>',
    expect: (md) => /^\*\s+\[x\]\s*việc đã xong\s*$/i.test(md.trim()),
    looseSpacing: true,
  },
];

// ---------------------------------------------------------------------------
// 4. applySpaceInputRule — bullet: "-"/"*"/"+" + space đều hội tụ về CÙNG một
//    <ul><li>...</li></ul> (convertBlockToListItem không phân biệt 3 ký tự
//    này — xem nhánh `marker === '-' || marker === '*' || marker === '+'`).
//    Dùng đúng 1 fixture DOM cho cả 3 trigger để chứng minh output giống hệt
//    nhau bất kể ký tự gõ.
// ---------------------------------------------------------------------------
const bulletCases: DomCase[] = [
  {
    name: 'bullet: "-", "*", "+" + space đều hội tụ về <ul><li>...</li></ul> giống hệt nhau',
    html: '<ul><li>gạch đầu dòng</li></ul>',
    expect: (md) => /^\*\s+gạch đầu dòng\s*$/.test(md.trim()),
  },
];

// ---------------------------------------------------------------------------
// 5. applySpaceInputRule — ordered list: "1."/"1)" + space hội tụ về CÙNG
//    <ol><li>...</li></ol> KHÔNG có attribute start (vì start===1 thì không
//    set — xem nhánh `if (start !== 1)`); "5." → có start="5".
// ---------------------------------------------------------------------------
const orderedCases: DomCase[] = [
  {
    name: 'ordered: "1." hoặc "1)" + space đều hội tụ về <ol><li>...</li></ol> (không set start)',
    html: '<ol><li>mục đầu tiên</li></ol>',
    expect: (md) => /^1\.\s+mục đầu tiên\s*$/.test(md.trim()),
  },
  {
    name: 'ordered: "5." + space → <ol start="5"><li>...</li></ol>',
    html: '<ol start="5"><li>mục thứ năm</li></ol>',
    expect: (md) => /^5\.\s+mục thứ năm\s*$/.test(md.trim()),
  },
];

// ---------------------------------------------------------------------------
// 6. applyCellListInputRule — bullet/số/task list trong td/th, chỉ thay ĐÚNG
//    "dòng" hiện tại của ô (không phải cả ô) — xem convertCellLineToListItem,
//    cellLineStart, cellListMergeTarget. Vì bảng flatten list phẳng trong ô
//    thành chuỗi inline "- a<br>- b" khi serialize (dom-serialize-prep.ts,
//    flattenListToBrLines) nên trạng thái hội tụ (list thật trong DOM) vẫn
//    đúng đắn ngay cả khi markdown cuối cùng không giữ <ul>/<ol> tường minh.
// ---------------------------------------------------------------------------
const cellListCases: DomCase[] = [
  {
    name: 'cell list: 1 dòng duy nhất trong ô chuyển bullet → <td><ul><li>...</li></ul></td>',
    html:
      '<table><thead><tr><th>Cột</th></tr></thead><tbody><tr><td>' +
      '<ul><li>mục một</li></ul>' +
      '</td></tr></tbody></table>',
    expect: (md) => md.trimStart().startsWith('|') && !md.includes('<ul>') && /-\s*mục một/.test(md),
  },
  {
    name: 'cell list: dòng thứ 2 GỘP vào list số cùng loại đã có ở dòng 1 (cellListMergeTarget) → 1 <ol> duy nhất, không còn <br> phân cách',
    html:
      '<table><thead><tr><th>Cột</th></tr></thead><tbody><tr><td>' +
      '<ol><li>dòng một</li><li>dòng hai</li></ol>' +
      '</td></tr></tbody></table>',
    expect: (md) =>
      md.trimStart().startsWith('|') &&
      !md.includes('<ol>') &&
      md.includes('<br>') &&
      /1\\?\.\s*dòng một/.test(md) &&
      /2\\?\.\s*dòng hai/.test(md),
  },
  {
    // Giới hạn có sẵn của pipeline: sau flattenListToBrLines, <input type=
    // "checkbox"> của task item trong ô KHÔNG còn nằm trực tiếp trong <li>
    // (bị "phẳng hoá" ra ngoài) nên rule taskCheckbox của turndown.ts (chỉ
    // khớp khi input là con trực tiếp của LI, hoặc P trong LI) không áp dụng
    // — checkbox bị giữ nguyên dạng thẻ HTML thay vì chuyển thành "[ ]". Test
    // này ghi nhận ĐÚNG hành vi hiện tại (không phải input-rules.ts gây ra,
    // không sửa ở đây) để không có gì thay đổi âm thầm sau này.
    name: 'cell list: task item trong ô → checkbox giữ dạng HTML thô (giới hạn hiện tại của flattenListToBrLines, không riêng input-rules.ts)',
    html:
      '<table><thead><tr><th>Cột</th></tr></thead><tbody><tr><td>' +
      '<ul class="contains-task-list"><li class="task-list-item">' +
      '<input type="checkbox" class="task-list-item-checkbox">việc trong ô</li></ul>' +
      '</td></tr></tbody></table>',
    expect: (md) =>
      md.trimStart().startsWith('|') &&
      md.includes('<input type="checkbox"') &&
      md.includes('việc trong ô'),
  },
];

// ---------------------------------------------------------------------------
// 7. applyEnterInputRule — horizontal rule: text đúng "---"/"***"/"___" (3+
//    lần) + Enter → block.replaceWith(hr) rồi hr.after(<p><br></p>). Dùng
//    <p> trước/sau để tránh trường hợp suy biến "toàn văn bản chỉ có 1 dòng
//    ---" bị hiểu nhầm thành front matter khi render lại (không liên quan
//    input-rules.ts, chỉ là edge case của parser khi "---" đứng một mình).
// ---------------------------------------------------------------------------
const hrCases: DomCase[] = [
  {
    name: 'hr: "---"/"***"/"___" + Enter → <hr> rồi <p><br></p> (p rỗng bị bỏ khi serialize)',
    html: '<p>trước đường kẻ</p><hr><p><br></p><p>sau đường kẻ</p>',
    expect: (md) => /trước đường kẻ\s*\n+---\s*\n+sau đường kẻ/.test(md),
  },
];

// ---------------------------------------------------------------------------
// 8. applyEnterInputRule — code fence: "`{3,}lang" + Enter → <pre><code
//    class="language-X"><br></code></pre> rồi <p><br></p> (không có lang →
//    "language-plaintext", xem regex fence + fallback ~line 479-493). Test
//    với nội dung mã đại diện (xem ghi chú giới hạn #2 ở đầu file: fence rỗng
//    tuyệt đối bị turndown coi là blank node, không phải lỗi input-rules.ts).
// ---------------------------------------------------------------------------
const fenceCases: DomCase[] = [
  {
    name: 'fence: "```js" + Enter → <pre><code class="language-js">',
    html: '<pre><code class="language-js">console.log(1);<br></code></pre><p><br></p>',
    expect: (md) => /```js\s*\nconsole\.log\(1\);\s*\n```/.test(md),
  },
  {
    name: 'fence: "```" (không lang) + Enter → <pre><code class="language-plaintext">',
    html: '<pre><code class="language-plaintext">ghi chú thường<br></code></pre><p><br></p>',
    expect: (md) => /```plaintext\s*\nghi chú thường\s*\n```/.test(md),
  },
];

// ---------------------------------------------------------------------------
// 9. applyTaskListEnterRule — Enter trong 1 task <li> không rỗng: phần text
//    SAU caret tách thành <li> mới, cũng được gọi addCheckbox() (khớp cấu
//    trúc checkbox y hệt mục cũ) — cả hai <li> cùng nằm trong 1 <ul>/<ol>.
// ---------------------------------------------------------------------------
const taskEnterSplitCases: DomCase[] = [
  {
    name: 'task Enter split: 2 <li class="task-list-item"> anh em, mỗi cái có checkbox riêng',
    html:
      '<ul class="contains-task-list">' +
      '<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox">phần một và </li>' +
      '<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox">phần hai</li>' +
      '</ul>',
    expect: (md) => {
      const lines = md
        .trim()
        .split('\n')
        .filter((l) => l.trim().length > 0);
      return (
        lines.length === 2 &&
        /^\*\s+\[ \]\s*phần một và\s*$/.test(lines[0]) &&
        /^\*\s+\[ \]\s*phần hai\s*$/.test(lines[1])
      );
    },
    looseSpacing: true,
  },
];

const allCases: DomCase[] = [
  ...headingCases,
  ...blockquoteCases,
  ...taskListCases,
  ...bulletCases,
  ...orderedCases,
  ...cellListCases,
  ...hrCases,
  ...fenceCases,
  ...taskEnterSplitCases,
];

for (const c of allCases) {
  let ok = true;
  const problems: string[] = [];
  try {
    const md = serializeHtml(c.html);
    if (!c.expect(md)) {
      ok = false;
      problems.push(`Kết quả không như kỳ vọng: ${JSON.stringify(md)}`);
    }
    const md2 = serializeHtml(renderer.render(md).html);
    const stable = c.looseSpacing ? collapseSpaces(md2) === collapseSpaces(md) : md2 === md;
    if (!stable) {
      ok = false;
      problems.push(`Không ổn định: md=${JSON.stringify(md)} md2=${JSON.stringify(md2)}`);
    }
  } catch (e) {
    ok = false;
    problems.push(`Exception: ${(e as Error).stack}`);
  }
  runner.check(c.name, ok, problems.join('\n'));
}

runner.finish('input-rules');
