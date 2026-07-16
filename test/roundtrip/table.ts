/**
 * Feature: Table Editing (HLR mục 6). DOM-outcome tests: mô phỏng chính xác
 * cấu trúc DOM mà table.ts (execCommand/insertRow/insertColumn...) tạo ra sau
 * một thao tác, rồi kiểm tra serialize(DOM) → markdown đúng kỳ vọng + ổn định
 * khi round-trip tiếp (render lại rồi serialize lần 2 phải ra cùng markdown).
 * KHÔNG gọi thẳng hàm trong table.ts vì chúng cần execCommand/Selection sống
 * (chỉ có trong webview thật) — domino (DOM giả lập Node) không cài các API đó.
 *
 * Chạy riêng: npm run test:roundtrip:table
 */
import { Runner, serializeHtml, renderer, fillSequenceColumn, domino } from './_lib';

const runner = new Runner();

interface DomCase {
  name: string;
  html: string;
  expect: (md: string) => boolean;
}

const domCases: DomCase[] = [
  {
    name: 'td mới chỉ chứa <br> (US-6.2 thêm dòng/cột) → ô rỗng, không emit <br>',
    html:
      '<table><thead><tr><th>A</th><th>B</th></tr></thead>' +
      '<tbody><tr><td><br></td><td>x</td></tr></tbody></table>',
    expect: (md) => !md.includes('<br>') && /\|\s*\| x \|/.test(md),
  },
  {
    name: 'th mới chỉ chứa <br> → header rỗng hợp lệ',
    html:
      '<table><thead><tr><th><br></th><th>B</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    expect: (md) => !md.includes('<br>') && md.includes('| 1 | 2 |'),
  },
  {
    name: 'ô có nội dung lẫn <br> thật (US-6.9) → giữ <br>',
    html:
      '<table><thead><tr><th>A</th></tr></thead>' +
      '<tbody><tr><td>dòng 1<br>dòng 2</td></tr></tbody></table>',
    expect: (md) => md.includes('dòng 1<br>dòng 2'),
  },
  {
    name: 'căn cột bảng qua align trên mọi ô (US-6.3) → delimiter :---:',
    html:
      '<table><thead><tr><th>A</th><th align="center" style="text-align: center;">B</th></tr></thead>' +
      '<tbody><tr><td>1</td><td align="center" style="text-align: center;">2</td></tr></tbody></table>',
    expect: (md) => md.includes(':-') && md.includes('| 1 | 2 |'),
  },
  {
    name: 'dòng mới toàn ô <br> (US-6.2) → hàng rỗng đủ cột',
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
    name: 'bullet phẳng trong ô (US-6.9) → giữ pipe, các dòng nối bằng <br>, giữ inline',
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
    name: 'danh sách số phẳng trong ô → "1. x<br>2. y" dạng pipe',
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
    name: 'bullet PHÂN CẤP trong ô → giữ nguyên cả bảng dạng HTML',
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
    name: 'phân cấp ở ô KHÔNG phải ô đầu → cả bảng vẫn thành HTML',
    html:
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr>' +
      '<td>văn bản thường</td>' +
      '<td><ul><li>x<ul><li>x.1</li></ul></li></ul></td>' +
      '</tr></tbody></table>',
    expect: (md) =>
      md.trimStart().startsWith('<table') && md.includes('x.1') && md.includes('văn bản thường'),
  },
  {
    name: 'dom méo (outdent li>li, Chromium) trong ô → phẳng dạng pipe, không dính dòng',
    html:
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>' +
      '<ul><li>A<li>B</li></li></ul>' +
      '</td></tr></tbody></table>',
    expect: (md) =>
      md.trimStart().startsWith('|') &&
      md.includes('<br>') &&
      !md.includes('<ul>') &&
      /A/.test(md) &&
      /B/.test(md),
  },
  {
    name: 'dom méo (indent ul>ul, Chromium) trong ô → giữ HTML, KHÔNG mất mục con',
    html:
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>' +
      '<ul><li>một</li><ul><li>hai</li></ul></ul>' +
      '</td></tr></tbody></table>',
    expect: (md) =>
      md.trimStart().startsWith('<table') && md.includes('một') && md.includes('hai'),
  },
  {
    // US-17.4 (M2): row drag reorder swaps two <tr> outerHTML positions in tbody — DOM outcome, not the drag itself.
    name: 'row drag reorder (US-17.4) — row 2 moved above row 1, cell content travels with it',
    html:
      '<table><thead><tr><th>Name</th><th>Score</th></tr></thead>' +
      '<tbody><tr><td>Bravo</td><td>2</td></tr><tr><td>Alpha</td><td>1</td></tr></tbody></table>',
    expect: (md) => {
      const bravo = md.indexOf('Bravo');
      const alpha = md.indexOf('Alpha');
      return bravo >= 0 && alpha >= 0 && bravo < alpha;
    },
  },
  {
    // US-17.4 (M2): column drag reorder — whole table rebuilt with reordered cells in EVERY row (header included).
    name: 'column drag reorder (US-17.4) — Score column moved before Name, every row keeps full column count',
    html:
      '<table><thead><tr><th>Score</th><th>Name</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>Alpha</td></tr><tr><td>2</td><td>Bravo</td></tr></tbody></table>',
    expect: (md) => {
      const rows = md.trim().split('\n').filter((l) => l.startsWith('|'));
      return (
        rows.length === 4 &&
        rows.every((r) => (r.match(/\|/g) ?? []).length === 3) &&
        /\|\s*Score\s*\|\s*Name\s*\|/.test(rows[0]) &&
        /\|\s*1\s*\|\s*Alpha\s*\|/.test(rows[2])
      );
    },
  },
  {
    // US-17.4 (M2): image dropped into a cell gets style="width:100%" — htmlImgWithAttrs already keeps ANY
    // non-src/alt/title attribute as raw HTML (verified here, no turndown rule change was needed for this).
    name: 'image dropped into a table cell (US-17.4) — style="width:100%" preserved as raw HTML',
    html:
      '<table><thead><tr><th>Preview</th></tr></thead>' +
      '<tbody><tr><td><img src="assets/shot.png" alt="" style="width:100%"></td></tr></tbody></table>',
    expect: (md) => md.includes('<img') && md.includes('style="width:100%"') && md.includes('assets/shot.png'),
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
// fillSequenceColumn (US-6.6) — mô phỏng đúng DOM mà thao tác thêm dòng tạo ra
// (nút toolbar và phím Tab đều đi qua insertRow → fillSequenceColumn)
// ---------------------------------------------------------------------------

interface SeqCase {
  name: string;
  tbodyRows: string[];
  insertAt: number;
  cols: number;
  expectFilled: boolean;
  expectFirstCol?: string[];
}

const seqCases: SeqCase[] = [
  {
    name: 'Tab ở ô cuối (chèn cuối bảng 1,2,3) → dòng mới = 4',
    tbodyRows: ['<tr><td>1</td><td>a</td></tr>', '<tr><td>2</td><td>b</td></tr>', '<tr><td>3</td><td>c</td></tr>'],
    insertAt: 3,
    cols: 2,
    expectFilled: true,
    expectFirstCol: ['1', '2', '3', '4'],
  },
  {
    name: 'chèn giữa (sau dòng 1) → dòng mới = 2, các dòng sau dồn số',
    tbodyRows: ['<tr><td>1</td><td>a</td></tr>', '<tr><td>2</td><td>b</td></tr>'],
    insertAt: 1,
    cols: 2,
    expectFilled: true,
    expectFirstCol: ['1', '2', '3'],
  },
  {
    name: 'bảng bắt đầu từ 5 → giữ số bắt đầu',
    tbodyRows: ['<tr><td>5</td><td>a</td></tr>', '<tr><td>6</td><td>b</td></tr>'],
    insertAt: 2,
    cols: 2,
    expectFilled: true,
    expectFirstCol: ['5', '6', '7'],
  },
  {
    name: 'cột đầu là chữ → không điền',
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
  runner.check(c.name, ok, problems.join('\n'));
}

runner.finish('table');
