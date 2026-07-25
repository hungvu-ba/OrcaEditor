/**
 * X-5: an entity mention's link fragment (`path#NS_ID`) is authored raw but is
 * percent-encoded by markdown-it's `normalizeLink` at render time and can be
 * persisted percent-encoded in the `.md`. Every place that compares or parses
 * that fragment (webview classify, webview broken-ref lookup key, host
 * occurrence scan, host exact-id lookup) must first bring it back to one
 * canonical spelling, or a non-ASCII namespace (any Vietnamese one) never
 * matches its decoded declaration/display counterpart.
 *
 * ONE shared transform, used on both bundles (this module is pure — no `vscode`,
 * no DOM — so `src/*` host code and `media/webview/*` both import it), so host
 * and webview can never drift: guarded percent-decode (a literal `%` in a name
 * makes `decodeURIComponent` throw → fall back to the raw string, matching the
 * existing pattern in dom-postprocess.ts `emptyLinkDisplayText`) then NFC, so an
 * NFD-authored namespace matches an NFC one. Idempotent on already-decoded,
 * already-NFC, and pure-ASCII input.
 */
export function decodeEntityFragment(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return decoded.normalize('NFC');
}
