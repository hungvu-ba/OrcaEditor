/**
 * Security — Audit S-4: mermaid renders with `securityLevel: 'strict'`
 * (mermaid.ts), which sanitizes its own SVG output; @plantuml/core has no such
 * option, so plantuml.ts runs its generated SVG string through this before
 * assigning it to `chart.innerHTML`. CSP already blocks script execution and
 * the delegated click handler routes real anchor clicks through the host's
 * scheme allowlist — this closes the gap for the SVG DOM itself: an embedded
 * `<script>`/`<foreignObject>`, an event-handler attribute, or a
 * `javascript:` href/xlink:href.
 *
 * Browser-only (uses `<template>`, never runs under domino/round-trip tests):
 * the SVG this reads is a rendering artifact regenerated on every render, not
 * something turndown ever serializes back to `.md` (see diagramSource in
 * turndown.ts, which reads the fenced source text instead), so stripping here
 * carries no round-trip risk.
 */
// Review finding (blind hunter + edge case hunter, 2026-07-28): a bare
// `/^\s*javascript:/i` test is bypassable — the WHATWG URL parser strips ASCII
// tab/newline/CR from anywhere in a URL string before reading its scheme, so a
// value like `jav\tascript:alert(1)` (control char injected mid-word) never
// matches the regex here yet still resolves to and executes as `javascript:`
// once the browser parses it as a URL. Strip those characters first so the
// check sees what the browser will actually see.
function isJavascriptUrl(value: string): boolean {
  return /^\s*javascript:/i.test(value.replace(/[\t\n\r]/g, ''));
}

export function sanitizeSvgMarkup(svg: string): string {
  const template = document.createElement('template');
  template.innerHTML = svg;
  const root = template.content;
  root.querySelectorAll('script, foreignObject').forEach((el) => el.remove());
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as Element;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const isHrefLike = name === 'href' || name === 'xlink:href';
      if (name.startsWith('on') || (isHrefLike && isJavascriptUrl(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return template.innerHTML;
}
