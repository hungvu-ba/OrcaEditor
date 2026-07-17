/**
 * Roundtrip — US-18.4a Preserve Original Format (hotfix), HEADING axis.
 *
 * Proves that editing one place in a file must NOT silently rewrite the original
 * syntax variant of the OTHER headings. Each heading serializes in exactly the
 * variant (ATX `# x` / Setext `x\n===`) — and the exact Setext underline length —
 * that its own `mdSlice` has, instead of being forced to the global style
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

runner.finish('style-preservation');
