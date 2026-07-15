/**
 * Feature: Readability / Accessibility (HLR mục 19 — US-19.7 ARIA, US-19.3 table).
 *
 * ARIA/role/scope là display-only (chỉ ở tầng render DOM) — PHẢI bị serializer
 * (turndown) strip khi ghi lại `.md`, không rò tag lạ (luật CLAUDE.md). Bảng
 * content-aware sizing (US-19.3) thuần CSS nên không đổi `.md`; test khẳng định
 * bảng vẫn roundtrip sạch qua pipe syntax.
 *
 * Chạy riêng: npm run test:roundtrip:accessibility
 */
import { Runner, serializeHtml, renderer } from './_lib';

const runner = new Runner();

// 1) th scope + aria-* + role dựng tay trong DOM → serialize ra `.md` sạch.
{
  const html =
    '<table role="table" aria-label="data">' +
    '<thead><tr>' +
    '<th scope="col" aria-sort="ascending">Name</th>' +
    '<th scope="col">Age</th>' +
    '</tr></thead>' +
    '<tbody><tr>' +
    '<td role="cell">Alice</td><td>30</td>' +
    '</tr></tbody></table>';
  let ok = true;
  const problems: string[] = [];
  try {
    const md = serializeHtml(html);
    for (const leak of ['scope', 'aria-', 'role=']) {
      if (md.includes(leak)) {
        ok = false;
        problems.push(`Rò "${leak}" vào .md: ${JSON.stringify(md)}`);
      }
    }
    if (!/\|\s*Name\s*\|\s*Age\s*\|/.test(md)) {
      ok = false;
      problems.push(`Bảng không ra pipe syntax sạch: ${JSON.stringify(md)}`);
    }
    // Render lại từ .md → th tự có scope="col" trở lại (render.ts, US-19.7),
    // nhưng serialize lần 2 vẫn ra .md y hệt (ổn định, không rò).
    const md2 = serializeHtml(renderer.render(md).html);
    if (md2 !== md) {
      ok = false;
      problems.push(`Không ổn định: md=${JSON.stringify(md)} md2=${JSON.stringify(md2)}`);
    }
    if (md2.includes('scope') || md2.includes('aria-')) {
      ok = false;
      problems.push(`Rò tag ở vòng 2: ${JSON.stringify(md2)}`);
    }
  } catch (e) {
    ok = false;
    problems.push(`Exception: ${(e as Error).stack}`);
  }
  runner.check('th scope/aria/role bị strip khỏi .md, bảng roundtrip sạch', ok, problems.join('\n'));
}

// 2) render.ts thực sự gắn scope="col" cho <th> (đảm bảo AC US-19.7 có hiệu lực).
{
  const html = renderer.render('| A | B |\n| - | - |\n| 1 | 2 |').html;
  const count = (html.match(/scope="col"/g) ?? []).length;
  runner.check('render() gắn scope="col" cho mọi <th> header cột', count === 2, `nhận ${count} scope="col", kỳ vọng 2`);
}

// 3) Bảng có token dài (US-19.3) vẫn roundtrip sạch qua pipe — sizing là CSS,
// không đổi nội dung .md.
runner.roundtrip(
  'bảng token dài (US-19.3 content-aware sizing) roundtrip ổn định',
  '| Column | Value |\n| --- | --- |\n| supercalifragilisticexpialidocious | 123 |\n| short | 4 |'
);

runner.finish('accessibility');
