/**
 * Roundtrip — US-18.4a Preserve Original Format (heading axis) + US-18.4b
 * remaining axes (bullet marker, code block style, em/strong delimiter, HR).
 *
 * Proves that editing one place in a file must NOT silently rewrite the original
 * syntax variant of the OTHER blocks. Each block serializes in exactly the
 * variant its own `mdSlice` has, instead of being forced to the global style
 * (Golden Rule: a canonical file comes out byte-identical to before).
 *
 * Two layers of tests:
 *  1) FULL-FLOW (`serializeWithBlockMap`) — mirrors the real serialize():
 *     render → buildBlockMap (produces mdSlice + data-block-id) → stamp override
 *     from mdSlice → turndown. This is the path production takes.
 *  2) RULE-LEVEL (`serializeHtml`) — hand-built HTML carrying (or not carrying)
 *     data-md-heading-style, to pin the turndown rule's behavior at the edges
 *     (H3+, empty text, new content, exact underline length).
 */
import domino from '@mixmark-io/domino';
import {
  MarkdownRenderer,
  createTurndown,
  normalizeMarkdown,
  postProcessMathDom,
  postProcessMermaidDom,
  prepareDomForSerialize,
} from '../../media/webview/pipeline';
import { buildBlockMap, BLOCK_ID_ATTR } from '../../media/webview/block-map';
import { detectBlockStyle, stampStyleOverride } from '../../media/webview/block-style';
import { Runner, serializeHtml, COMPLEX_CELL } from './_lib';

const renderer = new MarkdownRenderer({ breaks: false, linkify: true });
const turndown = createTurndown();

/**
 * Mirror the real serialize() for tests: render markdown, build the Block Map to
 * get mdSlice + data-block-id, stamp the original-style override, then turndown.
 */
function serializeWithBlockMap(md: string): string {
  const doc = domino.createDocument(`<div id="content">${renderer.render(md).html}</div>`, true);
  const content = doc.getElementById('content');
  if (!content) {
    throw new Error('could not parse rendered HTML');
  }
  postProcessMathDom(content, doc);
  postProcessMermaidDom(content, doc);
  const blockMap = buildBlockMap(content as HTMLElement, md, []);
  prepareDomForSerialize(content, doc);
  for (const entry of blockMap) {
    if (!entry.mdSlice) {
      continue;
    }
    const el = content.querySelector(`[${BLOCK_ID_ATTR}="${entry.id}"]`);
    if (el) {
      stampStyleOverride(el, detectBlockStyle(entry.mdSlice, entry.type));
    }
  }
  return normalizeMarkdown(turndown.turndown(content as HTMLElement));
}

const runner = new Runner();

// 4.1 — a Setext heading stays Setext when another block is edited (here: the
// whole file is re-serialized). The Setext heading must NOT flip to ATX, and its
// original underline length (7, deliberately != the 14-char title) is preserved.
{
  const md = 'Original Title\n=======\n\nSome body text.\n';
  const out = serializeWithBlockMap(md);
  runner.check(
    'setext H1 stays setext (no ATX flip)',
    /Original Title\n=+/.test(out) && !out.includes('# Original Title'),
    `  out = ${JSON.stringify(out)}`
  );
  runner.check('setext H1 byte-stable, original underline length kept', out === md, `  out = ${JSON.stringify(out)}`);
}

// Setext H2 (underline '-') is preserved just the same.
{
  const md = 'Sub Heading\n---\n\nbody\n';
  const out = serializeWithBlockMap(md);
  runner.check(
    'setext H2 stays setext (no ATX flip)',
    /Sub Heading\n-+/.test(out) && !out.includes('## Sub Heading'),
    `  out = ${JSON.stringify(out)}`
  );
  runner.check('setext H2 byte-stable, original underline length kept', out === md, `  out = ${JSON.stringify(out)}`);
}

// 4.4 — cross-block independence: one Setext H1 + one ATX H2 in the same file,
// each serializes in its own variant (and the Setext keeps its short underline).
{
  const md = 'Setext One\n===\n\n## Atx Two\n\nbody\n';
  const out = serializeWithBlockMap(md);
  runner.check(
    'cross-block: setext H1 + atx H2 keep their own variants',
    out === md,
    `  out = ${JSON.stringify(out)}`
  );
}

// 4.6 — Golden Rule: a file already in canonical ATX serializes byte-identical.
{
  const md = '# Canonical Title\n\n## Canonical Sub\n\nbody\n';
  const out = serializeWithBlockMap(md);
  runner.check('golden: canonical ATX file is byte-identical', out === md, `  out = ${JSON.stringify(out)}`);
}

// 4.5 — new content (a heading with no data-block-id/mdSlice) → default ATX, no
// crash. serializeHtml builds no Block Map, which is exactly this situation.
runner.check(
  'new-content: heading with no override → default ATX',
  serializeHtml('<h1>Freshly Typed</h1>').trim() === '# Freshly Typed',
  `  out = ${JSON.stringify(serializeHtml('<h1>Freshly Typed</h1>'))}`
);

// H3+ is always ATX even when marked setext (Setext has only H1/H2).
runner.check(
  'H3 marked setext still emits ATX',
  serializeHtml('<h3 data-md-heading-style="5">Deep</h3>').trim() === '### Deep',
  `  out = ${JSON.stringify(serializeHtml('<h3 data-md-heading-style="5">Deep</h3>'))}`
);

// Rule reads the mark and reproduces the ORIGINAL underline length (9), not the
// text length (6) — the fix for silent underline rewriting of untouched blocks.
runner.check(
  'rule: H1 marked len=9 → 9-char "=" underline (not text length)',
  serializeHtml('<h1 data-md-heading-style="9">Marked</h1>').trim() === 'Marked\n=========',
  `  out = ${JSON.stringify(serializeHtml('<h1 data-md-heading-style="9">Marked</h1>'))}`
);

// An empty heading can't form a Setext heading even with a stale mark: it must
// never emit a bare "=" / "-" line (which would parse as a paragraph / list).
{
  const out = serializeHtml('<h1 data-md-heading-style="5"> </h1>');
  runner.check(
    'empty heading + stale setext mark → no bare underline line',
    !/^=+$/m.test(out) && !/^-+$/m.test(out),
    `  out = ${JSON.stringify(out)}`
  );
}

// ---------------------------------------------------------------------------
// US-18.4b — bullet marker axis
// ---------------------------------------------------------------------------

// I/O row "edit elsewhere": a '+' list (in canonical marker+3 spacing) stays '+'
// byte-identical when the file re-serializes.
{
  const md = 'Intro paragraph.\n\n+   keep plus\n+   still plus\n';
  const out = serializeWithBlockMap(md);
  runner.check('bullet: "+" list untouched → byte-identical', out === md, `  out = ${JSON.stringify(out)}`);
}

// A '-' list keeps '-' the same way.
{
  const md = '-   dash one\n-   dash two\n';
  const out = serializeWithBlockMap(md);
  runner.check('bullet: "-" list untouched → byte-identical', out === md, `  out = ${JSON.stringify(out)}`);
}

// I/O row "mixed markers, one block": a nested level with a different marker
// collapses to the block's FIRST marker (indent normalization is pre-existing).
{
  const md = '- a\n  * b\n';
  const out = serializeWithBlockMap(md);
  runner.check(
    'bullet: mixed markers in one block → collapse to first ("-")',
    /^-\s+a/m.test(out) && /^\s+-\s+b/m.test(out) && !/^\s*\*/m.test(out),
    `  out = ${JSON.stringify(out)}`
  );
}

// I/O row "new list this session": no mdSlice/attr → new global default '*'.
runner.check(
  'bullet: new list (no override) → "*" default',
  /^\*\s+fresh/m.test(serializeHtml('<ul><li>fresh</li></ul>')),
  `  out = ${JSON.stringify(serializeHtml('<ul><li>fresh</li></ul>'))}`
);

// Rule-level: nested <li> inherit the marker stamped on the top-level list.
{
  const out = serializeHtml('<ul data-md-bullet-style="+"><li>top<ul><li>nested</li></ul></li></ul>');
  runner.check(
    'bullet: rule reads "+" from block ancestor, nested li inherits',
    /^\+\s+top/m.test(out) && /^\s+\+\s+nested/m.test(out),
    `  out = ${JSON.stringify(out)}`
  );
}

// Ordered items ignore the bullet attr (numbering emission untouched).
{
  const out = serializeHtml('<ol data-md-bullet-style="+"><li>one</li><li>two</li></ol>');
  runner.check(
    'bullet: ordered list unaffected by bullet attr',
    /^1\.\s+one/m.test(out) && /^2\.\s+two/m.test(out),
    `  out = ${JSON.stringify(out)}`
  );
}

// ---------------------------------------------------------------------------
// US-18.4b — code block style axis
// ---------------------------------------------------------------------------

// I/O row "edit elsewhere": 4-space indented code stays byte-identical, no fence.
{
  const md = 'para\n\n    indented line\n    second line\n';
  const out = serializeWithBlockMap(md);
  runner.check('code: indented block untouched → byte-identical, no fence', out === md, `  out = ${JSON.stringify(out)}`);
}

// I/O row "edit inside indented code": rule-level — a line added in the DOM
// (clone carries the stamp) stays indented, every line present.
{
  const out = serializeHtml(
    '<pre data-md-code-style="indented"><code>old line\nadded line</code></pre>'
  );
  runner.check(
    'code: edit inside indented block → new line present, stays indented',
    out === '    old line\n    added line\n',
    `  out = ${JSON.stringify(out)}`
  );
}

// I/O row "~~~ fence": keeps ~~~ and the language token.
{
  const md = '~~~python\nprint(1)\n~~~\n';
  const out = serializeWithBlockMap(md);
  runner.check('code: "~~~" fence untouched → byte-identical (keeps language)', out === md, `  out = ${JSON.stringify(out)}`);
}

// Rule-level: tilde fence grows only past LINE-START tilde runs (a mid-line
// `~~~` can't close a fence, so it must not trigger growth — byte churn).
{
  const out = serializeHtml('<pre data-md-code-style="fence-tilde"><code>~~~\n</code></pre>');
  runner.check(
    'code: tilde fence grows past a line-start "~~~" in the body',
    out === '~~~~\n~~~\n~~~~\n',
    `  out = ${JSON.stringify(out)}`
  );
}
{
  const out = serializeHtml('<pre data-md-code-style="fence-tilde"><code>has ~~~ inside</code></pre>');
  runner.check(
    'code: mid-line "~~~" does NOT grow the tilde fence',
    out === '~~~\nhas ~~~ inside\n~~~\n',
    `  out = ${JSON.stringify(out)}`
  );
}
// Full-flow: an untouched tilde block whose body has a mid-line "~~~" stays
// byte-identical (the old always-grow behavior rewrote the fence to "~~~~").
{
  const md = '~~~\nline ~~~ mid\n~~~\n';
  const out = serializeWithBlockMap(md);
  runner.check('code: tilde block with mid-line tildes → byte-identical', out === md, `  out = ${JSON.stringify(out)}`);
}

// Indented body with a BLANK line: the blank line must stay empty, not become
// a line of four trailing spaces.
{
  const md = 'para\n\n    a\n\n    b\n';
  const out = serializeWithBlockMap(md);
  runner.check('code: blank line inside indented block → byte-identical', out === md, `  out = ${JSON.stringify(out)}`);
}

// Tab-indented block keeps tabs (not silently converted to 4 spaces).
{
  const md = 'para\n\n\ttab line\n\tsecond\n';
  const out = serializeWithBlockMap(md);
  runner.check('code: tab-indented block untouched → byte-identical', out === md, `  out = ${JSON.stringify(out)}`);
}

// A whitespace-only indented body must never emit a bare indented blank line
// (which would silently vanish on reparse). turndown's own blankReplacement
// already swallows whitespace-only PRE blocks before any rule runs — the same
// pre-existing behavior as the fenced path — so the output is simply empty;
// the fence fallback in the rule is defense-in-depth for non-blank PREs whose
// code text is still whitespace-only.
{
  const out = serializeHtml('<pre data-md-code-style="indented"><code>   </code></pre>');
  runner.check(
    'code: emptied indented block never emits a bare indented blank line',
    !/^ {4}[ \t]*$/m.test(out) || out.trim() === '',
    `  out = ${JSON.stringify(out)}`
  );
}

// An indented block directly after a list would reparse as list continuation →
// falls back to a fence to keep the block's identity.
{
  const out = serializeHtml(
    '<ul><li>item</li></ul><pre data-md-code-style="indented"><code>code line</code></pre>'
  );
  runner.check(
    'code: indented block directly after a list falls back to fence',
    out.includes('```\ncode line\n```'),
    `  out = ${JSON.stringify(out)}`
  );
}

// I/O row "new code block (toolbar)": no attr → backtick fence, never indented.
{
  const out = serializeHtml('<pre><code class="language-js">const x = 1;</code></pre>');
  runner.check(
    'code: new block (no override) → backtick fence with language',
    out === '```js\nconst x = 1;\n```\n',
    `  out = ${JSON.stringify(out)}`
  );
}

// ---------------------------------------------------------------------------
// US-18.4b — em/strong delimiter + HR variant axes
// ---------------------------------------------------------------------------

// I/O row "_em_/__strong__/*** HR": each keeps its original variant when the
// file re-serializes.
{
  const md = 'uses _em_ and __strong__ words\n\n***\n\nafter\n';
  const out = serializeWithBlockMap(md);
  runner.check('em/strong/hr: original variants kept byte-identical', out === md, `  out = ${JSON.stringify(out)}`);
}

// Cross-block independence: a `_`-em block does not infect a `*`-em block.
{
  const md = 'first _underscore em_\n\nsecond *star em*\n';
  const out = serializeWithBlockMap(md);
  runner.check('em: per-block delimiter, no cross-block bleed', out === md, `  out = ${JSON.stringify(out)}`);
}

// Triple-delimiter emphasis (`___x___` = em+strong together) keeps both axes.
{
  const md = 'some ___both___ text\n';
  const out = serializeWithBlockMap(md);
  runner.check('em/strong: "___x___" kept byte-identical', out === md, `  out = ${JSON.stringify(out)}`);
}

// A literal intraword star (`2*4`) is NOT em-delimiter evidence — the real
// `_em_` in the same block keeps `_`.
{
  const out = serializeWithBlockMap('Buy 2*4 lumber and _nails_.\n');
  runner.check(
    'em: literal "2*4" does not flip a "_" block to "*"',
    out.includes('_nails_') && !out.includes('*nails*'),
    `  out = ${JSON.stringify(out)}`
  );
}

// Underscores inside a link DESTINATION are not delimiter evidence — the real
// `*note*` keeps `*`.
{
  const md = '[doc](https://ex.com/_v2_) and *note*\n';
  const out = serializeWithBlockMap(md);
  runner.check('em: "_" in link URL does not flip a "*" block', out === md, `  out = ${JSON.stringify(out)}`);
}

// Intraword underscores in non-ASCII words (`chữ_ký`) are not openers either.
{
  const out = serializeWithBlockMap('chữ_ký here and *em*\n');
  runner.check(
    'em: intraword "_" after non-ASCII letter does not flip a "*" block',
    out.includes('*em*') && !out.includes('_em_'),
    `  out = ${JSON.stringify(out)}`
  );
}

// An escaped backslash before `_` keeps the right escape parity: `C:\\_dir_`
// really contains an em, so the block's `_` delimiter is preserved.
{
  const md = 'C:\\\\_dir_ here\n';
  const out = serializeWithBlockMap(md);
  runner.check('em: escaped backslash before "_" → "_" still detected', out === md, `  out = ${JSON.stringify(out)}`);
}

// A double-backtick code span with single backticks inside strips fully — the
// literal `_foo` inside it is not delimiter evidence.
{
  const out = serializeWithBlockMap('Use ``x `_foo` y`` here and *em*\n');
  runner.check(
    'em: backtick-run code span strips fully, "*" block not flipped',
    out.includes('*em*') && !out.includes('_em_'),
    `  out = ${JSON.stringify(out)}`
  );
}

// Intraword em in a `_`-style block falls back to `*` (CommonMark can't parse
// `_th_ing`) — parseable output beats delimiter fidelity.
{
  const out = serializeHtml('<p data-md-em-style="_">th<em>i</em>ng and <em>whole</em></p>');
  runner.check(
    'em: intraword emphasis in a "_" block falls back to "*"',
    out.includes('th*i*ng') && out.includes('_whole_'),
    `  out = ${JSON.stringify(out)}`
  );
}

// Rule-level fallbacks: no attr → global '*'/'**'/'---'.
runner.check(
  'em/strong: new content (no override) → "*"/"**" defaults',
  serializeHtml('<p><em>a</em> <strong>b</strong></p>').trim() === '*a* **b**',
  `  out = ${JSON.stringify(serializeHtml('<p><em>a</em> <strong>b</strong></p>'))}`
);
runner.check(
  'hr: new content (no override) → "---" default',
  serializeHtml('<hr>').trim() === '---',
  `  out = ${JSON.stringify(serializeHtml('<hr>'))}`
);
runner.check(
  'hr: rule re-emits the stamped raw line verbatim',
  serializeHtml('<hr data-md-hr-style="- - -">').trim() === '- - -',
  `  out = ${JSON.stringify(serializeHtml('<hr data-md-hr-style="- - -">'))}`
);

// A list inside a BLOCKQUOTE lives in a 'blockquote'-typed block — its marker
// must be preserved too (the '-'→'*' default flip must not rewrite it).
{
  const md = '> -   quoted item\n> -   another\n';
  const out = serializeWithBlockMap(md);
  runner.check('bullet: list inside blockquote keeps "-"', out === md, `  out = ${JSON.stringify(out)}`);
}

// Bullet-like lines inside a fenced snippet WITHIN a list block (`- removed` in
// a diff) are not marker evidence — the real nested `*` marker is kept.
{
  const md = ['1. step', '', '   ```diff', '   - removed', '   ```', '', '   * sub', ''].join('\n');
  const out = serializeWithBlockMap(md);
  runner.check(
    'bullet: "- " inside a fenced diff does not override the real "*" marker',
    /^\s+\*\s+sub/m.test(out) && !/^\s+-\s+sub/m.test(out),
    `  out = ${JSON.stringify(out)}`
  );
}

// An HR written with legal leading indent keeps it (up to 3 spaces is valid).
{
  const md = 'para\n\n  ***\n\nafter\n';
  const out = serializeWithBlockMap(md);
  runner.check('hr: leading indent kept verbatim', out === md, `  out = ${JSON.stringify(out)}`);
}

// Complex table (serialized as raw HTML) must NOT leak transient editor
// attributes (per-block style stamps, block ids) into the `.md` output.
{
  const out = serializeHtml(
    '<table data-md-em-style="_" data-block-id="block-7"><tbody><tr>' +
      '<td><ul><li>x</li><li>y</li></ul></td></tr></tbody></table>'
  );
  runner.check(
    'complex table HTML output carries no transient data-* attributes',
    out.includes('<table') && !out.includes('data-md-em-style') && !out.includes('data-block-id'),
    `  out = ${JSON.stringify(out)}`
  );
}

// Req 23 US-23.1: same leak check for the comment anchor id — a comment must
// leave NO footprint in the `.md`, and the raw-HTML path is where a stamped
// attribute would otherwise survive. Covers the id on the table itself and on a
// descendant cell (a selection can anchor to either).
{
  const out = serializeHtml(
    '<table data-comment-anchor-id="comment-anchor-1"><tbody><tr>' +
      '<td data-comment-anchor-id="comment-anchor-2"><ul><li>x</li><li>y</li></ul></td></tr></tbody></table>'
  );
  runner.check(
    'complex table HTML output carries no comment-anchor id',
    out.includes('<table') && !out.includes('data-comment-anchor-id'),
    `  out = ${JSON.stringify(out)}`
  );
}

// Req 23 US-23.4: the resolution-state attribute is stamped on live nodes by the
// same tiers that move the anchor id, so it needs the identical no-leak
// guarantee — it is session-only UI state, never document content.
{
  const out = serializeHtml(
    '<table data-comment-anchor-state="approximate"><tbody><tr>' +
      '<td data-comment-anchor-state="floating"><ul><li>x</li><li>y</li></ul></td></tr></tbody></table>'
  );
  runner.check(
    'complex table HTML output carries no comment-anchor state',
    out.includes('<table') && !out.includes('data-comment-anchor-state'),
    `  out = ${JSON.stringify(out)}`
  );
}

// Same leak check for the table-separator axis specifically: a complex table
// (nested list forces HTML fallback) stamped 'compact' must not leak
// data-md-table-sep-style into the saved .md output.
{
  const out = serializeHtml(
    '<table data-md-table-sep-style="compact"><tbody><tr>' +
      '<td><ul><li>x</li><li>y</li></ul></td></tr></tbody></table>'
  );
  runner.check(
    'complex table HTML output carries no transient table-separator attribute',
    out.includes('<table') && !out.includes('data-md-table-sep-style'),
    `  out = ${JSON.stringify(out)}`
  );
}

// ---------------------------------------------------------------------------
// US-18.5 — table separator-row spacing axis
// ---------------------------------------------------------------------------

// I/O row "edit elsewhere": a compact-separator table stays byte-identical
// when another block in the same file is re-serialized.
{
  const md = '| A | B |\n|---|---|\n| 1 | 2 |\n\nSome body text.\n';
  const out = serializeWithBlockMap(md);
  runner.check('table: compact separator untouched → byte-identical', out === md, `  out = ${JSON.stringify(out)}`);
}

// Golden Rule: a file already using the padded default stays byte-identical.
{
  const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
  const out = serializeWithBlockMap(md);
  runner.check('table: golden — padded separator is byte-identical', out === md, `  out = ${JSON.stringify(out)}`);
}

// I/O row "new table (toolbar)": no mdSlice/attr → current padded default.
runner.check(
  'table: new table (no override) → padded default',
  serializeHtml('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
    .includes('| --- | --- |'),
  `  out = ${JSON.stringify(
    serializeHtml('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
  )}`
);

// Rule-level: compact mark + column alignment keeps the compact wrapping
// with the correct alignment token, no inner spaces.
{
  const out = serializeHtml(
    '<table data-md-table-sep-style="compact"><thead><tr><th>A</th>' +
      '<th align="center" style="text-align: center;">B</th></tr></thead>' +
      '<tbody><tr><td>1</td><td align="center" style="text-align: center;">2</td></tr></tbody></table>'
  );
  runner.check(
    'table: compact mark + alignment → "|:-:|" with no inner spaces',
    out.includes('|---|:-:|') && !out.includes('| --- |') && !out.includes('| :-: |'),
    `  out = ${JSON.stringify(out)}`
  );
}

// ---------------------------------------------------------------------------
// US-18.4b — new global defaults + Golden Rule
// ---------------------------------------------------------------------------

// I/O row "two-space hard break": rewritten to '\' on any edit (intended).
{
  const md = 'line one  \nline two\n';
  const out = serializeWithBlockMap(md);
  runner.check(
    'br: two-space hard break → rewritten to "\\" (intended)',
    out === 'line one\\\nline two\n',
    `  out = ${JSON.stringify(out)}`
  );
}

// I/O row "fully-canonical file" (GOLDEN RULE, new convention): ATX headings,
// '*' bullets, '1.' numbering, backslash break, backtick fence + language,
// '---' HR, '*em*'/'**strong**' — byte-identical through serialize.
{
  const md = [
    '# Title',
    '',
    'Some *em* and **strong** text.',
    '',
    'break here\\',
    'continues.',
    '',
    '*   item one',
    '*   item two',
    '',
    '1.  first',
    '2.  second',
    '',
    '---',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    'Done.',
    '',
  ].join('\n');
  const out = serializeWithBlockMap(md);
  runner.check('golden: fully-canonical file (new convention) is byte-identical', out === md, `  out = ${JSON.stringify(out)}`);
}

// --- Req 23 US-23.6: session-only comment CLASSES must not leak into `.md` ---
// TRANSIENT_ATTRS covers attributes; a class can only be dropped wholesale, so
// the raw-HTML path (complex table / kept tag) needs its own strip. A marker
// reaching the `.md` would be a real document edit — the undo-stack slot the US
// forbids. A complex table (nested list in a cell) is the reliable way in.

{
  const out = serializeHtml(
    `<table class="comment-anchor-active"><thead><tr><th>A</th></tr></thead>` +
      `<tbody><tr>${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(
    'US-23.6: comment-anchor-active on the serialized element itself is stripped',
    out.includes('<table') && !out.includes('comment-anchor-active') && !out.includes('class=""'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  const out = serializeHtml(
    `<table><thead><tr><th>A</th></tr></thead><tbody><tr>` +
      `<td class="comment-anchor-active">anchored</td>` +
      `${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(
    'US-23.6: comment-anchor-active on a descendant is stripped, no empty class left',
    out.includes('anchored') && !out.includes('comment-anchor-active') && !out.includes('class=""'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // Only the marker goes: a class the document legitimately carries must survive.
  const out = serializeHtml(
    `<table><thead><tr><th>A</th></tr></thead><tbody><tr>` +
      `<td class="comment-anchor-active md-keep-me">anchored</td>` +
      `${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(
    'US-23.6: a co-existing class survives the strip',
    !out.includes('comment-anchor-active') && out.includes('md-keep-me'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // The OTHER entry into safeOuterHtml: an unknown tag kept as raw HTML
  // (outerHtmlFallback). Exercised here because domino, not the browser, is the
  // engine where this repo's DOM-API traps live.
  const inline = serializeHtml('<p>Alpha <mark class="comment-anchor-active">marked</mark> text.</p>');
  const block = serializeHtml('<div class="comment-anchor-active"><span>kept block</span></div>');
  runner.check(
    'US-23.6: kept-tag fallback path strips the marker too (inline + block)',
    inline.includes('<mark>marked</mark>') &&
      !inline.includes('comment-anchor-active') &&
      block.includes('kept block') &&
      !block.includes('comment-anchor-active') &&
      !block.includes('class=""'),
    `  inline = ${JSON.stringify(inline)}\n  block = ${JSON.stringify(block)}`
  );
}

{
  // The third raw-HTML emitter, htmlImgWithAttrs — a sized image is stored as
  // raw <img> precisely so that rule fires, so it must strip the marker as well.
  const out = serializeHtml('<p><img src="a.png" width="200" class="comment-anchor-active"></p>');
  runner.check(
    'US-23.6: raw <img> emitter strips the marker but keeps its real attributes',
    out.includes('src="a.png"') && out.includes('width="200"') && !out.includes('comment-anchor-active'),
    `  out = ${JSON.stringify(out)}`
  );
}

// --- Req 24 US-23.21: the transient-class strip list becomes an enforced rule
// instead of a per-feature convention — 7 previously-leaking classes register,
// the one unrouted emitter (alignedBlock) and injected UI chrome close, and the
// img-attribute filter and rival stripTablePresentation list stop working
// around the mechanism instead of using it. ---

{
  // AC2: each of the 7 newly-registered classes strips to byte-identical
  // output on the raw-HTML table path, one named case per class.
  const NAMED_CLASSES: Array<{ name: string; cls: string; attrEl: 'td' | 'table' }> = [
    { name: 'md-entity-ref (Req 21)', cls: 'md-entity-ref', attrEl: 'td' },
    { name: 'dd-hover-outline (Req 17)', cls: 'dd-hover-outline', attrEl: 'td' },
    { name: 'dd-hover-outline-cell (Req 17)', cls: 'dd-hover-outline-cell', attrEl: 'td' },
    { name: 'dd-source-muted (Req 17)', cls: 'dd-source-muted', attrEl: 'td' },
    { name: 'md-code-wrapped (Req 04)', cls: 'md-code-wrapped', attrEl: 'td' },
    { name: 'md-table-fit (US-19.25, folded from stripTablePresentation)', cls: 'md-table-fit', attrEl: 'table' },
    // US-23.22: three more leaks the registration scan found after this story
    // shipped — same shape as the seven above, registered for the same reason.
    { name: 'broken-ref (Req 20 US-20.9, found by US-23.22)', cls: 'broken-ref', attrEl: 'td' },
    { name: 'entity-reveal-flash (Req 21, found by US-23.22)', cls: 'entity-reveal-flash', attrEl: 'td' },
    { name: 'dd-drop-target-cell (Req 17, found by US-23.22)', cls: 'dd-drop-target-cell', attrEl: 'td' },
  ];
  for (const { name, cls, attrEl } of NAMED_CLASSES) {
    const withClass =
      attrEl === 'td'
        ? serializeHtml(
            `<table><thead><tr><th>A</th></tr></thead><tbody><tr>` +
              `<td class="${cls}">ref</td>${COMPLEX_CELL}</tr></tbody></table>`
          )
        : serializeHtml(
            `<table class="${cls}"><thead><tr><th>A</th></tr></thead>` +
              `<tbody><tr>${COMPLEX_CELL}</tr></tbody></table>`
          );
    const withoutClass =
      attrEl === 'td'
        ? serializeHtml(
            `<table><thead><tr><th>A</th></tr></thead><tbody><tr>` +
              `<td>ref</td>${COMPLEX_CELL}</tr></tbody></table>`
          )
        : serializeHtml(
            `<table><thead><tr><th>A</th></tr></thead><tbody><tr>${COMPLEX_CELL}</tr></tbody></table>`
          );
    runner.check(
      `US-23.21 AC2: ${name} strips to byte-identical output`,
      withClass === withoutClass,
      `  withClass    = ${JSON.stringify(withClass)}\n  withoutClass = ${JSON.stringify(withoutClass)}`
    );
  }
}

{
  // AC3: an <img> whose only extra attribute is a transient class must fall
  // through to the default image rule (![]()), not htmlImgWithAttrs's raw HTML
  // — before this fix, safeOuterHtml would strip the class to nothing while the
  // filter still routed here on the class attribute's mere presence.
  const out = serializeHtml('<p><img src="a.png" alt="x" class="dd-hover-outline"></p>');
  runner.check(
    'US-23.21 AC3: an <img> whose only extra attribute is a transient class serializes as markdown, not raw HTML',
    out.includes('![x](a.png)') && !out.includes('<img'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // AC3 regression guard (caught in review 2026-07-28): a present-but-EMPTY
  // class="" must discount the same as an all-transient one — the old
  // `tokens.length > 0 && …` guard treated zero tokens as "extra", so this
  // case wrongly fell through to raw HTML before the fix.
  const out = serializeHtml('<p><img src="a.png" alt="x" class=""></p>');
  runner.check(
    'US-23.21 AC3: an <img> with an empty class="" serializes as markdown, not raw HTML',
    out.includes('![x](a.png)') && !out.includes('<img'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // AC1: alignedBlock used to read live el.innerHTML with zero stripping — the
  // one raw-HTML emitter that didn't funnel through safeOuterHtml/cloneAndStrip.
  const out = serializeHtml('<p align="center">Hello <span class="dd-hover-outline">world</span></p>');
  runner.check(
    'US-23.21 AC1: alignedBlock rule strips a transient class from its subtree (previously unrouted emitter)',
    out.includes('align="center"') && out.includes('world') && !out.includes('dd-hover-outline'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // AC1b: injected UI chrome (code-block header, language label, Copy/Wrap
  // buttons), stamped with the MD_CHROME_MARKER_ATTR ownership marker
  // (data-md-chrome) alongside contenteditable="false", must never reach the
  // .md on the same raw-HTML table path a fenced block can be dragged into.
  const codeCell =
    '<td><pre><div class="md-code-header" contenteditable="false" data-md-chrome>' +
    '<span class="md-code-lang" role="button">js</span>' +
    '<button class="md-code-wrap" contenteditable="false">Wrap</button>' +
    '<button class="md-code-copy" contenteditable="false">Copy</button>' +
    '</div><code>const x = 1;</code></pre></td>';
  const out = serializeHtml(
    `<table><thead><tr><th>A</th></tr></thead><tbody><tr>${codeCell}${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(
    'US-23.21 AC1b: injected code-header chrome (Copy/Wrap buttons) never reaches raw-HTML serialize',
    out.includes('const x = 1;') &&
      !out.includes('<button') &&
      !out.includes('md-code-header') &&
      !out.includes('Copy') &&
      !out.includes('Wrap'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // AC1b: a diagram/math toolbar's shape (toolbar div + toggle button, both
  // carrying the marker, per createToolbarToggle in dom-postprocess.ts) is
  // covered by the same marker match, not just the code-header shape above.
  const toolbarCell =
    '<td><div class="mermaid-toolbar" contenteditable="false" data-md-chrome>' +
    '<button class="mermaid-toggle" contenteditable="false" data-md-chrome>Toggle</button>' +
    '</div>content</td>';
  const out = serializeHtml(
    `<table><thead><tr><th>A</th></tr></thead><tbody><tr>${toolbarCell}${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(
    'US-23.21 AC1b: a marked diagram/math toolbar never reaches raw-HTML serialize',
    out.includes('content') && !out.includes('Toggle') && !out.includes('mermaid-toolbar'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // AC1b regression guard (caught in review 2026-07-28): a contenteditable="false"
  // node with no chrome marker holds REAL user content, so stripInjectedChrome
  // must keep matching the marker and never the bare attribute. Req 21's
  // `.md-caption` badge used to be this case's subject; US-23.22 gave it its own
  // source-form restoration (below), so the principle is pinned here on a plain
  // user-authored node instead — a node nothing else in the pipeline touches.
  const out = serializeHtml(
    `<table><thead><tr><th>A</th></tr></thead><tbody><tr>` +
      `<td>a <span contenteditable="false">real content</span></td>${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(
    'US-23.21 AC1b: a contenteditable="false" node with no chrome marker survives — not blanket-matched',
    out.includes('real content'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // US-23.22 deferred item 1 (fixed 2026-07-28): Req 21's `.md-caption` badge is
  // an editor-only WRAPPER around a `caption::NS_ID` token, normally undone by
  // turndown's SPAN default — which does not run on the raw-HTML path. So
  // cloneAndStrip restores the source token itself: the text must survive (it is
  // user content, not chrome) with no wrapper, class or contenteditable left.
  const badge =
    '<span class="md-caption" contenteditable="false">' +
    '<span class="md-caption-prefix">caption::</span>' +
    '<span class="md-caption-ns">UC</span><span class="md-caption-id">02</span></span>';
  const out = serializeHtml(
    `<table><thead><tr><th>A</th></tr></thead><tbody><tr>` +
      `<td>a ${badge}</td>${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(
    'US-23.22: a .md-caption badge is restored to its `caption::NS_ID` source token on the raw-HTML path',
    out.includes('a caption::UC02') && !out.includes('md-caption') && !out.includes('contenteditable'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // US-23.22 deferred item 1: `cloneAndStrip` is shared by THREE raw-HTML
  // emitters, and every other case here exercises only `complexTableAsHtml`. Pin
  // the other two, or a future change narrowing restoration to the table path
  // passes the whole suite:
  //  - `outerHtmlFallback`, reached from turndown's keep list (`<details>`);
  //  - `alignedBlock`, which uses cloneAndStrip(el).innerHTML, not outerHTML.
  const viaKeep = serializeHtml(
    '<details><summary>s</summary><p>see <span class="md-caption" contenteditable="false">' +
      '<span class="md-caption-prefix">caption::</span><span class="md-caption-ns">UC</span>' +
      '<span class="md-caption-id">02</span></span></p></details>'
  );
  runner.check(
    'US-23.22: outerHtmlFallback (a kept <details>) restores a wrapper too, not just complexTableAsHtml',
    viaKeep.includes('<details>') &&
      viaKeep.includes('see caption::UC02') &&
      !viaKeep.includes('md-caption') &&
      !viaKeep.includes('contenteditable'),
    `  out = ${JSON.stringify(viaKeep)}`
  );
  const viaAligned = serializeHtml(
    '<p align="center">a <span class="md-math-inline" data-tex="x^2">' +
      '<span class="md-math-render" contenteditable="false"><span class="katex">K</span></span></span> b</p>'
  );
  runner.check(
    'US-23.22: alignedBlock restores a wrapper too (it reads innerHTML, a separate route)',
    viaAligned.includes('align="center"') &&
      viaAligned.includes('a $x^2$ b') &&
      !viaAligned.includes('md-math') &&
      !viaAligned.includes('katex') &&
      !viaAligned.includes('contenteditable'),
    `  out = ${JSON.stringify(viaAligned)}`
  );
}

{
  // US-23.22 deferred item 1: same for a diagram frame dragged into a table cell
  // (drag-drop.ts treats a Mermaid frame as a draggable block). The frame — its
  // toolbar, its chart container, the `md-mermaid-error` stamped there when a
  // render fails, and the rendered SVG — collapses back to the source `<pre>`
  // markdown-it emitted for the fence, which is the `mermaidDiagram` rule's job
  // and the raw-HTML path used to skip entirely. An element, not fence text:
  // turndown's whitespace collapse would eat a text node's newlines on the next
  // save and destroy the diagram source.
  const CELL = '<td><pre><code class="language-mermaid">graph TD; A---B;</code></pre></td>';
  const out = serializeHtml(
    `<table><thead><tr><th>A</th></tr></thead><tbody><tr>${CELL}${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(
    'US-23.22: a Mermaid frame in a raw-HTML table collapses back to its source <pre>, byte-identical',
    out.includes(CELL) && !out.includes('md-mermaid') && !out.includes('contenteditable'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // AC4: stripTablePresentation's own rival `md-table-fit` strip is gone —
  // registering it centrally (the AC2 case above) is the only strip path left.
  // This asserts the width/box-sizing presentation strip AC4 must not break
  // still runs alongside the now-centralized class strip.
  const out = serializeHtml(
    `<table class="md-table-fit" style="width: 300px;"><thead><tr><th style="width: 100px;">A</th></tr></thead>` +
      `<tbody><tr>${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(
    'US-23.21 AC4: md-table-fit and its width presentation both strip, no rival list left',
    !out.includes('md-table-fit') && !out.includes('width: 300px') && !out.includes('width: 100px'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // AC5: a hand-authored class the document legitimately carries must survive —
  // only registered names are removed, unchanged behavior being reasserted
  // against the newly-registered 7.
  const out = serializeHtml(
    `<table><thead><tr><th>A</th></tr></thead><tbody><tr>` +
      `<td class="user-defined-class">kept</td>${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(
    'US-23.21 AC5: a hand-authored non-transient class survives serialization unchanged',
    out.includes('class="user-defined-class"') && out.includes('kept'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // AC5: a hand-authored class colliding with a registered name is
  // indistinguishable from an editor-stamped one at serialize time and is
  // removed all the same (deferred-work.md US-23.6 item 6(b), accepted).
  const out = serializeHtml(
    `<table><thead><tr><th>A</th></tr></thead><tbody><tr>` +
      `<td class="dd-hover-outline">collision</td>${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(
    'US-23.21 AC5: a hand-authored class colliding with a registered name is removed like an editor-stamped one',
    out.includes('collision') && !out.includes('dd-hover-outline') && !out.includes('class=""'),
    `  out = ${JSON.stringify(out)}`
  );
}

{
  // Clone-only safety (necessary precondition for AC7, not AC7 itself — see
  // below): after a raw-HTML serialize pass, the live #content DOM node
  // stamped with a transient class must be untouched, proving strip never
  // reaches the source a re-stamp would otherwise have to fight. One case per
  // newly-registered class.
  const CELL_CLASSES = [
    'md-entity-ref',
    'dd-hover-outline',
    'dd-hover-outline-cell',
    'dd-source-muted',
    'md-code-wrapped',
    // US-23.22 additions (see the named strip cases above).
    'broken-ref',
    'entity-reveal-flash',
    'dd-drop-target-cell',
  ];
  for (const cls of CELL_CLASSES) {
    const doc = domino.createDocument(
      `<div id="content"><table><thead><tr><th>A</th></tr></thead><tbody><tr>` +
        `<td class="${cls}">ref</td>${COMPLEX_CELL}</tr></tbody></table></div>`,
      true
    );
    const root = doc.getElementById('content') as HTMLElement;
    const carrier = root.querySelector(`.${cls}`) as HTMLElement;
    turndown.turndown(root);
    runner.check(
      `US-23.21 (clone-only safety): ${cls} — serialize never mutates the live DOM`,
      carrier.classList.contains(cls),
      `  classList after serialize = "${carrier.className}"`
    );
  }

  const tableDoc = domino.createDocument(
    `<div id="content"><table class="md-table-fit"><thead><tr><th>A</th></tr></thead>` +
      `<tbody><tr>${COMPLEX_CELL}</tr></tbody></table></div>`,
    true
  );
  const tableRoot = tableDoc.getElementById('content') as HTMLElement;
  const tableCarrier = tableRoot.querySelector('table') as HTMLElement;
  turndown.turndown(tableRoot);
  runner.check(
    'US-23.21 (clone-only safety): md-table-fit — serialize never mutates the live DOM',
    tableCarrier.classList.contains('md-table-fit'),
    `  classList after serialize = "${tableCarrier.className}"`
  );
}

/**
 * AC7 proper — "a test asserts the owning feature re-applies it [on render];
 * a class with no re-stamp path is reported back rather than registered
 * silently" — determined per class (2026-07-28 review):
 *
 *  - md-entity-ref: re-stamped by postProcessEntityRefs on every render pass.
 *    Already covered by test/roundtrip/entity-ref.ts (real render pipeline,
 *    asserts the class reappears on a fresh render) — not duplicated here.
 *  - md-code-wrapped: re-stamped by postProcessCodeHeaders on every render
 *    pass. Covered by test/roundtrip/code-header.ts (added alongside this
 *    story, same real-pipeline pattern as entity-ref.ts).
 *  - dd-hover-outline, dd-hover-outline-cell, dd-source-muted:
 *    REPORTED BACK — no render re-stamp path exists. Each is a one-shot,
 *    event-driven interaction state (mouse hover/drag)
 *    applied directly by its owning handler outside any render pass; nothing
 *    "re-applies" it on the next render because rendering never runs while
 *    the interaction is live. The clone-only safety tests above are what
 *    keeps registering these for strip from ever breaking their handlers:
 *    since strip runs on the clone, the live node the handler adds/removes
 *    the class on is never touched by a serialize pass.
 *  - md-table-fit: REPORTED BACK — same shape as the four above. Set by a
 *    user-triggered fit-mode toggle (table.ts, US-19.25), not by a render
 *    pass; nothing to re-stamp on render.
 *
 * US-23.22 additions, same determination:
 *
 *  - broken-ref: re-stamped by broken-ref.ts's post-render recompute pass
 *    (BROKEN_REF_RECOMPUTE_DEBOUNCE_MS), so it returns on its own after a
 *    render — the entity-ref/code-wrapped category, not the one-shot one.
 *  - entity-reveal-flash, dd-drop-target-cell: REPORTED BACK — one-shot,
 *    event-driven interaction states (a reveal-flash timeout, an external
 *    drag's hover highlight) applied outside any render pass, exactly like
 *    the dd-* states above. The clone-only safety cases are what keep
 *    registering them from breaking their handlers.
 */

runner.finish('style-preservation');
