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

runner.finish('front-matter');
