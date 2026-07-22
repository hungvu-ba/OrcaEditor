/**
 * Req 21 US-21.2: workspace-wide entity index (`caption::` declarations).
 *
 * PURE module — MUST NOT `import 'vscode'` (same rationale as src/text-utils.ts:
 * test/unit.ts bundles + runs this under Node without a VS Code runtime). All
 * vscode I/O (findFiles / fs.readFile / watchers) lives in provider.ts, which
 * feeds already-read text into the pure methods here.
 */
import { entityFollowingLabel, entityFollowingPreview, normalizeForSearch } from './text-utils';

/**
 * One indexed entity, flattened per declaration with its namespace carried on
 * the row (US-21.2's `namespace -> [{id,file,line,title}]` shape).
 *  - `file` = uri.toString() of the declaring file.
 *  - `line` = 0-based line of the `caption::` declaration.
 *  - `title` = nearest enclosing ATX heading above the declaration ('' if none).
 *  - `preview` = short preview of the text following the `caption::NS_ID` token
 *    on its declaration line (Req 21 hover tooltip); '' when nothing follows.
 *  - `label` = FULL following text (uncapped preview) — the entity's human name,
 *    used as a mention's link display text (Req 21); '' when nothing follows.
 */
export interface IndexedEntity {
  namespace: string;
  id: string;
  file: string;
  line: number;
  title: string;
  preview: string;
  label: string;
}

/** Matches a `caption::TOKEN` declaration; TOKEN is the following non-whitespace run. */
const CAPTION_RE = /caption::(\S+)/g;
/** Leading Unicode-letter run of a caption token = its namespace. */
const NAMESPACE_RE = /^\p{L}+/u;
/** A fenced-code opener/closer: 3+ backticks or tildes (marker char captured). */
const FENCE_RE = /^(`{3,}|~{3,})/;
/** An ATX heading line: 1–6 leading `#` followed by whitespace. */
const ATX_HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Split a source blob into lines, normalizing CRLF/CR/LF. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Blank out CommonMark inline code spans in a single line so a `caption::`
 * written as example syntax inside backticks (e.g. documentation like
 * `` `caption::UC01` ``) is NOT parsed as a real declaration — mirrors the
 * webview's CODE-ancestor skip in dom-postprocess.ts `inSkippedContext`, so the
 * host index and the rendered pill agree on what counts as a declaration
 * (PO 2026-07-22: inline-code `caption::` is documentation, not a declaration).
 *
 * A span opens on a run of N backticks and closes on the next run of EXACTLY N
 * backticks; an unmatched run stays literal text (so `` caption::UC01`, `` keeps
 * its `caption::UC01`, matched by CAPTION_RE and trimmed as before). Linear
 * left-to-right scan — no backtracking, so no ReDoS. Line-scoped, consistent
 * with the rest of this line-based, fence-aware parser. A matched span is
 * replaced by an equal-length run of spaces (NOT removed) so every column offset
 * is PRESERVED: a `match.index` into the returned string maps straight back onto
 * the original line, which parseEntities relies on to slice the token's
 * following text for the hover preview.
 *
 * Two deliberate, negligible-in-practice gaps: backslash-escaped backticks are
 * NOT honored (a `\`` is still treated as a delimiter), and a code span that
 * opens and closes on different lines is not detected (line-scoped, like the
 * rest of this parser). Captions in this codebase sit on their own lines and
 * doc examples are single-line, so neither case occurs in real content.
 */
function stripInlineCode(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i++;
      continue;
    }
    // Measure the opening backtick run.
    let open = i;
    while (open < line.length && line[open] === '`') {
      open++;
    }
    const runLen = open - i;
    // Look for a closing run of exactly the same length.
    let close = -1;
    let k = open;
    while (k < line.length) {
      if (line[k] !== '`') {
        k++;
        continue;
      }
      let run = k;
      while (run < line.length && line[run] === '`') {
        run++;
      }
      if (run - k === runLen) {
        close = run;
        break;
      }
      k = run;
    }
    if (close === -1) {
      // Unmatched run — keep the backticks as literal text.
      out += line.slice(i, open);
      i = open;
    } else {
      // Blank the whole span (delimiters + content) with equal-length spaces —
      // preserves column offsets so match.index maps back onto the original line.
      out += ' '.repeat(close - i);
      i = close;
    }
  }
  return out;
}

/** Fence marker char ('`' or '~') of a trimmed line, or null if it isn't a fence line. */
function fenceMarkerOf(trimmed: string): string | null {
  const m = FENCE_RE.exec(trimmed);
  return m ? m[1][0] : null;
}

/**
 * ATX heading level (1–6) of a raw line, or null if it isn't an ATX heading.
 * Mirrors drag-drop.ts `headingLevel` but takes a raw string (not an Element)
 * so it can live host-side and be ported into the webview drill-down (US-21.3).
 */
function headingLevelOfLine(line: string): number | null {
  const m = ATX_HEADING_RE.exec(line);
  return m ? m[1].length : null;
}

/** Heading text with its leading `#`+space (and any trailing `#` run) stripped. */
function headingText(line: string): string {
  const m = ATX_HEADING_RE.exec(line);
  return m ? m[2].replace(/\s+#+\s*$/, '').trim() : '';
}

/**
 * Text of the nearest preceding ATX heading that encloses `lineIndex` — the
 * heading whose section the line sits in (by the "heading -> next same-or-higher
 * heading" rule, the last heading before a line always opens its section).
 * Fenced-code aware: a `#`-looking line inside a ``` / ~~~ fence is NOT a
 * heading. Returns '' when the line sits above any heading.
 *
 * THE named, easy-to-port primitive the webview drill-down (US-21.3) mirrors.
 */
export function nearestEnclosingHeading(lines: string[], lineIndex: number): string {
  let inFence = false;
  let fenceMarker = '';
  let heading = '';
  const end = Math.min(lineIndex, lines.length);
  for (let i = 0; i < end; i++) {
    const trimmed = lines[i].trim();
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
    if (headingLevelOfLine(lines[i]) !== null) {
      heading = headingText(lines[i]);
    }
  }
  return heading;
}

/**
 * Parse all `caption::` entity declarations from one file's text (fenced-code
 * aware). Each caption token splits into namespace = leading Unicode-letter run,
 * id = the remainder; a token with no letter prefix or an empty id half is
 * skipped (a malformed/empty declaration is not a valid target, per US-21.1's
 * empty-id refusal). `title` = nearest enclosing heading, tracked in the SAME
 * forward pass (no second scan).
 */
export function parseEntities(fileUri: string, text: string): IndexedEntity[] {
  const lines = splitLines(text);
  const out: IndexedEntity[] = [];
  let inFence = false;
  let fenceMarker = '';
  let heading = '';
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
    if (headingLevelOfLine(raw) !== null) {
      heading = headingText(raw);
      continue;
    }
    // Scan the line with inline code spans blanked out so a `caption::` written
    // as example syntax inside backticks is not indexed as a declaration.
    const scan = stripInlineCode(raw);
    CAPTION_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CAPTION_RE.exec(scan)) !== null) {
      // The `\S+` capture greedily absorbs trailing punctuation from the
      // surrounding prose/markdown (e.g. `caption::UC01`, → `` UC01`, ``;
      // `caption::UC01).` → `UC01).`). Strip that trailing non-alphanumeric run
      // so the parsed id stays a clean token; a punctuation-only token drops out.
      const token = match[1].replace(/[^\p{L}\p{N}]+$/u, '');
      if (token === '') {
        continue; // nothing left after trimming trailing punctuation.
      }
      const nsMatch = NAMESPACE_RE.exec(token);
      if (!nsMatch) {
        continue; // no namespace letters — not a valid declaration.
      }
      const namespace = nsMatch[0];
      const id = token.slice(namespace.length);
      if (id === '') {
        continue; // empty id half — refused (US-21.1).
      }
      // Text following the token on this line. stripInlineCode is length-
      // preserving, so match.index/length (into `scan`) map straight onto `raw`.
      const following = raw.slice(match.index + match[0].length);
      const label = entityFollowingLabel(following);
      const preview = entityFollowingPreview(following);
      out.push({ namespace, id, file: fileUri, line, title: heading, preview, label });
    }
  }
  return out;
}

/** Deterministic result cap so a query payload stays bounded. */
const QUERY_RESULT_CAP = 50;

/**
 * In-memory entity index keyed by file so an incremental per-file update just
 * replaces that file's rows (US-21.2). Pure — fed already-read text by
 * provider.ts. `isReady()` is false until the first full `build()` completes so
 * a query during the initial background scan reports "indexing" rather than a
 * false "nothing exists" (index freshness is NOT existence truth).
 */
export class EntityIndex {
  private byFile = new Map<string, IndexedEntity[]>();
  private ready = false;

  /** Full (re)build from every workspace markdown file's text. */
  build(files: Iterable<{ uri: string; text: string }>): void {
    this.byFile.clear();
    for (const { uri, text } of files) {
      const rows = parseEntities(uri, text);
      if (rows.length > 0) {
        this.byFile.set(uri, rows);
      }
    }
    this.ready = true;
  }

  /**
   * Re-parse a single file and overwrite its rows — works before or after the
   * full build (incremental, per US-21.2). Empty text / a deleted file drops
   * that file's rows.
   */
  onFileChanged(uri: string, text: string): void {
    const rows = parseEntities(uri, text);
    if (rows.length > 0) {
      this.byFile.set(uri, rows);
    } else {
      this.byFile.delete(uri);
    }
  }

  /**
   * Combined id-OR-title match (US-21.2): every token of the normalized query
   * must match a row on the id OR the title. The id match is a substring of
   * `normalize(namespace + id)` (so `UC01` and the partial `01` both hit); the
   * title match is anchored to a word start (segment prefix) so a short token
   * like `uc` does NOT hit mid-word inside a title (e.g. "strUCtured"). An empty
   * query returns all rows. `opts.namespace` narrows case-insensitively.
   * Deterministic order (namespace asc, then id asc), capped small.
   */
  query(q: string, opts?: { namespace?: string }): IndexedEntity[] {
    const wantNs = opts?.namespace?.toLowerCase();
    const tokens = normalizeForSearch(q)
      .split('-')
      .filter((t) => t.length > 0);
    const out: IndexedEntity[] = [];
    for (const rows of this.byFile.values()) {
      for (const row of rows) {
        if (wantNs !== undefined && row.namespace.toLowerCase() !== wantNs) {
          continue;
        }
        // Full id is namespace + id (row.id holds only the post-namespace half),
        // so a full-id query like `UC01` matches, as do partial-id tokens.
        const idHay = normalizeForSearch(row.namespace + row.id);
        // Title match anchors to a word start: normalizeForSearch joins words with
        // '-', so prefixing both sides with '-' turns includes() into a
        // segment-prefix test (kills mid-word hits like `uc` in "strUCtured").
        const titleHay = `-${normalizeForSearch(row.title)}`;
        if (tokens.every((t) => idHay.includes(t) || titleHay.includes(`-${t}`))) {
          out.push(row);
        }
      }
    }
    out.sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out.slice(0, QUERY_RESULT_CAP);
  }

  /**
   * Req 21 US-21.3: EXACT-id resolver used only for broken-reference existence
   * (NOT the fuzzy `query` above — substring matching would false-positive a
   * broken id against a longer real one). `fullId` is parsed with the SAME rule
   * as `parseEntities`: namespace = leading Unicode-letter run, id = remainder
   * (empty id -> no match). Returns every row whose namespace matches
   * case-insensitively (per US-21.2) and whose id matches exactly.
   */
  lookup(fullId: string): IndexedEntity[] {
    const nsMatch = NAMESPACE_RE.exec(fullId);
    if (!nsMatch) {
      return [];
    }
    const ns = nsMatch[0].toLowerCase();
    const id = fullId.slice(nsMatch[0].length);
    if (id === '') {
      return [];
    }
    const out: IndexedEntity[] = [];
    for (const rows of this.byFile.values()) {
      for (const row of rows) {
        if (row.namespace.toLowerCase() === ns && row.id === id) {
          out.push(row);
        }
      }
    }
    return out;
  }

  /**
   * Namespaces with their entity counts, grouped case-insensitively (folded to
   * the first-seen casing), sorted by count desc then name asc (US-21.2 browse
   * order + US-21.1 shared sort).
   */
  namespaces(): { name: string; count: number }[] {
    const byKey = new Map<string, { name: string; count: number }>();
    for (const rows of this.byFile.values()) {
      for (const row of rows) {
        const key = row.namespace.toLowerCase();
        const existing = byKey.get(key);
        if (existing) {
          existing.count++;
        } else {
          byKey.set(key, { name: row.namespace, count: 1 });
        }
      }
    }
    return [...byKey.values()].sort(
      (a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
  }

  /** False until the first full `build()` completes (US-21.2 indexing state). */
  isReady(): boolean {
    return this.ready;
  }
}
