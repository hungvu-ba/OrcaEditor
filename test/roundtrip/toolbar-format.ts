/**
 * Feature: Toolbar định dạng — Heading toggle (HLR mục 4.1/4.9/4.16), Blockquote
 * toggle (mục 4.3), List/Task list (mục 4.2, 7 — xem
 * ../OrcaEditor-Requirements/Requirement - 07 Lists & Task Lists.md), Clear
 * formatting/Inline code (mục 4.13). DOM-outcome test: hầu hết các hàm trong
 * toolbar.ts dùng document.execCommand/window.getSelection (chỉ có trong
 * webview thật, domino không cài) — nên KHÔNG gọi thẳng formatHeading/
 * toggleBlockquote/setBulletList/setNumberedList/toggleTaskItem, mà dựng tay
 * đúng hình DOM chúng hội tụ về (đọc kỹ source để lấy đúng tag/class/thứ tự
 * attribute) rồi kiểm tra serialize(DOM) → markdown đúng kỳ vọng + ổn định.
 *
 * Chạy riêng: npm run test:roundtrip:toolbar-format
 */
import { Runner, serializeHtml, renderer } from './_lib';

const runner = new Runner();

interface DomCase {
  name: string;
  html: string;
  expect: (md: string) => boolean;
}

const domCases: DomCase[] = [
  // -------------------------------------------------------------------------
  // formatHeading (US-4.1/US-4.9) — thay tag block bằng ctx.dom.replaceBlockTag
  // (thao tác DOM/execCommand thuần, không thể gọi trực tiếp trên domino).
  // Bấm lại CÙNG cấp heading → toggle về <p> (block.tagName === target ⇒
  // replaceBlockTag(block, 'p'), toolbar.ts:904-907). Test bằng cách dựng
  // sẵn state "SAU" thao tác toggle/convert rồi verify nó serialize đúng.
  // -------------------------------------------------------------------------
  {
    name: 'h1..h6 → # .. ###### (mọi cấp heading hội tụ về đúng markdown)',
    html: '<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><h5>e</h5><h6>f</h6>',
    expect: (md) =>
      /^#\s+a$/m.test(md) &&
      /^##\s+b$/m.test(md) &&
      /^###\s+c$/m.test(md) &&
      /^####\s+d$/m.test(md) &&
      /^#####\s+e$/m.test(md) &&
      /^######\s+f$/m.test(md),
  },
  {
    name: 'bấm lại cùng cấp heading (toggle) → replaceBlockTag(block, "p") → đoạn văn thường',
    html: '<p>x</p>',
    expect: (md) => md.trim() === 'x',
  },
  {
    name: 'h4 → #### x (case cụ thể theo yêu cầu đề bài)',
    html: '<h4>x</h4>',
    expect: (md) => md.trim() === '#### x',
  },
  {
    name: 'h1 → # x (case cụ thể theo yêu cầu đề bài)',
    html: '<h1>x</h1>',
    expect: (md) => md.trim() === '# x',
  },
  {
    name: 'heading giữ align khi replaceBlockTag copy lại attribute align (toolbar.ts:903-907, dom-utils.ts replaceBlockTag)',
    html: '<h2 align="center">giữa</h2>',
    expect: (md) => md.includes('<h2 align="center">giữa</h2>'),
  },

  // -------------------------------------------------------------------------
  // toggleBlockquote (US-4.3) — nhánh UNWRAP (toolbar.ts:915-945) là DOM thuần:
  // khi đã có <blockquote>, kéo hết children ra ngoài rồi remove() blockquote,
  // không đi qua execCommand. Test 2 chiều: (a) hình DOM SAU unwrap thủ công
  // (mô phỏng đúng vòng lặp while(bq.firstChild) parent.insertBefore(...)),
  // (b) hình DOM mà execCommand('formatBlock','blockquote') tạo ra khi TOGGLE
  // ON (không gọi được execCommand thật trên domino, nhưng verify được hình
  // <blockquote><p>...</p></blockquote> serialize đúng — đây là input tự
  // nhiên turndown/markdown-it luôn tạo ra cho blockquote nên vẫn đáng test).
  // -------------------------------------------------------------------------
  {
    name: 'toggle ON: <blockquote><p>text</p></blockquote> (hình execCommand formatBlock tạo ra) → "> text"',
    html: '<blockquote><p>text</p></blockquote>',
    expect: (md) => md.trim() === '> text',
  },
  {
    name: 'toggle OFF (unwrap thủ công, mô phỏng đúng vòng lặp bq.firstChild → parent.insertBefore): <blockquote> biến mất, <p> lộ ra ngoài #content',
    // Mô phỏng CHÍNH XÁC kết quả unwrap: bq.remove() sau khi đã kéo hết
    // children ra trước nó trong parent — tức <p> đứng trực tiếp trong
    // #content, không còn <blockquote> bao ngoài.
    html: '<p>quoted</p>',
    expect: (md) => md.trim() === 'quoted' && !md.includes('>'),
  },
  {
    name: 'unwrap blockquote nhiều đoạn (2 <p>) → mỗi đoạn thành 1 đoạn văn thường, không còn dấu >',
    html: '<p>đoạn 1</p><p>đoạn 2</p>',
    expect: (md) => md.includes('đoạn 1') && md.includes('đoạn 2') && !md.includes('>'),
  },

  // -------------------------------------------------------------------------
  // setBulletList/setNumberedList/toggleTaskItem + stripCheckboxFrom/
  // syncTaskListClass/addCheckbox (dom-utils.ts) — hình <li> chính xác:
  // addCheckbox() insertBefore input.task-list-item-checkbox làm CON ĐẦU
  // TIÊN của <li>, gắn class "task-list-item" lên <li> và
  // "contains-task-list" lên <ul>/<ol> cha.
  // -------------------------------------------------------------------------
  {
    name: 'bullet list phẳng → "- a" / "- b"',
    html: '<ul><li>a</li><li>b</li></ul>',
    expect: (md) => /^-\s+a$/m.test(md) && /^-\s+b$/m.test(md),
  },
  {
    name: 'numbered list phẳng → "1. a" / "2. b"',
    html: '<ol><li>a</li><li>b</li></ol>',
    expect: (md) => /^1\.\s+a$/m.test(md) && /^2\.\s+b$/m.test(md),
  },
  {
    name: 'task list chưa check + đã check (đúng hình addCheckbox: input là con ĐẦU TIÊN, class task-list-item/contains-task-list)',
    html:
      '<ul class="contains-task-list">' +
      '<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox"> chưa xong</li>' +
      '<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked> đã xong</li>' +
      '</ul>',
    expect: (md) => /^-\s+\[ \]\s+chưa xong$/m.test(md) && /^-\s+\[x\]\s+đã xong$/m.test(md),
  },
  {
    name: 'task item bỏ checkbox (stripCheckboxFrom: xoá input + cắt whitespace ĐẦU text node còn lại) → về bullet thường, không dư khoảng trắng đầu dòng',
    // stripCheckboxFrom cắt "^\s+" khỏi textContent của first child (text node
    // ngay sau checkbox cũ) — mô phỏng đúng: <li> không còn input, text bắt
    // đầu ngay bằng nội dung (không còn khoảng trắng thừa phía trước).
    html: '<ul><li class="task-list-item">việc thường</li></ul>',
    expect: (md) => /^-\s+việc thường$/m.test(md) && !md.includes('[ ]') && !md.includes('[x]'),
  },
  {
    name: 'stripCheckboxFrom cắt hết whitespace nếu text node CHỈ có khoảng trắng → text node bị remove() luôn (toolbar.ts:1074-1076), không để lại "- " trơ',
    // first.textContent.replace(/^\s+/, '') === '' → first.remove(): mô
    // phỏng bằng <li> có 1 <strong> làm nội dung thật duy nhất (không có text
    // thừa phía trước, đúng hệt kết quả sau strip).
    html: '<ul><li><strong>chỉ có bold</strong></li></ul>',
    expect: (md) => /^-\s+\*\*chỉ có bold\*\*$/m.test(md),
  },
  {
    name: 'ordered task list (giữ số thứ tự, độc lập với checkbox — US-4.2 "Checkbox state is independent of list ordering")',
    html:
      '<ol class="contains-task-list">' +
      '<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked> việc 1</li>' +
      '</ol>',
    expect: (md) => /^1\.\s+\[x\]\s+việc 1$/m.test(md),
  },
  {
    // Defense-in-depth for bug #10 (checkbox stacking): if an <li> already has
    // two stacked checkboxes from prior corruption, turndown's taskCheckbox
    // rule (turndown.ts) must still emit exactly one [ ]/[x] token — not two.
    name: 'stacked duplicate checkboxes on one <li> (pre-existing corruption) → emits exactly ONE [ ] token, not two (bug #10 defense-in-depth)',
    html:
      '<ul class="contains-task-list">' +
      '<li class="task-list-item">' +
      '<input type="checkbox" class="task-list-item-checkbox">' +
      '<input type="checkbox" class="task-list-item-checkbox">' +
      ' duplicated task</li>' +
      '</ul>',
    expect: (md) => {
      const tokenCount = (md.match(/\[ \]/g) ?? []).length;
      return tokenCount === 1 && /^-\s+\[ \]\s+duplicated task$/m.test(md);
    },
  },
  {
    // Follow-up to the above: bug #10's dedup guard only compared checkbox
    // SIBLINGS under the same immediate parentNode, so it missed a "loose"
    // list item (checkbox nested in the <li>'s child <p> — see comment atop
    // the taskCheckbox rule in turndown.ts) that ALSO carries a duplicate
    // checkbox as a direct <li> child: different parentNode (<p> vs <li>) →
    // old guard treated them as unrelated and let both serialize. turndown.ts
    // now walks the <li>'s children in document order (`firstQualifyingCheckbox`)
    // so a tight-child + loose-nested-in-<p> pair on the SAME <li> dedupes
    // to one token regardless of which parentNode each sits under.
    name: 'loose-list checkbox (nested in child <p>) + duplicate direct-child checkbox on same <li> → still emits exactly ONE token (bug #10 follow-up)',
    html:
      '<ul class="contains-task-list">' +
      '<li class="task-list-item">' +
      '<p><input type="checkbox" class="task-list-item-checkbox" checked> loose task</p>' +
      '<input type="checkbox" class="task-list-item-checkbox">' +
      '</li>' +
      '</ul>',
    expect: (md) => {
      const tokenCount = (md.match(/\[x\]|\[ \]/g) ?? []).length;
      return tokenCount === 1 && /^-\s+\[x\]\s+loose task$/m.test(md);
    },
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
// toggleInlineCode (US-4.13) — export function, nhánh UNWRAP (khi đã có
// <code> KHÔNG nằm trong <pre>) là DOM thuần (toolbar.ts:1379-1390): kéo hết
// children của <code> ra parent rồi removeChild — không execCommand. Nhánh
// WRAP dùng range.surroundContents(code) (cần Selection/Range sống, không
// gọi được trên domino) — nhưng verify được HÌNH KẾT QUẢ <code>wrapped</code>
// serialize đúng thành `wrapped` có backtick.
// ---------------------------------------------------------------------------
const inlineCodeCases: DomCase[] = [
  {
    name: 'wrap: <p>before <code>wrapped</code> after</p> (hình surroundContents tạo ra) → before `wrapped` after',
    html: '<p>before <code>wrapped</code> after</p>',
    expect: (md) => md.trim() === 'before `wrapped` after',
  },
  {
    name: 'unwrap: <code> không trong <pre> — kéo children ra ngoài rồi removeChild (toolbar.ts:1382-1388) → mất backtick, giữ nguyên text',
    // Mô phỏng đúng kết quả unwrap: children của <code> (chỉ có text "wrapped")
    // đã được insertBefore ra ngay trong <p>, <code> đã bị removeChild.
    html: '<p>before wrapped after</p>',
    expect: (md) => md.trim() === 'before wrapped after' && !md.includes('`'),
  },
  {
    name: 'unwrap giữ nguyên inline formatting bên trong <code> cũ (vd <code><em>x</em></code> → chỉ mất backtick, giữ <em>)',
    html: '<p>a <em>x</em> b</p>',
    expect: (md) => md.trim() === 'a *x* b' && !md.includes('`'),
  },
];

for (const c of inlineCodeCases) {
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

runner.finish('toolbar-format');
