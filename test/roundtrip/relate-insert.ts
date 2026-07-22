/**
 * Feature: Req 21 US-21.4 — `/relate` one-way relationship declaration commit
 * (toolbar.ts's runTriggerInsertRelateLink). No new postprocess transform is
 * involved here — this is the DOM-outcome pattern (Plan/ROUNDTRIP_TEST.md):
 * hand-build the exact `<p>` structure runTriggerInsertRelateLink's
 * `insertHTML` call produces (a literal "Refers to: " prefix + a real `<a>`
 * link, read verbatim from toolbar.ts's own execCommand string) and assert
 * the round-tripped markdown is a real one-way link — never a bare id, never
 * a References-section entry, never a reverse line.
 *
 * Run standalone: npm run test:roundtrip:relate-insert
 */
import { Runner, renderer, serializeHtml } from './_lib';

const runner = new Runner();

// ---------------------------------------------------------------------------
// 1. Happy path — cross-file relate target.
// ---------------------------------------------------------------------------
{
  const html = '<p>Refers to: <a href="relative/path.md#BR01">BR01</a></p>';
  const md = serializeHtml(html);
  runner.check('happy: real markdown link, one-way', md.trim() === 'Refers to: [BR01](relative/path.md#BR01)', md);
  // 2nd-pass stability is a full render round trip (md → HTML → md), NOT
  // serializeHtml(md): serializeHtml expects HTML, so feeding the markdown
  // string back through it re-escapes the link syntax as literal text
  // (`\[BR01\]`) and never round-trips — the render step is what turns the
  // link markdown back into an `<a>` for the serializer to see.
  runner.check('happy: stable on 2nd pass', serializeHtml(renderer.render(md).html) === md, md);
}

// ---------------------------------------------------------------------------
// 2. Same-file relate target (relativeLinkPath's own fallback to the file's
//    basename when there's nothing to relativize against — trigger-at.ts's
//    Entities scope already relies on this same fallback; not a new decision
//    here, entityHref's formula is copied verbatim).
// ---------------------------------------------------------------------------
{
  const html = '<p>Refers to: <a href="notes.md#UC01">UC01</a></p>';
  const md = serializeHtml(html);
  runner.check('same-file: link preserved verbatim', md.trim() === 'Refers to: [UC01](notes.md#UC01)', md);
}

// ---------------------------------------------------------------------------
// 3. Inline mid-paragraph (`/relate` is not restricted to an empty paragraph):
//    surrounding text is untouched, exactly one one-way link, no reverse/
//    duplicate line ever added to this file.
// ---------------------------------------------------------------------------
{
  const html = '<p>See background. Refers to: <a href="other.md#TC02">TC02</a> for detail.</p>';
  const md = serializeHtml(html);
  runner.check(
    'inline: surrounding text preserved, exactly one link',
    md.trim() === 'See background. Refers to: [TC02](other.md#TC02) for detail.',
    md
  );
  const matches = md.match(/\[TC02\]/g) ?? [];
  runner.check('inline: no reverse/duplicate line', matches.length === 1, md);
}

runner.finish('relate-insert');
