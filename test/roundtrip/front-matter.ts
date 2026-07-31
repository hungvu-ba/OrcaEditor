/**
 * Feature: front-matter serialization (HLR mục 2 US-2.7/US-2.9/US-2.10 + Sync &
 * Save HLR mục 12) — the cases `test/fixtures/*.md` cannot express.
 *
 * Two of them are invisible to the fixture-driven `rendering.ts` runner:
 *
 *  - CRLF input. `.gitattributes` carries `* text=auto`, so a CRLF fixture file
 *    would be normalized to LF on commit and the case would silently stop
 *    testing anything. The EOL has to come from a string literal in code.
 *  - Byte identity of the SOURCE. `checkRoundtrip` only asserts html1≡html2 and
 *    a stable serializer; it never compares md2 back to md, so a block that
 *    gains a line on every save passes it.
 *
 * Run standalone: npm run test:roundtrip:front-matter
 */
import { Runner, serializeHtml, renderer } from './_lib';

const runner = new Runner();

/** One render → serialize cycle, exactly what a save writes back to the file. */
function save(md: string): string {
  return serializeHtml(renderer.render(md).html);
}

// US-2.10: the `+++` pre-scan runs BEFORE markdown-it, so unlike the `---`
// path it never benefits from markdown-it's own CR normalization. Left
// unstripped, the captured text ends in a bare CR that `escapeAttr` does not
// encode and the HTML parser folds to a newline on read — the block would grow
// a blank line before its closing fence on the very first save.
{
  const CRLF_TOML = '+++\r\ntitle = "T"\r\nweight = 3\r\n+++\r\n\r\n# Heading\r\n';
  const saved = save(CRLF_TOML);
  runner.eq('US-2.10: a CRLF TOML block saves back with no line the author did not write', saved, '+++\ntitle = "T"\nweight = 3\n+++\n\n# Heading\n');
  runner.check('US-2.10: a CRLF TOML block keeps no stray CR in its serialized form', !saved.includes('\r'), `  saved: ${JSON.stringify(saved)}`);
  // The host reconciles LF back to the document's own EOL (X-2), so an LF-only
  // serialization is correct — a doubled newline inside the block is not.
  const YAML_CRLF = '---\r\ntitle: T\r\n---\r\n\r\n# Heading\r\n';
  runner.eq('US-2.7 control: the shipped YAML path already behaves this way', save(YAML_CRLF), '---\ntitle: T\n---\n\n# Heading\n');
}

// An empty block has an empty `data-raw`, so the generic `fence + raw + fence`
// form emits three lines where the source had two.
{
  const EMPTY_TOML = '+++\n+++\n\n# Heading\n';
  const EMPTY_YAML = '---\n---\n\n# Heading\n';
  runner.eq('US-2.10: an empty `+++` block round-trips byte-identical', save(EMPTY_TOML), EMPTY_TOML);
  runner.eq('US-2.7: an empty `---` block round-trips byte-identical too (same guard)', save(EMPTY_YAML), EMPTY_YAML);
}

// The format decides the fence and nothing else: a TOML block must never come
// back under YAML's `---`, which would silently change the file's format.
{
  const TOML = '+++\ntitle = "T"\n\n[params]\ntheme = "orca"\n+++\n\n# Heading\n';
  const YAML = '---\ntitle: T\nstatus: draft\n---\n\n# Heading\n';
  runner.eq('US-2.10: a TOML block keeps its `+++` fences across a save', save(TOML), TOML);
  runner.eq('US-2.7: a YAML block still keeps its `---` fences', save(YAML), YAML);
  // Malformed TOML renders the invalid frame, whose wrapper must carry the
  // format too — otherwise the block would be re-fenced as YAML and the file
  // would be corrupted precisely when the user can least afford it.
  const BROKEN = '+++\na = 1\nkey = \n+++\n\n# Heading\n';
  runner.eq('US-2.10: a malformed TOML block is still saved with its own fences', save(BROKEN), BROKEN);
}

// US-2.11: JSON front matter carries no fence at all, and its `data-raw` spans
// the braces themselves — the one place where the shared `frontMatterSource`
// must NOT wrap the attribute in anything. A block re-emitted under `---`
// would corrupt the file on the very first save.
{
  const JSON_DOC = '{\n  "title": "T",\n  "weight": 3\n}\n\n# Heading\n';
  runner.eq('US-2.11: a JSON block round-trips byte-identical, with no fence added', save(JSON_DOC), JSON_DOC);
  runner.eq('US-2.11: an empty `{}` block round-trips byte-identical', save('{}\n\n# Heading\n'), '{}\n\n# Heading\n');
  // A `\` inside a string must not desync the brace scan, and the escaped
  // backslash must survive the `data-raw` round trip unchanged.
  const ESCAPED = '{\n  "path": "C:\\\\Users\\\\x",\n  "brace": "}"\n}\n\n# Heading\n';
  runner.eq('US-2.11: escaped backslashes and a braced string value survive the save', save(ESCAPED), ESCAPED);
  // The host reconciles LF back to the document's own EOL (X-2), so an LF-only
  // serialization is correct — a doubled newline inside the block is not.
  const CRLF_JSON = '{\r\n  "title": "T"\r\n}\r\n\r\n# Heading\r\n';
  const savedCrlf = save(CRLF_JSON);
  runner.eq('US-2.11: a CRLF JSON block saves back with no line the author did not write', savedCrlf, '{\n  "title": "T"\n}\n\n# Heading\n');
  runner.check('US-2.11: a CRLF JSON block keeps no stray CR in its serialized form', !savedCrlf.includes('\r'), `  saved: ${JSON.stringify(savedCrlf)}`);
  // A BOM cannot survive a fixture file reliably, so it is asserted here: the
  // block is recognized, and the BOM itself is not written back into the body.
  runner.eq('US-2.11: a BOM-prefixed JSON block is recognized and the BOM is not re-emitted', save(`\uFEFF${JSON_DOC}`), JSON_DOC);

  // Review finding (step-04, edge case hunter): a MIXED-EOL block. Stripping
  // only `\r\n` pairs leaves a lone CR in `data-raw`, which the HTML parser
  // folds to a newline on read \u2014 the block would grow a line on the first save
  // even though VS Code never counted that CR as a line separator.
  const MIXED_EOL = '{\r\n  "a": 1\r}\n\n# Heading\n';
  const savedMixed = save(MIXED_EOL);
  runner.eq('US-2.11: a lone CR inside the block does not grow it by a line', savedMixed, '{\n  "a": 1}\n\n# Heading\n');
  runner.check('US-2.11: ...and leaves no CR behind either', !savedMixed.includes('\r'), `  saved: ${JSON.stringify(savedMixed)}`);

  // Review finding (step-04, edge case hunter): trailing spaces after the
  // closing brace are tolerated by detection but sit OUTSIDE `data-raw`, so
  // the first save drops them. Recorded, not fixed: every fenced format
  // already drops trailing whitespace on its delimiter line the same way.
  runner.eq('US-2.11: trailing whitespace after the closing brace is dropped on save', save('{"a":1}  \t\n\n# Heading\n'), '{"a":1}\n\n# Heading\n');

  // Every rejection path must leave the document exactly as it renders today.
  const NOT_JSON = '{ not valid json }\n\n# Heading\n';
  const NO_BLANK = '{\n  "a": 1\n}\n# Heading\n';
  runner.eq('US-2.11: a `{`-leading paragraph that is not valid JSON is unchanged', save(NOT_JSON), NOT_JSON);
  runner.check('US-2.11: ...and produces no front-matter block at all', !renderer.render(NOT_JSON).html.includes('md-front-matter'), '  a card was built');
  runner.check('US-2.11: a block with no blank line before the body is not front matter', !renderer.render(NO_BLANK).html.includes('md-front-matter'), '  a card was built');

  // ...but that shape CONVERGES to front matter after one save, and this is
  // recorded rather than worked around. Turndown normalizes any paragraph
  // followed by a block into `paragraph\n\nblock` — pre-existing behaviour
  // every paragraph in the codebase already gets, nothing to do with JSON —
  // and the normalized form satisfies AC4's blank-line rule. Suppressing it
  // would mean writing escape bytes the author never typed. There is therefore
  // no render-stable fixture for this branch, which is why it lives here and
  // not in test/fixtures/.
  // Reflowed onto one line, because it serialized as an ordinary paragraph —
  // the soft line breaks inside it were never structural.
  const CONVERGED = '{ "a": 1 }\n\n# Heading\n';
  runner.eq('US-2.11: a no-blank-line block gains the separator turndown gives every paragraph', save(NO_BLANK), CONVERGED);
  runner.check('US-2.11: ...so the SECOND render does see front matter', renderer.render(CONVERGED).html.includes('md-front-matter'), '  no card was built');
  runner.eq('US-2.11: ...and the file is byte-stable from then on, never churning', save(CONVERGED), CONVERGED);
}

runner.finish('front-matter');
