/**
 * Feature: Bug #8 — smart gap on inline paste (main.ts applySmartGap).
 *
 * The *decision* of whether to insert a gap is DOM/Selection behavior and is
 * covered by the Playwright spec (test/webview/paste-smart-gap.spec.ts). This
 * roundtrip file guards only the serialization contract the gap depends on:
 * the gap is inserted into the live DOM as an NBSP ( ) — to dodge
 * Chromium's execCommand leading-space-collapse trap — and MUST serialize back
 * to a plain ASCII space in the saved `.md`, never `&nbsp;`/ . This is
 * `normalizeNbsp` (dom-serialize-prep.ts) doing its job; if that ever regresses
 * the pasted gap would leak an NBSP into the document.
 *
 * Run standalone: npm run test:roundtrip:paste-text
 */
import { Runner, serializeHtml } from './_lib';

const runner = new Runner();
const NBSP = String.fromCharCode(0x00a0);

// ---------------------------------------------------------------------------
// 1. Leading + trailing NBSP gap (simulated post-paste DOM: "foo" | "bar",
//    pasted "X" → "foo·X·bar" with NBSPs) serializes to plain ASCII spaces.
// ---------------------------------------------------------------------------
{
  const md = serializeHtml(`<p>foo${NBSP}X${NBSP}bar</p>`);
  runner.check('gap: serializes to plain spaces', md.includes('foo X bar'), JSON.stringify(md));
  runner.check('gap: no NBSP leaks into .md', !md.includes(NBSP), JSON.stringify(md));
  runner.check('gap: no literal &nbsp; entity', !md.includes('&nbsp;'), JSON.stringify(md));
}

// ---------------------------------------------------------------------------
// 2. Leading-only NBSP gap (paste before a following word) — "foo·X bar".
// ---------------------------------------------------------------------------
{
  const md = serializeHtml(`<p>foo${NBSP}X bar</p>`);
  runner.check('leading-only: plain space, no NBSP', md.includes('foo X bar') && !md.includes(NBSP), JSON.stringify(md));
}

// ---------------------------------------------------------------------------
// 3. NBSP gap next to a styled inline (paste next to bold) keeps the span
//    structure and still serializes the NBSP to a plain space.
// ---------------------------------------------------------------------------
{
  const md = serializeHtml(`<p><strong>foo</strong>${NBSP}bar</p>`);
  runner.check('inline-styled: space between bold and word', md.includes('**foo** bar') && !md.includes(NBSP), JSON.stringify(md));
}

runner.finish('paste-text');
