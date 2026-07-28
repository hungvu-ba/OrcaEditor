/**
 * Feature: sửa công thức Math (KaTeX) qua popup nổi (US-4.19, HLR mục 4 —
 * xem ../OrcaEditor-Requirements/Requirement - 04 Formatting Toolbar.md,
 * mục "US-4.19 — Math (KaTeX) edit popover with a syntax cheat-sheet").
 *
 * Apply (button click, hoặc ⌘/Ctrl+Enter trong textarea) gọi renderInto()
 * (media/webview/math-edit.ts): render lại KaTeX vào .md-math-render (chỉ
 * ảnh hưởng hiển thị) rồi `wrapper.setAttribute('data-tex', tex)` — ĐÂY mới
 * là phần duy nhất ảnh hưởng tới serialize, vì turndown.ts (rule mathBlock/
 * mathInline) đọc THẲNG attribute `data-tex` của wrapper, bỏ qua toàn bộ
 * children (kể cả .md-math-render vừa render lại) khi sinh markdown. Vậy nên
 * test không cần gọi katex.renderToString thật (dù làm được trên Node, katex
 * là pure JS) — chỉ cần mô phỏng đúng bước setAttribute('data-tex', ...) là
 * đủ phủ hành vi commit() thật của renderInto.
 *
 * Không gọi thẳng renderInto/openEditPopover vì chúng cần querySelector vào
 * DOM đã tồn tại của popup + Selection/focus sống — nhưng phần DOM mà chúng
 * cần tồn tại TRƯỚC đó (wrapper .md-math-inline/.md-math-block) do
 * postProcessMathDom() dựng — đúng bước main.ts chạy sau mỗi lần render
 * (main.ts:210) hoặc chèn markdown mới (main.ts:582), TRƯỚC khi người dùng
 * bấm nút "Edit". Test dựng wrapper đó bằng chính postProcessMathDom thật
 * (import trực tiếp từ pipeline.ts, cùng cách _lib.ts dùng nội bộ), rồi mô
 * phỏng "Apply" bằng cách sửa attribute data-tex trên chuỗi HTML kết quả.
 *
 * Lưu ý: gọi postProcessMathDom() LẦN 2 (bên trong serializeHtml, khi
 * "chốt" bước Apply) trên một wrapper .md-math-inline đã tồn tại là AN
 * TOÀN/vô hại — nhánh inline có check hasAncestor(MATH_INLINE_CLASS) nên bỏ
 * qua .katex con đã nằm trong wrapper cũ. Nhánh BLOCK (.katex-display)
 * KHÔNG có check ancestor tương tự nên sẽ lồng thêm 1 .md-math-block bên
 * trong (đã kiểm chứng thủ công) — nhưng vô hại cho markdown cuối cùng: rule
 * `mathBlock` trong turndown.ts bỏ qua toàn bộ children khi đã match 1 node
 * .md-math-block, nên chỉ có data-tex của wrapper NGOÀI CÙNG (đã sửa qua
 * Apply) được dùng, wrapper lồng bên trong (data-tex cũ) bị bỏ qua hoàn
 * toàn. Ghi chú lại ở đây để không ai nhầm là bug khi đọc lại test này.
 *
 * Chạy riêng: npm run test:roundtrip:math-edit
 */
import { Runner, serializeHtml, renderer, domino, COMPLEX_CELL } from './_lib';
import { postProcessMathDom } from '../../media/webview/pipeline';

const runner = new Runner();

/**
 * Dựng đúng cấu trúc wrapper .md-math-inline/.md-math-block (data-tex + con
 * .md-math-render chứa KaTeX thật đã render) từ markdown nguồn — cùng bước
 * postProcessMathDom mà main.ts chạy trên DOM thật trước khi người dùng có
 * thể bấm nút "Edit" mở popup (xem doc comment đầu file).
 */
function buildWrapperHtml(md: string): string {
  const html = renderer.render(md).html;
  const doc = domino.createDocument(`<div id="content">${html}</div>`, true);
  const root = doc.getElementById('content');
  if (!root) {
    throw new Error('không parse được HTML');
  }
  postProcessMathDom(root, doc);
  return root.innerHTML;
}

/**
 * Mô phỏng bước cốt lõi của renderInto()/commit() trong openEditPopover
 * (math-edit.ts) khi bấm Apply: wrapper.setAttribute('data-tex', tex mới).
 * Dùng regex (không phải string literal match) vì KaTeX giữ nguyên whitespace
 * gốc trong annotation TeX — công thức block "$$x^2$$" ra data-tex="x^2\n"
 * (có \n cuối, đã kiểm chứng thủ công), match literal chuỗi sẽ silently
 * fail nếu không tính whitespace đó.
 */
function applyEdit(wrapperHtml: string, newTex: string): string {
  const edited = wrapperHtml.replace(/data-tex="[^"]*"/, `data-tex="${newTex}"`);
  if (edited === wrapperHtml) {
    throw new Error('không tìm thấy attribute data-tex để thay — fixture sai hình');
  }
  return edited;
}

// ---------------------------------------------------------------------------
// Inline math: $x^2$ → Apply "y^3" → $y^3$
// ---------------------------------------------------------------------------
{
  const before = buildWrapperHtml('$x^2$');
  runner.check(
    'inline: wrapper dựng từ renderer thật mang đúng data-tex="x^2" (US-4.19 tiền đề)',
    before.includes('class="md-math-inline"') && before.includes('data-tex="x^2"'),
    before.slice(0, 200)
  );

  const edited = applyEdit(before, 'y^3');
  const md = serializeHtml(edited);
  runner.check('inline: Apply → serialize ra công thức MỚI $y^3$', md.includes('$y^3$'), md);
  runner.check('inline: KHÔNG còn dấu vết công thức cũ x^2', !md.includes('x^2'), md);
}

// ---------------------------------------------------------------------------
// Block math: $$x^2$$ → Apply "y^3" → $$y^3$$
// ---------------------------------------------------------------------------
{
  const before = buildWrapperHtml('$$x^2$$');
  runner.check(
    'block: wrapper dựng từ renderer thật mang class md-math-block + data-tex chứa x^2',
    before.includes('class="md-math-block"') && /data-tex="x\^2\s*"/.test(before),
    before.slice(0, 200)
  );

  const edited = applyEdit(before, 'y^3');
  const md = serializeHtml(edited);
  runner.check('block: Apply → serialize ra công thức MỚI $$ y^3 $$', /\$\$\s*y\^3\s*\$\$/.test(md), md);
  runner.check('block: KHÔNG còn dấu vết công thức cũ x^2', !md.includes('x^2'), md);
}

// ---------------------------------------------------------------------------
// Ổn định round-trip: markdown SAU Apply phải render→serialize lại ra chính nó
// (checkRoundtrip render từ markdown thật, không đụng lại DOM wrapper đã sửa
// tay ở trên — xác nhận $y^3$/$$y^3$$ là markdown hợp lệ, tự-consistent).
// ---------------------------------------------------------------------------
runner.roundtrip(
  'inline: markdown sau Apply ($y^3$) ổn định qua round-trip render→serialize',
  serializeHtml(applyEdit(buildWrapperHtml('$x^2$'), 'y^3'))
);
runner.roundtrip(
  'block: markdown sau Apply ($$y^3$$) ổn định qua round-trip render→serialize',
  serializeHtml(applyEdit(buildWrapperHtml('$$x^2$$'), 'y^3'))
);

// ---------------------------------------------------------------------------
// RAW-HTML serialize path (US-23.22 deferred item 1, fixed 2026-07-28): the
// mathInline/mathBlock RULES above are what turn a wrapper back into `$…$` /
// `$$…$$`, and a rule never runs inside complexTableAsHtml — a table with a
// `td li li` cell is emitted through outerHTML. So math in such a table used to
// write the wrapper, its `md-math-*` classes, `data-tex`, `contenteditable` AND
// the whole rendered KaTeX subtree into the user's `.md`. The wrapper element
// itself must be back to its source form before outerHTML is taken.
// ---------------------------------------------------------------------------
{
  /** A complex (raw-HTML-serialized) table whose first cell holds real rendered math. */
  function tableWithMath(mathMd: string): string {
    const cell = renderer.render(mathMd).html.trim();
    const doc = domino.createDocument(
      '<div id="content"><table><thead><tr><th>A</th></tr></thead><tbody><tr>' +
        `<td>${cell}</td>${COMPLEX_CELL}</tr></tbody></table></div>`,
      true
    );
    const root = doc.getElementById('content');
    if (!root) {
      throw new Error('could not parse HTML');
    }
    postProcessMathDom(root, doc);
    return root.innerHTML;
  }

  for (const [kind, mathMd, expect] of [
    ['inline', '$x^2$', /\$x\^2\$/],
    ['block', '$$x^2$$', /\$\$\s*x\^2\s*\$\$/],
  ] as const) {
    const fixture = tableWithMath(mathMd);
    runner.check(
      `raw-HTML ${kind}: fixture really carries a math wrapper in the cell`,
      fixture.includes('data-tex="x^2'),
      fixture.slice(0, 300)
    );
    const md = serializeHtml(fixture);
    runner.check(
      `raw-HTML ${kind}: the table really took the raw-HTML path (complexTableAsHtml)`,
      md.trimStart().startsWith('<table'),
      JSON.stringify(md)
    );
    runner.check(`raw-HTML ${kind}: the .md carries the formula's SOURCE form`, expect.test(md), md);
    runner.check(`raw-HTML ${kind}: no md-math-* class leaks`, !md.includes('md-math'), md);
    runner.check(`raw-HTML ${kind}: no data-tex leaks`, !md.includes('data-tex'), md);
    runner.check(`raw-HTML ${kind}: no rendered KaTeX subtree leaks`, !md.includes('katex'), md);
    runner.check(`raw-HTML ${kind}: no contenteditable leaks`, !md.includes('contenteditable'), md);
    runner.check(
      `raw-HTML ${kind}: stable on a 2nd render->serialize pass`,
      serializeHtml(renderer.render(md).html) === md,
      `\n  md2: ${JSON.stringify(serializeHtml(renderer.render(md).html))}\n  md1: ${JSON.stringify(md)}`
    );
  }

  // TeX `%` comments to end of line, so folding a MULTI-LINE formula onto one
  // line moves everything after the comment INTO it and deletes it silently.
  // Measured before the guard: `a % first term\n+ b` serialized as
  // `$$a % first term + b$$` — `+ b` gone from the user's file, unrecoverable.
  // Found by the US-23.22 review's blind hunter, 2026-07-28.
  {
    const md = serializeHtml(tableWithMath('$$\na % first term\n+ b\n$$'));
    runner.check(
      'raw-HTML block: a formula with a `%` comment is NOT folded onto one line, losing what follows it',
      md.includes('a % first term\n+ b'),
      md
    );
    runner.check('raw-HTML block (`%` comment): no md-math-* class leaks', !md.includes('md-math'), md);
    runner.check(
      'raw-HTML block (`%` comment): stable on a 2nd pass',
      serializeHtml(renderer.render(md).html) === md,
      `\n  md2: ${JSON.stringify(serializeHtml(renderer.render(md).html))}\n  md1: ${JSON.stringify(md)}`
    );
  }

  // An empty formula must write NOTHING, not a bare `$`/`$$` — that would be an
  // unterminated math opener the day the cell stops needing HTML serialization.
  {
    const empty = serializeHtml(
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr>' +
        `<td>a <span class="md-math-inline" data-tex=" ">x</span> b</td>${COMPLEX_CELL}</tr></tbody></table>`
    );
    runner.check(
      'raw-HTML: an empty data-tex writes nothing, not a bare `$`',
      empty.includes('<td>a  b</td>') && !empty.includes('$'),
      empty
    );
  }

  // KNOWN LIMITATION, pinned deliberately — NOT an assertion that this is
  // desirable. `postProcessMathDom` finds math only by querying `.katex` /
  // `.katex-display`, which only @vscode/markdown-it-katex produces, and
  // markdown-it never runs inline rules inside an html_block. So `$…$` written
  // back into a raw-HTML region can never become math again: the cell shows the
  // literal source after a save (the same thing GitHub and VS Code preview show
  // there). Measured 2026-07-28: before US-23.22 the leaked KaTeX subtree DID
  // revive, so the leak was functional — this fix trades that for a clean `.md`.
  // The caption and diagram branches both revive (postProcessCaptions walks text
  // nodes; postProcessDiagramDom queries `pre > code.language-*`); math is the one
  // family with no equivalent, recorded as deferred work.
  // WHEN A REVIVAL PASS SHIPS: this case goes red — delete it and assert the
  // wrapper comes back with its original data-tex instead.
  {
    const md = serializeHtml(tableWithMath('$x^2$'));
    const doc = domino.createDocument(`<div id="content">${renderer.render(md).html}</div>`, true);
    const root = doc.getElementById('content');
    if (!root) {
      throw new Error('could not parse HTML');
    }
    postProcessMathDom(root, doc);
    runner.check(
      'raw-HTML inline: KNOWN LIMITATION — the restored `$…$` does not revive as math on reopen',
      root.querySelectorAll('.md-math-inline').length === 0 && md.includes('$x^2$'),
      root.innerHTML.slice(0, 300)
    );
  }
}

// Ghi chú: nhánh "TeX rỗng sau trim → giữ nguyên currentTex"
// (`textarea.value.trim() || currentTex`, math-edit.ts commit()) là logic
// JS thuần không đụng DOM gì khác ngoài chính renderInto đã phủ ở trên (khi
// currentTex được giữ nguyên, kết quả set data-tex giống hệt case "không
// đổi gì" — không có hình DOM mới nào để test riêng).

runner.finish('math-edit');
