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
import { computeIndent, computeOutdent, computeToList } from '../../media/webview/list-ops';

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
  runner.eq('computeIndent: prev has no sublist → creates one, li > ul', plan?.html, '<li>Alpha<ul><li>Bravo</li></ul></li>');
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
    '<li>Alpha<ul><li>X</li><li>Bravo</li></ul></li>'
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
    '<li>A</li><li>B<ul><li>C</li></ul></li>'
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
  runner.eq('computeOutdent: sublist emptied → removed, no orphan empty <ul>', plan?.html, '<li>A</li><li>B</li>');
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

runner.finish('list-ops');
