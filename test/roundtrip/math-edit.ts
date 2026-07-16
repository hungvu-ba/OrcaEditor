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
import { Runner, serializeHtml, renderer, domino } from './_lib';
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

// Ghi chú: nhánh "TeX rỗng sau trim → giữ nguyên currentTex"
// (`textarea.value.trim() || currentTex`, math-edit.ts commit()) là logic
// JS thuần không đụng DOM gì khác ngoài chính renderInto đã phủ ở trên (khi
// currentTex được giữ nguyên, kết quả set data-tex giống hệt case "không
// đổi gì" — không có hình DOM mới nào để test riêng).

runner.finish('math-edit');
