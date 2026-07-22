/**
 * Feature: bug_General #15 — empty-text link `[](url)` display + round-trip
 * (postProcessEmptyLinks in dom-postprocess.ts + the `emptyLink` turndown rule).
 * markdown-it renders `[](url)` as an empty `<a>`, which shows as a blank bullet
 * in a list. Apply the transform BY HAND to a rendered-DOM snapshot (serializeHtml
 * only runs the math/mermaid transforms) and assert:
 *   (a) the empty anchor gets the decoded target file name as DISPLAY text,
 *   (b) serialize preserves the exact empty link `[](href)` (turndown's
 *       `emptyLink` rule drops the injected display text),
 *   (c) NOT touched: an anchor that already has text, or one wrapping an <img>,
 *   (d) idempotent / stable across a 2nd render→transform→serialize pass.
 *
 * Run standalone: npm run test:roundtrip:empty-link
 */
import { Runner, serializeHtml, renderer, domino } from './_lib';
import { postProcessEmptyLinks } from '../../media/webview/pipeline';

const runner = new Runner();

/** Apply the transform to the given innerHTML (a rendered-DOM snapshot) → innerHTML after transform. */
function transform(innerHtml: string): string {
  const doc = domino.createDocument(`<div id="content">${innerHtml}</div>`, true);
  const root = doc.getElementById('content');
  if (!root) {
    throw new Error('could not build DOM');
  }
  postProcessEmptyLinks(root);
  return root.innerHTML;
}

/** render markdown → HTML → apply transform → innerHTML. */
function renderAndTransform(md: string): string {
  return transform(renderer.render(md).html);
}

/** Inspect the anchors produced from innerHTML. */
function inspectAnchors(innerHtml: string): Array<{ href: string; text: string }> {
  const doc = domino.createDocument(`<div id="r">${innerHtml}</div>`, true);
  return Array.from(doc.querySelectorAll('a')).map((el) => ({
    href: el.getAttribute('href') ?? '',
    text: el.textContent ?? '',
  }));
}

// ---------------------------------------------------------------------------
// 1. The bug's own case — empty link in a bullet, encoded file name.
// ---------------------------------------------------------------------------
{
  const md = '-   [](bug_Drag%20%26%20Drop.md)';
  const link = '[](bug_Drag%20%26%20Drop.md)';
  const after = renderAndTransform(md);
  const anchors = inspectAnchors(after);
  runner.check(
    'bullet: decoded file name shown as display text',
    anchors.length === 1 && anchors[0]?.text === 'bug_Drag & Drop.md',
    JSON.stringify(anchors)
  );
  runner.check(
    'bullet: serialize preserves the exact empty link (display text dropped)',
    serializeHtml(after).includes(link),
    JSON.stringify(serializeHtml(after))
  );
  runner.check('bullet: stable on 2nd pass', serializeHtml(renderAndTransform(serializeHtml(after))).includes(link));
}

// ---------------------------------------------------------------------------
// 2. Empty link with a directory path — only the last segment is displayed.
// ---------------------------------------------------------------------------
{
  const md = '[](../docs/Some%20File.md)';
  const anchors = inspectAnchors(renderAndTransform(md));
  runner.check(
    'path: last segment decoded, dropped dir prefix',
    anchors.length === 1 && anchors[0]?.text === 'Some File.md',
    JSON.stringify(anchors)
  );
  runner.check(
    'path: serialize preserves the exact empty link',
    serializeHtml(renderAndTransform(md)).trim() === '[](../docs/Some%20File.md)',
    JSON.stringify(serializeHtml(renderAndTransform(md)))
  );
}

// ---------------------------------------------------------------------------
// 3. NOT touched — a link that already has visible text.
// ---------------------------------------------------------------------------
{
  const md = '[Drag & Drop](bug_Drag%20%26%20Drop.md)';
  const after = renderAndTransform(md);
  const anchors = inspectAnchors(after);
  runner.check('with-text: display text unchanged', anchors[0]?.text === 'Drag & Drop', JSON.stringify(anchors));
  runner.check('with-text: round-trips display-only', serializeHtml(after) === serializeHtml(renderer.render(md).html));
}

// ---------------------------------------------------------------------------
// 4. NOT touched — an image link (empty text, but an <img> child).
// ---------------------------------------------------------------------------
{
  const md = '[![alt](img.png)](target.md)';
  const after = renderAndTransform(md);
  runner.check('image-link: <img> child preserved', after.includes('<img'), after);
  runner.check('image-link: round-trips display-only', serializeHtml(after) === serializeHtml(renderer.render(md).html));
}

runner.finish('empty-link');
