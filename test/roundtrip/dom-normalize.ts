/**
 * Feature: chuẩn hóa DOM chung trước khi serialize (HLR mục 3 WYSIWYG Editing /
 * dom-serialize-prep.ts) — không gắn với 1 nút toolbar cụ thể, mà là bước dọn
 * dẹp style→attribute áp dụng bất kể nguồn gốc DOM (paste, execCommand...).
 *
 * Chạy riêng: npm run test:roundtrip:dom-normalize
 */
import { Runner, serializeHtml, renderer } from './_lib';

const runner = new Runner();

interface DomCase {
  name: string;
  html: string;
  expect: (md: string) => boolean;
}

const domCases: DomCase[] = [
  {
    name: 'p có style text-align → chuyển thành <p align="...">',
    html: '<p style="text-align: center;">giữa</p>',
    expect: (md) => md.includes('<p align="center">giữa</p>'),
  },
  {
    name: 'heading có align → giữ dạng HTML, không mất căn lề',
    html: '<h2 align="center">Tiêu đề <em>giữa</em></h2>',
    expect: (md) => md.includes('<h2 align="center">Tiêu đề <em>giữa</em></h2>'),
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

runner.finish('dom-normalize');
