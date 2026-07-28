/**
 * Security — Audit S-2: `<meta http-equiv="refresh" content="0;url=...">` is
 * the one raw-HTML vector the page's CSP does not cover (script-src blocks
 * `<script>`/inline handlers, style-src/base-uri already neutralize injected
 * stylesheets and `<base>` — see Plan/Security — Audit.md S-2/S-3). A
 * malicious `.md` can otherwise trigger a navigation attempt just from being
 * opened in the preview.
 *
 * Browser-only (uses `<template>`, never runs under domino/round-trip tests):
 * parsing into a `<template>` element's `.content` keeps the fragment
 * detached/inert (no browsing context) so the tag is gone BEFORE anything is
 * ever connected to the live, rendered `#content` — by the time the sanitized
 * markup reaches it, there is nothing left to fire.
 */
export function stripMetaRefresh(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('meta').forEach((el) => el.remove());
  return template.innerHTML;
}
