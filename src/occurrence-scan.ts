/**
 * Req 21 US-21.3: pure, fenced-code-aware scan of ONE file's text for entity-
 * REFERENCE occurrences — every markdown link `[..](..#FRAGMENT)` whose
 * FRAGMENT is a validly-shaped entity token (namespace = leading Unicode-letter
 * run, non-empty id remainder). Feeds provider.ts's session-only occurrence
 * cache that backs "Fix all"'s `+N other occurrence(s)` count.
 *
 * PURE module — MUST NOT `import 'vscode'` (same discipline as entity-index.ts:
 * unit-tested under Node). The fence/splitLines shape here is a deliberate small
 * clone of entity-index.ts's (NOT an import — avoids a cross-dependency between
 * two independently-evolving scanners, matching this codebase's existing
 * small-clone convention). Only REFERENCE sites are captured (not `caption::`
 * declarations) — those are the sites Fix-all cares about.
 */

/** A fenced-code opener/closer: 3+ backticks or tildes (marker char captured). */
const FENCE_RE = /^(`{3,}|~{3,})/;
/** Leading Unicode-letter run of an entity token = its namespace. */
const NAMESPACE_RE = /^\p{L}+/u;
/** A markdown inline link — captures everything inside `(...)` (url + optional title). */
const LINK_RE = /\[[^\]]*\]\(([^)]*)\)/g;

/** Split a source blob into lines, normalizing CRLF/CR/LF. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Fence marker char ('`' or '~') of a trimmed line, or null if it isn't a fence line. */
function fenceMarkerOf(trimmed: string): string | null {
  const m = FENCE_RE.exec(trimmed);
  return m ? m[1][0] : null;
}

/**
 * Canonical full id of a validly-shaped entity token, or null. Namespace folded
 * to lower case (case-insensitive per US-21.2), id kept verbatim — matches the
 * key provider.ts stores/reads the occurrence cache under, and the canonical id
 * checkEntitiesExist derives from a webview-sent fragment.
 */
export function canonicalEntityId(token: string): string | null {
  const nsMatch = NAMESPACE_RE.exec(token);
  if (!nsMatch || nsMatch[0].length >= token.length) {
    return null; // no namespace letters, or empty id half — not a valid entity token.
  }
  return nsMatch[0].toLowerCase() + token.slice(nsMatch[0].length);
}

/**
 * Every entity-reference occurrence in `text` (fence-aware): canonical `id`
 * (ns.toLowerCase()+id) + 0-based `line`. The caller tags each occurrence with
 * its own file — this pure scan only needs the text.
 */
export function scanEntityOccurrences(text: string): { id: string; line: number }[] {
  const lines = splitLines(text);
  const out: { id: string; line: number }[] = [];
  let inFence = false;
  let fenceMarker = '';
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line];
    const trimmed = raw.trim();
    const marker = fenceMarkerOf(trimmed);
    if (inFence) {
      if (marker === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (marker) {
      inFence = true;
      fenceMarker = marker;
      continue;
    }
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(raw)) !== null) {
      const url = m[1];
      const hashIdx = url.indexOf('#');
      if (hashIdx === -1) {
        continue;
      }
      // Fragment stops at the first whitespace (a `(url "title")` link title never belongs to the id).
      const id = canonicalEntityId(url.slice(hashIdx + 1).split(/\s/)[0]);
      if (id !== null) {
        out.push({ id, line });
      }
    }
  }
  return out;
}
