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
import { Runner, serializeHtml } from './_lib';

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

runner.finish('style-preservation');
