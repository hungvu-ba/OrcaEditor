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
  // HLR 22 (execCommand List/Block Verb Replacement) Phase 0.4: golden-rule
  // roundtrip coverage for the <p><ul>/<p><ol> shape that
  // insertUnorderedList/insertOrderedList leave behind (setBulletList/
  // setNumberedList, toolbar.ts) when starting from a plain paragraph — turndown
  // already serializes this correctly today; these lock that in so the Phase 2
  // primitive replacement can't silently regress it (see
  // test/webview/list-verbs-audit.spec.ts for the live-DOM characterization).
  {
    name: 'dom méo (insertUnorderedList: <ul> lồng trong <p> còn sót, nhiều đoạn) → 2 bullet đúng, không mất dòng',
    html: '<p><ul><li>First</li><li>Second</li></ul></p>',
    expect: (md) => /^\*\s+First$/m.test(md) && /^\*\s+Second$/m.test(md),
  },
  {
    name: 'dom méo (insertUnorderedList: <ul> lồng trong <p> còn sót, 1 đoạn) → 1 bullet đúng',
    html: '<p><ul><li>Hello world</li></ul></p>',
    expect: (md) => /^\*\s+Hello world$/m.test(md),
  },
  {
    name: 'dom méo (insertOrderedList từ <p> thường, không phải convert ul->ol: <ol> lồng trong <p> còn sót) → đánh số đúng',
    html: '<p><ol><li>First</li><li>Second</li></ol></p>',
    expect: (md) => /^1\.\s+First$/m.test(md) && /^2\.\s+Second$/m.test(md),
  },
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
  // HLR 22 Phase 2.1: golden-rule equivalence for the "later siblings re-nest"
  // outdent scenario -- this is the exact clean HTML computeOutdent (list-ops.ts)
  // produces for that same A/B/C case (see test/roundtrip/list-ops.ts's "later
  // siblings re-nest under the outdented item" case), now that main.ts's
  // Shift+Tab handler is wired to it. Must serialize to the SAME markdown as the
  // malformed-DOM case right above -- proves the Phase 2.1 fix doesn't change
  // the golden-rule output for this scenario.
  {
    name: 'clean DOM (computeOutdent: later item re-nests under the outdented item) → same markdown as the corresponding malformed DOM',
    html: '<ul><li>A</li><li>B<ul><li>C</li></ul></li></ul>',
    expect: (md) => md === serializeHtml('<ul><li>A<li>B</li><ul><li>C</li></ul></li></ul>'),
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
  // HLR 22 Phase 2.2: golden-rule equivalence for the "previous sibling already
  // has a sublist" indent scenario -- this is the exact clean HTML computeIndent
  // (list-ops.ts) produces for that same case (see test/roundtrip/list-ops.ts's
  // "previous sibling already has a sublist" case), now that main.ts's Tab
  // handler is wired to it. Serializes with the same Alpha-stays-top-level,
  // Bravo-lands-nested-underneath shape as the malformed-DOM indent case above
  // ("list item drag indent") -- proves the Phase 2.2 fix doesn't regress the
  // golden-rule output for this scenario.
  {
    name: 'clean DOM (computeIndent: previous sibling already has a sublist) → same indent shape as the corresponding malformed DOM, X not dropped/duplicated',
    html: '<ul><li>Alpha<ul><li>X</li><li>Bravo</li></ul></li></ul>',
    expect: (md) => {
      const alpha = md.indexOf('Alpha');
      const x = md.indexOf('X');
      const bravo = md.indexOf('Bravo');
      return (
        alpha >= 0 &&
        x > alpha &&
        bravo > x &&
        /^\*\s+Alpha/m.test(md) &&
        /^\s+\*\s+X/m.test(md) &&
        /^\s+\*\s+Bravo/m.test(md)
      );
    },
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
  // HLR 22 Phase 2.3: golden-rule structural checks for the two new primitives'
  // clean output (computeRetagListRange/computeUnwrapListRange, list-ops.ts) --
  // this is the exact clean HTML each produces for a MIDDLE target in a 3-item
  // list (before AND after both non-empty), the compound case the malformed
  // "toggle off"/"OL→UL convert" shapes in list-verbs-audit.spec.ts never
  // handled correctly. The malformed shapes are themselves broken (see that
  // file), so this asserts the clean output is structurally correct on its
  // own rather than against a malformed baseline.
  {
    name: 'clean DOM (computeUnwrapListRange: middle item of a 3-item <ul> toggled off) → two separate bullet lists split by one plain paragraph line',
    html: '<ul><li>Alpha</li></ul><p>Bravo</p><ul><li>Charlie</li></ul>',
    expect: (md) => {
      const alpha = md.indexOf('Alpha');
      const bravo = md.indexOf('Bravo');
      const charlie = md.indexOf('Charlie');
      const bravoLine = md.split('\n').find((l) => l.includes('Bravo')) ?? '';
      return (
        alpha >= 0 &&
        alpha < bravo &&
        bravo < charlie &&
        /^\*\s+Alpha/m.test(md) &&
        /^\*\s+Charlie/m.test(md) &&
        !/^\s*\*/.test(bravoLine) // Bravo is a plain paragraph, not a bullet
      );
    },
  },
  {
    // Bug ExcelCmd #5: toggling a TASK item off returns it to normal text. The
    // middle item of a 3-item task list is unwrapped to a <p> (computeUnwrapList
    // Range) while the split-off before/after slices keep `contains-task-list`,
    // so Alpha/Charlie stay `* [ ] …` task items and Bravo is a plain paragraph.
    name: 'clean DOM (computeUnwrapListRange: middle item of a 3-item TASK <ul> toggled off) → two task lists split by one plain paragraph, siblings keep checkboxes',
    html:
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox"> Alpha</li></ul>' +
      '<p>Bravo</p>' +
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox"> Charlie</li></ul>',
    expect: (md) => {
      const bravoLine = md.split('\n').find((l) => l.includes('Bravo')) ?? '';
      return (
        md.indexOf('Alpha') < md.indexOf('Bravo') &&
        md.indexOf('Bravo') < md.indexOf('Charlie') &&
        /^\*\s+\[ \]\s+Alpha$/m.test(md) &&
        /^\*\s+\[ \]\s+Charlie$/m.test(md) &&
        /^Bravo$/m.test(bravoLine) && // plain paragraph — no bullet, no checkbox
        (md.match(/\[ \]/g) ?? []).length === 2 // only Alpha and Charlie carry a checkbox
      );
    },
  },
  {
    name: 'clean DOM (computeRetagListRange: middle item of a 3-item <ol> converted to bullet) → ol/ul/ol split, only the targeted item retags',
    html: '<ol><li>Alpha</li></ol><ul><li>Bravo</li></ul><ol><li>Charlie</li></ol>',
    expect: (md) => {
      const alpha = md.indexOf('Alpha');
      const bravo = md.indexOf('Bravo');
      const charlie = md.indexOf('Charlie');
      return (
        alpha >= 0 &&
        alpha < bravo &&
        bravo < charlie &&
        /^1\.\s+Alpha/m.test(md) &&
        /^\*\s+Bravo/m.test(md) &&
        /^1\.\s+Charlie/m.test(md) // Charlie's split-off <ol> is its own list, renumbers from 1
      );
    },
  },
  // Bug 0717: pressing Enter at the end of a list item that has a FOLLOWING
  // sibling (i.e. NOT the last item) leaves a genuinely empty <li><br></li> in
  // the middle of the list -- turndown's default 'br' rule turns the lone <br>
  // into a hard-break "  \n", which its default 'listItem' rule then indents
  // and appends an extra trailing "\n" to (because a next sibling exists),
  // producing corrupted output like "-     \n    \n-   c\n" instead of a clean
  // empty bullet line. Fixed via turndown.ts's 'emptyListItemBr' rule (drops a
  // <br> that is the ONLY child of its <li>, matching the existing
  // 'brInTableCell' empty-cell precedent).
  {
    name: 'clean DOM (Enter creating an empty <li> mid-list, has a following sibling) → clean empty bullet line, no "-     \\n    \\n" corruption (bug 0717)',
    html: '<ul><li>a</li><li><br></li><li>c</li></ul>',
    expect: (md) => {
      const lines = md.split('\n').filter((l) => l.trim() !== '');
      return lines.length === 3 && /^\*\s+a$/.test(lines[0]) && /^\*\s*$/.test(lines[1]) && /^\*\s+c$/.test(lines[2]);
    },
  },
  // Bug 0717, <ol> variant: an <li> with ZERO children (markdown-it rebuilds
  // this shape from a blank-marker line on re-parse -- see the domino-only
  // 'zero-child <li>' regression this same fix also covers) is caught by
  // turndown's OWN isBlank() check, which short-circuits straight to
  // blankReplacement BEFORE any addRule-registered rule runs -- 'emptyListItemBr'
  // above never sees it. Fixed via the 'LI' branch in blankReplacement
  // (turndown.ts), which must replicate default 'listItem' numbering exactly so
  // the empty item still gets the right ordinal.
  {
    name: 'clean DOM (<ol> with a zero-child middle <li>) → empty item keeps correct ordinal, no dropped item',
    html: '<ol><li>a</li><li></li><li>c</li></ol>',
    expect: (md) => {
      const lines = md.split('\n').filter((l) => l.trim() !== '');
      return lines.length === 3 && /^1\.\s+a$/.test(lines[0]) && /^2\.\s*$/.test(lines[1]) && /^3\.\s+c$/.test(lines[2]);
    },
  },
  // Bug 0717 round2 #1: an "empty" <li> Chromium's Enter/Backspace leaves with
  // MORE than one <br> (or a <br> + whitespace text) — the old
  // childNodes.length === 1 check missed it, so it fell through to a literal
  // "\". The broadened 'strayTrailingBr' rule (trailing <br> in an <li>) strips
  // it → clean empty bullet, no backslash.
  {
    name: 'clean DOM (<li> empty with two <br>) → clean empty bullet, no backslash (bug 0717 round2 #1)',
    html: '<ul><li>a</li><li><br><br></li><li>c</li></ul>',
    expect: (md) => !/\\/.test(md) && md.split('\n').filter((l) => l.trim() !== '').length === 3,
  },
  // Bug 0717 round3 #6: toggling a list item off (computeUnwrapListRange) when
  // the item carried a trailing <br> (real text + hard-break residue) produced
  // "<p>Bravo<br></p>" → "Bravo\\". The trailing <br> is not mid-content, so
  // 'strayTrailingBr' drops it → clean "Bravo", no backslash.
  {
    name: 'dom méo (unwrap list item còn <br> đuôi: <li>Bravo<br>) → "Bravo" sạch, không backslash (round3 #6)',
    html: '<ul><li>Bravo<br></li></ul>',
    expect: (md) => /^\*\s+Bravo$/m.test(md) && !/\\/.test(md),
  },
  {
    name: 'dom méo (paragraph còn <br> đuôi sau unwrap: <p>Bravo<br>) → "Bravo" sạch, không backslash (round3 #6)',
    html: '<p>Bravo<br></p>',
    expect: (md) => md.trim() === 'Bravo',
  },
  // Bug 0717 round3 #8: 'strayTrailingBr' now covers the <blockquote> parent
  // too. A blockquote carrying real text + a trailing <br> (the same residue
  // class) serializes cleanly with no backslash and round-trips stably. (The
  // exact BARE "<blockquote><br></blockquote>" shape is asserted serialize-only
  // below — an empty blockquote is dropped by markdown-it on re-parse, which the
  // stability check here would flag, so it can't live in this runner.)
  {
    name: 'dom méo (blockquote còn <br> đuôi: <blockquote>Quoted<br>) → "> Quoted" sạch, không backslash (round3 #8)',
    html: '<blockquote>Quoted<br></blockquote>',
    expect: (md) => /^>\s+Quoted$/m.test(md) && !/\\/.test(md),
  },
  // Group Backslash deep fix: a trailing <br> followed only by empty inline
  // cruft (contentEditable <span></span>, no visible content) is still residual
  // -> stripped, no backslash. Content-based trailing check, not a node-type list.
  {
    name: 'dom méo (<br> đuôi trước inline rỗng: <p>foo<br><span></span>) → "foo" sạch, không backslash',
    html: '<p>foo<br><span></span></p>',
    expect: (md) => md.trim() === 'foo',
  },
  // Regression guard for the deep fix: a <br> BEFORE real inline content is a
  // genuine hard break -> the backslash MUST survive (must not over-strip).
  {
    name: 'CONTROL (<br> giữa nội dung, có inline thật sau: <p>foo<br><strong>bar</strong>) → GIỮ backslash',
    html: '<p>foo<br><strong>bar</strong></p>',
    expect: (md) => /foo\\/.test(md) && /\*\*bar\*\*/.test(md),
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

// Bug 0717 round3 #8 (exact bare shape): the blockquote-toggle-off native
// fallback can leave "<blockquote><br></blockquote>", which used to serialize
// to a stray "> \\". Serialize-only assertion (no stability check): the empty
// blockquote itself is dropped by markdown-it on re-parse, but the point of
// this group is that no literal backslash survives the save.
{
  const md = serializeHtml('<p>Hello world</p><blockquote><br></blockquote>');
  runner.check(
    'serialize-only (bare <blockquote><br>) → không còn "\\" trong markdown lưu ra (round3 #8)',
    /^Hello world$/m.test(md) && !/\\/.test(md),
    `  nhận: ${JSON.stringify(md)}`
  );
}

// bug_ExcelCommand #2 (Undo khi indent ở TC2.2c): Tab-indenting a fresh EMPTY
// item under Bravo leaves "<li>Bravo<ul><li><br></li></ul></li>". With a "-"
// bullet marker this used to serialize as "-   Bravo\n    -", and a lone "-"
// line under a paragraph is a SETEXT H2 underline -> re-parse (e.g. after Undo
// re-renders the whole doc) turned "Bravo" into <h2>. dropEmptyNestedSublists
// removes the all-blank nested sublist so the empty child disappears and the
// parent stays a plain bullet. Serialize-only + re-render assertion (no stability
// loop): a hand-built data-md-bullet-style="-" DOM can't round-trip byte-stably
// because pure render() doesn't restamp the bullet-style attr (it comes from the
// edit-time mdSlice), which would trip the domCases stability check — the point
// here is solely that no setext-underline line, and thus no heading, survives.
{
  const md = serializeHtml('<ul data-md-bullet-style="-"><li>Alpha</li><li>Bravo<ul><li><br></li></ul></li></ul>');
  const noTrapLine = !md.split('\n').some((l) => /^\s+[-=]+\s*$/.test(l));
  runner.check(
    'bug_ExcelCommand #2 (empty <li><br> nested dưới mục "-") → không có dòng setext, re-render không ra heading',
    noTrapLine && !/<h[12]>/.test(renderer.render(md).html) && /^-\s+Alpha$/m.test(md) && /^-\s+Bravo$/m.test(md),
    `  nhận: ${JSON.stringify(md)}`
  );
}
{
  // The exact shape in the user's screenshot: an empty child under Alpha AND Bravo.
  const md = serializeHtml(
    '<ul data-md-bullet-style="-"><li>Alpha<ul><li><br></li></ul></li><li>Bravo<ul><li><br></li></ul></li></ul>'
  );
  runner.check(
    'bug_ExcelCommand #2 (empty <li><br> nested dưới CẢ HAI mục) → cả hai vẫn là bullet, re-render không ra heading',
    !/<h[12]>/.test(renderer.render(md).html) && /^-\s+Alpha$/m.test(md) && /^-\s+Bravo$/m.test(md),
    `  nhận: ${JSON.stringify(md)}`
  );
}
{
  // Guard: a nested sublist that MIXES a real item and an empty one is NOT
  // all-blank -> left intact (the empty item is a sibling bullet, not a setext
  // underline of the item above it), so the child list must survive.
  const md = serializeHtml('<ul data-md-bullet-style="-"><li>A<ul><li>x</li><li><br></li></ul></li></ul>');
  runner.check(
    'CONTROL (nested sublist có 1 mục thật + 1 mục rỗng) → GIỮ sublist "x", không heading',
    !/<h[12]>/.test(renderer.render(md).html) && /^ {4}-\s+x$/m.test(md),
    `  nhận: ${JSON.stringify(md)}`
  );
}

runner.finish('lists');
