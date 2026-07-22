/**
 * Feature: Req 21 US-21.3 — entity REFERENCE muted-pill marking
 * (postProcessEntityRefs, dom-postprocess.ts). Mirrors caption-insert.ts's
 * pattern for its declaration-badge sibling: apply the transform BY HAND to a
 * rendered-DOM snapshot (`_lib`'s serializeHtml/checkRoundtrip only run the
 * math/mermaid transforms) and assert:
 *   (a) an entity reference `[FULLID](path#FULLID)` gets ENTITY_REF_CLASS,
 *   (b) serialize(with class) === serialize(without) → a class-only change
 *       never touches the .md (turndown ignores `<a>` class attributes),
 *   (c) stability across a 2nd render→transform→serialize pass,
 *   (d) NOT marked: display text != fragment, fragment not a valid entity
 *       token (mirrors entity-index.ts's namespace/id validity rule), a plain
 *       `http(s)` link, or a same-document heading anchor whose slug happens
 *       to look letters-only (id-half rule already excludes plain words),
 *   (e) idempotent re-run (instant-feedback call right after a live insert
 *       must never leave a stale class on a since-edited/no-longer-matching anchor).
 *
 * Run standalone: npm run test:roundtrip:entity-ref
 */
import { Runner, serializeHtml, renderer, domino } from './_lib';
import { postProcessEntityRefs } from '../../media/webview/pipeline';

const runner = new Runner();
const ENTITY_REF_SELECTOR = 'a.md-entity-ref';

/** Apply the transform to the given innerHTML (a rendered-DOM snapshot) → innerHTML after transform. */
function transform(innerHtml: string): string {
  const doc = domino.createDocument(`<div id="content">${innerHtml}</div>`, true);
  const root = doc.getElementById('content');
  if (!root) {
    throw new Error('could not build DOM');
  }
  postProcessEntityRefs(root);
  return root.innerHTML;
}

/** render markdown → HTML → apply transform → innerHTML. */
function renderAndTransform(md: string): string {
  return transform(renderer.render(md).html);
}

/** Inspect the `a.md-entity-ref` anchors produced from innerHTML. */
function inspectRefs(innerHtml: string): Array<{ href: string; text: string }> {
  const doc = domino.createDocument(`<div id="r">${innerHtml}</div>`, true);
  return Array.from(doc.querySelectorAll(ENTITY_REF_SELECTOR)).map((el) => ({
    href: el.getAttribute('href') ?? '',
    text: el.textContent ?? '',
  }));
}

// ---------------------------------------------------------------------------
// 1. Happy path — cross-file entity reference, US-21.3's own worked example.
// ---------------------------------------------------------------------------
{
  const md = 'See [BR01](relative/path.md#BR01) for the rule.';
  const before = serializeHtml(renderer.render(md).html);
  const after = renderAndTransform(md);
  const refs = inspectRefs(after);
  runner.check('happy: exactly one entity-ref anchor', refs.length === 1, JSON.stringify(refs));
  runner.check(
    'happy: href/text preserved verbatim',
    refs[0]?.href === 'relative/path.md#BR01' && refs[0]?.text === 'BR01',
    JSON.stringify(refs)
  );
  runner.check(
    'happy: serialize(with class) === serialize(without)',
    serializeHtml(after) === before,
    `\n  with:    ${JSON.stringify(serializeHtml(after))}\n  without: ${JSON.stringify(before)}`
  );
  const md2 = serializeHtml(after);
  runner.check('happy: stable on 2nd pass', serializeHtml(renderAndTransform(md2)) === before);
}

// ---------------------------------------------------------------------------
// 2. Same-document reference (`#FULLID`, no file part) — entity-scope.ts's
//    dot-drill insert shape.
// ---------------------------------------------------------------------------
{
  const refs = inspectRefs(renderAndTransform('A [UC01](#UC01) reference.'));
  runner.check('same-doc: marked', refs.length === 1 && refs[0]?.href === '#UC01', JSON.stringify(refs));
}

// ---------------------------------------------------------------------------
// 3. NOT marked — display text differs from the fragment (an ordinary heading
//    link, not an entity reference: US-8.x precedent, [Intro](#introduction)).
// ---------------------------------------------------------------------------
{
  const refs = inspectRefs(renderAndTransform('See the [Introduction](#introduction) section.'));
  runner.check('heading-link: not marked (text != fragment)', refs.length === 0, JSON.stringify(refs));
}

// ---------------------------------------------------------------------------
// 4. NOT marked — fragment is an all-letters word (no id half after the
//    greedy namespace run) even when display text matches it exactly.
// ---------------------------------------------------------------------------
{
  const refs = inspectRefs(renderAndTransform('[readme](readme.md#readme)'));
  runner.check('all-letters fragment: not marked (empty id half)', refs.length === 0, JSON.stringify(refs));
}

// ---------------------------------------------------------------------------
// 5. NOT marked — a plain http(s) link, even with a coincidentally-shaped
//    fragment and matching display text.
// ---------------------------------------------------------------------------
{
  const refs = inspectRefs(renderAndTransform('[UC01](https://example.com/page#UC01)'));
  runner.check('external link: not marked', refs.length === 0, JSON.stringify(refs));
}

// ---------------------------------------------------------------------------
// 6. NOT marked — a link with no `#fragment` at all.
// ---------------------------------------------------------------------------
{
  const refs = inspectRefs(renderAndTransform('[UC01](UC01.md)'));
  runner.check('no-fragment link: not marked', refs.length === 0, JSON.stringify(refs));
}

// ---------------------------------------------------------------------------
// 7. Idempotent — re-running the transform never leaves a stale class once
//    the anchor no longer qualifies (mirrors caption-insert.ts's own case,
//    but also exercises the REMOVE branch: a class postProcessCaptions never
//    needed since it never has to un-wrap).
// ---------------------------------------------------------------------------
{
  const doc = domino.createDocument('<div id="content"></div>', true);
  const root = doc.getElementById('content');
  if (!root) {
    throw new Error('could not build DOM');
  }
  root.innerHTML = '<p><a href="#UC01">UC01</a></p>';
  postProcessEntityRefs(root);
  runner.check('idempotent: marked on 1st pass', root.querySelectorAll(ENTITY_REF_SELECTOR).length === 1, root.innerHTML);
  // Display text edited so it no longer starts with its own fragment token.
  // (Req 21: `UC01 <label>` DOES still qualify — the human name follows the
  // code — so the divergent text here must NOT begin with `UC01 `.)
  const anchor = root.querySelector('a');
  if (anchor) {
    anchor.textContent = 'Something else';
  }
  postProcessEntityRefs(root);
  runner.check('idempotent: class removed once text no longer matches', root.querySelectorAll(ENTITY_REF_SELECTOR).length === 0, root.innerHTML);
}

// ---------------------------------------------------------------------------
// 8. Multiple references in one paragraph, mixed with a non-entity link.
// ---------------------------------------------------------------------------
{
  const md = 'From [UC01](#UC01) to [BR02](other.md#BR02), see [here](#somewhere).';
  const refs = inspectRefs(renderAndTransform(md));
  runner.check(
    'multi: two entity refs, non-entity link untouched',
    refs.length === 2 && refs[0]?.text === 'UC01' && refs[1]?.text === 'BR02',
    JSON.stringify(refs)
  );
  runner.check('multi: serialize round-trips', serializeHtml(renderAndTransform(md)) === serializeHtml(renderer.render(md).html));
}

// ---------------------------------------------------------------------------
// 9. Req 21: a labeled mention `[NS_ID label](#NS_ID)` — display text is the
//    entity's human name (starts with the token, then a space + label). It must
//    still be marked, and the class-only change must not touch the .md.
// ---------------------------------------------------------------------------
{
  const md = 'See [UC01 Submit Leave Request](#UC01) for details.';
  const before = serializeHtml(renderer.render(md).html);
  const after = renderAndTransform(md);
  const refs = inspectRefs(after);
  runner.check(
    'label: labeled mention marked, full name kept as text, clean fragment',
    refs.length === 1 && refs[0]?.text === 'UC01 Submit Leave Request' && refs[0]?.href === '#UC01',
    JSON.stringify(refs)
  );
  runner.check('label: serialize(with class) === serialize(without) — .md untouched', serializeHtml(after) === before);
}

runner.finish('entity-ref');
