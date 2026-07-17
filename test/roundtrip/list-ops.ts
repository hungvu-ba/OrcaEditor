/**
 * DOM-outcome tests for the pure tree-transform functions in
 * media/webview/list-ops.ts (HLR 22, execCommand List/Block Verb Replacement,
 * Phase 1) — one case per row of the spec's I/O & Edge-Case Matrix. These test
 * the functions directly (domino-built Elements in, plan object out), not
 * markdown serialization — commitListOp (the execCommand/live-DOM boundary)
 * is covered separately in test/webview/list-ops-primitive.spec.ts since
 * domino has no execCommand/Selection API.
 *
 * Run standalone: npm run test:roundtrip:list-ops
 */
import { Runner, domino } from './_lib';
import {
  computeIndent,
  computeOutdent,
  computeRetagListRange,
  computeTaskifyListRange,
  computeToList,
  computeToListAroundAtoms,
  computeUnwrapListRange,
} from '../../media/webview/list-ops';

const runner = new Runner();

function buildRoot(html: string): Element {
  const doc = domino.createDocument(`<div id="content">${html}</div>`, true);
  const root = doc.getElementById('content');
  if (!root) {
    throw new Error('failed to parse HTML');
  }
  return root;
}

// computeIndent, no previous sibling → null (nothing to indent under)
{
  const root = buildRoot('<ul><li>Alpha</li></ul>');
  const alpha = root.querySelector('li') as Element;
  runner.eq('computeIndent: first <li> in a list → null', computeIndent(alpha), null);
}

// computeIndent, previous sibling has no sublist yet
{
  const root = buildRoot('<ul><li>Alpha</li><li>Bravo</li></ul>');
  const list = root.querySelector('ul') as Element;
  const bravo = list.children[1];
  const plan = computeIndent(bravo);
  runner.eq(
    'computeIndent: prev has no sublist → creates one, li > ul',
    plan?.html,
    '<li>Alpha<ul><li data-list-op-caret-anchor="">Bravo</li></ul></li>'
  );
  runner.check('computeIndent: stableRoot is the shared parent <ul>', plan?.stableRoot === list);
  runner.check('computeIndent: rangeStart/rangeEnd are prev/current <li>', plan?.rangeStart === list.children[0] && plan?.rangeEnd === bravo);
}

// computeIndent, previous sibling already has a sublist
{
  const root = buildRoot('<ul><li>Alpha<ul><li>X</li></ul></li><li>Bravo</li></ul>');
  const list = root.querySelector('ul') as Element;
  const bravo = list.children[1];
  const plan = computeIndent(bravo);
  runner.eq(
    'computeIndent: prev already has a sublist → Bravo appended as last item',
    plan?.html,
    '<li>Alpha<ul><li>X</li><li data-list-op-caret-anchor="">Bravo</li></ul></li>'
  );
}

// computeIndent, LOOSE list (items <p>-wrapped -- blank lines between them in
// the source), previous sibling already has a sublist. The pure transform must
// still collapse to a single clean <li> root -- no duplicated wrappers -- so
// that committing it via commitListOpDirect (Range surgery) round-trips clean.
// The old execCommand('insertHTML') commit corrupted this exact shape (phantom
// empty <li>s, stray bullets) -- bug 0717 round3 #3 (Group IndentCollapse).
{
  const root = buildRoot('<ul><li><p>Alpha</p><ul><li><p>X</p></li></ul></li><li><p>Bravo</p></li></ul>');
  const list = root.querySelector('ul') as Element;
  const bravo = list.children[1];
  const plan = computeIndent(bravo);
  runner.eq(
    'computeIndent: loose <p>-wrapped item appends into prev sibling’s existing sublist as one clean <li>',
    plan?.html,
    '<li><p>Alpha</p><ul><li><p>X</p></li><li data-list-op-caret-anchor=""><p>Bravo</p></li></ul></li>'
  );
}

// computeIndent, previous sibling is not an <li> (malformed bare <ul> sibling,
// e.g. left behind by an unmigrated execCommand fallback) → null, does not
// nest under it (HLR 22 Phase 2.2 review fix)
{
  const root = buildRoot('<ul><li>Alpha</li><ul><li>Bravo</li></ul><li>Charlie</li></ul>');
  const list = root.querySelector('ul') as Element;
  const charlie = list.children[2];
  runner.eq('computeIndent: previous sibling is not an <li> → null', computeIndent(charlie), null);
}

// computeIndent, the item being indented already has its own nested sublist,
// AND the previous sibling also already has one → both merge correctly,
// the indented item's own sublist travels with it
{
  const root = buildRoot('<ul><li>Alpha<ul><li>X</li></ul></li><li>Bravo<ul><li>Y</li></ul></li></ul>');
  const list = root.querySelector('ul') as Element;
  const bravo = list.children[1];
  const plan = computeIndent(bravo);
  runner.eq(
    "computeIndent: indented item's own sublist travels with it into the prev sibling's existing sublist",
    plan?.html,
    '<li>Alpha<ul><li>X</li><li data-list-op-caret-anchor="">Bravo<ul><li>Y</li></ul></li></ul></li>'
  );
}

// computeOutdent, parent list is top-level → null (nothing to outdent to)
{
  const root = buildRoot('<ul><li>Alpha</li></ul>');
  const alpha = root.querySelector('li') as Element;
  runner.eq('computeOutdent: parent list is top-level → null', computeOutdent(alpha), null);
}

// computeOutdent, item has later siblings in its sublist
{
  const root = buildRoot('<ul><li>A<ul><li>B</li><li>C</li></ul></li></ul>');
  const outerList = root.querySelector('ul') as Element;
  const aLi = outerList.children[0];
  const innerList = (Array.from(aLi.children).find((c) => c.tagName === 'UL') as Element);
  const bLi = innerList.children[0];
  const plan = computeOutdent(bLi);
  runner.eq(
    'computeOutdent: later siblings re-nest under the outdented item',
    plan?.html,
    '<li>A</li><li data-list-op-caret-anchor="">B<ul><li>C</li></ul></li>'
  );
  runner.check('computeOutdent: stableRoot is the grandparent <ul>', plan?.stableRoot === outerList);
  runner.check('computeOutdent: rangeStart === rangeEnd === parent <li>', plan?.rangeStart === aLi && plan?.rangeEnd === aLi);
}

// computeOutdent, item is the sublist's only item → sublist removed entirely
{
  const root = buildRoot('<ul><li>A<ul><li>B</li></ul></li></ul>');
  const outerList = root.querySelector('ul') as Element;
  const aLi = outerList.children[0];
  const innerList = (Array.from(aLi.children).find((c) => c.tagName === 'UL') as Element);
  const bLi = innerList.children[0];
  const plan = computeOutdent(bLi);
  runner.eq(
    'computeOutdent: sublist emptied → removed, no orphan empty <ul>',
    plan?.html,
    '<li>A</li><li data-list-op-caret-anchor="">B</li>'
  );
}

// computeOutdent, item has BOTH its own nested sublist AND later siblings
// (compound case, HLR 22 Phase 2.1 review fix) — later siblings must merge
// into the item's existing sublist, not become a second sibling <ul>/<ol>.
{
  const root = buildRoot('<ul><li>A<ul><li>B<ul><li>D</li></ul></li><li>C</li></ul></li></ul>');
  const outerList = root.querySelector('ul') as Element;
  const aLi = outerList.children[0];
  const innerList = (Array.from(aLi.children).find((c) => c.tagName === 'UL') as Element);
  const bLi = innerList.children[0];
  const plan = computeOutdent(bLi);
  runner.eq(
    'computeOutdent: item with its own sublist AND later siblings → siblings merge into the existing sublist, no second sibling <ul>',
    plan?.html,
    '<li>A</li><li data-list-op-caret-anchor="">B<ul><li>D</li><li>C</li></ul></li>'
  );
}

// computeToList, 2 plain paragraphs, unordered → tight <ul>, no <p> wrapper
{
  const root = buildRoot('<p>First</p><p>Second</p>');
  const blocks = Array.from(root.children) as Element[];
  const plan = computeToList(blocks, false);
  runner.eq('computeToList: tight <ul> from 2 paragraphs, no <p> wrapper', plan.html, '<ul><li>First</li><li>Second</li></ul>');
  runner.check('computeToList: stableRoot is the shared parent', plan.stableRoot === root);
  runner.check('computeToList: rangeStart/rangeEnd span the given blocks', plan.rangeStart === blocks[0] && plan.rangeEnd === blocks[1]);
}

// computeToList, ordered
{
  const root = buildRoot('<p>First</p><p>Second</p>');
  const blocks = Array.from(root.children) as Element[];
  const plan = computeToList(blocks, true);
  runner.eq('computeToList: ordered → tight <ol>', plan.html, '<ol><li>First</li><li>Second</li></ol>');
}

// computeToList: a blank <p><br></p> line between two selected paragraphs is
// dropped, not turned into its own empty <li> (blank lines are spacing, not
// content the user meant to bullet).
{
  const root = buildRoot('<p>First</p><p><br></p><p>Second</p>');
  const blocks = Array.from(root.children) as Element[];
  const plan = computeToList(blocks, false);
  runner.eq(
    'computeToList: blank paragraph in the middle of the selection is dropped, not an empty <li>',
    plan.html,
    '<ul><li>First</li><li>Second</li></ul>'
  );
}

// computeToList: TWO adjacent blank <p>s between text (the genuine double-Enter
// shape from TC2.3b/2.4b/2.7b) — both blanks are dropped, only the two real
// paragraphs become items.
{
  const root = buildRoot('<p>First</p><p><br></p><p><br></p><p>Second</p>');
  const blocks = Array.from(root.children) as Element[];
  const plan = computeToList(blocks, false);
  runner.eq(
    'computeToList: two adjacent blank paragraphs between text are both dropped',
    plan.html,
    '<ul><li>First</li><li>Second</li></ul>'
  );
}

// computeToList: a selection made up entirely of blank lines still yields one
// placeholder <li> to convert into, instead of an empty <ul></ul>.
{
  const root = buildRoot('<p><br></p><p><br></p>');
  const blocks = Array.from(root.children) as Element[];
  const plan = computeToList(blocks, false);
  runner.eq(
    'computeToList: all-blank selection collapses to one placeholder <li>, not an empty <ul>',
    plan.html,
    '<ul><li><br></li></ul>'
  );
}

// computeToListAroundAtoms: the atom-aware sibling of computeToList used by
// toggleTaskItem's fallback (bug 0717r3 #11). A content-bearing block that
// can't be a list item (table/pre/blockquote) SPLITS the list instead of being
// swallowed or handed to the corruption-prone native execCommand.
{
  const root = buildRoot('<p>Before</p><table><tbody><tr><td>cell</td></tr></tbody></table><p>After</p>');
  const blocks = Array.from(root.children) as Element[];
  const table = blocks[1];
  const plan = computeToListAroundAtoms(blocks, false);
  runner.eq(
    'computeToListAroundAtoms: list splits around a <table>, table kept verbatim',
    plan?.html,
    `<ul><li>Before</li></ul>${table.outerHTML}<ul><li>After</li></ul>`
  );
  runner.check(
    'computeToListAroundAtoms: rangeStart/rangeEnd span the whole run',
    plan?.rangeStart === blocks[0] && plan?.rangeEnd === blocks[2]
  );
  runner.check('computeToListAroundAtoms: stableRoot is the run parent', plan?.stableRoot === root);
}

// computeToListAroundAtoms: a heading is CONVERTIBLE (bug 0717r3 #11 decision) —
// it becomes a list item from its inline innerHTML (never demoted/absorbed),
// staying in the same list as adjacent paragraphs.
{
  const root = buildRoot('<h2>Title</h2><p>x</p>');
  const blocks = Array.from(root.children) as Element[];
  const plan = computeToListAroundAtoms(blocks, false);
  runner.eq(
    'computeToListAroundAtoms: a heading converts to a flattened list item',
    plan?.html,
    '<ul><li>Title</li><li>x</li></ul>'
  );
}

// computeToListAroundAtoms: a blockquote stays an atom this pass (the `> - item`
// wrap is deferred to spec-11b) — kept verbatim, list splits around it.
{
  const root = buildRoot('<p>a</p><blockquote><p>quoted</p></blockquote>');
  const blocks = Array.from(root.children) as Element[];
  const bq = blocks[1];
  const plan = computeToListAroundAtoms(blocks, false);
  runner.eq(
    'computeToListAroundAtoms: a blockquote is kept verbatim (not wrapped into a bullet)',
    plan?.html,
    `<ul><li>a</li></ul>${bq.outerHTML}`
  );
}

// computeToListAroundAtoms: a run with no convertible block (only a table — the
// partial-table / in-cell selection shape) → null so the caller no-ops instead
// of touching the table.
{
  const root = buildRoot('<table><tbody><tr><td>cell</td></tr></tbody></table>');
  const blocks = Array.from(root.children) as Element[];
  runner.eq(
    'computeToListAroundAtoms: all-atom run → null (caller no-ops)',
    computeToListAroundAtoms(blocks, false),
    null
  );
}

// computeToListAroundAtoms: an <hr> is a content atom kept verbatim (the list
// splits around it), matching the frozen I/O matrix — NOT dropped. Since bug
// 0717r3 #5 routed setBulletList/setNumberedList onto this same atom-aware
// fallback, an <hr> ALWAYS reaches this path (a lone `[p, hr, p]` selection too,
// not only when it sits alongside another content atom) — so it is never dropped.
{
  const root = buildRoot('<p>a</p><table><tbody><tr><td>c</td></tr></tbody></table><hr><p>b</p>');
  const blocks = Array.from(root.children) as Element[];
  const table = blocks[1];
  const hr = blocks[2];
  const plan = computeToListAroundAtoms(blocks, false);
  runner.eq(
    'computeToListAroundAtoms: an <hr> is kept verbatim as an atom (list splits around it)',
    plan?.html,
    `<ul><li>a</li></ul>${table.outerHTML}${hr.outerHTML}<ul><li>b</li></ul>`
  );
}

// computeToListAroundAtoms: a <pre> code block is a content atom kept verbatim.
{
  const root = buildRoot('<p>a</p><pre><code>x = 1</code></pre><p>b</p>');
  const blocks = Array.from(root.children) as Element[];
  const pre = blocks[1];
  const plan = computeToListAroundAtoms(blocks, false);
  runner.eq(
    'computeToListAroundAtoms: a <pre> code block splits the list, kept verbatim',
    plan?.html,
    `<ul><li>a</li></ul>${pre.outerHTML}<ul><li>b</li></ul>`
  );
}

// computeToListAroundAtoms: a blockquote-only run has no convertible block → null.
{
  const root = buildRoot('<blockquote><p>q</p></blockquote>');
  const blocks = Array.from(root.children) as Element[];
  runner.eq(
    'computeToListAroundAtoms: a blockquote-only run → null (no convertible block)',
    computeToListAroundAtoms(blocks, false),
    null
  );
}

// computeToListAroundAtoms + blockToListItemsHtml: an image-only block (empty
// textContent but real media) must NOT be dropped — bug 0717r3 #11 review found
// the textContent-based blank check silently deleted a lone `![](img)` line.
{
  const root = buildRoot('<p>a</p><p><img src="x.png"></p>');
  const blocks = Array.from(root.children) as Element[];
  const plan = computeToListAroundAtoms(blocks, false);
  runner.eq(
    'computeToListAroundAtoms: an image-only paragraph is kept as a list item, not dropped',
    plan?.html,
    '<ul><li>a</li><li><img src="x.png"></li></ul>'
  );
}

// computeToList (clean path): the same media guard — an image-only paragraph is
// kept, not dropped as a blank line.
{
  const root = buildRoot('<p>a</p><p><img src="x.png"></p>');
  const blocks = Array.from(root.children) as Element[];
  const plan = computeToList(blocks, false);
  runner.eq(
    'computeToList: an image-only paragraph is kept as a list item, not dropped',
    plan.html,
    '<ul><li>a</li><li><img src="x.png"></li></ul>'
  );
}

// computeUnwrapListRange, whole list targeted -> before/after both empty, all
// items become <p>s, no leftover <ul>
{
  const root = buildRoot('<ul><li>Alpha</li><li>Bravo</li><li>Charlie</li></ul>');
  const list = root.querySelector('ul') as Element;
  const targets = Array.from(list.children);
  const plan = computeUnwrapListRange(list, targets);
  runner.eq(
    'computeUnwrapListRange: whole list targeted -> every item becomes a <p>, no leftover <ul>',
    plan?.html,
    '<p>Alpha</p><p>Bravo</p><p>Charlie</p>'
  );
  runner.check('computeUnwrapListRange: stableRoot is the list\'s parent', plan?.stableRoot === root);
  runner.check('computeUnwrapListRange: rangeStart === rangeEnd === list', plan?.rangeStart === list && plan?.rangeEnd === list);
}

// computeUnwrapListRange, partial-before -- items before the target stay in
// their own <ul>, only the last (targeted) item unwraps
{
  const root = buildRoot('<ul><li>Alpha</li><li>Bravo</li><li>Charlie</li></ul>');
  const list = root.querySelector('ul') as Element;
  const charlie = list.children[2];
  const plan = computeUnwrapListRange(list, [charlie]);
  runner.eq(
    'computeUnwrapListRange: partial-before -- untouched items before the target stay <ul>',
    plan?.html,
    '<ul><li>Alpha</li><li>Bravo</li></ul><p>Charlie</p>'
  );
}

// computeUnwrapListRange, partial-after -- items after the target stay in
// their own <ul>, only the first (targeted) item unwraps
{
  const root = buildRoot('<ul><li>Alpha</li><li>Bravo</li><li>Charlie</li></ul>');
  const list = root.querySelector('ul') as Element;
  const alpha = list.children[0];
  const plan = computeUnwrapListRange(list, [alpha]);
  runner.eq(
    'computeUnwrapListRange: partial-after -- untouched items after the target stay <ul>',
    plan?.html,
    '<p>Alpha</p><ul><li>Bravo</li><li>Charlie</li></ul>'
  );
}

// computeUnwrapListRange, target has a nested sublist -> null (flattening is
// out of scope, legacy execCommand fallback handles it instead)
{
  const root = buildRoot('<ul><li>Alpha<ul><li>X</li></ul></li><li>Bravo</li></ul>');
  const list = root.querySelector('ul') as Element;
  const alpha = list.children[0];
  runner.eq('computeUnwrapListRange: target has a nested sublist -> null', computeUnwrapListRange(list, [alpha]), null);
}

// computeUnwrapListRange, LOOSE target (content already a block <p>) -> reuse
// the <p> verbatim, never nest it in a fresh <p>. `<p><p>…</p></p>` parses to a
// stray empty paragraph that serializes to a spurious blank line (bug ExcelCmd
// #5 review, confirmed by two reviewers + a live loose-list repro). Untouched
// loose siblings keep their own <p> too.
{
  const root = buildRoot(
    '<ul class="contains-task-list">' +
      '<li class="task-list-item"><p><input class="task-list-item-checkbox" type="checkbox"> Alpha</p></li>' +
      '<li class="task-list-item"><p>Bravo</p></li>' +
      '<li class="task-list-item"><p><input class="task-list-item-checkbox" type="checkbox"> Charlie</p></li>' +
      '</ul>'
  );
  const list = root.querySelector('ul') as Element;
  const bravo = list.children[1];
  const plan = computeUnwrapListRange(list, [bravo]);
  runner.eq(
    'computeUnwrapListRange: loose target reuses its block <p> (no <p><p>…</p></p> double-wrap)',
    plan?.html,
    '<ul class="contains-task-list"><li class="task-list-item"><p><input class="task-list-item-checkbox" type="checkbox"> Alpha</p></li></ul>' +
      '<p>Bravo</p>' +
      '<ul class="contains-task-list"><li class="task-list-item"><p><input class="task-list-item-checkbox" type="checkbox"> Charlie</p></li></ul>'
  );
}

// computeUnwrapListRange, middle target's untouched siblings still carry
// checkboxes -> both split-off <ul>s must keep `contains-task-list` (Phase
// 2.3 compound-case fix: markdown.css's ul.contains-task-list rule keys off
// the LIST's class, not the <li>'s, so a bare wrapper would double up the
// bullet marker and mis-position the checkbox for those untouched items)
{
  const root = buildRoot(
    '<ul><li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox"> Alpha</li>' +
      '<li>Bravo</li>' +
      '<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox"> Charlie</li></ul>'
  );
  const list = root.querySelector('ul') as Element;
  const bravo = list.children[1];
  const plan = computeUnwrapListRange(list, [bravo]);
  runner.eq(
    'computeUnwrapListRange: split-off before/after <ul>s keep contains-task-list when their items still have checkboxes',
    plan?.html,
    '<ul class="contains-task-list"><li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox"> Alpha</li></ul>' +
      '<p>Bravo</p>' +
      '<ul class="contains-task-list"><li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox"> Charlie</li></ul>'
  );
}

// computeRetagListRange, whole list targeted (ol -> ul) -- before/after both
// empty, retagged list replaces the original entirely
{
  const root = buildRoot('<ol><li>Alpha</li><li>Bravo</li></ol>');
  const list = root.querySelector('ol') as Element;
  const targets = Array.from(list.children);
  const plan = computeRetagListRange(list, targets, false);
  runner.eq(
    'computeRetagListRange: whole list targeted -- ol -> ul, no leftover <ol>',
    plan?.html,
    '<ul><li>Alpha</li><li>Bravo</li></ul>'
  );
  runner.check('computeRetagListRange: stableRoot is the list\'s parent', plan?.stableRoot === root);
  runner.check('computeRetagListRange: rangeStart === rangeEnd === list', plan?.rangeStart === list && plan?.rangeEnd === list);
}

// computeRetagListRange, partial-before -- untouched items before the target
// stay in their ORIGINAL <ol>, only the last (targeted) item retags to <ul>
{
  const root = buildRoot('<ol><li>Alpha</li><li>Bravo</li><li>Charlie</li></ol>');
  const list = root.querySelector('ol') as Element;
  const charlie = list.children[2];
  const plan = computeRetagListRange(list, [charlie], false);
  runner.eq(
    'computeRetagListRange: partial-before -- untouched items before the target stay <ol>',
    plan?.html,
    '<ol><li>Alpha</li><li>Bravo</li></ol><ul><li>Charlie</li></ul>'
  );
}

// computeRetagListRange, partial-after -- untouched items after the target
// stay in their ORIGINAL <ol>, only the first (targeted) item retags to <ul>
{
  const root = buildRoot('<ol><li>Alpha</li><li>Bravo</li><li>Charlie</li></ol>');
  const list = root.querySelector('ol') as Element;
  const alpha = list.children[0];
  const plan = computeRetagListRange(list, [alpha], false);
  runner.eq(
    'computeRetagListRange: partial-after -- untouched items after the target stay <ol>',
    plan?.html,
    '<ul><li>Alpha</li></ul><ol><li>Bravo</li><li>Charlie</li></ol>'
  );
}

// computeRetagListRange, target has a nested sublist -> null
{
  const root = buildRoot('<ol><li>Alpha<ol><li>X</li></ol></li><li>Bravo</li></ol>');
  const list = root.querySelector('ol') as Element;
  const alpha = list.children[0];
  runner.eq(
    'computeRetagListRange: target has a nested sublist -> null',
    computeRetagListRange(list, [alpha], false),
    null
  );
}

// computeTaskifyListRange, middle target -- the OL→task split (bug ExcelCmd
// #3): Alpha/Charlie stay in their own <ol>, Bravo becomes a task item in its
// own <ul class="contains-task-list"> (checkbox as first child, task-list-item
// class), never "2. [ ] Bravo" left inside the <ol>
{
  const root = buildRoot('<ol><li>Alpha</li><li>Bravo</li><li>Charlie</li></ol>');
  const list = root.querySelector('ol') as Element;
  const bravo = list.children[1];
  const plan = computeTaskifyListRange(list, [bravo]);
  runner.eq(
    'computeTaskifyListRange: OL middle target -- Bravo splits into its own task <ul>, Alpha/Charlie stay <ol>',
    plan?.html,
    '<ol><li>Alpha</li></ol><ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox">Bravo</li></ul><ol><li>Charlie</li></ol>'
  );
  runner.check('computeTaskifyListRange: stableRoot is the list\'s parent', plan?.stableRoot === root);
  runner.check('computeTaskifyListRange: rangeStart === rangeEnd === list', plan?.rangeStart === list && plan?.rangeEnd === list);
}

// computeTaskifyListRange, first target -- before slice empty, only one <ol>
// after
{
  const root = buildRoot('<ol><li>Alpha</li><li>Bravo</li><li>Charlie</li></ol>');
  const list = root.querySelector('ol') as Element;
  const alpha = list.children[0];
  const plan = computeTaskifyListRange(list, [alpha]);
  runner.eq(
    'computeTaskifyListRange: OL first target -- no leading <ol>, Bravo/Charlie stay <ol>',
    plan?.html,
    '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox">Alpha</li></ul><ol><li>Bravo</li><li>Charlie</li></ol>'
  );
}

// computeTaskifyListRange, last target -- after slice empty, only one <ol>
// before
{
  const root = buildRoot('<ol><li>Alpha</li><li>Bravo</li><li>Charlie</li></ol>');
  const list = root.querySelector('ol') as Element;
  const charlie = list.children[2];
  const plan = computeTaskifyListRange(list, [charlie]);
  runner.eq(
    'computeTaskifyListRange: OL last target -- Alpha/Bravo stay <ol>, no trailing <ol>',
    plan?.html,
    '<ol><li>Alpha</li><li>Bravo</li></ol><ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox">Charlie</li></ul>'
  );
}

// computeTaskifyListRange, single-item OL -- both slices empty, becomes a lone
// task <ul> (no leftover <ol>, no "1. [ ] Alpha" mix)
{
  const root = buildRoot('<ol><li>Alpha</li></ol>');
  const list = root.querySelector('ol') as Element;
  const alpha = list.children[0];
  const plan = computeTaskifyListRange(list, [alpha]);
  runner.eq(
    'computeTaskifyListRange: single-item OL -- lone task <ul>, no leftover <ol>',
    plan?.html,
    '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox">Alpha</li></ul>'
  );
}

// computeTaskifyListRange, LOOSE <li> (<p>-wrapped, as blank-line-separated
// numbered source renders) -- the checkbox must go INSIDE the <p>
// (<li><p><input>…</p></li>), the only shape turndown/findTaskCheckbox accept
// as a task item. A checkbox placed as a direct <li> child before the <p>
// serializes to a stray "[ ]" line + a detached paragraph (checkbox lost on
// reload). Review finding (blind hunter, 2026-07-18).
{
  const root = buildRoot('<ol><li><p>Alpha</p></li><li><p>Bravo</p></li><li><p>Charlie</p></li></ol>');
  const list = root.querySelector('ol') as Element;
  const bravo = list.children[1];
  const plan = computeTaskifyListRange(list, [bravo]);
  runner.eq(
    'computeTaskifyListRange: loose <li> -- checkbox goes inside the <p>, not before it',
    plan?.html,
    '<ol><li><p>Alpha</p></li></ol><ul class="contains-task-list"><li class="task-list-item"><p><input type="checkbox" class="task-list-item-checkbox">Bravo</p></li></ul><ol><li><p>Charlie</p></li></ol>'
  );
}

// computeTaskifyListRange, target has a nested sublist -> null (same
// out-of-scope contract as computeRetagListRange; toolbar falls back to
// addCheckbox)
{
  const root = buildRoot('<ol><li>Alpha<ol><li>X</li></ol></li><li>Bravo</li></ol>');
  const list = root.querySelector('ol') as Element;
  const alpha = list.children[0];
  runner.eq(
    'computeTaskifyListRange: target has a nested sublist -> null',
    computeTaskifyListRange(list, [alpha]),
    null
  );
}

// computeUnwrapListRange, a GENUINE multi-item (2+) contiguous middle target
// -- the realistic "select several items, click Bullet" path, not just a
// single collapsed-caret item (Phase 2.3 review: the only case the earlier
// tests above exercised)
{
  const root = buildRoot('<ul><li>Alpha</li><li>Bravo</li><li>Charlie</li><li>Delta</li></ul>');
  const list = root.querySelector('ul') as Element;
  const [, bravo, charlie] = Array.from(list.children);
  const plan = computeUnwrapListRange(list, [bravo, charlie]);
  runner.eq(
    'computeUnwrapListRange: multi-item contiguous middle target -- both become <p>s, Alpha/Delta split off correctly',
    plan?.html,
    '<ul><li>Alpha</li></ul><p>Bravo</p><p>Charlie</p><ul><li>Delta</li></ul>'
  );
}

// computeRetagListRange, a GENUINE multi-item (2+) contiguous middle target
{
  const root = buildRoot('<ol><li>Alpha</li><li>Bravo</li><li>Charlie</li><li>Delta</li></ol>');
  const list = root.querySelector('ol') as Element;
  const [, bravo, charlie] = Array.from(list.children);
  const plan = computeRetagListRange(list, [bravo, charlie], false);
  runner.eq(
    'computeRetagListRange: multi-item contiguous middle target -- both retag to <ul>, Alpha/Delta stay <ol>',
    plan?.html,
    '<ol><li>Alpha</li></ol><ul><li>Bravo</li><li>Charlie</li></ul><ol><li>Delta</li></ol>'
  );
}

// buildListSplitHtml's contiguity guard (Phase 2.3 review fix) -- a
// non-contiguous target set (skips Bravo) must return null, not silently
// drop the skipped item from the output
{
  const root = buildRoot('<ul><li>Alpha</li><li>Bravo</li><li>Charlie</li></ul>');
  const list = root.querySelector('ul') as Element;
  const [alpha, , charlie] = Array.from(list.children);
  runner.eq(
    'computeUnwrapListRange: non-contiguous targets (Bravo skipped) -> null, nothing silently dropped',
    computeUnwrapListRange(list, [alpha, charlie]),
    null
  );
}

runner.finish('list-ops');
