/**
 * Feature: a literal dollar sign keeps its source form through serialize
 * (Performance Low-End T4.7, audit L-9 "Found on the way").
 *
 * markdown-it renders `\$` as a text node holding a bare `$`, so the backslash
 * is gone from the DOM. The text escape in media/webview/turndown.ts
 * (`escapeMathDollars`) has to put it back wherever a bare `$` would be read as
 * a math delimiter by @vscode/markdown-it-katex on the next render — and leave
 * every other dollar bare, so a file with plain prices is not rewritten.
 *
 * Every case asserts BYTES (render → serialize === source), and that the
 * serialized text renders the same number of formulas as the source did.
 *
 * Run alone: node esbuild.js --test && node dist/test/roundtrip/math-source.js
 */
import { COMPLEX_CELL, Runner, serializeHtml, renderer } from './_lib';

const runner = new Runner();

/** What the editor writes for `md` when every block is serialized: render, then serialize. */
function reserialize(md: string): string {
  return serializeHtml(renderer.render(md).html);
}

/** Formulas in the rendered output of `md` (a display formula holds one `.katex` too). */
function formulaCount(md: string): number {
  return (renderer.render(md).html.match(/class="katex"/g) ?? []).length;
}

/** `source` comes back byte-identical and still renders `formulas` formulas. */
function keepsBytes(name: string, source: string, formulas: number): void {
  runner.eq(`${name}: source renders ${formulas} formula(s)`, formulaCount(source), formulas);
  const out = reserialize(source);
  runner.eq(`${name}: serialized === source`, out, source);
  runner.eq(`${name}: serialized renders ${formulas} formula(s)`, formulaCount(out), formulas);
  runner.roundtrip(`${name}: stable on a 2nd render->serialize pass`, source);
}

// ---------------------------------------------------------------------------
// Escaped dollars keep their backslash (the bug: they came back bare, and
// `$a$` was a formula after the next render).
// ---------------------------------------------------------------------------
keepsBytes('escaped pair', 'Pay \\$a\\$ now.\n', 0);
keepsBytes('escaped $$', 'a \\$\\$ b\n', 0);
keepsBytes('escaped $$ at a line start', '\\$\\$ is the shell PID\n', 0);
keepsBytes('escaped pair next to a real formula', 'Price \\$a\\$ vs $b$.\n', 1);
keepsBytes('escaped pair in a heading', '# Pay \\$a\\$\n', 0);
keepsBytes('escaped pair in a list item', '*   pay \\$a\\$ now\n', 0);
keepsBytes('escaped pair in a table cell', '| A | B |\n| --- | --- |\n| \\$a\\$ | x |\n', 0);
keepsBytes('escaped pair in link text', '[pay \\$a\\$](https://example.com)\n', 0);

// ---------------------------------------------------------------------------
// Bare dollars that were never math stay bare: no byte churn on real files.
// ---------------------------------------------------------------------------
keepsBytes('bare prices', 'Costs $5 and $6 today.\n', 0);
keepsBytes('single bare dollar', 'It costs $5.\n', 0);
keepsBytes('dollar after a word', 'Pay 5$ or 6$ here.\n', 0);
keepsBytes('bare prices in a table cell', '| A | B |\n| --- | --- |\n| $5 and $6 | x |\n', 0);

// ---------------------------------------------------------------------------
// Real math and code are not text runs: untouched.
// ---------------------------------------------------------------------------
keepsBytes('inline formula', 'Inline $x$ here.\n', 1);
keepsBytes('two formulas on one line', 'Both $a$ and $b$ on one line.\n', 2);
keepsBytes('block formula', 'Before\n\n$$\nE = mc^2\n$$\n\nAfter\n', 1);
keepsBytes('dollars in inline code', 'Run `echo $a$ and $$` now.\n', 0);
keepsBytes('dollars in a fence', '```sh\necho $a$ $$\n```\n', 0);

// ---------------------------------------------------------------------------
// The rule follows the math plugin, not the source: a source `\$` whose dollar
// could not open or close math comes back bare.
// ---------------------------------------------------------------------------
runner.eq('escaped dollar that cannot be math comes back bare', reserialize('Costs \\$5 today.\n'), 'Costs $5 today.\n');

// ---------------------------------------------------------------------------
// DOM-outcome cases: text typed in the editor is a text node with bare dollars.
// What is written must render 0 formulas and be stable.
// ---------------------------------------------------------------------------
{
  const typed: Array<[name: string, html: string, expected: string]> = [
    ['typed $a$', '<p>Pay $a$ now.</p>', 'Pay \\$a\\$ now.\n'],
    ['typed $$', '<p>a $$ b</p>', 'a \\$\\$ b\n'],
    ['typed $$$', '<p>a $$$ b</p>', 'a \\$\\$\\$ b\n'],
    ['typed prices', '<p>Costs $5 and $6 today.</p>', 'Costs $5 and $6 today.\n'],
    // `$a` opens, but its closer `$b` is followed by a word character: only `$b$` is math.
    ['opener without a valid closer', '<p>$a $b$</p>', '$a \\$b\\$\n'],
    // Escaping `$b$` would hand the first `$` the last one as its closer: all four are escaped.
    ['a pair freed by escaping another', '<p>$a $b$ c$</p>', '\\$a \\$b\\$ c\\$\n'],
    // A literal backslash before the dollar: `\\$` cannot open math in the plugin.
    ['literal backslash before a dollar', '<p>a \\$b$ c</p>', 'a \\\\$b$ c\n'],
    ['typed pair in a table cell', '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>$a$</td></tr></tbody></table>', '| A |\n| --- |\n| \\$a\\$ |\n'],  ];
  for (const [name, html, expected] of typed) {
    const md = serializeHtml(html);
    runner.eq(`${name}: serialized bytes`, md, expected);
    runner.eq(`${name}: renders 0 formulas`, formulaCount(md), 0);
    runner.eq(`${name}: stable on a 2nd render->serialize pass`, reserialize(md), md);
  }
}

// ---------------------------------------------------------------------------
// A math wrapper's data-tex is written raw: dollars and backslashes in the TeX
// never go through the text escape.
// ---------------------------------------------------------------------------
{
  const md = serializeHtml(
    '<p>a <span class="md-math-inline" data-tex="\\text{\\$5}">' +
      '<span class="md-math-render" contenteditable="false"><span class="katex">K</span></span></span> b</p>'
  );
  runner.eq('data-tex is written raw', md, 'a $\\text{\\$5}$ b\n');
}

// ---------------------------------------------------------------------------
// A formula KaTeX cannot parse (T4.8): the math plugin renders the error
// message as the element text and keeps the TeX in `title` only. What is
// written is the TeX, never the message.
// ---------------------------------------------------------------------------
keepsBytes('invalid inline', 'Bad $\\frac{$ tex.\n', 0);
keepsBytes('invalid $$ block', 'Before\n\n$$\n\\frac{\n$$\n\nAfter\n', 0);
keepsBytes('invalid inline in a list item', '*   bad $\\frac{$ here\n', 0);
keepsBytes('invalid inline in a table cell', '| A | B |\n| --- | --- |\n| $\\frac{$ | x |\n', 0);
keepsBytes('valid formula next to an invalid one', 'Good $x$ and bad $\\frac{$ here.\n', 1);
keepsBytes('invalid TeX holding a dollar', 'Bad $\\text{\\$5}\\frac{$ here.\n', 0);

// Raw-HTML table path (complexTableAsHtml): no turndown rule runs inside the
// table, so the error element must be restored to its source form there too.
{
  const cell = renderer.render('Bad $\\frac{$ tex.').html.trim();
  const md = serializeHtml(
    `<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>${cell}</td>${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check('invalid inline, raw-HTML table: fixture carries the error element', cell.includes('katex-error'), cell);
  runner.check('invalid inline, raw-HTML table: took the raw-HTML path', md.startsWith('<table'), md);
  runner.check('invalid inline, raw-HTML table: the cell holds the source', md.includes('Bad $\\frac{$ tex.'), md);
  runner.check('invalid inline, raw-HTML table: no error message or class leaks', !/ParseError|katex/.test(md), md);
  runner.eq('invalid inline, raw-HTML table: stable on a 2nd render->serialize pass', reserialize(md), md);
}

// Block form in a list item and in a pipe-table cell. There the editor already
// normalizes a VALID `$$` block, so the invalid one is held to the bytes the
// valid one gets, with only the TeX swapped.
for (const [name, withTex] of [
  ['invalid $$ block in a list item', (tex: string) => `*   item\n\n    $$\n    ${tex}\n    $$\n`],
  ['invalid $$ block in a table cell', (tex: string) => `| A | B |\n| --- | --- |\n| $$${tex}$$ | x |\n`],
] as const) {
  const source = withTex('\\frac{');
  const out = reserialize(source);
  runner.check(`${name}: fixture carries the error element`, renderer.render(source).html.includes('katex-block katex-error'));
  runner.eq(`${name}: same bytes as a valid block`, out, reserialize(withTex('\\alpha')).split('\\alpha').join('\\frac{'));
  runner.eq(`${name}: stable on a 2nd render->serialize pass`, reserialize(out), out);
}

// Block form, raw-HTML table path: `$$` delimiter, and the `<pre>` carrier for
// a multi-line formula holding a `%` comment.
for (const [name, tex, expected] of [
  ['invalid $$ block, raw-HTML table', '\\frac{', '$$\\frac{$$'],
  ['invalid $$ block with a % comment, raw-HTML table', '\\frac{ % c\nx', '<pre>$$\n\\frac{ % c\nx\n$$</pre>'],
] as const) {
  const cell = renderer.render(`$$\n${tex}\n$$`).html.trim();
  const md = serializeHtml(
    `<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>${cell}</td>${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(`${name}: fixture carries the error element`, cell.includes('katex-block katex-error'), cell);
  runner.check(`${name}: the cell holds the source`, md.includes(expected), md);
  runner.eq(`${name}: stable on a 2nd render->serialize pass`, reserialize(md), md);
}

// Only the plugin's two shapes are read from `title`: a `.katex-error` with no
// title, or KaTeX's own error span (title = message, text = TeX), keeps the
// default handling — never `$$` or the message.
{
  const noTitle = serializeHtml('<p>a <span class="katex-error">x</span> b</p>');
  runner.check('katex-error with no title: its text is kept, no math opener', noTitle.includes('x') && !noTitle.includes('$'), noTitle);
  const katexOwn = serializeHtml(
    '<p>a <span class="katex-error" title="ParseError: KaTeX parse error: boom" style="color:#cc0000">\\frac{</span> b</p>'
  );
  runner.check("KaTeX's own error span: its text is kept, not the message", katexOwn.includes('frac{') && !katexOwn.includes('ParseError'), katexOwn);
  const rawNoTitle = serializeHtml(
    `<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><span class="katex-error">kept</span></td>${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check('katex-error with no title, raw-HTML table: kept', rawNoTitle.startsWith('<table') && rawNoTitle.includes('>kept<'), rawNoTitle);
}

runner.finish('math-source');
