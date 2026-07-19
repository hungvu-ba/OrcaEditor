/**
 * Feature: auto-link bare relative file paths — display-only (bug_General #5).
 * postProcessRelativePathLinks (dom-postprocess.ts) wraps each bare relative file
 * path written as plain text into an <a> that DISPLAYS the file name (with
 * extension); the original path string is kept in data-autolink-path so turndown
 * serializes it back — run through td.escape(), the same escaping the plain-text
 * serializer uses — so the .md is byte-identical whether or not the feature ran.
 *
 * _lib's serializeHtml/checkRoundtrip do NOT run this transform (only math/
 * mermaid), so here we apply it BY HAND (the DOM-outcome pattern: rebuild the DOM
 * the render step actually produces) and assert:
 *   (a) anchor structure + display text,
 *   (b) serialize(after-transform) === serialize(before-transform) → .md unchanged,
 *       including paths with turndown-escapable chars (_ [ ] *) — the core invariant,
 *   (c) stability across a 2nd render→transform→serialize pass,
 * plus negatives (code span, absolute URL), a security case (" / < never break out),
 * and a ReDoS-timing guard.
 *
 * Run standalone: npm run test:roundtrip:autolink-path
 */
import { Runner, serializeHtml, renderer, domino } from './_lib';
import { postProcessRelativePathLinks } from '../../media/webview/pipeline';

const runner = new Runner();

/** Apply the transform to the given innerHTML (a rendered-DOM snapshot) → innerHTML after transform. */
function transform(innerHtml: string): string {
  const doc = domino.createDocument(`<div id="content">${innerHtml}</div>`, true);
  const root = doc.getElementById('content');
  if (!root) {
    throw new Error('could not build DOM');
  }
  postProcessRelativePathLinks(root, doc);
  return root.innerHTML;
}

/** render markdown → HTML → apply transform → innerHTML. */
function renderAndTransform(md: string): string {
  return transform(renderer.render(md).html);
}

/** Inspect the <a data-autolink-path> anchors produced from innerHTML. */
function inspectAnchors(innerHtml: string): Array<{ raw: string | null; text: string }> {
  const doc = domino.createDocument(`<div id="r">${innerHtml}</div>`, true);
  return Array.from(doc.querySelectorAll('a[data-autolink-path]')).map((a) => ({
    raw: a.getAttribute('data-autolink-path'),
    text: a.textContent ?? '',
  }));
}

// ---------------------------------------------------------------------------
// 1. Happy path — .md path with spaces in the file name (the user's example).
// ---------------------------------------------------------------------------
{
  const md = 'See ../OrcaEditor-Requirements/Requirement - 20 Trigger-based Quick Actions.md for details';
  const before = serializeHtml(renderer.render(md).html);
  const after = renderAndTransform(md);
  const a = inspectAnchors(after);
  runner.check('happy: exactly one anchor', a.length === 1, `count=${a.length}`);
  runner.check(
    'happy: display text = file name with extension',
    a[0]?.text === 'Requirement - 20 Trigger-based Quick Actions.md',
    `text=${JSON.stringify(a[0]?.text)}`
  );
  runner.check(
    'happy: data-autolink-path = the original path verbatim',
    a[0]?.raw === '../OrcaEditor-Requirements/Requirement - 20 Trigger-based Quick Actions.md',
    `raw=${JSON.stringify(a[0]?.raw)}`
  );
  runner.check('happy: serialize(with) === serialize(without)', serializeHtml(after) === before,
    `\n  with:    ${JSON.stringify(serializeHtml(after))}\n  without: ${JSON.stringify(before)}`);
  const md2 = serializeHtml(after);
  runner.check('happy: stable on 2nd pass', serializeHtml(renderAndTransform(md2)) === before);
}

// ---------------------------------------------------------------------------
// 2. Non-.md file — any relative file path, not just .md.
// ---------------------------------------------------------------------------
{
  const md = '../img/pic.png';
  const after = renderAndTransform(md);
  const a = inspectAnchors(after);
  runner.check('png: anchor with text pic.png', a.length === 1 && a[0]?.text === 'pic.png', `text=${JSON.stringify(a[0]?.text)}`);
  runner.check('png: serialize round-trips to the bare path', serializeHtml(after) === serializeHtml(renderer.render(md).html));
}

// ---------------------------------------------------------------------------
// 3. Compound extension — must keep the whole extension (archive.tar.gz, not .tar).
// ---------------------------------------------------------------------------
{
  const md = 'grab ../dist/archive.tar.gz now';
  const a = inspectAnchors(renderAndTransform(md));
  runner.check('compound-ext: whole extension kept',
    a.length === 1 && a[0]?.raw === '../dist/archive.tar.gz' && a[0]?.text === 'archive.tar.gz',
    `raw=${JSON.stringify(a[0]?.raw)} text=${JSON.stringify(a[0]?.text)}`);
}

// ---------------------------------------------------------------------------
// 4. Escapable characters in the path (_ [ ] *) — the byte-identity invariant.
//    Emitting the raw path un-escaped would drop/mismatch turndown escapes and
//    change the .md; td.escape() in the rule keeps with === without.
// ---------------------------------------------------------------------------
for (const md of ['see ../docs/my_notes/read_me.md here', './a/b[1].md', '../a/b*x.md']) {
  const before = serializeHtml(renderer.render(md).html);
  const after = renderAndTransform(md);
  runner.check(`escape-neutral: serialize(with) === serialize(without) for ${JSON.stringify(md)}`,
    serializeHtml(after) === before,
    `\n  with:    ${JSON.stringify(serializeHtml(after))}\n  without: ${JSON.stringify(before)}`);
  runner.check(`escape-neutral: an anchor was actually created for ${JSON.stringify(md)}`, inspectAnchors(after).length === 1);
}

// ---------------------------------------------------------------------------
// 5. Multiple paths interleaved with text in one node — all linked, order kept.
// ---------------------------------------------------------------------------
{
  const after = transform('<p>first ../a/one.md then ../b/two.md end</p>');
  const a = inspectAnchors(after);
  runner.check('multi: two anchors in order',
    a.length === 2 && a[0]?.raw === '../a/one.md' && a[1]?.raw === '../b/two.md',
    JSON.stringify(a));
  runner.check('multi: serialize round-trips',
    serializeHtml(after) === serializeHtml('<p>first ../a/one.md then ../b/two.md end</p>'));
}

// ---------------------------------------------------------------------------
// 5b. Strict left boundary — only ./ or ../ prefixed paths; prose slash-idioms,
//     dates, ratios and unprefixed paths are NOT linkified (bug #5 review choice).
// ---------------------------------------------------------------------------
for (const md of ['use and/or logic.md here', 'on 12/25/2024.txt done', 'ratio 1/2.5 up', 'open a/foo.md now']) {
  runner.check(`strict-boundary: no anchor for ${JSON.stringify(md)}`, inspectAnchors(renderAndTransform(md)).length === 0);
}
{
  // A ./|../ path directly after an opening paren links without swallowing "(".
  const a = inspectAnchors(transform('<p>see (../foo/bar.md) here</p>'));
  runner.check('strict-boundary: "(../foo/bar.md)" → raw excludes the paren',
    a.length === 1 && a[0]?.raw === '../foo/bar.md', JSON.stringify(a));
}

/** Count <code data-autolink-path> and read the first one's stored path. */
function inspectCodeLinks(innerHtml: string): Array<{ raw: string | null; text: string }> {
  const doc = domino.createDocument(`<div id="r">${innerHtml}</div>`, true);
  return Array.from(doc.querySelectorAll('code[data-autolink-path]')).map((c) => ({
    raw: c.getAttribute('data-autolink-path'),
    text: c.textContent ?? '',
  }));
}

// ---------------------------------------------------------------------------
// 6. Inline code span that IS a whole path → marked clickable on the <code>
//    itself (no <a> injected); text + backticks preserved, .md unchanged.
// ---------------------------------------------------------------------------
{
  const md = 'see `../OrcaEditor-Requirements/Requirement - 20 Trigger-based Quick Actions.md` here';
  const before = serializeHtml(renderer.render(md).html);
  const after = renderAndTransform(md);
  const c = inspectCodeLinks(after);
  runner.check('code-path: no <a> injected', inspectAnchors(after).length === 0, after);
  runner.check('code-path: <code> stores the full path but displays the file name',
    c.length === 1 && c[0]?.raw === '../OrcaEditor-Requirements/Requirement - 20 Trigger-based Quick Actions.md'
      && c[0]?.text === 'Requirement - 20 Trigger-based Quick Actions.md',
    JSON.stringify(c));
  runner.check('code-path: serialize preserves the code span (backticks + full path)', serializeHtml(after) === before);
}

// ---------------------------------------------------------------------------
// 6b. Code span NOT a whole path (partial / unprefixed) → not marked.
// ---------------------------------------------------------------------------
{
  const partial = transform('<p><code>run ../a/b.md then stop</code></p>');
  runner.check('code-path: partial content not marked', inspectCodeLinks(partial).length === 0, partial);
  const unprefixed = transform('<p><code>a/b.md</code></p>');
  runner.check('code-path: unprefixed code path not marked', inspectCodeLinks(unprefixed).length === 0, unprefixed);
}

// ---------------------------------------------------------------------------
// 6c. Fenced code block (<pre><code>) is never marked.
// ---------------------------------------------------------------------------
{
  const fenced = transform('<pre><code>../a/b.md</code></pre>');
  runner.check('code-path: fenced code block excluded', inspectCodeLinks(fenced).length === 0, fenced);
}

// ---------------------------------------------------------------------------
// 7. Negative — absolute URL already linkified by markdown-it: not double-wrapped.
// ---------------------------------------------------------------------------
{
  const after = renderAndTransform('https://x.com/a.md');
  runner.check('absolute URL: no data-autolink-path added', inspectAnchors(after).length === 0, after);
}

// ---------------------------------------------------------------------------
// 8. Security — " / < in the text neither match nor break out of HTML.
// ---------------------------------------------------------------------------
{
  const after = transform('<p>../a"b/c.md and ../x&lt;y/z.md</p>');
  runner.check('security: text with "/< produces no anchor', inspectAnchors(after).length === 0, after);
  runner.check('security: no script/onerror emitted', !/onerror|<script/i.test(after), after);
}

// ---------------------------------------------------------------------------
// 9. Security/perf — "/"-heavy string with no extension returns fast (ReDoS-safe).
// ---------------------------------------------------------------------------
{
  const pathological = '<p>' + 'a/'.repeat(5000) + 'no_extension_here</p>';
  const start = Date.now();
  const after = transform(pathological);
  const ms = Date.now() - start;
  runner.check('redos: no anchor for an extension-less string', inspectAnchors(after).length === 0);
  runner.check('redos: completes < 500ms', ms < 500, `took ${ms}ms`);
}

runner.finish('autolink-path');
