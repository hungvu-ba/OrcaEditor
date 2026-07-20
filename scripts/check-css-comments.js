#!/usr/bin/env node

/**
 * Guard against the "star-slash inside comment prose" trap.
 *
 * CSS comments do NOT nest: the first star-slash closes a slash-star comment. So
 * a literal star-slash written inside comment text (e.g. a class list like
 * "selector-star/link") closes the comment early — the trailing prose plus a
 * spurious star-slash become garbage tokens, and the CSS parser's error-recovery
 * silently DROPS the rule that follows (see the media/markdown.css Reading Mode
 * width bug, 2026-07-20).
 *
 * Detection: strip comments with first-close semantics (the same rule the CSS
 * parser uses), then any star-slash left in the remainder is an orphan close = a
 * comment that ended earlier than the author intended. Report it and exit 1.
 */

const fs = require('fs');
const path = require('path');

const FILES = ['media/markdown.css', 'media/editor.css'];

/** 1-based line number of a character offset in `text`. */
function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

let problems = [];

for (const rel of FILES) {
  const abs = path.join(__dirname, '..', rel);
  const css = fs.readFileSync(abs, 'utf-8');

  // Replace each comment with equal-length blanks (keep offsets/newlines) so the
  // remaining offsets still map to real line numbers. First `*/` closes.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  // Any `*/` still present in the stripped text is an orphan close: it lived
  // inside what the author meant to be one comment.
  const orphan = /\*\//g;
  let m;
  while ((m = orphan.exec(stripped)) !== null) {
    const ln = lineOf(css, m.index);
    problems.push(`${rel}:${ln}  orphan "*/" — a comment closed early (star-slash inside comment prose). Space it as "* /".`);
  }

  // An unclosed comment (leftover `/*`) is the same class of defect.
  const unclosed = /\/\*/g;
  while ((m = unclosed.exec(stripped)) !== null) {
    const ln = lineOf(css, m.index);
    problems.push(`${rel}:${ln}  unclosed "/*" — comment never terminated.`);
  }
}

if (problems.length) {
  console.error('CSS comment check FAILED:\n' + problems.map((p) => '  ' + p).join('\n'));
  process.exit(1);
}
console.log('CSS comment check passed: no orphan/unclosed comment delimiters.');
