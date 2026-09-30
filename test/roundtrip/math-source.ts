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
import { Runner, serializeHtml, renderer } from './_lib';

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

runner.finish('math-source');
