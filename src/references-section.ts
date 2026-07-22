/**
 * Req 20 US-20.5 — `/add reference` scan + merge engine.
 *
 * PURE module: no `vscode`, `path`, `fs`, or DOM import, so BOTH the extension
 * host (src/provider.ts, for the dedup/present-check and the merge write) and
 * the webview bundle (media/webview/main.ts, for first-body-occurrence nav
 * matching) import from here. `normalizeHrefKey` is the SINGLE source of truth
 * for how a link's file segment is turned into a comparison key — both ends
 * must agree or navigation lands on the wrong (or no) body occurrence.
 *
 * The body scan is a single pass over lines that (a) tracks fenced-code state
 * so example links in code samples are never gathered, (b) excludes the whole
 * `## References` section (heading → next same-or-higher heading / EOD) from the
 * body-link gather while parsing that section separately into a "present" set
 * for the additive merge, and (c) runs a hand-rolled balanced-bracket inline
 * link scanner (with inline-code masking) so images and nested
 * `[![alt](img.png)](file.md)` links are handled correctly.
 */

/** One in-scope body link, keyed for dedup/present-check and nav matching. */
export interface RefCandidate {
  /** `normalizeHrefKey(fileSegment)` — the comparison key (host dedup + webview nav). */
  key: string;
  /** The raw, original relative href to EMIT in the entry (portability: never resolved-absolute). */
  href: string;
  /** The raw file part (href minus `?query`/`#fragment`, angle-brackets stripped) — the host `fs.stat`s this. */
  fileSegment: string;
  /** First-occurrence display text (raw, single line). */
  display: string;
}

/** Where an existing `## References` section is, and where appended lines go. */
export interface SectionInfo {
  exists: boolean;
  /** Char offset in `text` where appended lines are spliced (end of the existing section). */
  insertOffset: number;
  /** Char offset in `text` of the `## References` heading line start (0 when !exists). */
  headingOffset: number;
}

/** Result of the single-pass body scan. */
export interface RefPlan {
  /** In-scope body links, deduped by `key`, first-occurrence order, MINUS `presentKeys`. */
  candidates: RefCandidate[];
  /** Keys of links already listed inside the existing References section. */
  presentKeys: Set<string>;
  section: SectionInfo;
}

/** A raw inline-link match: display + bare href (angle-brackets already stripped). */
interface LinkMatch {
  display: string;
  href: string;
}

/**
 * SINGLE source of truth for the comparison key of a link's file segment.
 * Strips `#fragment` then `?query`, `decodeURIComponent`s, converts `\` to `/`,
 * lower-cases a leading Windows drive letter (`C:` → `c:`, kept as a path — not
 * treated as a URL scheme), and posix-normalizes the relative segments
 * (resolving `.`/`..`). The path body is NOT case-folded (filesystem case
 * sensitivity is unknown in a pure module); only the drive letter, which is
 * conventionally case-insensitive, is folded.
 */
export function normalizeHrefKey(href: string): string {
  let s = href;
  const hashIdx = s.indexOf('#');
  if (hashIdx !== -1) {
    s = s.slice(0, hashIdx);
  }
  const qIdx = s.indexOf('?');
  if (qIdx !== -1) {
    s = s.slice(0, qIdx);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    decoded = s;
  }
  decoded = decoded.replace(/\\/g, '/');
  let drive = '';
  const driveMatch = /^([a-zA-Z]):/.exec(decoded);
  if (driveMatch) {
    drive = driveMatch[1].toLowerCase() + ':';
    decoded = decoded.slice(2);
  }
  const isAbsolute = decoded.startsWith('/');
  const out: string[] = [];
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') {
        out.pop();
      } else if (!isAbsolute) {
        out.push('..');
      }
      continue;
    }
    out.push(part);
  }
  return drive + (isAbsolute ? '/' : '') + out.join('/');
}

/** Replace each inline-code span (`` `...` ``, matched backtick-run length) with equal-length spaces so offsets stay aligned and the link scanner never fires inside code. */
function maskInlineCode(line: string): string {
  const chars = line.split('');
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== '`') {
      i++;
      continue;
    }
    let n = 0;
    while (i + n < chars.length && chars[i + n] === '`') {
      n++;
    }
    let j = i + n;
    let closed = false;
    while (j < chars.length) {
      if (chars[j] === '`') {
        let m = 0;
        while (j + m < chars.length && chars[j + m] === '`') {
          m++;
        }
        if (m === n) {
          for (let k = i; k < j + n; k++) {
            chars[k] = ' ';
          }
          i = j + n;
          closed = true;
          break;
        }
        j += m;
      } else {
        j++;
      }
    }
    if (!closed) {
      i += n; // unclosed run — leave as-is, skip past the opening backticks.
    }
  }
  return chars.join('');
}

/**
 * Hand-rolled inline-link scanner. Finds `[label](href)` links on ONE line,
 * skipping images (`![...]`, incl. the inner image of a nested
 * `[![alt](img.png)](file.md)` — only the OUTER link is returned). Masking of
 * inline-code spans is done by the caller; `masked` keeps positions aligned so
 * display/href are sliced from the ORIGINAL `line`.
 */
function scanInlineLinks(line: string, masked: string): LinkMatch[] {
  const out: LinkMatch[] = [];
  let i = 0;
  const len = masked.length;
  while (i < len) {
    if (masked[i] !== '[') {
      i++;
      continue;
    }
    if (i > 0 && (masked[i - 1] === '!' || masked[i - 1] === '\\')) {
      i++; // image or escaped bracket — not a link opener.
      continue;
    }
    // Parse the label with balanced brackets (parens inside the label are
    // ignored for depth, so a nested image `![a](img)` inside the label works).
    let depth = 1;
    let j = i + 1;
    while (j < len && depth > 0) {
      const ch = masked[j];
      if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
      }
      if (depth === 0) {
        break;
      }
      j++;
    }
    if (depth !== 0 || masked[j + 1] !== '(') {
      i++; // no balanced `]` immediately followed by `(` — not a link.
      continue;
    }
    const labelStart = i + 1;
    const labelEnd = j; // masked[j] === ']'
    // Parse the href with balanced parens.
    let pdepth = 1;
    let k = j + 2;
    while (k < len && pdepth > 0) {
      const ch = masked[k];
      if (ch === '(') {
        pdepth++;
      } else if (ch === ')') {
        pdepth--;
      }
      if (pdepth === 0) {
        break;
      }
      k++;
    }
    if (pdepth !== 0) {
      i++; // unbalanced parens — not a valid link.
      continue;
    }
    const hrefStart = j + 2;
    const hrefEnd = k; // masked[k] === ')'
    const display = line.slice(labelStart, labelEnd);
    let href = line.slice(hrefStart, hrefEnd).trim();
    if (href.startsWith('<') && href.endsWith('>')) {
      href = href.slice(1, -1);
    }
    out.push({ display, href });
    i = k + 1;
  }
  return out;
}

/** True for an href with a URL scheme (`https:`, `mailto:`…) that is NOT a Windows drive-letter path. */
function isExternalHref(href: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(href)) {
    return false; // Windows drive-letter path — local, not a scheme.
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** The raw file part of an href (minus `?query`/`#fragment`), or '' if none. */
function fileSegmentOf(href: string): string {
  let s = href;
  const hashIdx = s.indexOf('#');
  if (hashIdx !== -1) {
    s = s.slice(0, hashIdx);
  }
  const qIdx = s.indexOf('?');
  if (qIdx !== -1) {
    s = s.slice(0, qIdx);
  }
  return s;
}

/** Inclusion filter (US-20.5): local, non-image, has a file segment, not a `caption:`-scheme entity. */
function toCandidate(match: LinkMatch): RefCandidate | undefined {
  const { display, href } = match;
  if (isExternalHref(href)) {
    return undefined; // external scheme (incl. v1 `caption:` entity refs) — skip.
  }
  const fileSegment = fileSegmentOf(href);
  if (fileSegment === '') {
    return undefined; // pure `#anchor` or empty `[t]()` — no file to reference.
  }
  return { key: normalizeHrefKey(fileSegment), href, fileSegment, display };
}

const REFERENCES_HEADING_RE = /^##\s+references\s*$/i;
const SAME_OR_HIGHER_HEADING_RE = /^#{1,2}\s/;
const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})/;

/** SINGLE-PASS body scan → dedup/present sets + section boundaries (US-20.5). */
export function planReferences(text: string): RefPlan {
  const lines = text.split('\n');
  const candidates: RefCandidate[] = [];
  const seen = new Set<string>();
  const presentKeys = new Set<string>();
  const section: SectionInfo = { exists: false, insertOffset: 0, headingOffset: 0 };

  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let inReferences = false;
  let lineStart = 0;

  for (const line of lines) {
    const lineEnd = lineStart + line.length;

    // ---- Fence tracking ----
    if (inFence) {
      const closeRe = new RegExp(`^\\s*${fenceChar === '`' ? '`' : '~'}{${fenceLen},}\\s*$`);
      if (closeRe.test(line)) {
        inFence = false;
      }
      lineStart = lineEnd + 1;
      continue; // fenced code is never scanned.
    }
    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen) {
      inFence = true;
      fenceChar = fenceOpen[2][0];
      fenceLen = fenceOpen[2].length;
      lineStart = lineEnd + 1;
      continue;
    }

    // ---- References-section boundary ----
    if (inReferences) {
      if (SAME_OR_HIGHER_HEADING_RE.test(line)) {
        inReferences = false; // closed by the next `#`/`##` heading — fall through to body handling below.
      } else {
        // Inside the existing section: gather present keys, keep tracking the
        // append point (end of the last content line), do NOT gather as body.
        if (line.trim() !== '') {
          section.insertOffset = lineEnd;
        }
        for (const match of scanInlineLinks(line, maskInlineCode(line))) {
          const cand = toCandidate(match);
          if (cand) {
            presentKeys.add(cand.key);
          }
        }
        lineStart = lineEnd + 1;
        continue;
      }
    }

    if (!section.exists && REFERENCES_HEADING_RE.test(line)) {
      section.exists = true;
      section.headingOffset = lineStart;
      section.insertOffset = lineEnd; // default append point = end of the heading line (empty section).
      inReferences = true;
      lineStart = lineEnd + 1;
      continue;
    }

    // ---- Body line ----
    for (const match of scanInlineLinks(line, maskInlineCode(line))) {
      const cand = toCandidate(match);
      if (cand && !seen.has(cand.key)) {
        seen.add(cand.key);
        candidates.push(cand);
      }
    }
    lineStart = lineEnd + 1;
  }

  const filtered = candidates.filter((c) => !presentKeys.has(c.key));
  return { candidates: filtered, presentKeys, section };
}

/** Escape `[`/`]` in display text so the emitted `[display]` stays balanced. */
function escDisplay(display: string): string {
  return display.replace(/([[\]])/g, '\\$1');
}

/** `<>`-wrap an href that contains whitespace or parens so the emitted `(href)` is never malformed. */
function escHref(href: string): string {
  if (/[\s()]/.test(href) || href.includes('\n')) {
    return '<' + href.replace(/([<>])/g, '\\$1') + '>';
  }
  return href;
}

/**
 * Build the new document text with missing entries merged in (US-20.5), or
 * `null` when there is nothing to add (never creates an empty section, never
 * deletes/reformats existing entries). `brokenKeys` = candidate keys whose
 * target failed `fs.stat` with FileNotFound → prefixed with the literal `⚠️ `.
 */
export function renderReferences(text: string, plan: RefPlan, brokenKeys: ReadonlySet<string>): string | null {
  if (plan.candidates.length === 0) {
    return null;
  }
  const lines = plan.candidates.map((c) => {
    const prefix = brokenKeys.has(c.key) ? '⚠️ ' : '';
    return `- ${prefix}[${escDisplay(c.display)}](${escHref(c.href)})`;
  });
  const block = lines.join('\n');

  if (plan.section.exists) {
    const at = plan.section.insertOffset;
    return text.slice(0, at) + '\n' + block + text.slice(at);
  }
  // No section — create one at the very end of the body, exactly one trailing newline.
  const body = text.replace(/\n+$/, '');
  const prefix = body === '' ? '' : body + '\n\n';
  return prefix + '## References\n\n' + block + '\n';
}
