/**
 * Feature: Lists & Task Lists (HLR mục 7) + thụt/bỏ thụt (US-3.3). DOM-outcome
 * tests cho DOM méo mà execCommand indent/outdent của Chromium sinh ra ngoài
 * bảng (bên trong bảng xem test/roundtrip/table.ts) — serialize phải chuẩn hóa
 * về markdown đúng, không dính dòng hay mất mục con.
 *
 * Chạy riêng: npm run test:roundtrip:lists
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
    name: 'dom méo (outdent li>li) ngoài bảng → hai bullet riêng, không "* A* B"',
    html: '<ul><li>A<li>B</li></li></ul>',
    expect: (md) => {
      const bullets = md.split('\n').filter((l) => /^\s*\*\s+\S/.test(l));
      return bullets.length === 2 && /A/.test(bullets[0]) && /B/.test(bullets[1]);
    },
  },
  {
    name: 'dom méo (outdent 2 mục) ngoài bảng → A,B ngang cấp, C thụt dưới B',
    html: '<ul><li>A<li>B</li><ul><li>C</li></ul></li></ul>',
    expect: (md) => /^\*\s+B/m.test(md) && /^\s+\*\s+C/m.test(md),
  },
  // US-17.5 (M3): list item drag reorder + drag-triggered indent/outdent. Drag-
  // triggered outdent produces the exact same DOM shape as the Tab-triggered
  // case above ("dom méo (outdent li>li)") since both go through the same
  // execCommand('outdent') — not duplicated here, only the shapes NOT already
  // covered above are added: plain reorder, indent, ordered renumber, nested
  // sub-tree carried along with the dragged item.
  {
    name: 'list item drag reorder (US-17.5) — item B moved above item A',
    html: '<ul><li>Bravo</li><li>Alpha</li></ul>',
    expect: (md) => {
      const bravo = md.indexOf('Bravo');
      const alpha = md.indexOf('Alpha');
      return bravo >= 0 && alpha >= 0 && bravo < alpha;
    },
  },
  {
    name: 'list item drag reorder (US-17.5) — nested sub-tree travels WITH the dragged item, not left behind',
    html: '<ul><li>Bravo<ul><li>Bravo child</li></ul></li><li>Alpha</li></ul>',
    expect: (md) => {
      const bravo = md.indexOf('Bravo');
      const child = md.indexOf('Bravo child');
      const alpha = md.indexOf('Alpha');
      return bravo >= 0 && bravo < child && child < alpha && /^\s+\*\s+Bravo child/m.test(md);
    },
  },
  {
    name: 'list item drag indent (US-17.5) — execCommand(\'indent\') DOM shape (list nested directly in list, Chromium) normalizes to a proper nested bullet',
    html: '<ul><li>Alpha</li><ul><li>Bravo</li></ul></ul>',
    expect: (md) => /^\*\s+Alpha/m.test(md) && /^\s+\*\s+Bravo/m.test(md),
  },
  {
    name: 'ordered list renumbers by DOM position after drag reorder (US-17.5) — no stored index needed',
    html: '<ol><li>Second</li><li>First</li></ol>',
    expect: (md) => /^1\.\s+Second/m.test(md) && /^2\.\s+First/m.test(md),
  },
  // US-17.7 (M6): cross-level li drag — moving an item to a genuinely different
  // depth (not just a same-parent reorder or a one-step indent/outdent) within
  // the same root list. These hand-build the RESULT DOM shape a cross-level
  // move must produce (canonical <li>text<ul>/<ol>...</ul></li>), matching
  // finishLiMove/applyLiReparentMove's output in drag-drop.ts/sibling-move.ts.
  {
    name: 'cross-level li move (US-17.7) — item dropped as a new child at target depth+1, correct indentation',
    html: '<ul><li>Alpha</li><li>Bravo<ul><li>Charlie</li><li>Delta</li></ul></li></ul>',
    expect: (md) => {
      // Delta landed as Bravo's child (depth 2), alongside Charlie — both indented one level
      // under Bravo, Alpha stays at depth 1.
      const alpha = md.indexOf('Alpha');
      const bravo = md.indexOf('Bravo');
      const charlie = md.indexOf('Charlie');
      const delta = md.indexOf('Delta');
      return (
        alpha >= 0 &&
        bravo >= 0 &&
        alpha < bravo &&
        bravo < charlie &&
        charlie < delta &&
        /^\*\s+Alpha/m.test(md) &&
        /^\*\s+Bravo/m.test(md) &&
        /^\s+\*\s+Charlie/m.test(md) &&
        /^\s+\*\s+Delta/m.test(md)
      );
    },
  },
  {
    name: 'cross-level li move (US-17.7) — parent item (with its own children) moved to a shallower depth, subtree keeps exact relative structure',
    html: '<ul><li>Alpha</li><li>Bravo</li><li>Parent<ul><li>Child</li></ul></li></ul>',
    expect: (md) => {
      // "Parent" (with its own nested "Child") moved out from under Bravo to sit at depth 1,
      // right after Bravo — Child stays nested one level under Parent, exactly as before the move.
      const bravo = md.indexOf('Bravo');
      const parent = md.indexOf('Parent');
      const child = md.indexOf('Child');
      return (
        bravo >= 0 &&
        bravo < parent &&
        parent < child &&
        /^\*\s+Parent/m.test(md) &&
        /^\s+\*\s+Child/m.test(md)
      );
    },
  },
  {
    name: 'cross-level li move (US-17.7) — ordered list renumbers correctly at both source and destination after a depth change',
    html: '<ol><li>First</li><li>Second<ol><li>Third</li></ol></li></ol>',
    expect: (md) => /^1\.\s+First/m.test(md) && /^2\.\s+Second/m.test(md) && /^\s+1\.\s+Third/m.test(md),
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

runner.finish('lists');
