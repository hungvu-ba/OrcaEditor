/**
 * Roundtrip — Performance Audit P-7: per-block serialization must be BYTE-IDENTICAL
 * to the whole-document pass.
 *
 * This is the gate that makes the optimisation acceptable at all: `serializeChildren`
 * re-runs turndown only for the blocks an edit touched and reuses cached markdown for
 * the rest, so any divergence from `serializeFull` would silently corrupt the user's
 * `.md`. Both functions are imported from production (`media/webview/serialize-blocks.ts`)
 * — no mirror of the pipeline is re-implemented here.
 *
 * Per corpus document it checks, for every top-level block in turn:
 *  1) cold cache (every block serialized) === full pass,
 *  2) warm cache + one block edited === full pass,
 *  3) exactly ONE block is re-serialized in case 2 (the whole point),
 * plus the structural cases a cache can get wrong (insert, remove, reorder) and the
 * sibling-sensitive blocks (indented code), serialized together with their neighbours.
 */
import domino from '@mixmark-io/domino';
import {
  MarkdownRenderer,
  createTurndown,
  postProcessMathDom,
  postProcessMermaidDom,
  serializeChildren,
  serializeFull,
  stampBlockStyle,
  stampBlockStyles,
  siblingSensitiveBlockIds,
  type BlockMarkdownCache,
  type BlockSerializeOptions,
} from '../../media/webview/pipeline';
import { buildBlockMap, type BlockEntry } from '../../media/webview/block-map';
import { Runner, firstDiff } from './_lib';

const renderer = new MarkdownRenderer({ breaks: false, linkify: true });

/**
 * The webview's serialize wiring for one document: render → Block Map → the same
 * `BlockSerializeOptions` main.ts builds, with a turndown that counts its calls
 * (one call = one block serialized).
 */
interface Harness {
  doc: Document;
  content: HTMLElement;
  opts: BlockSerializeOptions;
  blockMap: BlockEntry[];
  calls: () => number;
  resetCalls: () => void;
}

function open(md: string): Harness {
  const doc = domino.createDocument(`<div id="content">${renderer.render(md).html}</div>`, true);
  const content = doc.getElementById('content') as HTMLElement | null;
  if (!content) {
    throw new Error('could not parse rendered HTML');
  }
  postProcessMathDom(content, doc);
  postProcessMermaidDom(content, doc);
  const blockMap = buildBlockMap(content, md, []);
  const byId = new Map(blockMap.map((entry) => [entry.id, entry]));
  const td = createTurndown();
  let calls = 0;
  const opts: BlockSerializeOptions = {
    doc,
    turndown: {
      turndown: (node: HTMLElement) => {
        calls++;
        return td.turndown(node);
      },
    },
    stampAll: (clone) => stampBlockStyles(clone, blockMap),
    stampBlock: (clone, id) => {
      const entry = byId.get(id);
      if (entry) {
        stampBlockStyle(clone, entry);
      }
    },
    siblingSensitiveIds: siblingSensitiveBlockIds(blockMap),
  };
  return { doc, content, opts, blockMap, calls: () => calls, resetCalls: () => (calls = 0) };
}

function fullPass(h: Harness): string {
  return serializeFull(h.content, h.opts);
}

function incremental(h: Harness, cache: BlockMarkdownCache, dirty: Set<Node>): string {
  return serializeChildren(h.content, h.opts, cache, dirty);
}

/** Top-level children, the unit `serializeChildren` caches. */
function blocks(h: Harness): Node[] {
  return Array.from(h.content.childNodes);
}

/**
 * Edit a block the way typing does: append a character to its first non-blank text
 * node. Returns false when the block has no text to edit (an `<hr>`, an image-only
 * paragraph), so the caller can skip it.
 */
function typeInto(block: Node): boolean {
  const stack: Node[] = [block];
  while (stack.length) {
    const node = stack.shift() as Node;
    if (node.nodeType === 3 && (node.nodeValue ?? '').trim()) {
      node.nodeValue = `${node.nodeValue}X`;
      return true;
    }
    stack.push(...Array.from(node.childNodes));
  }
  return false;
}

const CORPUS: Array<{ name: string; md: string }> = [
  {
    name: 'headings + paragraphs (ATX, setext, emphasis variants)',
    md: 'Setext title\n============\n\nFirst _paragraph_ with __strong__ text.\n\n## ATX heading\n\nSecond paragraph.\n',
  },
  {
    name: 'lists (bullet marker, ordered, nested, task)',
    md: '* Alpha\n* Bravo\n    * Bravo one\n\nBetween.\n\n1.  One\n2.  Two\n\n-   [ ] todo\n-   [x] done\n',
  },
  {
    name: 'table + paragraphs',
    md: 'Before.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter.\n',
  },
  {
    name: 'blockquote + hr + code fences',
    md: '> Quoted line\n> more\n\n---\n\n```js\nconst a = 1;\n```\n\n~~~py\nx = 1\n~~~\n\nTail paragraph.\n',
  },
  {
    name: 'links, images and inline code',
    md: 'See [docs](./a%20b.md) and ![shot](img/a.png).\n\nUse `npm run test` now.\n\n<img src="img/b.png" width="120">\n',
  },
  {
    name: 'front matter + body',
    md: '---\ntitle: Demo\ntags: [a, b]\n---\n\n# Heading\n\nBody text.\n',
  },
  {
    name: 'math and mermaid blocks',
    md: 'Intro.\n\n$$\na^2 + b^2\n$$\n\n```mermaid\ngraph TD;\nA-->B;\n```\n\nOutro.\n',
  },
  {
    name: 'long document (20 paragraphs + a list)',
    md: `${Array.from({ length: 20 }, (_, i) => `Paragraph number ${i} with some words.`).join('\n\n')}\n\n- item a\n- item b\n`,
  },
];

const runner = new Runner();

for (const { name, md } of CORPUS) {
  // 1) Cold cache — every block serialized on its own — must equal the full pass.
  const cold = open(md);
  const coldIncremental = incremental(cold, new WeakMap(), new Set());
  const coldCalls = cold.calls();
  const coldFull = fullPass(cold);
  runner.check(
    `[${name}] cold cache === full pass`,
    coldIncremental === coldFull,
    firstDiff(coldIncremental, coldFull)
  );
  // Guard the guard: a document that silently fell back to the whole-document pass
  // would satisfy every equality below while testing nothing (one turndown call for
  // the whole document, and the per-edit count of 2 would still hold).
  runner.check(
    `[${name}] really used the per-block path`,
    coldCalls > 1,
    `  turndown calls on a cold cache: ${coldCalls} (expected one per top-level child)`
  );

  // 2) + 3) Warm cache, one block edited: same bytes as the full pass, and ONLY the
  //    edited block goes through turndown again.
  const total = blocks(open(md)).length;
  for (let i = 0; i < total; i++) {
    const h = open(md);
    const cache: BlockMarkdownCache = new WeakMap();
    const dirty = new Set<Node>();
    incremental(h, cache, dirty); // warm
    const block = blocks(h)[i];
    if (!typeInto(block)) {
      continue;
    }
    dirty.add(block);
    h.resetCalls();
    const after = incremental(h, cache, dirty);
    const expected = fullPass(h);
    runner.check(
      `[${name}] edit block ${i} === full pass`,
      after === expected,
      firstDiff(after, expected)
    );
    // 2 = the one dirty block + the `fullPass` above, which also runs turndown once.
    runner.check(
      `[${name}] edit block ${i} re-serializes only that block`,
      h.calls() === 2,
      `  turndown calls: ${h.calls()} (expected 2 = 1 dirty block + 1 full pass)`
    );
  }
}

// --- structural cases a cache can get wrong -------------------------------------
{
  const md = 'One.\n\nTwo.\n\nThree.\n';

  const removed = open(md);
  const removedCache: BlockMarkdownCache = new WeakMap();
  const removedDirty = new Set<Node>();
  incremental(removed, removedCache, removedDirty);
  blocks(removed)[1].parentNode?.removeChild(blocks(removed)[1]);
  const afterRemove = incremental(removed, removedCache, removedDirty);
  runner.eq(`removing a block drops it from the output`, afterRemove, fullPass(removed));

  const reordered = open(md);
  const reorderedCache: BlockMarkdownCache = new WeakMap();
  const reorderedDirty = new Set<Node>();
  incremental(reordered, reorderedCache, reorderedDirty);
  const [first] = blocks(reordered);
  reordered.content.appendChild(first); // move block 1 to the end, no content change
  const afterMove = incremental(reordered, reorderedCache, reorderedDirty);
  runner.eq(`reordering blocks follows the live order`, afterMove, fullPass(reordered));

  const inserted = open(md);
  const insertedCache: BlockMarkdownCache = new WeakMap();
  const insertedDirty = new Set<Node>();
  incremental(inserted, insertedCache, insertedDirty);
  const fresh = inserted.doc.createElement('p');
  fresh.textContent = 'Brand new.';
  inserted.content.appendChild(fresh);
  // Deliberately NOT marked dirty: a node with no cache entry must serialize anyway.
  const afterInsert = incremental(inserted, insertedCache, insertedDirty);
  runner.eq(`an inserted block serializes without being marked dirty`, afterInsert, fullPass(inserted));
}

// --- task-list checkbox: the `checked` PROPERTY is not copied by cloneNode --------
{
  const h = open('- [ ] todo\n');
  const box = h.content.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  runner.check('task list renders a checkbox', box !== null);
  if (box) {
    box.checked = true;
    const cache: BlockMarkdownCache = new WeakMap();
    const out = incremental(h, cache, new Set());
    runner.check('a checked property reaches the per-block output', out.includes('[x]'), `  ${JSON.stringify(out)}`);
    runner.eq('checked block matches the full pass', out, fullPass(h));
  }
}

// --- top-level children that are not block elements --------------------------------
// turndown joins two ADJACENT non-block replacements with nothing (or a collapsed
// space, or a <br>'s single newline), so the per-block join's blank line would split
// one line into several paragraphs — those documents must take the whole-document
// pass. A LONE non-block child between blocks is safe, and that case is the common
// one here: this project stores sized images as raw `<img>` lines. Each case pins
// both the bytes AND which path ran (one turndown call = the fallback).
{
  const runCase = (html: string): { out: string; expected: string; calls: number } => {
    const doc = domino.createDocument(`<div id="content">${html}</div>`, true);
    const content = doc.getElementById('content') as HTMLElement;
    const td = createTurndown();
    let calls = 0;
    const opts: BlockSerializeOptions = {
      doc,
      turndown: {
        turndown: (node: HTMLElement) => {
          calls++;
          return td.turndown(node);
        },
      },
    };
    const out = serializeChildren(content, opts, new WeakMap(), new Set());
    const incrementalCalls = calls;
    return { out, expected: serializeFull(content, opts), calls: incrementalCalls };
  };

  const MUST_FALL_BACK: Array<{ name: string; html: string }> = [
    { name: 'inline element next to text', html: '<em>x</em>y' },
    { name: 'text around an inline element', html: 'lead <strong>bold</strong> tail' },
    { name: 'two <img> lines in a row', html: '<img src="a.png" width="10">\n<img src="b.png" width="10">' },
    { name: '<img> followed by text', html: '<img src="a.png" width="10">Some text right after' },
    { name: 'two adjacent <br>', html: '<p>A</p><br>\n<br><p>B</p>' },
  ];
  for (const { name, html } of MUST_FALL_BACK) {
    const { out, expected, calls } = runCase(html);
    runner.check(`[fallback: ${name}] === full pass`, out === expected, firstDiff(out, expected));
    runner.check(`[fallback: ${name}] took the whole-document pass`, calls === 1, `  turndown calls: ${calls} (expected 1)`);
  }

  const STAYS_INCREMENTAL: Array<{ name: string; html: string }> = [
    { name: 'lone <img> between paragraphs', html: '<p>x</p>\n<img src="a.png" width="120">\n<p>y</p>' },
    { name: 'lone html comment between paragraphs', html: '<p>Above.</p>\n<!-- a note -->\n<p>Below.</p>' },
    { name: 'lone <br> between paragraphs', html: '<p>one</p>\n<br>\n<p>two</p>' },
    // A single-child document is deliberately not listed: one turndown call cannot
    // distinguish the per-block path from the fallback, so the assertion below
    // could not fail. `stray text after a paragraph` covers the bare-text shape.
    { name: 'stray text after a paragraph', html: '<p>para</p>trailing words' },
  ];
  for (const { name, html } of STAYS_INCREMENTAL) {
    const { out, expected, calls } = runCase(html);
    runner.check(`[lone non-block: ${name}] === full pass`, out === expected, firstDiff(out, expected));
    runner.check(`[lone non-block: ${name}] stayed on the per-block path`, calls > 1, `  turndown calls: ${calls} (expected > 1)`);
  }
}

// --- an edit made while the document was on the fallback path ---------------------
// The whole-document pass fills no cache, so if it consumed the dirty marks the edit
// would be served from the pre-edit cache once the document went back per block —
// silently reverting the user's typing.
{
  const h = open('Alpha\n\nBravo\n');
  const cache: BlockMarkdownCache = new WeakMap();
  const dirty = new Set<Node>();
  incremental(h, cache, dirty); // warm
  const bravo = h.content.querySelectorAll('p')[1];
  (bravo.firstChild as Text).nodeValue += ' EDITED';
  dirty.add(bravo);
  // Same edit batch leaves two adjacent non-block children → forces the fallback.
  const stray = h.doc.createElement('em');
  stray.textContent = 'x';
  h.content.appendChild(h.doc.createTextNode('tail'));
  h.content.appendChild(stray);
  runner.eq('the fallback still serializes the edit', incremental(h, cache, dirty), fullPass(h));
  // The stray run goes away (undo / retype) without touching the edited paragraph.
  h.content.removeChild(stray);
  h.content.removeChild(h.content.lastChild as Node);
  const back = incremental(h, cache, dirty);
  runner.eq('the edit survives the return to the per-block path', back, fullPass(h));
}

// --- an op that re-parents a block carries data-block-id onto a DESCENDANT --------
// `wrapInBlockquote` (toolbar Quote) rebuilds the block from its outerHTML, so the
// new top-level <blockquote> has no id and the old one sits on the nested <p>. The
// whole-document pass finds it anyway (it queries descendants), and the per-block
// path must too — otherwise the block loses its original `_em_` delimiter.
{
  const h = open('One _em_ here.\n\nTwo.\n');
  const cache: BlockMarkdownCache = new WeakMap();
  const dirty = new Set<Node>();
  incremental(h, cache, dirty); // warm
  const p = h.content.querySelector('p') as HTMLElement;
  const quote = h.doc.createElement('blockquote');
  quote.innerHTML = p.outerHTML;
  p.parentNode?.replaceChild(quote, p);
  dirty.add(quote);
  const after = incremental(h, cache, dirty);
  const expected = fullPass(h);
  runner.check('a block id on a descendant is still stamped', after === expected, firstDiff(after, expected));
  runner.check('...and the original `_` delimiter survived', after.includes('_em_'), `  got: ${JSON.stringify(after)}`);
}

// --- a split block leaves two children sharing one data-block-id ------------------
// The whole-document stamp is first-match-wins (querySelector semantics), so the
// per-block path must stamp the first twin only.
{
  const h = open('One _em_ here.\n\nTwo.\n');
  const cache: BlockMarkdownCache = new WeakMap();
  const dirty = new Set<Node>();
  incremental(h, cache, dirty); // warm
  const first = h.content.querySelector('p') as HTMLElement;
  const twin = first.cloneNode(true) as HTMLElement; // carries the same data-block-id
  first.parentNode?.insertBefore(twin, first.nextSibling);
  dirty.add(twin);
  const after = incremental(h, cache, dirty);
  const expected = fullPass(h);
  runner.check('a duplicated data-block-id stamps the first twin only', after === expected, firstDiff(after, expected));
}

// --- sibling-sensitive blocks (audit L-10) ------------------------------------------
// An indented code block is the one block whose markdown depends on a SIBLING, so it
// is serialized in one wrapper with its neighbours (a "unit") while the rest of the
// document stays per block.
{
  // Indented code only becomes its OWN top-level block after a paragraph; after a
  // list the same lines are the list's continuation.
  const indented = open('Text.\n\n    indented code\n');
  runner.check(
    'an indented code block is sibling-sensitive',
    siblingSensitiveBlockIds(indented.blockMap).size === 1,
    `  blockMap: ${JSON.stringify(indented.blockMap.map((b) => [b.type, b.mdSlice]))}`
  );

  const fenced = open('- a list\n\n```\nfenced code\n```\n');
  runner.check('a fenced code block is not sibling-sensitive', siblingSensitiveBlockIds(fenced.blockMap).size === 0);

  const prose = open('Just text.\n\nMore text.\n');
  runner.check('a prose document has no sibling-sensitive block', siblingSensitiveBlockIds(prose.blockMap).size === 0);

  /** Cold cache === full pass; returns the markdown so a case can pin the bytes too. */
  const coldEquals = (name: string, h: Harness): string => {
    const out = incremental(h, new WeakMap(), new Set());
    const expected = fullPass(h);
    runner.check(`${name} === full pass`, out === expected, firstDiff(out, expected));
    return out;
  };
  const codeBlock = (h: Harness): HTMLElement => h.content.querySelector('pre') as HTMLElement;
  /** A warm cache over `md` — the state every sync after the first one runs in. */
  const warm = (md: string): { h: Harness; cache: BlockMarkdownCache; dirty: Set<Node> } => {
    const h = open(md);
    const cache: BlockMarkdownCache = new WeakMap();
    const dirty = new Set<Node>();
    incremental(h, cache, dirty);
    return { h, cache, dirty };
  };

  // The unit is load-bearing, not decorative: an indented code block directly after
  // a list serializes as a FENCE (turndown's mdCodeBlock rule reads
  // previousElementSibling), which a wrapper holding only that block cannot see.
  // Rendering can't produce that shape — the lines would be the list's
  // continuation — but an edit can, so build it by removing the paragraph between.
  const afterList = open('- a list\n\nText.\n\n    indented code\n');
  const middle = afterList.content.querySelector('p');
  middle?.parentNode?.removeChild(middle);
  const afterListOut = coldEquals('indented code after a list', afterList);
  runner.check('...and it fell back to a fence', afterListOut.includes('```'), `  got: ${JSON.stringify(afterListOut)}`);

  // The tab variant needs the unit for a second reason: turndown's postProcess
  // strips a leading tab from every result, so on its own the block stops being
  // code at all.
  const tabOut = coldEquals('indented-tab code after a paragraph', open('Text.\n\n\tcode\n'));
  runner.check('...and it kept its tab indent', tabOut.includes('\n\tcode'), `  got: ${JSON.stringify(tabOut)}`);

  for (const [variant, indent] of [
    ['space', '    '],
    ['tab', '\t'],
  ]) {
    const code = `${indent}code line\n${indent}second line\n`;
    const name = (what: string): string => `[indented code, ${variant}] ${what}`;

    const afterParagraph = open(`Text.\n\n${code}\nTail.\n`);
    coldEquals(name('after a paragraph'), afterParagraph);
    runner.check(
      name('after a paragraph stayed on the per-block path'),
      // 2 = the whole-document pass + the `fullPass` inside coldEquals.
      afterParagraph.calls() > 2,
      `  turndown calls: ${afterParagraph.calls()} (expected > 2)`
    );
    coldEquals(name('after a heading'), open(`# Title\n\n${code}`));
    coldEquals(name('after an HTML comment'), open(`Intro.\n\n<!-- note -->\n\n${code}`));
    coldEquals(name('after a leading HTML comment'), open(`<!-- note -->\n\n${code}\nTail.\n`));
    coldEquals(name('as the first block'), open(`${code}\nText.\n`));
    coldEquals(name('as the only block'), open(code));

    // An empty paragraph serializes to nothing, so a unit starting with it would
    // start with the code — and lose a leading tab.
    const afterEmpty = open(`Text.\n\n${code}`);
    const emptyParagraph = afterEmpty.doc.createElement('p');
    emptyParagraph.appendChild(afterEmpty.doc.createElement('br'));
    afterEmpty.content.insertBefore(emptyParagraph, codeBlock(afterEmpty));
    coldEquals(name('after an inserted <p><br></p>'), afterEmpty);

    const listThenCode = open(`- a list\n\nText.\n\n${code}`);
    const between = listThenCode.content.querySelector('p');
    between?.parentNode?.removeChild(between);
    coldEquals(name('after a list'), listThenCode);

    // Two sensitive blocks with only a comment between them fold into one unit.
    const twoBlocks = `Lead.\n\n${code}\n<!-- split -->\n\n${indent}other code\n\nTail.\n`;
    coldEquals(name('two blocks in a row'), open(twoBlocks));

    // --- warm cache: the unit must notice every change that reaches its markdown ---
    const md = `Lead.\n\nBefore.\n\n${code}\nAfter.\n`;
    const edits: Array<[string, (h: Harness) => Node]> = [
      ['the code', codeBlock],
      ['its previous sibling', (h) => h.content.querySelectorAll('p')[1]],
      ['an unrelated paragraph before', (h) => h.content.querySelectorAll('p')[0]],
      ['an unrelated paragraph after', (h) => h.content.querySelectorAll('p')[2]],
    ];
    for (const [what, pick] of edits) {
      const { h, cache, dirty } = warm(md);
      const target = pick(h);
      typeInto(target);
      dirty.add(target);
      runner.eq(name(`typing into ${what} === full pass`), incremental(h, cache, dirty), fullPass(h));
    }

    // Blanks ending the last code line survive in the middle of a document and are
    // dropped at its end; turndown trims the END of every result, so the unit has to
    // tell the two apart.
    const trailingBlanks: Array<[string, string, string]> = [
      ['kept before a paragraph', md, 'second line  \n\nAfter.\n'],
      ['dropped at the end of the document', `Lead.\n\n${code}`, 'second line\n'],
    ];
    for (const [what, source, tail] of trailingBlanks) {
      const { h, cache, dirty } = warm(source);
      const text = codeBlock(h).querySelector('code')?.firstChild as Text;
      text.nodeValue = `${(text.nodeValue ?? '').replace(/\n$/, '')}  \n`;
      dirty.add(codeBlock(h));
      const out = incremental(h, cache, dirty);
      runner.eq(name(`trailing spaces on the last code line, ${what} === full pass`), out, fullPass(h));
      runner.check(name(`...and really ${what}`), out.endsWith(tail), `  got: ${JSON.stringify(out)}`);
    }

    // The structural changes below are deliberately NOT marked dirty: the unit has
    // to notice on its own that it no longer sits next to the nodes it was cached with.
    {
      const { h, cache, dirty } = warm(md);
      const before = h.content.querySelectorAll('p')[1];
      before.parentNode?.removeChild(before);
      runner.eq(name('deleting the previous sibling === full pass'), incremental(h, cache, dirty), fullPass(h));
    }
    {
      const { h, cache, dirty } = warm(md);
      const list = h.doc.createElement('ul');
      list.innerHTML = '<li>new item</li>';
      h.content.insertBefore(list, codeBlock(h));
      const out = incremental(h, cache, dirty);
      runner.eq(name('a <ul> inserted before a cached block === full pass'), out, fullPass(h));
      runner.check(name('...and the cached block became a fence'), out.includes('```'), `  got: ${JSON.stringify(out)}`);
    }
    {
      const { h, cache, dirty } = warm(`Intro.\n\n<!-- note -->\n\n${code}`);
      const comment = Array.from(h.content.childNodes).find((node) => node.nodeType === 8) as Node;
      comment.parentNode?.removeChild(comment);
      runner.eq(name('deleting a comment inside the unit === full pass'), incremental(h, cache, dirty), fullPass(h));
    }
    {
      // A unit that starts the document may start with empty markdown; once a block
      // lands in front of it, the unit has to reach back to that block.
      const { h, cache, dirty } = warm(code);
      const blank = h.doc.createElement('p');
      blank.appendChild(h.doc.createElement('br'));
      h.content.insertBefore(blank, codeBlock(h));
      incremental(h, cache, dirty);
      const intro = h.doc.createElement('p');
      intro.textContent = 'Intro.';
      h.content.insertBefore(intro, blank);
      runner.eq(
        name('a block inserted before a unit that led the document === full pass'),
        incremental(h, cache, dirty),
        fullPass(h)
      );
    }
    {
      // The previous sibling is edited while folded into the unit, then the unit
      // splits: the sibling's own markdown must not be the pre-edit one.
      const { h, cache, dirty } = warm(md);
      const before = h.content.querySelectorAll('p')[1];
      typeInto(before);
      dirty.add(before);
      incremental(h, cache, dirty);
      const pre = codeBlock(h);
      pre.parentNode?.removeChild(pre);
      runner.eq(name('an edit made inside a unit survives its split'), incremental(h, cache, dirty), fullPass(h));
    }
    {
      const { h, cache, dirty } = warm(twoBlocks);
      const first = codeBlock(h);
      typeInto(first);
      dirty.add(first);
      runner.eq(
        name('typing into the first of two blocks in a row === full pass'),
        incremental(h, cache, dirty),
        fullPass(h)
      );
    }

    // --- the number that matters (audit L-10): one keystroke, one block -----------
    {
      const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} with some words.`);
      const { h, cache, dirty } = warm(
        `${paragraphs.slice(0, 20).join('\n\n')}\n\n${code}\n${paragraphs.slice(20).join('\n\n')}\n`
      );
      const target = h.content.querySelectorAll('p')[5];
      typeInto(target);
      dirty.add(target);
      h.resetCalls();
      const out = incremental(h, cache, dirty);
      const calls = h.calls();
      runner.check(
        name('typing into one of 40 paragraphs re-serializes only that paragraph'),
        calls === 1,
        `  turndown calls: ${calls} (expected 1)`
      );
      runner.eq(name('...and still === full pass'), out, fullPass(h));
    }
  }
}

runner.finish('incremental-serialize');
