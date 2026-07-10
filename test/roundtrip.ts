/**
 * Round-trip test: với mỗi fixture markdown
 *   1. html1 = render(md)
 *   2. md2   = serialize(html1)        (turndown, giống webview)
 *   3. html2 = render(md2)
 *   → PASS nếu html1 ≡ html2 (chuẩn hóa whitespace ngoài <pre>)
 *   → đồng thời kiểm tra serializer ổn định: serialize(html2) === md2
 *
 * Chạy: npm run test:roundtrip
 */
import * as fs from 'fs';
import * as path from 'path';
import domino from '@mixmark-io/domino';
import {
  MarkdownRenderer,
  createTurndown,
  fillSequenceColumn,
  normalizeMarkdown,
  postProcessMathDom,
  postProcessMermaidDom,
  prepareDomForSerialize,
} from '../media/webview/pipeline';

const fixturesDir = path.join(__dirname, '..', '..', 'test', 'fixtures');
const renderer = new MarkdownRenderer({ breaks: false, linkify: true });
const turndown = createTurndown();

function serializeHtml(html: string): string {
  const doc = domino.createDocument(`<div id="content">${html}</div>`, true);
  const root = doc.getElementById('content');
  if (!root) {
    throw new Error('không parse được HTML');
  }
  postProcessMathDom(root, doc);
  postProcessMermaidDom(root, doc);
  prepareDomForSerialize(root, doc);
  return normalizeMarkdown(turndown.turndown(root as HTMLElement));
}

/**
 * Chuẩn hóa HTML để so sánh: parse DOM rồi serialize lại dạng chuẩn.
 *  - Trong <pre>: giữ text nguyên vẹn.
 *  - Ngoài <pre>: gộp whitespace (kể cả NBSP) thành 1 space; bỏ text node
 *    chỉ chứa whitespace nếu nằm cạnh phần tử block (whitespace giữa các
 *    block không có ý nghĩa hiển thị).
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

function normalizeHtml(html: string): string {
  const doc = domino.createDocument(`<div id="__root">${html}</div>`, true);
  const root = doc.getElementById('__root');
  if (!root) {
    return html;
  }
  const out: string[] = [];
  serializeNode(root, out, false);
  return out.join('');
}

function serializeNode(node: Node, out: string[], inPre: boolean): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3) {
      const text = child.nodeValue ?? '';
      if (inPre) {
        out.push(text);
        continue;
      }
      let collapsed = text.replace(/\s+/g, ' ');
      const atStart = !child.previousSibling || isBlockEl(child.previousSibling);
      const atEnd = !child.nextSibling || isBlockEl(child.nextSibling);
      const parentBlock = isBlockEl(node) || (node as Element).id === '__root';
      if (collapsed === ' ' && ((parentBlock && (atStart || atEnd)) ||
          (child.previousSibling != null && isBlockEl(child.previousSibling)) ||
          (child.nextSibling != null && isBlockEl(child.nextSibling)))) {
        continue; // whitespace giua cac block - bo qua
      }
      // Whitespace o mep block bi browser collapse - bo khi so sanh.
      if (parentBlock && atStart) {
        collapsed = collapsed.replace(/^ /, '');
      }
      if (parentBlock && atEnd) {
        collapsed = collapsed.replace(/ $/, '');
      }
      if (collapsed) {
        out.push(collapsed);
      }
    } else if (child.nodeType === 8) {
      out.push(`<!--${(child as Comment).data}-->`);
    } else if (child.nodeType === 1) {
      const el = child as Element;
      // data-line/data-line-end (số dòng nguồn) tự nhiên khác nhau giữa md gốc
      // và md sau round-trip (turndown định dạng lại loose list, setext→atx...)
      // dù nội dung hiển thị tương đương — không phải khác biệt cấu trúc cần bắt lỗi.
      const attrs = Array.from(el.attributes ?? [])
        .filter((a) => a.name !== 'data-line' && a.name !== 'data-line-end')
        .map((a) => `${a.name}="${a.value}"`)
        .sort()
        .join(' ');
      out.push(`<${el.nodeName.toLowerCase()}${attrs ? ' ' + attrs : ''}>`);
      serializeNode(el, out, inPre || el.nodeName === 'PRE');
      out.push(`</${el.nodeName.toLowerCase()}>`);
    }
  }
}

function isBlockEl(n: Node): boolean {
  // BR tính như block: whitespace quanh line break bị browser bỏ khi hiển thị.
  return n.nodeType === 1 && (BLOCK_TAGS.has(n.nodeName) || n.nodeName === 'BR');
}

function firstDiff(a: string, b: string): string {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) {
    i++;
  }
  const from = Math.max(0, i - 60);
  return [
    `  vị trí khác nhau đầu tiên: ${i}`,
    `  html1: ...${JSON.stringify(a.slice(from, i + 120))}`,
    `  html2: ...${JSON.stringify(b.slice(from, i + 120))}`,
  ].join('\n');
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

const files = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.md'))
  .sort();

if (files.length === 0) {
  console.error('Không tìm thấy fixture nào trong', fixturesDir);
  process.exit(1);
}

for (const file of files) {
  const md = fs.readFileSync(path.join(fixturesDir, file), 'utf8');
  let ok = true;
  const problems: string[] = [];
  try {
    const html1 = renderer.render(md).html;
    const md2 = serializeHtml(html1);
    const html2 = renderer.render(md2).html;

    const n1 = normalizeHtml(html1);
    const n2 = normalizeHtml(html2);
    if (n1 !== n2) {
      ok = false;
      problems.push('HTML thay đổi sau round-trip:');
      problems.push(firstDiff(n1, n2));
      problems.push(`  md2 = ${JSON.stringify(md2.slice(0, 400))}`);
    }

    // Serializer phải ổn định (không drift khi round-trip lần 2)
    const md3 = serializeHtml(html2);
    if (md3 !== md2) {
      ok = false;
      problems.push('Serializer không ổn định (md3 !== md2):');
      let i = 0;
      const n = Math.min(md2.length, md3.length);
      while (i < n && md2[i] === md3[i]) {
        i++;
      }
      problems.push(`  md2: ...${JSON.stringify(md2.slice(Math.max(0, i - 40), i + 80))}`);
      problems.push(`  md3: ...${JSON.stringify(md3.slice(Math.max(0, i - 40), i + 80))}`);
    }
  } catch (e) {
    ok = false;
    problems.push(`Exception: ${(e as Error).stack}`);
  }

  if (ok) {
    pass++;
    console.log(`PASS  ${file}`);
  } else {
    fail++;
    console.log(`FAIL  ${file}`);
    failures.push(`--- ${file} ---\n${problems.join('\n')}`);
  }
}

// ---------------------------------------------------------------------------
// DOM sinh từ thao tác chỉnh sửa (không có fixture .md tương ứng):
// thao tác bảng tạo ô placeholder <td><br></td> — serialize phải ra ô rỗng
// sạch và ổn định khi round-trip tiếp.
// ---------------------------------------------------------------------------

interface DomCase {
  name: string;
  html: string;
  expect: (md: string) => boolean;
}

const domCases: DomCase[] = [
  {
    name: 'dom: td mới chỉ chứa <br> → ô rỗng, không emit <br>',
    html:
      '<table><thead><tr><th>A</th><th>B</th></tr></thead>' +
      '<tbody><tr><td><br></td><td>x</td></tr></tbody></table>',
    expect: (md) => !md.includes('<br>') && /\|\s*\| x \|/.test(md),
  },
  {
    name: 'dom: th mới chỉ chứa <br> → header rỗng hợp lệ',
    html:
      '<table><thead><tr><th><br></th><th>B</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    expect: (md) => !md.includes('<br>') && md.includes('| 1 | 2 |'),
  },
  {
    name: 'dom: ô có nội dung lẫn <br> thật → giữ <br>',
    html:
      '<table><thead><tr><th>A</th></tr></thead>' +
      '<tbody><tr><td>dòng 1<br>dòng 2</td></tr></tbody></table>',
    expect: (md) => md.includes('dòng 1<br>dòng 2'),
  },
  {
    name: 'dom: p có style text-align → chuyển thành <p align="...">',
    html: '<p style="text-align: center;">giữa</p>',
    expect: (md) => md.includes('<p align="center">giữa</p>'),
  },
  {
    name: 'dom: heading có align → giữ dạng HTML, không mất căn lề',
    html: '<h2 align="center">Tiêu đề <em>giữa</em></h2>',
    expect: (md) => md.includes('<h2 align="center">Tiêu đề <em>giữa</em></h2>'),
  },
  {
    name: 'dom: căn cột bảng qua align trên mọi ô → delimiter :---:',
    html:
      '<table><thead><tr><th>A</th><th align="center" style="text-align: center;">B</th></tr></thead>' +
      '<tbody><tr><td>1</td><td align="center" style="text-align: center;">2</td></tr></tbody></table>',
    expect: (md) => md.includes(':-') && md.includes('| 1 | 2 |'),
  },
  {
    name: 'dom: dòng mới toàn ô <br> → hàng rỗng đủ cột',
    html:
      '<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td><td>3</td></tr>' +
      '<tr><td><br></td><td><br></td><td><br></td></tr></tbody></table>',
    expect: (md) => {
      const rows = md.trim().split('\n');
      const lastRow = rows[rows.length - 1];
      return !md.includes('<br>') && (lastRow.match(/\|/g) ?? []).length === 4;
    },
  },
  {
    name: 'dom: bullet phẳng trong ô → giữ pipe, các dòng nối bằng <br>, giữ inline',
    html:
      '<table><thead><tr><th>Cột</th></tr></thead><tbody><tr><td>' +
      '<ul><li>mục A</li><li>mục <strong>B</strong></li></ul>' +
      '</td></tr></tbody></table>',
    expect: (md) =>
      md.trimStart().startsWith('|') &&
      !md.includes('<ul>') &&
      !md.includes('<table') &&
      md.includes('<br>') &&
      md.includes('mục A') &&
      md.includes('**B**'),
  },
  {
    name: 'dom: danh sách số phẳng trong ô → "1. x<br>2. y" dạng pipe',
    html:
      '<table><thead><tr><th>Cột</th></tr></thead><tbody><tr><td>' +
      '<ol><li>một</li><li>hai</li></ol>' +
      '</td></tr></tbody></table>',
    expect: (md) =>
      md.trimStart().startsWith('|') &&
      !md.includes('<ol>') &&
      md.includes('<br>') &&
      /1\\?\.\s*một/.test(md) &&
      /2\\?\.\s*hai/.test(md),
  },
  {
    name: 'dom: bullet PHÂN CẤP trong ô → giữ nguyên cả bảng dạng HTML',
    html:
      '<table><thead><tr><th>Cột</th></tr></thead><tbody><tr><td>' +
      '<ul><li>cha 1<ul><li>con 1.1</li><li>con 1.2</li></ul></li><li>cha 2</li></ul>' +
      '</td></tr></tbody></table>',
    expect: (md) =>
      md.trimStart().startsWith('<table') &&
      md.includes('<ul>') &&
      md.includes('con 1.1') &&
      !md.trimStart().startsWith('|'),
  },
  {
    name: 'dom: phân cấp ở ô KHÔNG phải ô đầu → cả bảng vẫn thành HTML',
    html:
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr>' +
      '<td>văn bản thường</td>' +
      '<td><ul><li>x<ul><li>x.1</li></ul></li></ul></td>' +
      '</tr></tbody></table>',
    expect: (md) =>
      md.trimStart().startsWith('<table') && md.includes('x.1') && md.includes('văn bản thường'),
  },
  // --- Chuẩn hóa DOM méo do execCommand indent/outdent của Chromium sinh ra ---
  {
    name: 'dom méo (outdent li>li) trong ô → phẳng dạng pipe, không dính dòng',
    html:
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>' +
      '<ul><li>A<li>B</li></li></ul>' + // Chromium outdent: li nằm trong li
      '</td></tr></tbody></table>',
    expect: (md) =>
      md.trimStart().startsWith('|') &&
      md.includes('<br>') &&
      !md.includes('<ul>') &&
      /A/.test(md) &&
      /B/.test(md),
  },
  {
    name: 'dom méo (indent ul>ul) trong ô → giữ HTML, KHÔNG mất mục con',
    html:
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>' +
      '<ul><li>một</li><ul><li>hai</li></ul></ul>' + // Chromium indent: ul trong ul
      '</td></tr></tbody></table>',
    expect: (md) =>
      md.trimStart().startsWith('<table') && md.includes('một') && md.includes('hai'),
  },
  {
    name: 'dom méo (outdent li>li) ngoài bảng → hai bullet riêng, không "- A- B"',
    html: '<ul><li>A<li>B</li></li></ul>',
    expect: (md) => {
      const bullets = md.split('\n').filter((l) => /^\s*-\s+\S/.test(l));
      return bullets.length === 2 && /A/.test(bullets[0]) && /B/.test(bullets[1]);
    },
  },
  {
    name: 'dom méo (outdent 2 mục) ngoài bảng → A,B ngang cấp, C thụt dưới B',
    html: '<ul><li>A<li>B</li><ul><li>C</li></ul></li></ul>',
    expect: (md) => /^-\s+B/m.test(md) && /^\s+-\s+C/m.test(md),
  },
];

let domTotal = 0;
for (const c of domCases) {
  domTotal++;
  let ok = true;
  const problems: string[] = [];
  try {
    const md = serializeHtml(c.html);
    if (!c.expect(md)) {
      ok = false;
      problems.push(`Kết quả không như kỳ vọng: ${JSON.stringify(md)}`);
    }
    // Ổn định: render lại rồi serialize lần nữa phải giữ nguyên
    const md2 = serializeHtml(renderer.render(md).html);
    if (md2 !== md) {
      ok = false;
      problems.push(`Không ổn định: md=${JSON.stringify(md)} md2=${JSON.stringify(md2)}`);
    }
  } catch (e) {
    ok = false;
    problems.push(`Exception: ${(e as Error).stack}`);
  }
  if (ok) {
    pass++;
    console.log(`PASS  ${c.name}`);
  } else {
    fail++;
    console.log(`FAIL  ${c.name}`);
    failures.push(`--- ${c.name} ---\n${problems.join('\n')}`);
  }
}

// ---------------------------------------------------------------------------
// fillSequenceColumn — mô phỏng đúng DOM mà thao tác thêm dòng tạo ra
// (nút toolbar và phím Tab đều đi qua insertRow → fillSequenceColumn)
// ---------------------------------------------------------------------------

interface SeqCase {
  name: string;
  /** HTML tbody TRƯỚC khi chèn; dòng mới (toàn <td><br></td>) sẽ được chèn theo position. */
  tbodyRows: string[];
  insertAt: number; // vị trí chèn trong tbody (số dòng đứng trước)
  cols: number;
  expectFilled: boolean;
  expectFirstCol?: string[]; // giá trị cột đầu sau khi điền
}

const seqCases: SeqCase[] = [
  {
    name: 'seq: Tab ở ô cuối (chèn cuối bảng 1,2,3) → dòng mới = 4',
    tbodyRows: ['<tr><td>1</td><td>a</td></tr>', '<tr><td>2</td><td>b</td></tr>', '<tr><td>3</td><td>c</td></tr>'],
    insertAt: 3,
    cols: 2,
    expectFilled: true,
    expectFirstCol: ['1', '2', '3', '4'],
  },
  {
    name: 'seq: chèn giữa (sau dòng 1) → dòng mới = 2, các dòng sau dồn số',
    tbodyRows: ['<tr><td>1</td><td>a</td></tr>', '<tr><td>2</td><td>b</td></tr>'],
    insertAt: 1,
    cols: 2,
    expectFilled: true,
    expectFirstCol: ['1', '2', '3'],
  },
  {
    name: 'seq: bảng bắt đầu từ 5 → giữ số bắt đầu',
    tbodyRows: ['<tr><td>5</td><td>a</td></tr>', '<tr><td>6</td><td>b</td></tr>'],
    insertAt: 2,
    cols: 2,
    expectFilled: true,
    expectFirstCol: ['5', '6', '7'],
  },
  {
    name: 'seq: cột đầu là chữ → không điền',
    tbodyRows: ['<tr><td>alpha</td><td>a</td></tr>', '<tr><td>beta</td><td>b</td></tr>'],
    insertAt: 2,
    cols: 2,
    expectFilled: false,
  },
];

for (const c of seqCases) {
  let ok = true;
  const problems: string[] = [];
  try {
    const emptyRow = `<tr>${'<td><br></td>'.repeat(c.cols)}</tr>`;
    const rowsHtml = [...c.tbodyRows];
    rowsHtml.splice(c.insertAt, 0, emptyRow);
    const doc = domino.createDocument(
      `<table><thead><tr><th>#</th><th>Tên</th></tr></thead><tbody>${rowsHtml.join('')}</tbody></table>`,
      true
    );
    const table = doc.querySelector('table');
    const tbody = doc.querySelector('tbody');
    const newRow = tbody ? Array.from(tbody.children).filter((el) => el.tagName === 'TR')[c.insertAt] : null;
    if (!table || !newRow) {
      throw new Error('không dựng được DOM test');
    }
    const filled = fillSequenceColumn(table, newRow);
    if (filled !== c.expectFilled) {
      ok = false;
      problems.push(`filled = ${filled}, kỳ vọng ${c.expectFilled}`);
    }
    if (c.expectFirstCol) {
      const got = Array.from(tbody!.children)
        .filter((el) => el.tagName === 'TR')
        .map((r) => (r.children[0]?.textContent ?? '').trim());
      if (JSON.stringify(got) !== JSON.stringify(c.expectFirstCol)) {
        ok = false;
        problems.push(`cột đầu = ${JSON.stringify(got)}, kỳ vọng ${JSON.stringify(c.expectFirstCol)}`);
      }
    }
  } catch (e) {
    ok = false;
    problems.push(`Exception: ${(e as Error).stack}`);
  }
  domTotal++;
  if (ok) {
    pass++;
    console.log(`PASS  ${c.name}`);
  } else {
    fail++;
    console.log(`FAIL  ${c.name}`);
    failures.push(`--- ${c.name} ---\n${problems.join('\n')}`);
  }
}

console.log(`\n${pass} pass, ${fail} fail / ${files.length + domTotal} cases`);
if (failures.length) {
  console.log('\n' + failures.join('\n\n'));
  process.exit(1);
}
