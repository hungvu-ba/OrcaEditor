/**
 * Feature: Windows backslash-path links (UNC `\\server\share\x.md`, drive
 * `C:\dir\x.md`) — X-7 round-trip fix, two coupled root causes:
 *  A) markdown-it's default normalizeLink percent-encoded `\` → `%5C` at parse
 *     time; turndown re-emitted that encoded href verbatim, differing from the
 *     source .md byte-for-byte → the doc was marked dirty on mere open, with
 *     zero user edits. Fixed by disabling normalizeLink (render.ts).
 *  B) CommonMark's own backslash-escape rule collapses a hand-typed `\\server\...`
 *     (2 raw backslash chars) down to 1 backslash in the parsed href, so
 *     `isWindowsUncPath` (which used to require exactly 2) never classified a
 *     naturally-authored UNC link as UNC. Fixed by accepting 1 OR 2 leading
 *     backslashes (link-scheme.ts) + a turndown rule that re-escapes backslash
 *     RUNS with the minimal reproducing form (2k-1 raw chars for a run of k),
 *     so a genuinely-doubled href stays stable across repeated opens instead of
 *     decaying further.
 *
 * Run standalone: npm run test:roundtrip:links
 */
import domino from '@mixmark-io/domino';
import { Runner, renderer, serializeHtml } from './_lib';
import { isWindowsUncPath } from '../../src/shared/link-scheme';

const runner = new Runner();

/** n actual backslash characters (avoids eye-counting escaped `\\` in source literals). */
const bs = (n: number): string => '\\'.repeat(n);

/** First <a href> in a rendered-HTML fragment. */
function firstHref(html: string): string | null {
  const doc = domino.createDocument(`<div id="r">${html}</div>`, true);
  return doc.querySelector('a')?.getAttribute('href') ?? null;
}

// ---------------------------------------------------------------------------
// 1. Drive path, single backslash separators (the common, natural-typing case)
//    — byte-identical to source on the FIRST open (no false-dirty).
// ---------------------------------------------------------------------------
{
  const md = `[a](C:${bs(1)}dir${bs(1)}x.md)\n`;
  const before = serializeHtml(renderer.render(md).html);
  runner.check('drive path: byte-identical on first open', before === md, `\n  md    = ${JSON.stringify(md)}\n  before= ${JSON.stringify(before)}`);
}

// ---------------------------------------------------------------------------
// 2. UNC written in its canonical minimal-escaping form (3 raw backslash chars
//    for the doubled network prefix, per the 2k-1 formula) — byte-identical on
//    the first open AND stable on the second (idempotent).
// ---------------------------------------------------------------------------
{
  const md = `[a](${bs(3)}server${bs(1)}share${bs(1)}x.md)\n`;
  const html1 = renderer.render(md).html;
  const href1 = firstHref(html1);
  runner.check('unc canonical: parsed href has 2 leading backslashes', href1 === `${bs(2)}server${bs(1)}share${bs(1)}x.md`, `href=${JSON.stringify(href1)}`);
  runner.check('unc canonical: isWindowsUncPath(href) true', !!href1 && isWindowsUncPath(href1));
  const md2 = serializeHtml(html1);
  runner.check('unc canonical: byte-identical on first open', md2 === md, `\n  md = ${JSON.stringify(md)}\n  md2= ${JSON.stringify(md2)}`);
  const md3 = serializeHtml(renderer.render(md2).html);
  runner.check('unc canonical: stable on 2nd pass', md3 === md2, `\n  md2= ${JSON.stringify(md2)}\n  md3= ${JSON.stringify(md3)}`);
}

// ---------------------------------------------------------------------------
// 3. UNC written the way a real user naturally types it — 2 raw backslash
//    chars for the network prefix (not the canonical 3). CommonMark's escape
//    rule collapses this to a single leading backslash in the href: the FIRST
//    open canonicalizes (expected, matches style-preservation.ts's "canonical
//    file byte-identical" precedent for non-canonical input), but the doc must
//    (a) still classify as UNC, and (b) become stable from the 2nd open on.
// ---------------------------------------------------------------------------
{
  const md = `[a](${bs(2)}server${bs(1)}share${bs(1)}x.md)\n`;
  const html1 = renderer.render(md).html;
  const href1 = firstHref(html1);
  runner.check('unc natural: parsed href has 1 leading backslash (CommonMark collapse)', href1 === `${bs(1)}server${bs(1)}share${bs(1)}x.md`, `href=${JSON.stringify(href1)}`);
  runner.check('unc natural: isWindowsUncPath(href) still true (root cause B fix)', !!href1 && isWindowsUncPath(href1));
  const md2 = serializeHtml(html1);
  runner.check('unc natural: first open canonicalizes (md2 !== md is expected here)', md2 !== md, `md2=${JSON.stringify(md2)}`);
  const md3 = serializeHtml(renderer.render(md2).html);
  runner.check('unc natural: stable from 2nd open onward', md3 === md2, `\n  md2= ${JSON.stringify(md2)}\n  md3= ${JSON.stringify(md3)}`);
}

// ---------------------------------------------------------------------------
// 4. Plain relative link (no backslash) — untouched regression guard: the new
//    turndown rule must not fire, default inlineLink rule still handles it.
// ---------------------------------------------------------------------------
{
  const md = '[a](./rel/x.md)\n';
  const before = serializeHtml(renderer.render(md).html);
  runner.check('plain relative link: unaffected', before === md, `before=${JSON.stringify(before)}`);
}

// ---------------------------------------------------------------------------
// 5. Unicode filename link — normalizeLink no longer forces percent-encoding,
//    so it now stays byte-identical too (previously `tệp.md` → `t%E1%BB%87p.md`).
// ---------------------------------------------------------------------------
{
  const md = '[a](tệp.md)\n';
  const before = serializeHtml(renderer.render(md).html);
  runner.check('unicode filename link: byte-identical on first open', before === md, `before=${JSON.stringify(before)}`);
}

// ---------------------------------------------------------------------------
// 6. Backslash run touching the END of the href (folder ref, no filename) —
//    edge-case-hunter finding: the minimal 2k-1 escaping is always odd, so an
//    unpadded trailing run would leave a lone `\` immediately before the
//    closing `)`, which CommonMark reads as an escaped paren and breaks the
//    link on re-parse. Must stay stable across 2 open/serialize cycles.
// ---------------------------------------------------------------------------
{
  // 2 raw backslashes right before the closing `)` is required to reach this
  // DOM state via valid source: a lone trailing `\` in RAW source ALSO escapes
  // the `)` per CommonMark (same rule, applies before any of this fix's code
  // runs), so it can only be reached by writing the escaped-pair form.
  const md = `[a](C:${bs(1)}dir${bs(2)})\n`;
  const html1 = renderer.render(md).html;
  const href1 = firstHref(html1);
  runner.check('trailing backslash: parsed href ends in exactly 1 backslash', href1 === `C:${bs(1)}dir${bs(1)}`, `href=${JSON.stringify(href1)}`);
  const md2 = serializeHtml(html1);
  const html2 = renderer.render(md2).html;
  runner.check('trailing backslash: link still parses as a real <a> after re-serialize', firstHref(html2) === href1, `md2=${JSON.stringify(md2)} href2=${JSON.stringify(firstHref(html2))}`);
  const md3 = serializeHtml(html2);
  runner.check('trailing backslash: stable from 2nd open onward', md3 === md2, `\n  md2= ${JSON.stringify(md2)}\n  md3= ${JSON.stringify(md3)}`);
}

// ---------------------------------------------------------------------------
// 7. <img src> with a hand-typed backslash path — same escaping as <a href>
//    (edge-case-hunter finding: normalizeLink disable is global, so images
//    need the same round-trip fix or they'd silently decay worse than before).
// ---------------------------------------------------------------------------
{
  const md = `![alt](C:${bs(1)}dir${bs(1)}pic.png)\n`;
  const before = serializeHtml(renderer.render(md).html);
  runner.check('img backslash: byte-identical on first open', before === md, `before=${JSON.stringify(before)}`);
}
{
  const md = `![alt](${bs(3)}server${bs(1)}share${bs(1)}pic.png)\n`;
  const before = serializeHtml(renderer.render(md).html);
  runner.check('img UNC backslash (canonical form): byte-identical on first open', before === md, `before=${JSON.stringify(before)}`);
}

runner.finish('links');
