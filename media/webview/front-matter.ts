/**
 * Front matter block redesign (US-2.7 quick-dev spec, 2026-07-27): collapsed
 * one-line row (default) / expanded card (title + badges + key/value grid) /
 * raw YAML — replacing the old always-full `<pre>` dump. Design source of
 * truth: `Wireframe Handoff/design_handoff_front_matter/` (README.md,
 * tokens.css, tokens.json) — colors/sizes ported verbatim into editor.css.
 *
 * Split the same way diagram-frame.ts is: `parseFrontMatterFields` and
 * `buildFrontMatterHtml` are pure string/DOM-free logic so `render.ts` can call
 * them under Node (test/roundtrip/); `initFrontMatterToggle` touches browser
 * globals (`navigator.clipboard`) and is only ever called from `main.ts`.
 *
 * US-2.9 (2026-07-31) replaced the original hand-rolled scanner with `js-yaml`,
 * so nested maps, block-style lists, block scalars, flow collections and
 * anchors/aliases all parse for real. Three separable concerns:
 *
 *  - `parseFrontMatterFields` — YAML-specific: `load(raw, { json: true })`
 *    ({ json: true } makes a duplicate key override instead of throwing, so the
 *    last occurrence wins). A `load()` throw is NOT the invalid state: the card
 *    still renders, one verbatim raw row per source line, with a `Line N` marker.
 *  - `buildFrontMatterFields` / `buildInvalidParseResult` — parser-agnostic:
 *    they take an ALREADY-PARSED JS value, never raw text, so US-2.10 (TOML)
 *    and US-2.11 (JSON) reuse them with their own parser. Keep them free of any
 *    `js-yaml` import.
 *  - `buildFrontMatterHtml` — markup for all three view states.
 *
 * US-2.10 (2026-07-31) added TOML (`+++` fences, `smol-toml`) as a second
 * format. It supplies its own parsed object to the SAME adapter, so no field,
 * badge or grid rendering branches on format — only the topline tag, the raw
 * view's tint, and the fences Copy/turndown emit do.
 *
 * Values are canonically reformatted for DISPLAY only (numbers via `String`,
 * dates to UTC, `null` to an empty string); the saved file always keeps its
 * original bytes because turndown re-emits `data-raw` verbatim. The `invalid`
 * state is now reserved for a top level that isn't a key/value map at all.
 */
import { load } from 'js-yaml';
import { parse as parseToml } from 'smol-toml';
import { FRONT_MATTER_CLASS, LINE_NUMBER_ATTR } from './render';
import { escapeHtml, escapeAttr } from './dom-utils';

/** Which delimiter the block was written with. Picks the parser and the fence, and nothing else — no field, badge or grid rendering branches on it. */
export type FrontMatterFormat = 'yaml' | 'toml';

/** Retained from the removed scanner purely for `buildRawBodyHtml`'s `key:` syntax tint. */
const KEY_VALUE_RE = /^([\w.-]+):\s*(.*)$/;

/** TOML's equivalents for the same raw-view tint: a `key = value` assignment and a `[section]` / `[[array-of-tables]]` header. */
const TOML_KEY_VALUE_RE = /^\s*("[^"]*"|'[^']*'|[\w.-]+)\s*=/;
/** A comma excludes an array continuation line such as `  [1, 2]`, which is a value, not a header. */
const TOML_SECTION_RE = /^\s*\[\[?[^\],]*\]\]?\s*$/;

/** Character budget for a deeper-than-one-level value's compact JSON grid row, before it is ellipsised. */
const DEEP_VALUE_MAX_CHARS = 160;

/** Shown instead of the compact JSON when the value cannot be serialized (a cyclic anchor, a BigInt). */
const UNSERIALIZABLE_TEXT = '<unserializable value>';

/** Topline note for the `invalid` state, which has no source position to report. */
const NON_MAP_TEXT = 'Not a key/value map';

/**
 * Topline note when parsing failed but the error carried no source position.
 * Every error js-yaml raises inside a `---` block carries a `mark` today (the
 * mark-less multi-document class can't occur: `markdown-it-front-matter` ends
 * the block at `...`), but the note must exist regardless — it is what makes a
 * fallback card distinguishable from a parsed one, including for the `N lines`
 * count label.
 */
const PARSE_ERROR_TEXT = 'Parse error';

/** The time-of-day part of an ISO string whose UTC clock reads exactly midnight — such a value displays as a bare date. */
const MIDNIGHT_UTC_SUFFIX = 'T00:00:00.000Z';

/** Keys promoted out of the key/value grid into the title/badge/meta slots (tokens.json `fieldMapping`). */
const PROMOTED_KEYS = new Set(['title', 'status', 'type', 'priority', 'created', 'updated']);

/**
 * Display shape of one top-level field's value — the taxonomy the card's grid
 * can represent. `raw` is the catch-all full-width row: it spans both columns
 * and renders no separate key cell, so its `text` must carry the key itself.
 */
export type FrontMatterValue =
  | { kind: 'scalar'; text: string }
  | { kind: 'list'; items: string[] }
  /** A string containing a newline (block scalar or quoted multi-line): full-width, `pre-wrap`, clamped. */
  | { kind: 'text'; text: string }
  /** One level deep, every child a scalar or `Date`: an indented sub-grid. */
  | { kind: 'map'; entries: { key: string; text: string }[] }
  | { kind: 'raw'; text: string };

export interface FrontMatterField {
  key: string;
  value: FrontMatterValue;
}

export interface FrontMatterParseResult {
  invalid: boolean;
  /**
   * Topline note shown next to the field count: `Line N` (1-based, relative to
   * the front-matter block) when the parser reported a position, otherwise a
   * fixed message. `undefined` on a block that parsed cleanly — so a card
   * carrying a note is always a raw-row fallback, never a normal card.
   */
  errorNote: string | undefined;
  fields: FrontMatterField[];
  /** Collapsed-row / expanded-card title: the `title` field's promotable text if non-blank, else the first promotable field formatted `key: value`. `undefined` when there isn't one. */
  title: string | undefined;
  /** The key `title` resolved from (either the literal `title` field, or the fallback field) — excluded a second time from the key/value grid. */
  titleKey: string | undefined;
  /** `status` field's promotable text, for the coloured badge — `undefined` when absent, blank, or not promotable. */
  status: string | undefined;
}

/** A plain `{}` map — deliberately NOT `typeof v === 'object'`, which a `Date` and a `Uint8Array` both pass. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Canonical display text for a scalar, or `undefined` when the value is a
 * richer shape the caller must handle. Display-only: the file keeps its own
 * bytes, so `007` shows as `7` and an offset timestamp shows shifted to UTC.
 */
function canonicalScalar(v: unknown): string | undefined {
  if (v === null || v === undefined) {
    return ''; // `key:` / `key: ~` -- an empty cell, never the JS string "undefined".
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number') {
    return String(v);
  }
  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }
  if (typeof v === 'bigint') {
    // TOML's out-of-safe-range integer (US-2.10). It must resolve here: falling
    // through to the deeper-structure row would hand it to `JSON.stringify`,
    // which throws on a BigInt, and the row would read "unserializable".
    return String(v);
  }
  if (v instanceof Date) {
    const iso = v.toISOString();
    // Trim the time suffix by length, never `slice(0, 10)`: a rolled-over date
    // (`9999-99-99`) yields the 6-digit extended year form, which a fixed cut
    // would truncate mid-year into garbage.
    if (iso.endsWith(MIDNIGHT_UTC_SUFFIX)) {
      return iso.slice(0, -MIDNIGHT_UTC_SUFFIX.length);
    }
    // smol-toml's TomlDate extends Date and overrides toISOString() to emit the
    // TOML form, which ends in `Z`, an offset, or nothing at all (a local
    // datetime / local time keeps the source's own wall clock, never a
    // UTC-shifted one) — so drop a zero millisecond component wherever it sits
    // rather than only before a `Z`. A plain string replace is enough: the
    // fractional seconds are the only `.` any of these forms contains.
    return iso.replace('.000', '');
  }
  return undefined;
}

/** Compact JSON for a deeper-than-one-level value, ellipsised to a fixed budget. Never throws: a cyclic anchor or a BigInt would otherwise escape `render()` and blank the whole preview. */
function compactJson(v: unknown): string {
  let json: string | undefined;
  try {
    // TOML hands every integer over as a `bigint`, which `JSON.stringify`
    // throws on. Without the replacer a whole nested table degrades to the
    // placeholder just because one child is an ordinary integer.
    json = JSON.stringify(v, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value));
  } catch {
    return UNSERIALIZABLE_TEXT;
  }
  if (json === undefined) {
    return UNSERIALIZABLE_TEXT;
  }
  if (json.length <= DEEP_VALUE_MAX_CHARS) {
    return json;
  }
  // Back off one unit when the budget lands between a surrogate pair, which
  // would otherwise render as a replacement character.
  const lastCode = json.charCodeAt(DEEP_VALUE_MAX_CHARS - 1);
  const cut = lastCode >= 0xd800 && lastCode <= 0xdbff ? DEEP_VALUE_MAX_CHARS - 1 : DEEP_VALUE_MAX_CHARS;
  return `${json.slice(0, cut)}…`;
}

/** Classify one top-level value into the grid's display taxonomy. `key` is only used for the raw row, which renders no key cell of its own. */
function toFieldValue(key: string, v: unknown): FrontMatterValue {
  const scalar = canonicalScalar(v);
  if (scalar !== undefined) {
    return scalar.includes('\n') ? { kind: 'text', text: scalar } : { kind: 'scalar', text: scalar };
  }
  if (Array.isArray(v)) {
    const items: string[] = [];
    for (const item of v) {
      const text = canonicalScalar(item);
      if (text === undefined) {
        return { kind: 'raw', text: `${key}: ${compactJson(v)}` }; // an array holding a map/array is deeper structure.
      }
      items.push(text);
    }
    return { kind: 'list', items };
  }
  if (isPlainObject(v)) {
    const entries: { key: string; text: string }[] = [];
    for (const [childKey, childValue] of Object.entries(v)) {
      const text = canonicalScalar(childValue);
      // A multi-line child bails out too: the sub-grid's cells are
      // `nowrap`/`ellipsis`, so a block scalar there would silently clip.
      if (text === undefined || text.includes('\n')) {
        return { kind: 'raw', text: `${key}: ${compactJson(v)}` }; // deeper than one level.
      }
      entries.push({ key: childKey, text });
    }
    if (entries.length === 0) {
      return { kind: 'raw', text: `${key}: ${compactJson(v)}` }; // an empty map, rather than an empty sub-grid box.
    }
    return { kind: 'map', entries };
  }
  return { kind: 'raw', text: `${key}: ${compactJson(v)}` }; // an explicit-tag value (`!!binary`, `!!omap`) and anything else.
}

/** Text a field may contribute to the title/badge/meta slots: a scalar as-is, a multi-line value's first line only. `undefined` for shapes that are never promoted. */
function promotableText(field: FrontMatterField): string | undefined {
  if (field.value.kind === 'scalar') {
    return field.value.text;
  }
  if (field.value.kind === 'text') {
    return field.value.text.split('\n')[0];
  }
  return undefined;
}

/** Promotable text that is actually worth showing — a blank one demotes the field back into the grid instead of vanishing from the card. */
function nonBlankPromotable(field: FrontMatterField): string | undefined {
  const text = promotableText(field);
  return text !== undefined && text.trim() !== '' ? text : undefined;
}

/**
 * Parser-agnostic adapter: turns an ALREADY-PARSED value into the render
 * result. Takes no raw text and imports no parser, so US-2.10 (TOML) and
 * US-2.11 (JSON) can feed it their own parsed object unchanged.
 */
export function buildFrontMatterFields(parsed: unknown): FrontMatterParseResult {
  if (parsed === null || parsed === undefined) {
    // Empty or comment-only front matter: a valid block with zero fields, not
    // an error -- the collapsed row and its toggle must still work.
    return { invalid: false, errorNote: undefined, fields: [], title: undefined, titleKey: undefined, status: undefined };
  }
  if (!isPlainObject(parsed)) {
    // A bare scalar, a top-level list, a Date, a Uint8Array: front matter is by
    // definition a set of key/value fields, so there is nothing to show.
    return buildInvalidParseResult(undefined);
  }
  // Object.entries yields document order for ordinary keys and always yields
  // string labels, including for a source key that wasn't written as a string.
  const fields: FrontMatterField[] = Object.entries(parsed).map(([key, value]) => ({ key, value: toFieldValue(key, value) }));

  const titleField = fields.find((f) => f.key === 'title' && nonBlankPromotable(f) !== undefined);
  const firstPromotable = fields.find((f) => nonBlankPromotable(f) !== undefined);
  const title = titleField
    ? (nonBlankPromotable(titleField) as string)
    : firstPromotable
      ? `${firstPromotable.key}: ${nonBlankPromotable(firstPromotable) as string}`
      : undefined;
  const statusField = fields.find((f) => f.key === 'status');

  return {
    invalid: false,
    errorNote: undefined,
    fields,
    title,
    titleKey: titleField ? titleField.key : firstPromotable?.key,
    status: statusField ? nonBlankPromotable(statusField) : undefined,
  };
}

/** The `invalid` error frame's result. `errorLine` is optional because YAML's non-map case has no source position; US-2.10's TOML path does. */
export function buildInvalidParseResult(errorLine: number | undefined): FrontMatterParseResult {
  return {
    invalid: true,
    errorNote: errorLine === undefined ? NON_MAP_TEXT : `Line ${errorLine}`,
    fields: [],
    title: undefined,
    titleKey: undefined,
    status: undefined,
  };
}

/** Parse failed: show every source line verbatim as its own full-width row rather than hiding what the user wrote behind an error frame. */
function buildRawLineFallback(raw: string, errorLine: number | undefined): FrontMatterParseResult {
  const fields: FrontMatterField[] = raw
    .split('\n')
    // A CRLF document reaches the webview unnormalized, so drop the trailing CR
    // rather than rendering it inside the `pre-wrap` cell.
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.trim() !== '')
    .map((line) => ({ key: line, value: { kind: 'raw', text: line } as FrontMatterValue }));
  return {
    invalid: false,
    errorNote: errorLine === undefined ? PARSE_ERROR_TEXT : `Line ${errorLine}`,
    fields,
    title: undefined,
    titleKey: undefined,
    status: undefined,
  };
}

/** YAML entry point — the only place `js-yaml` is used. See the module docstring for the `{ json: true }` duplicate-key rule and the throw-is-not-invalid rule. */
export function parseFrontMatterFields(raw: string): FrontMatterParseResult {
  let parsed: unknown;
  try {
    parsed = load(raw, { json: true });
  } catch (err) {
    // `mark.line` is 0-based and relative to the text between the `---` fences.
    const mark = (err as { mark?: { line?: number } }).mark;
    return buildRawLineFallback(raw, typeof mark?.line === 'number' ? mark.line + 1 : undefined);
  }
  return buildFrontMatterFields(parsed);
}

/**
 * 1-based line, relative to the front-matter block, that a `smol-toml` parse
 * failure points at — `TomlError` carries `line` directly, already relative to
 * the string handed to `parse()`. Falls back to line 1 only when the thrown
 * value carries no usable position at all; `err.name` is plain `Error`, so the
 * position must be probed, never inferred from the error's class.
 */
export function tomlErrorLine(err: unknown): number {
  // Optional chaining, not a bare property read: a thrown `null` would
  // otherwise raise a TypeError from inside the catch that called this and
  // blank the entire preview instead of one block.
  const line = (err as { line?: unknown } | null | undefined)?.line;
  return typeof line === 'number' && Number.isFinite(line) && line >= 1 ? line : 1;
}

/**
 * TOML entry point — the only place `smol-toml` is used. Unlike YAML, a parse
 * failure IS the invalid state: TOML's grammar guarantees a map at the top
 * level, so the only way to fail is malformed source, which has a real position
 * worth showing (a duplicate key throws here too, rather than resolving
 * last-wins the way js-yaml's `{ json: true }` does).
 *
 * `integersAsBigInt` is load-bearing, not a tweak: without it `parse()` throws
 * on any integer outside the JS safe range, so a perfectly valid file would
 * render as an error frame.
 */
export function parseTomlFrontMatterFields(raw: string): FrontMatterParseResult {
  let parsed: unknown;
  // Only the parse call belongs inside the try. Wrapping the field-building
  // too would relabel any rendering bug as a syntax error the user does not
  // have, reported at a line number invented by the fallback.
  try {
    parsed = parseToml(raw, { integersAsBigInt: true });
  } catch (err) {
    return buildInvalidParseResult(tomlErrorLine(err));
  }
  return buildFrontMatterFields(parsed);
}

/** `unit` is `line` on a raw-row fallback card: those rows are source lines, not fields the parser resolved. */
function countLabel(n: number, unit: 'field' | 'line'): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Neutral/done/draft/blocked status-dot bucket (README: "done = teal, draft = amber, blocked = red, else neutral"). */
function statusBadgeClass(status: string): string {
  switch (status.trim().toLowerCase()) {
    case 'done':
      return 'done';
    case 'draft':
      return 'draft';
    case 'blocked':
      return 'blocked';
    default:
      return 'neutral';
  }
}

function buildStatusBadge(status: string): string {
  const cls = statusBadgeClass(status);
  return (
    `<span class="md-fm-badge md-fm-badge-status md-fm-status-${cls}">` +
    `<span class="md-fm-status-dot" aria-hidden="true"></span>${escapeHtml(status)}` +
    `</span>`
  );
}

function buildBadgesRow(fields: FrontMatterField[], status: string | undefined): string {
  const byKey = (k: string): string | undefined => {
    const field = fields.find((f) => f.key === k);
    return field ? nonBlankPromotable(field) : undefined;
  };
  const type = byKey('type');
  const priority = byKey('priority');
  const created = byKey('created');
  const updated = byKey('updated');
  if (!type && !priority && !status && !created && !updated) {
    return '';
  }
  let html = '<div class="md-fm-badges">';
  if (type) {
    html += `<span class="md-fm-badge">${escapeHtml(type)}</span>`;
  }
  if (priority) {
    html += `<span class="md-fm-badge">${escapeHtml(priority)}</span>`;
  }
  if (status) {
    html += buildStatusBadge(status);
  }
  if (created) {
    html += `<span class="md-fm-meta">created ${escapeHtml(created)}</span>`;
  }
  if (updated) {
    html += `<span class="md-fm-meta">updated ${escapeHtml(updated)}</span>`;
  }
  html += '</div>';
  return html;
}

function buildGridRow(field: FrontMatterField): string {
  const value = field.value;
  if (value.kind === 'raw') {
    // Spans both columns and renders no key cell, so `text` carries the key.
    return `<div class="md-fm-grid-row md-fm-grid-row-raw"><div class="md-fm-value md-fm-value-raw">${escapeHtml(value.text)}</div></div>`;
  }
  const keyCell = `<div class="md-fm-key" title="${escapeAttr(field.key)}">${escapeHtml(field.key)}</div>`;
  if (value.kind === 'list') {
    const items = value.items.map((v) => `<div class="md-fm-value-item" title="${escapeAttr(v)}">${escapeHtml(v)}</div>`).join('');
    return `<div class="md-fm-grid-row">${keyCell}<div class="md-fm-value md-fm-value-list">${items}</div></div>`;
  }
  if (value.kind === 'text') {
    // `.md-fm-value-raw` spans the full width under the key cell and is
    // `pre-wrap` + height-clamped -- the plain `.md-fm-value` cell is
    // `nowrap`/`ellipsis` and would silently clip a block scalar to one line.
    return `<div class="md-fm-grid-row">${keyCell}<div class="md-fm-value md-fm-value-raw">${escapeHtml(value.text)}</div></div>`;
  }
  if (value.kind === 'map') {
    const entries = value.entries
      .map(
        (e) =>
          `<div class="md-fm-key" title="${escapeAttr(e.key)}">${escapeHtml(e.key)}</div>` +
          `<div class="md-fm-value" title="${escapeAttr(e.text)}">${escapeHtml(e.text)}</div>`
      )
      .join('');
    return `<div class="md-fm-grid-row">${keyCell}<div class="md-fm-subgrid">${entries}</div></div>`;
  }
  return `<div class="md-fm-grid-row">${keyCell}<div class="md-fm-value" title="${escapeAttr(value.text)}">${escapeHtml(value.text)}</div></div>`;
}

function buildBodyHtml(parsed: FrontMatterParseResult): string {
  // Exclusion by key name is safe: the parser resolves duplicate keys before
  // this point, so at most one field ever carries a given key.
  // Only a plain scalar is fully represented by its promoted slot. A multi-line
  // value contributes just its first line there, so it stays in the grid too --
  // dropping it would leave the rest of the block scalar nowhere in the card.
  const fullyPromoted = (f: FrontMatterField): boolean => f.value.kind === 'scalar' && nonBlankPromotable(f) !== undefined;
  const promoted = new Set<string>();
  for (const key of PROMOTED_KEYS) {
    const field = parsed.fields.find((f) => f.key === key);
    if (field && fullyPromoted(field)) {
      promoted.add(key);
    }
  }
  const titleField = parsed.titleKey ? parsed.fields.find((f) => f.key === parsed.titleKey) : undefined;
  if (titleField && fullyPromoted(titleField)) {
    promoted.add(titleField.key);
  }
  const gridRows = parsed.fields
    .filter((f) => !promoted.has(f.key))
    .map((f) => buildGridRow(f))
    .join('');
  return (
    `<div class="md-fm-body">` +
    `<div class="md-fm-title">${escapeHtml(parsed.title ?? '')}</div>` +
    buildBadgesRow(parsed.fields, parsed.status) +
    (gridRows ? `<div class="md-fm-hairline"></div><div class="md-fm-grid">${gridRows}</div>` : '') +
    `</div>`
  );
}

/**
 * Split point for the raw view's syntax tint: the end of the line's "key" part,
 * or -1 for a line that gets no tint (a continuation line, a comment, a blank).
 * YAML tints `key:`; TOML tints `key =` and a whole `[section]` header. The two
 * `.md-fm-yaml-*` class names are the shipped tint palette, shared by both
 * formats rather than duplicated under a second name.
 */
function tintSplit(line: string, format: FrontMatterFormat): number {
  if (format === 'toml') {
    if (TOML_SECTION_RE.test(line)) {
      return line.length;
    }
    // The match's own length, never `indexOf('=')`: a quoted key may itself
    // contain an `=`, and splitting on the first one would cut through it.
    const assignment = TOML_KEY_VALUE_RE.exec(line);
    return assignment ? assignment[0].length : -1;
  }
  return KEY_VALUE_RE.test(line) ? line.indexOf(':') + 1 : -1;
}

/** Minimal syntax tint for the raw view: the key part in one span, the rest of the line in another. `KEY_VALUE_RE` now exists only for this tint, not for parsing. */
function buildRawBodyHtml(raw: string, format: FrontMatterFormat): string {
  const tinted = raw
    .split('\n')
    .map((line) => {
      const split = tintSplit(line, format);
      if (split === -1) {
        return escapeHtml(line);
      }
      return `<span class="md-fm-yaml-key">${escapeHtml(line.slice(0, split))}</span><span class="md-fm-yaml-string">${escapeHtml(line.slice(split))}</span>`;
    })
    .join('\n');
  return `<pre class="md-fm-raw-body">${tinted}</pre>`;
}

/**
 * Topline label. YAML — every currently-shipped document — reads exactly
 * `FRONT MATTER`; any other format appends a ` · <FORMAT>` tag. Deliberately
 * generic rather than a TOML-specific branch, so US-2.11 reuses it for JSON.
 */
function formatLabel(format: FrontMatterFormat): string {
  return format === 'yaml' ? 'FRONT MATTER' : `FRONT MATTER · ${format.toUpperCase()}`;
}

/**
 * The source fences a block is re-emitted with. Shared by the Copy button and
 * turndown's `frontMatter` rule — the two must agree byte-for-byte, or a save
 * would re-fence the block into a format the user never wrote.
 */
export function frontMatterFence(format: string | null | undefined): string {
  return format === 'toml' ? '+++' : '---';
}

function buildInvalidHtml(raw: string, rawAttr: string, line: number, note: string, format: FrontMatterFormat): string {
  // YAML's non-map top level has no source position, so the topline states the
  // shape problem instead of a misleading "Line 1". `.md-fm-error-line` is the
  // topline's error-meta slot, not a line-number-only element.
  // `data-fm-format` must be here too, not only on the valid-state wrapper: a
  // malformed TOML block saved through a format-less wrapper would come back
  // fenced in `---` and silently corrupt the file.
  return (
    `<div class="${FRONT_MATTER_CLASS}" ${LINE_NUMBER_ATTR}="${line}" contenteditable="false" data-raw="${rawAttr}" data-fm-format="${format}" data-fm-view="invalid" role="status">` +
    `<div class="md-fm-topline">` +
    `<span class="md-fm-label md-fm-label-error">${formatLabel(format)} — INVALID</span>` +
    `<span class="md-fm-error-line">${escapeHtml(note)}</span>` +
    `</div>` +
    `<pre class="md-fm-error-body">${escapeHtml(raw)}</pre>` +
    `</div>\n`
  );
}

/**
 * Full collapsed+expanded+raw markup for one front-matter block, Node/domino-
 * safe (string building only, no DOM APIs) — called from `render.ts`. All
 * three states' markup coexist in the DOM; `data-fm-view`/`data-fm-raw` on the
 * wrapper (toggled by `initFrontMatterToggle`, CSS-driven visibility) pick
 * which one shows, the same "attribute is the state" shape as diagram-frame.ts.
 */
export function buildFrontMatterHtml(raw: string, line: number, parsed: FrontMatterParseResult, format: FrontMatterFormat = 'yaml'): string {
  const rawAttr = escapeAttr(raw);
  if (parsed.invalid) {
    return buildInvalidHtml(raw, rawAttr, line, parsed.errorNote ?? NON_MAP_TEXT, format);
  }
  const formatName = format.toUpperCase();
  // A note on a valid block means the raw-row fallback: its rows are source
  // lines, so calling them "fields" would claim a parse that never happened.
  const label = countLabel(parsed.fields.length, parsed.errorNote === undefined ? 'field' : 'line');
  const titleText = parsed.title ?? '';
  const ariaLabel = `Front matter, ${label}`;

  const topline =
    `<button type="button" class="md-fm-toggle" aria-expanded="false" aria-label="${escapeAttr(ariaLabel)}">` +
    `<span class="md-fm-chevron" aria-hidden="true"></span>` +
    `<span class="md-fm-label">${formatLabel(format)}</span>` +
    `<span class="md-fm-row-title" title="${escapeAttr(titleText)}">${escapeHtml(titleText)}</span>` +
    `<span class="md-fm-count">${label}</span>` +
    `</button>` +
    // Raw-row fallback only: parsing stopped, but the card still shows every
    // source line rather than hiding them behind an error frame.
    (parsed.errorNote !== undefined ? `<span class="md-fm-error-line">${escapeHtml(parsed.errorNote)}</span>` : '') +
    `<div class="md-fm-actions" contenteditable="false">` +
    `<button type="button" class="md-fm-raw-toggle" aria-pressed="false" title="Show raw ${formatName}">RAW</button>` +
    `<button type="button" class="md-fm-copy" aria-label="Copy front matter ${formatName}">Copy</button>` +
    `</div>`;
  const body = buildBodyHtml(parsed);
  const rawBody = buildRawBodyHtml(raw, format);

  return (
    `<div class="${FRONT_MATTER_CLASS}" ${LINE_NUMBER_ATTR}="${line}" contenteditable="false" data-raw="${rawAttr}" data-fm-format="${format}" data-fm-view="collapsed" data-fm-raw="false">` +
    `<div class="md-fm-topline">${topline}</div>` +
    body +
    rawBody +
    `<div class="md-fm-live" role="status" aria-live="polite"></div>` +
    `</div>\n`
  );
}

// ---------------------------------------------------------------------------
// Webview-only: toggle interactions + in-session persistence.
// Never called from render.ts's Node/domino path, exactly like
// diagram-frame.ts's initDiagramFrameToolbar / math-edit.ts.
// ---------------------------------------------------------------------------

const COPY_LABEL_RESET_MS = 1200;

/** Pending "reset to Copy" timeout per copy button, so a rapid double-click clears the earlier timeout instead of racing it (the earlier timeout would otherwise fire second and leave the label stuck on "Copied"). */
const pendingCopyReset = new WeakMap<HTMLElement, number>();

/** Boundaries: no extension-host/workspace-state persistence — module-level state only, reapplied by main.ts's renderDocument() after every re-render, for as long as the webview stays open. */
let lastView: 'collapsed' | 'expanded' = 'collapsed';
let lastRaw = false;

/** Delegated interactions for every `.md-front-matter` block: row/header toggle, RAW toggle, copy. One module owns all three, same shape as diagram-frame.ts/math-edit.ts. */
export function initFrontMatterToggle(content: HTMLElement): void {
  content.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.md-fm-toggle, .md-fm-raw-toggle, .md-fm-copy')) {
      e.preventDefault();
    }
  });

  content.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const copyBtn = target.closest('.md-fm-copy') as HTMLElement | null;
    if (copyBtn) {
      const wrapper = copyBtn.closest(`.${FRONT_MATTER_CLASS}`) as HTMLElement | null;
      const raw = wrapper?.getAttribute('data-raw') ?? '';
      // The clipboard gets the SOURCE fences, byte-for-byte: a TOML block copied
      // out under `---` would not paste back as the front matter it came from.
      const format = wrapper?.getAttribute('data-fm-format') ?? 'yaml';
      const fence = frontMatterFence(format);
      if (!navigator.clipboard) {
        return; // No Clipboard API in this context -- nothing to do (avoid a sync throw).
      }
      navigator.clipboard
        .writeText(`${fence}\n${raw}\n${fence}`)
        .then(() => {
          const pending = pendingCopyReset.get(copyBtn);
          if (pending !== undefined) {
            window.clearTimeout(pending);
          }
          copyBtn.textContent = 'Copied';
          const live = wrapper?.querySelector('.md-fm-live');
          if (live) {
            live.textContent = `Copied front matter ${format.toUpperCase()}`;
          }
          pendingCopyReset.set(
            copyBtn,
            window.setTimeout(() => {
              copyBtn.textContent = 'Copy';
              pendingCopyReset.delete(copyBtn);
            }, COPY_LABEL_RESET_MS)
          );
        })
        .catch(() => {
          /* No clipboard-write permission -- leave the button unchanged. */
        });
      return;
    }

    const rawToggle = target.closest('.md-fm-raw-toggle') as HTMLElement | null;
    if (rawToggle) {
      const wrapper = rawToggle.closest(`.${FRONT_MATTER_CLASS}`) as HTMLElement | null;
      if (!wrapper) {
        return;
      }
      lastRaw = wrapper.getAttribute('data-fm-raw') !== 'true';
      wrapper.setAttribute('data-fm-raw', String(lastRaw));
      rawToggle.setAttribute('aria-pressed', String(lastRaw));
      return;
    }

    const toggle = target.closest('.md-fm-toggle') as HTMLElement | null;
    if (toggle) {
      const wrapper = toggle.closest(`.${FRONT_MATTER_CLASS}`) as HTMLElement | null;
      if (!wrapper) {
        return;
      }
      lastView = wrapper.getAttribute('data-fm-view') === 'expanded' ? 'collapsed' : 'expanded';
      wrapper.setAttribute('data-fm-view', lastView);
      toggle.setAttribute('aria-expanded', String(lastView === 'expanded'));
    }
  });
}

/**
 * Reapply the last known collapsed/expanded/raw state onto a freshly-rendered
 * `.md-front-matter` node — main.ts calls this right after `content.innerHTML
 * = html` on every render, so the state survives a keystroke-triggered
 * re-render (Boundaries: in-memory only, not across a reload). No-op on an
 * invalid block, which carries no toggle state.
 */
export function applyFrontMatterViewState(content: HTMLElement): void {
  const wrapper = content.querySelector(`.${FRONT_MATTER_CLASS}`) as HTMLElement | null;
  const view = wrapper?.getAttribute('data-fm-view');
  if (!wrapper || view === 'invalid') {
    return;
  }
  wrapper.setAttribute('data-fm-view', lastView);
  wrapper.setAttribute('data-fm-raw', String(lastRaw));
  wrapper.querySelector('.md-fm-toggle')?.setAttribute('aria-expanded', String(lastView === 'expanded'));
  wrapper.querySelector('.md-fm-raw-toggle')?.setAttribute('aria-pressed', String(lastRaw));
}
