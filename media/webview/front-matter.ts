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
 * Hand-rolled minimal parser (Boundaries — NEVER a full YAML parser, no new
 * npm dependency): flat `key: value` scalars and single-line flow arrays
 * (`key: [a, b]`) only. A line that isn't `key:`-shaped at all (no colon,
 * meaning the front matter isn't line-based key/value text) flips the WHOLE
 * block to the invalid state. A field written in a richer form this parser
 * doesn't cover (nested map, block scalar `|`/`>`, block-style `- ` list, an
 * array/string left open without its closing bracket/quote) falls back to a
 * raw `key: <original line>` grid row instead — it does NOT invalidate the
 * rest of the block.
 */
import { FRONT_MATTER_CLASS, LINE_NUMBER_ATTR } from './render';
import { escapeHtml, escapeAttr } from './dom-utils';

/** Matches `--fm-collapse-threshold` in editor.css (ported from tokens.css) — keep both in sync by hand. */
export const FM_COLLAPSE_THRESHOLD = 2;

const KEY_VALUE_RE = /^([\w.-]+):\s*(.*)$/;

/** Keys promoted out of the key/value grid into the title/badge/meta slots (tokens.json `fieldMapping`). */
const PROMOTED_KEYS = new Set(['title', 'status', 'type', 'priority', 'created', 'updated']);

export interface FrontMatterField {
  key: string;
  /** Parsed value, or `undefined` when this one field is an unsupported form (see `rawLine`). */
  value: string | string[] | undefined;
  /** Verbatim source line(s) (key + original value text) for the raw-fallback grid row — only set when `value` is `undefined`. */
  rawLine: string | undefined;
}

export interface FrontMatterParseResult {
  invalid: boolean;
  /** 1-based line number, relative to the front-matter block, of the first non-`key:`-shaped line. Only set when `invalid`. */
  invalidLine: number | undefined;
  fields: FrontMatterField[];
  /** Collapsed-row / expanded-card title: the `title` field's value (quotes stripped) if present, else the first scalar field formatted `key: value` (I/O matrix "No title field"). `undefined` when there isn't even one scalar field. */
  title: string | undefined;
  /** The key `title` resolved from (either the literal `title` field, or the fallback field) — excluded a second time from the key/value grid. */
  titleKey: string | undefined;
  /** `status` field's value, for the coloured badge — `undefined` if absent or not a plain scalar. */
  status: string | undefined;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** True unless `s` opens with a quote it never closes (an unterminated quoted scalar — richer than this parser handles). */
function isBalancedQuoted(s: string): boolean {
  if (s.length === 0) {
    return true;
  }
  const first = s[0];
  if (first !== '"' && first !== "'") {
    return true;
  }
  return s.length >= 2 && s[s.length - 1] === first;
}

/** Split a flow array's inner text (between `[` and `]`) on top-level commas, quote-aware. `undefined` on an unterminated quote inside it. */
function splitFlowArrayItems(inner: string): string[] | undefined {
  if (inner.trim() === '') {
    return [];
  }
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === ']') {
      // A nested flow array (`[[a,b],[c,d]]`) is richer than this parser
      // handles -- bail to the raw-line fallback instead of splitting on its
      // commas blindly, which would silently corrupt the item list.
      return undefined;
    }
    if (ch === ',') {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  items.push(current);
  if (quote) {
    return undefined;
  }
  return items.map((item) => stripQuotes(item.trim()));
}

/** Pure parse — see the module docstring for exactly what this hand-rolled parser covers. */
export function parseFrontMatterFields(raw: string): FrontMatterParseResult {
  const lines = raw.split('\n');
  const fields: FrontMatterField[] = [];
  let invalid = false;
  let invalidLine: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      continue; // a blank separator line -- not a field, not an error.
    }
    if (/^\s/.test(line)) {
      // Indented continuation of the previous key: nested map child, block
      // scalar body, or block-style list item -- richer than this parser
      // handles. Falls back to a raw grid row for THAT field (Boundaries),
      // never the whole-block invalid state -- unless there IS no previous
      // field to attach to, which really is malformed structure.
      const prev = fields[fields.length - 1];
      if (!prev) {
        invalid = true;
        invalidLine = i + 1;
        break;
      }
      if (prev.rawLine === undefined) {
        // First continuation seen for this field -- seed the fallback text from
        // its already-parsed value (not just the bare key) so a scalar/array
        // value isn't lost when it turns out to have a continuation after all.
        const prevValueText = Array.isArray(prev.value) ? `[${prev.value.join(', ')}]` : (prev.value ?? '');
        prev.rawLine = `${prev.key}: ${prevValueText}`;
      }
      prev.value = undefined;
      prev.rawLine = `${prev.rawLine}\n${line}`;
      continue;
    }
    const m = KEY_VALUE_RE.exec(line);
    if (!m) {
      invalid = true;
      invalidLine = i + 1;
      break;
    }
    const key = m[1];
    const valueText = m[2].trim();
    if (valueText.startsWith('[') && valueText.endsWith(']')) {
      const items = splitFlowArrayItems(valueText.slice(1, -1));
      fields.push(items === undefined ? { key, value: undefined, rawLine: line } : { key, value: items, rawLine: undefined });
      continue;
    }
    if (valueText.startsWith('[') || !isBalancedQuoted(valueText)) {
      fields.push({ key, value: undefined, rawLine: line });
      continue;
    }
    fields.push({ key, value: stripQuotes(valueText), rawLine: undefined });
  }

  if (invalid) {
    return { invalid: true, invalidLine, fields: [], title: undefined, titleKey: undefined, status: undefined };
  }

  const nonBlankScalar = (f: FrontMatterField): boolean => typeof f.value === 'string' && f.value.trim() !== '';
  const titleField = fields.find((f) => f.key === 'title' && nonBlankScalar(f));
  const firstScalar = fields.find(nonBlankScalar);
  const title = titleField ? (titleField.value as string) : firstScalar ? `${firstScalar.key}: ${firstScalar.value as string}` : undefined;
  const titleKey = titleField ? titleField.key : firstScalar?.key;
  const statusField = fields.find((f) => f.key === 'status' && typeof f.value === 'string');

  return { invalid: false, invalidLine: undefined, fields, title, titleKey, status: statusField?.value as string | undefined };
}

function fieldCountLabel(n: number): string {
  return `${n} field${n === 1 ? '' : 's'}`;
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

function buildStatusBadge(status: string, inline: boolean): string {
  const cls = statusBadgeClass(status);
  return (
    `<span class="md-fm-badge md-fm-badge-status md-fm-status-${cls}${inline ? ' md-fm-badge-inline' : ''}">` +
    `<span class="md-fm-status-dot" aria-hidden="true"></span>${escapeHtml(status)}` +
    `</span>`
  );
}

function buildBadgesRow(fields: FrontMatterField[], status: string | undefined): string {
  const byKey = (k: string): FrontMatterField | undefined => fields.find((f) => f.key === k && typeof f.value === 'string');
  const type = byKey('type');
  const priority = byKey('priority');
  const created = byKey('created');
  const updated = byKey('updated');
  if (!type && !priority && !status && !created && !updated) {
    return '';
  }
  let html = '<div class="md-fm-badges">';
  if (type) {
    html += `<span class="md-fm-badge">${escapeHtml(type.value as string)}</span>`;
  }
  if (priority) {
    html += `<span class="md-fm-badge">${escapeHtml(priority.value as string)}</span>`;
  }
  if (status) {
    html += buildStatusBadge(status, false);
  }
  if (created) {
    html += `<span class="md-fm-meta">created ${escapeHtml(created.value as string)}</span>`;
  }
  if (updated) {
    html += `<span class="md-fm-meta">updated ${escapeHtml(updated.value as string)}</span>`;
  }
  html += '</div>';
  return html;
}

function buildGridRow(field: FrontMatterField): string {
  if (field.value === undefined) {
    return (
      `<div class="md-fm-grid-row md-fm-grid-row-raw">` +
      `<div class="md-fm-value md-fm-value-raw">${escapeHtml(field.rawLine ?? field.key)}</div>` +
      `</div>`
    );
  }
  const keyCell = `<div class="md-fm-key" title="${escapeAttr(field.key)}">${escapeHtml(field.key)}</div>`;
  if (Array.isArray(field.value)) {
    const items = field.value.map((v) => `<div class="md-fm-value-item" title="${escapeAttr(v)}">${escapeHtml(v)}</div>`).join('');
    return `<div class="md-fm-grid-row">${keyCell}<div class="md-fm-value md-fm-value-list">${items}</div></div>`;
  }
  return `<div class="md-fm-grid-row">${keyCell}<div class="md-fm-value" title="${escapeAttr(field.value)}">${escapeHtml(field.value)}</div></div>`;
}

function buildBodyHtml(parsed: FrontMatterParseResult): string {
  // Exclude by FIELD IDENTITY, not by key name -- a duplicate `status:`/`type:`
  // line is unusual front matter, but its second occurrence must still show up
  // somewhere (the grid), not vanish just because another field shares its key.
  const promoted = new Set<FrontMatterField>();
  for (const key of PROMOTED_KEYS) {
    const field = parsed.fields.find((f) => f.key === key && typeof f.value === 'string');
    if (field) {
      promoted.add(field);
    }
  }
  if (parsed.titleKey) {
    const titleField = parsed.fields.find((f) => f.key === parsed.titleKey && typeof f.value === 'string');
    if (titleField) {
      promoted.add(titleField);
    }
  }
  const gridRows = parsed.fields
    .filter((f) => !promoted.has(f))
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

/** Minimal syntax tint for the raw view: `key:` in one span, the rest of the line in another — matches the same `KEY_VALUE_RE` the parser itself uses. Indented continuation lines (no top-level key) render untinted. */
function buildRawBodyHtml(raw: string): string {
  const tinted = raw
    .split('\n')
    .map((line) => {
      const colon = KEY_VALUE_RE.test(line) ? line.indexOf(':') : -1;
      if (colon === -1) {
        return escapeHtml(line);
      }
      return `<span class="md-fm-yaml-key">${escapeHtml(line.slice(0, colon + 1))}</span><span class="md-fm-yaml-string">${escapeHtml(line.slice(colon + 1))}</span>`;
    })
    .join('\n');
  return `<pre class="md-fm-raw-body">${tinted}</pre>`;
}

function buildInvalidHtml(raw: string, rawAttr: string, line: number, invalidLine: number): string {
  return (
    `<div class="${FRONT_MATTER_CLASS}" ${LINE_NUMBER_ATTR}="${line}" contenteditable="false" data-raw="${rawAttr}" data-fm-view="invalid" role="status">` +
    `<div class="md-fm-topline">` +
    `<span class="md-fm-label md-fm-label-error">FRONT MATTER — INVALID</span>` +
    `<span class="md-fm-error-line">Line ${invalidLine}</span>` +
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
export function buildFrontMatterHtml(raw: string, line: number, parsed: FrontMatterParseResult): string {
  const rawAttr = escapeAttr(raw);
  if (parsed.invalid) {
    return buildInvalidHtml(raw, rawAttr, line, parsed.invalidLine ?? 1);
  }
  const count = parsed.fields.length;
  const expandable = count > FM_COLLAPSE_THRESHOLD;
  const titleText = parsed.title ?? '';
  const countLabel = fieldCountLabel(count);
  const ariaLabel = `Front matter, ${countLabel}`;

  let topline: string;
  let body = '';
  let rawBody = '';
  if (expandable) {
    topline =
      `<button type="button" class="md-fm-toggle" aria-expanded="false" aria-label="${escapeAttr(ariaLabel)}">` +
      `<span class="md-fm-chevron" aria-hidden="true"></span>` +
      `<span class="md-fm-label">FRONT MATTER</span>` +
      `<span class="md-fm-row-title" title="${escapeAttr(titleText)}">${escapeHtml(titleText)}</span>` +
      `<span class="md-fm-count">${countLabel}</span>` +
      `</button>` +
      `<div class="md-fm-actions" contenteditable="false">` +
      `<button type="button" class="md-fm-raw-toggle" aria-pressed="false" title="Show raw YAML">RAW</button>` +
      `<button type="button" class="md-fm-copy" aria-label="Copy front matter YAML">Copy</button>` +
      `</div>`;
    body = buildBodyHtml(parsed);
    rawBody = buildRawBodyHtml(raw);
  } else {
    topline =
      `<div class="md-fm-line">` +
      `<span class="md-fm-label">FRONT MATTER</span>` +
      `<span class="md-fm-row-title" title="${escapeAttr(titleText)}">${escapeHtml(titleText)}</span>` +
      (parsed.status ? buildStatusBadge(parsed.status, true) : '') +
      `</div>`;
  }

  return (
    `<div class="${FRONT_MATTER_CLASS}" ${LINE_NUMBER_ATTR}="${line}" contenteditable="false" data-raw="${rawAttr}" data-fm-view="${expandable ? 'collapsed' : 'line'}" data-fm-raw="false">` +
    `<div class="md-fm-topline">${topline}</div>` +
    body +
    rawBody +
    (expandable ? `<div class="md-fm-live" role="status" aria-live="polite"></div>` : '') +
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
      if (!navigator.clipboard) {
        return; // No Clipboard API in this context -- nothing to do (avoid a sync throw).
      }
      navigator.clipboard
        .writeText(`---\n${raw}\n---`)
        .then(() => {
          const pending = pendingCopyReset.get(copyBtn);
          if (pending !== undefined) {
            window.clearTimeout(pending);
          }
          copyBtn.textContent = 'Copied';
          const live = wrapper?.querySelector('.md-fm-live');
          if (live) {
            live.textContent = 'Copied front matter YAML';
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
 * re-render (Boundaries: in-memory only, not across a reload). No-op on a
 * line-only (no expand affordance) or invalid block — neither carries a
 * toggle state.
 */
export function applyFrontMatterViewState(content: HTMLElement): void {
  const wrapper = content.querySelector(`.${FRONT_MATTER_CLASS}`) as HTMLElement | null;
  const view = wrapper?.getAttribute('data-fm-view');
  if (!wrapper || view === 'invalid' || view === 'line') {
    return;
  }
  wrapper.setAttribute('data-fm-view', lastView);
  wrapper.setAttribute('data-fm-raw', String(lastRaw));
  wrapper.querySelector('.md-fm-toggle')?.setAttribute('aria-expanded', String(lastView === 'expanded'));
  wrapper.querySelector('.md-fm-raw-toggle')?.setAttribute('aria-pressed', String(lastRaw));
}
