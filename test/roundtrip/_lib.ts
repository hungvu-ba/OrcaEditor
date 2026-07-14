/**
 * Hạ tầng dùng chung cho mọi file test roundtrip theo feature (test/roundtrip/*.ts).
 * Mỗi file feature tự import từ đây, tự định nghĩa case, tự gọi runner.finish() —
 * chạy độc lập được (npm run test:roundtrip:<feature>) hoặc gộp lại
 * (npm run test:roundtrip chạy tuần tự tất cả file trong thư mục này).
 */
import domino from '@mixmark-io/domino';
import {
  MarkdownRenderer,
  createTurndown,
  fillSequenceColumn,
  normalizeMarkdown,
  postProcessMathDom,
  postProcessMermaidDom,
  prepareDomForSerialize,
} from '../../media/webview/pipeline';

export { fillSequenceColumn, domino };

export const renderer = new MarkdownRenderer({ breaks: false, linkify: true });
export const turndown = createTurndown();

/** DOM (đã render từ markdown, hoặc dựng tay mô phỏng kết quả 1 thao tác editor) → markdown. */
export function serializeHtml(html: string): string {
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

export function normalizeHtml(html: string): string {
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
  return n.nodeType === 1 && (BLOCK_TAGS.has(n.nodeName) || n.nodeName === 'BR');
}

export function firstDiff(a: string, b: string): string {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) {
    i++;
  }
  const from = Math.max(0, i - 60);
  return [
    `  vị trí khác nhau đầu tiên: ${i}`,
    `  a: ...${JSON.stringify(a.slice(from, i + 120))}`,
    `  b: ...${JSON.stringify(b.slice(from, i + 120))}`,
  ].join('\n');
}

/** html1 = render(md); md2 = serialize(html1); html2 = render(md2) — so sánh html1≡html2, và md3===md2 (serializer ổn định). */
export function checkRoundtrip(md: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  let ok = true;
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

    const md3 = serializeHtml(html2);
    if (md3 !== md2) {
      ok = false;
      problems.push('Serializer không ổn định (md3 !== md2):');
      problems.push(firstDiff(md2, md3));
    }
  } catch (e) {
    ok = false;
    problems.push(`Exception: ${(e as Error).stack}`);
  }
  return { ok, problems };
}

export class Runner {
  pass = 0;
  fail = 0;
  private failures: string[] = [];

  check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
      this.pass++;
      console.log(`PASS  ${name}`);
    } else {
      this.fail++;
      console.log(`FAIL  ${name}`);
      this.failures.push(`--- ${name} ---${detail ? '\n' + detail : ''}`);
    }
  }

  /** So khớp value bất kỳ (JSON-stringify) — tiện cho case dạng eq(actual, expected). */
  eq(name: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    this.check(name, a === e, `  nhận:    ${a}\n  kỳ vọng: ${e}`);
  }

  /** Chạy checkRoundtrip(md) và ghi nhận kết quả dưới tên `name`. */
  roundtrip(name: string, md: string): void {
    const { ok, problems } = checkRoundtrip(md);
    this.check(name, ok, problems.join('\n'));
  }

  /** In tổng kết + exit(1) nếu có fail — gọi ở cuối MỖI file feature. */
  finish(featureName: string): void {
    console.log(`\n[${featureName}] ${this.pass} pass, ${this.fail} fail`);
    if (this.failures.length) {
      console.log('\n' + this.failures.join('\n\n'));
      process.exit(1);
    }
  }
}
