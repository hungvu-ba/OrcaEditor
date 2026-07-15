/**
 * Feature: Drag & Drop block reorder (HLR section 17, US-17.3). DOM-outcome
 * tests: drag-drop.ts's move always replaces a Range with the SAME blocks'
 * original outerHTML in a new order (see buildInsertion/performMove) — so a
 * completed move is fully described by "what #content's top-level children
 * look like afterwards". Hand-author that resulting HTML, then check
 * serialize(DOM) -> markdown reflects the new order and is stable across a
 * second render+serialize round trip. Does NOT call drag-drop.ts directly —
 * it needs execCommand/Selection (real browser only), same reasoning as
 * table.ts.
 *
 * Run alone: npm run test:roundtrip:drag-drop
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
    name: 'reorder 2 paragraphs — dragged paragraph lands first',
    html: '<p>Paragraph B.</p><p>Paragraph A.</p>',
    expect: (md) => {
      const lines = md.trim().split('\n').filter(Boolean);
      return lines[0] === 'Paragraph B.' && lines[1] === 'Paragraph A.';
    },
  },
  {
    name: 'move heading + its section (F7 section-move) below another section — paragraph travels with its heading',
    html:
      '<h2>Section Two</h2><p>Intro two.</p>' +
      '<h2>Section One</h2><p>Intro one.</p>',
    expect: (md) => {
      const iTwo = md.indexOf('## Section Two');
      const iIntroTwo = md.indexOf('Intro two.');
      const iOne = md.indexOf('## Section One');
      const iIntroOne = md.indexOf('Intro one.');
      return iTwo >= 0 && iTwo < iIntroTwo && iIntroTwo < iOne && iOne < iIntroOne;
    },
  },
  {
    name: 'move code fence — content and indentation preserved exactly',
    html:
      '<pre><code class="language-js">function foo() {\n  return 1;\n}</code></pre>' +
      '<p>Before.</p>' +
      '<p>After.</p>',
    expect: (md) => {
      const fenceIdx = md.indexOf('```js');
      const beforeIdx = md.indexOf('Before.');
      const afterIdx = md.indexOf('After.');
      return (
        fenceIdx >= 0 &&
        fenceIdx < beforeIdx &&
        beforeIdx < afterIdx &&
        md.includes('```js\nfunction foo() {\n  return 1;\n}\n```')
      );
    },
  },
  {
    name: 'two Mermaid blocks separated by a caret-spacer paragraph (what buildInsertion produces when a move would otherwise land them back-to-back) — both stay separate and round-trip',
    html:
      '<pre><code class="language-mermaid">graph TD; A--&gt;B;</code></pre>' +
      '<p><br></p>' +
      '<pre><code class="language-mermaid">graph TD; C--&gt;D;</code></pre>',
    expect: (md) => {
      const first = md.indexOf('```mermaid');
      const second = md.indexOf('```mermaid', first + 1);
      return (
        first >= 0 &&
        second > first &&
        md.slice(first, second).includes('A-->B') &&
        md.slice(second).includes('C-->D')
      );
    },
  },
  {
    // US-17.7 (M5): "move an existing image" — grounds the scope decision that
    // an image standing alone in its own paragraph is ALREADY a normal
    // top-level block (block-map.ts classifies any <p> as 'paragraph'
    // regardless of contents, and draggableTopLevelBlocks only checks for a
    // markdown source range) — so it's already draggable via the M1 engine
    // with zero new code, no different from reordering any other paragraph.
    name: 'M5: an image alone in its own paragraph reorders exactly like any other block — dragged image paragraph lands first',
    html: '<p><img src="assets/diagram.png" alt=""></p><p>Intro.</p>',
    expect: (md) => {
      const img = md.indexOf('![]');
      const intro = md.indexOf('Intro.');
      return img >= 0 && img < intro && md.includes('assets/diagram.png');
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
      problems.push(`Result not as expected: ${JSON.stringify(md)}`);
    }
    const md2 = serializeHtml(renderer.render(md).html);
    if (md2 !== md) {
      ok = false;
      problems.push(`Unstable: md=${JSON.stringify(md)} md2=${JSON.stringify(md2)}`);
    }
  } catch (e) {
    ok = false;
    problems.push(`Exception: ${(e as Error).stack}`);
  }
  runner.check(c.name, ok, problems.join('\n'));
}

runner.finish('drag-drop');
