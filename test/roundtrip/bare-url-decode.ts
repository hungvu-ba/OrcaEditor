/**
 * X-19: encodeLinkPath (dom-utils.ts) encodes each path segment with
 * encodeURIComponent, so `&`/`#`/`=`/`+` in a file name become `%26`/`%23`/…
 * The turndown `bareUrl` rule (turndown.ts) keeps an <a> whose text equals the
 * DECODED href as a bare link instead of `[text](href)`. It decoded with
 * decodeURI, which by spec leaves `; / ? : @ & = + $ , #` encoded — so a bare
 * link to `Tài liệu R&D.md` never matched its own text and was serialized as
 * `[Tài liệu R&D.md](Tài%20liệu%20R%26D.md)`. The fix decodes segment-wise with
 * decodeURIComponent (symmetric with the encode).
 *
 * DOM-outcome test: build the <a> the encoder+markdown-it produce and assert the
 * serialized .md keeps it bare (no `](`), plus a malformed-`%` safety case.
 *
 * Run standalone: npm run test:roundtrip:bare-url-decode
 */
import { Runner, serializeHtml } from './_lib';

const runner = new Runner();

/** Build a paragraph with one anchor: encoded href + human-readable text. */
function anchor(href: string, text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p><a href="${href}">${escaped}</a></p>`;
}

// ---------------------------------------------------------------------------
// 1. `&` in the name — the audit's example. Decoded href === text → stays bare.
// ---------------------------------------------------------------------------
{
  const out = serializeHtml(anchor('T%C3%A0i%20li%E1%BB%87u%20R%26D.md', 'Tài liệu R&D.md'));
  runner.check('and: not serialized as a []() link', !out.includes(']('), JSON.stringify(out));
  runner.check('and: bare text with decoded &', out.includes('Tài liệu R&D.md'), JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 2. `#` in the name — decodeURI would leave %23 encoded; decodeURIComponent
//    decodes it so the anchor matches its text and stays bare.
// ---------------------------------------------------------------------------
{
  const out = serializeHtml(anchor('a%23b.md', 'a#b.md'));
  runner.check('hash: not a []() link', !out.includes(']('), JSON.stringify(out));
  runner.check('hash: bare text with decoded #', out.includes('a#b.md'), JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 3. `=` and `+` in the name — same class (decodeURI leaves both encoded).
// ---------------------------------------------------------------------------
{
  const out = serializeHtml(anchor('a%3Db%2Bc.md', 'a=b+c.md'));
  runner.check('eq-plus: stays bare', !out.includes('](') && out.includes('a=b+c.md'), JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 4. Already-plain href (no encoding) — unchanged, still bare (regression guard).
// ---------------------------------------------------------------------------
{
  const out = serializeHtml(anchor('plain.md', 'plain.md'));
  runner.check('plain: bare, no link syntax', !out.includes('](') && out.includes('plain.md'), JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 5. Malformed `%` in href, text differs — decodeURIComponent throws → the
//    try/catch falls back to the raw string (no exception), and since raw href
//    !== text it serializes as a normal link. The point: serializeHtml never
//    throws on a lone/invalid `%`.
// ---------------------------------------------------------------------------
{
  let out = '';
  let threw = false;
  try {
    out = serializeHtml(anchor('x%2Gy.md', 'different label'));
  } catch {
    threw = true;
  }
  runner.check('malformed-%: no throw', !threw, `threw=${threw}`);
  runner.check('malformed-%: falls through to a normal link', out.includes('](x%2Gy.md)'), JSON.stringify(out));
}

runner.finish('bare-url-decode');
