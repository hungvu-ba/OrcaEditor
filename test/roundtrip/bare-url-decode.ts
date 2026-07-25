/**
 * X-19: encodeLinkPath (dom-utils.ts) encodes each path segment with
 * encodeURIComponent, so `&`/`#`/`=`/`+` in a file name become `%26`/`%23`/…
 * The turndown `bareUrl` rule (turndown.ts) used to keep an <a> whose text
 * equals the DECODED href as a bare link instead of `[text](href)` for ANY
 * href, including relative workspace paths.
 *
 * That was over-broad: markdown-it linkify runs with `fuzzyLink:false`
 * (render.ts), so it never auto-links a bare RELATIVE path from raw text — an
 * `<a>` whose relative href equals its text can only be an intentional link
 * (typed `[x](x)` or an `@`-mention insert to a same-folder file), and must
 * always keep its `[]()` syntax. `bareUrl` now only collapses true absolute-
 * URL/`mailto:` autolinks (guarded by `hasUrlScheme`, the shared X-7 predicate
 * that also excludes Windows drive paths like `C:\…` from "URL scheme") —
 * cases #1-4 below flip from "stays bare" to "becomes a link" accordingly;
 * case #6 is the explicit regression guard that absolute-URL autolinks still
 * collapse as before, and cases #7-8 guard the drive-path exclusion.
 *
 * DOM-outcome test: build the <a> the encoder+markdown-it produce and assert the
 * serialized .md, plus a malformed-`%` safety case.
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
// 1. `&` in the name — the audit's example. Relative href → always a link now,
//    even though the decoded href equals the text.
// ---------------------------------------------------------------------------
{
  const out = serializeHtml(anchor('T%C3%A0i%20li%E1%BB%87u%20R%26D.md', 'Tài liệu R&D.md'));
  runner.check(
    'and: serialized as a []() link with the raw (encoded) href',
    out.includes('[Tài liệu R&D.md](T%C3%A0i%20li%E1%BB%87u%20R%26D.md)'),
    JSON.stringify(out)
  );
}

// ---------------------------------------------------------------------------
// 2. `#` in the name — decodeURI would leave %23 encoded; decodeURIComponent
//    decodes it so the anchor's decoded href matches its text — still a link.
// ---------------------------------------------------------------------------
{
  const out = serializeHtml(anchor('a%23b.md', 'a#b.md'));
  runner.check('hash: serialized as a []() link', out.includes('[a#b.md](a%23b.md)'), JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 3. `=` and `+` in the name — same class (decodeURI leaves both encoded).
// ---------------------------------------------------------------------------
{
  const out = serializeHtml(anchor('a%3Db%2Bc.md', 'a=b+c.md'));
  runner.check('eq-plus: serialized as a []() link', out.includes('[a=b+c.md](a%3Db%2Bc.md)'), JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 4. Already-plain href (no encoding), relative path — `@`-mention to a
//    same-folder file shapes exactly this (href === text, no scheme). Bug:
//    used to collapse to bare "plain.md", losing the link syntax entirely.
// ---------------------------------------------------------------------------
{
  const out = serializeHtml(anchor('plain.md', 'plain.md'));
  runner.check('plain: serialized as a []() link, not bare text', out.includes('[plain.md](plain.md)'), JSON.stringify(out));
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

// ---------------------------------------------------------------------------
// 6. Absolute-URL autolink (scheme-based) — regression guard: this is the ONE
//    shape linkify (fuzzyLink:false) actually produces from bare raw text, so
//    it must still collapse to bare text on serialize, unchanged by the
//    hasUrlScheme narrowing above.
// ---------------------------------------------------------------------------
{
  const out = serializeHtml(anchor('https://example.com', 'https://example.com'));
  runner.check('absolute url: not a []() link', !out.includes(']('), JSON.stringify(out));
  runner.check('absolute url: stays bare', out.includes('https://example.com'), JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 7. Windows drive-path link, raw backslashes — a hand-typed
//    `[C:\Users\x.md](C:\Users\x.md)` has href === text, but `X:\…` is a LOCAL
//    filesystem target, not a URL scheme (X-7, src/shared/link-scheme.ts). Must
//    stay a real link, not collapse to bare text like a real `c:` scheme would.
// ---------------------------------------------------------------------------
{
  // Text backslashes come out doubled: turndown's `escape()` escapes `\` in
  // display text (markdown-significant), href is emitted raw/unescaped.
  const out = serializeHtml(anchor('C:\\Users\\x.md', 'C:\\Users\\x.md'));
  runner.check(
    'drive-path raw: serialized as a []() link, not bare text',
    out.includes('[C:\\\\Users\\\\x.md](C:\\Users\\x.md)'),
    JSON.stringify(out)
  );
}

// ---------------------------------------------------------------------------
// 8. Windows drive-path link, percent-encoded backslashes — markdown-it's
//    normalizeLink encodes `\` to `%5C` in the href it renders, so this is the
//    shape that actually reaches turndown from a real authored drive-path link.
// ---------------------------------------------------------------------------
{
  const out = serializeHtml(anchor('C:%5CUsers%5Cx.md', 'C:\\Users\\x.md'));
  runner.check(
    'drive-path encoded: serialized as a []() link, not bare text',
    out.includes('[C:\\\\Users\\\\x.md](C:%5CUsers%5Cx.md)'),
    JSON.stringify(out)
  );
}

runner.finish('bare-url-decode');
