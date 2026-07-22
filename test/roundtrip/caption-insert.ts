/**
 * Feature: Req 21 US-21.1 — Declare-entity's `caption::NS_ID` solid-pill badge
 * (postProcessCaptions, dom-postprocess.ts). Mirrors autolink-path.ts's pattern:
 * `_lib`'s serializeHtml/checkRoundtrip do NOT run this transform (only math/
 * mermaid), so apply it BY HAND here (the DOM-outcome pattern) and assert:
 *   (a) badge structure (span.md-caption, plain text content verbatim),
 *   (b) serialize(with badge) === serialize(without) → the .md is unchanged
 *       whether or not the transform ran (turndown's default rule for a plain
 *       <span> — no dedicated rule needed),
 *   (c) stability across a 2nd render→transform→serialize pass,
 *   (d) malformed tokens (no namespace letters / empty id half) are left as
 *       plain text (mirrors entity-index.ts's parseEntities validity rule),
 *   (e) idempotent re-run (instant-feedback call right after a live insert
 *       must never double-wrap).
 *
 * Run standalone: npm run test:roundtrip:caption-insert
 */
import { Runner, serializeHtml, renderer, domino } from './_lib';
import { postProcessCaptions } from '../../media/webview/pipeline';

const runner = new Runner();

/** Apply the transform to the given innerHTML (a rendered-DOM snapshot) → innerHTML after transform. */
function transform(innerHtml: string): string {
  const doc = domino.createDocument(`<div id="content">${innerHtml}</div>`, true);
  const root = doc.getElementById('content');
  if (!root) {
    throw new Error('could not build DOM');
  }
  postProcessCaptions(root, doc);
  return root.innerHTML;
}

/** render markdown → HTML → apply transform → innerHTML. */
function renderAndTransform(md: string): string {
  return transform(renderer.render(md).html);
}

/** Inspect the <span class="md-caption"> badges produced from innerHTML. */
function inspectBadges(innerHtml: string): Array<{ text: string }> {
  const doc = domino.createDocument(`<div id="r">${innerHtml}</div>`, true);
  return Array.from(doc.querySelectorAll('span.md-caption')).map((el) => ({ text: el.textContent ?? '' }));
}

/** Inspect the split-display structure of the first badge (bug_General Mention Declare #5). */
function inspectBadgeParts(
  innerHtml: string
): { editable: string | null; prefix: string | undefined; ns: string | undefined; id: string | undefined } | null {
  const doc = domino.createDocument(`<div id="r">${innerHtml}</div>`, true);
  const badge = doc.querySelector('span.md-caption');
  if (!badge) {
    return null;
  }
  return {
    editable: badge.getAttribute('contenteditable'),
    prefix: badge.querySelector('.md-caption-prefix')?.textContent ?? undefined,
    ns: badge.querySelector('.md-caption-ns')?.textContent ?? undefined,
    id: badge.querySelector('.md-caption-id')?.textContent ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// 1. Happy path — a valid declaration inline in a paragraph.
// ---------------------------------------------------------------------------
{
  const md = 'See caption::UC01 for details.';
  const before = serializeHtml(renderer.render(md).html);
  const after = renderAndTransform(md);
  const badges = inspectBadges(after);
  runner.check('happy: exactly one badge', badges.length === 1, `count=${badges.length}`);
  runner.check('happy: badge text is the literal token', badges[0]?.text === 'caption::UC01', JSON.stringify(badges));
  runner.check(
    'happy: serialize(with badge) === serialize(without)',
    serializeHtml(after) === before,
    `\n  with:    ${JSON.stringify(serializeHtml(after))}\n  without: ${JSON.stringify(before)}`
  );
  const md2 = serializeHtml(after);
  runner.check('happy: stable on 2nd pass', serializeHtml(renderAndTransform(md2)) === before);
}

// ---------------------------------------------------------------------------
// 2. Multiple declarations in one paragraph, interleaved with text.
// ---------------------------------------------------------------------------
{
  const after = transform('<p>first caption::UC01 then caption::TCa02 end</p>');
  const badges = inspectBadges(after);
  runner.check(
    'multi: two badges in order',
    badges.length === 2 && badges[0]?.text === 'caption::UC01' && badges[1]?.text === 'caption::TCa02',
    JSON.stringify(badges)
  );
  runner.check(
    'multi: serialize round-trips',
    serializeHtml(after) === serializeHtml('<p>first caption::UC01 then caption::TCa02 end</p>')
  );
}

// ---------------------------------------------------------------------------
// 3. Namespace with a Unicode-letter run (mirrors entity-index.ts's \p{L}+ rule).
// ---------------------------------------------------------------------------
{
  const md = 'caption::Đặc01';
  const badges = inspectBadges(renderAndTransform(md));
  runner.check('unicode-ns: badge created', badges.length === 1 && badges[0]?.text === 'caption::Đặc01', JSON.stringify(badges));
}

// ---------------------------------------------------------------------------
// 4. Malformed tokens — left as plain text, not wrapped (mirrors
//    entity-index.ts parseEntities: no namespace letters, or empty id half).
// ---------------------------------------------------------------------------
for (const md of ['caption::123 no letters', 'caption::UC no id half here', 'plain text, no token']) {
  const badges = inspectBadges(renderAndTransform(md));
  runner.check(`malformed: no badge for ${JSON.stringify(md)}`, badges.length === 0, JSON.stringify(badges));
}

// ---------------------------------------------------------------------------
// 5. Never inside fenced code / inline code — mirrors entity-index.ts's
//    fenced-code-aware scan and dom-postprocess.ts's existing code/pre guard.
// ---------------------------------------------------------------------------
{
  const after = transform('<pre><code>caption::UC01</code></pre>');
  runner.check('fenced: no badge inside <pre><code>', inspectBadges(after).length === 0, after);
}
{
  const after = transform('<p><code>caption::UC01</code></p>');
  runner.check('inline-code: no badge inside <code>', inspectBadges(after).length === 0, after);
}

// ---------------------------------------------------------------------------
// 6. Idempotent — calling the transform a 2nd time on already-processed DOM
//    must never double-wrap (instant-feedback call right after a live insert).
// ---------------------------------------------------------------------------
{
  const once = transform('<p>caption::UC01</p>');
  const doc = domino.createDocument(`<div id="content">${once}</div>`, true);
  const root = doc.getElementById('content');
  if (!root) {
    throw new Error('could not build DOM');
  }
  postProcessCaptions(root, doc); // 2nd run, in place
  const badges = Array.from(root.querySelectorAll('span.md-caption'));
  runner.check('idempotent: still exactly one badge after a 2nd pass', badges.length === 1, root.innerHTML);
  runner.check('idempotent: badge text unchanged', badges[0]?.textContent === 'caption::UC01', root.innerHTML);
}

// ---------------------------------------------------------------------------
// 7. bug_General Mention Declare #5: split display — the badge hides the
//    internal `caption::` prefix and shows `NS value` as separate spans, while
//    keeping textContent === the literal token (so serialize stays byte-
//    identical, covered by section 1). Also a non-editable atom (#6/#7).
// ---------------------------------------------------------------------------
{
  const parts = inspectBadgeParts(renderAndTransform('caption::UC01'));
  runner.check('split: badge is contenteditable=false', parts?.editable === 'false', JSON.stringify(parts));
  runner.check('split: prefix span holds the hidden "caption::"', parts?.prefix === 'caption::', JSON.stringify(parts));
  runner.check('split: namespace span = leading-letter run', parts?.ns === 'UC', JSON.stringify(parts));
  runner.check('split: id span = the value remainder', parts?.id === '01', JSON.stringify(parts));
  runner.check(
    'split: concatenated textContent is still the literal token',
    (parts?.prefix ?? '') + (parts?.ns ?? '') + (parts?.id ?? '') === 'caption::UC01',
    JSON.stringify(parts)
  );
}

runner.finish('caption-insert');
