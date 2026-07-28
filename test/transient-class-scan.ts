/**
 * Req 24 US-23.22 — make forgetting to register a transient class impossible.
 *
 * `turndown.ts`'s `TRANSIENT_CLASSES` is the one list that keeps editor-session
 * classes out of the user's `.md` on every raw-HTML serialize path. US-23.6
 * stated the rule ("every future class belongs here too") and US-23.21 cleaned
 * up the classes that had already leaked past it — but nothing stopped the next
 * feature from stamping a class inside `#content` and forgetting the list
 * again. This module is that stop: a grep-style scan of every class stamped in
 * `media/webview/*.ts`, driven from `test/unit.ts`.
 *
 * The two rules compose so that new code is covered without a retroactive sweep
 * of the ~120 class names that already exist:
 *
 *  - **R1** — every class name the scan resolves must be registered in
 *    `TRANSIENT_CLASSES` or listed in `OUTSIDE_CONTENT_CLASSES` below. A brand
 *    new class fails here, naming itself and the file that adds it.
 *  - **R2** — every registered name must be stamped from a named constant
 *    declared in `media/webview/constants.ts` (US-23.22 AC2 / US-23.21 AC6), so
 *    a rename can never desynchronize the strip list from its stamp site.
 *
 * Registering the class R1 flagged is what pulls it into R2, so a `#content`
 * class ends up both registered and declared without either rule having to
 * decide, statically, whether an element is inside `#content` — which a regex
 * cannot know. That undecidability is why `OUTSIDE_CONTENT_CLASSES` exists at
 * all: it grandfathers the names that today's code stamps on `document.body`,
 * on popovers, and on other body-mounted chrome.
 *
 * KNOWN GAPS (deliberate — AC1 enumerates the DOM-API stamp forms, and the two
 * routes below are the "different leak shape" the story explicitly descoped).
 * Both are measured, not assumed, and both must be re-checked if a class ever
 * does appear inside `#content` through them:
 *
 *  1. `dom-utils.ts`'s `el(tag, className)` creation helper (and the local copy
 *     in `cross-file-search.ts`, and `comment-menu.ts`'s `bubbleIcon`). ~135
 *     further class tokens reach the DOM only this way, across ~149 call sites.
 *     Every leak US-23.21 found was stamped with `classList.add`/`toggle` on an
 *     element that ALREADY existed in the document; `el()` builds a fresh node.
 *     Decisive measurement (2026-07-28): `render.ts`, `dom-postprocess.ts`,
 *     `pipeline.ts` and `gutter.ts` — the only modules that build `#content` —
 *     contain zero `el(` call sites, so this route holds no `#content` class.
 *  2. Class names written into HTML template strings and assigned through
 *     `innerHTML`. `front-matter.ts` builds its whole block that way (~35
 *     `md-fm-*` names) and main.ts inserts it INSIDE `#content`; `list-ops.ts`
 *     emits `class="contains-task-list"` the same way. turndown's
 *     `FRONT_MATTER_CLASS` rule replaces that subtree with the source YAML, so
 *     nothing leaks on the rule path — but the raw-HTML paths bypass rules (see
 *     the KNOWN LEAK group in `OUTSIDE_CONTENT_CLASSES`), which is the same
 *     open serialization question, recorded as deferred work.
 *
 * Catch both in code review when a new emitter appears; this scan does not.
 */

export interface SourceFile {
  /** Basename inside `media/webview/`, e.g. `turndown.ts` — used in failure messages. */
  file: string;
  source: string;
}

export interface StampSite {
  file: string;
  line: number;
}

export interface UnresolvedStamp extends StampSite {
  /** The class expression exactly as written, whitespace-collapsed. */
  expr: string;
}

export interface ScanResult {
  /** Resolved class name -> every site that stamps it. */
  names: Map<string, StampSite[]>;
  /** Subset of `names` stamped as a bare string literal at least once. */
  literalNames: Map<string, StampSite[]>;
  /** Stamp expressions the scan cannot read (template literal, ternary, parameter). */
  unresolved: UnresolvedStamp[];
}

/**
 * Stamp sites that the strip list has no business knowing about, keyed
 * `<file> | <class>` — the same per-site key `UNRESOLVED_STAMP_EXEMPTIONS`
 * uses, and per-site for the same reason: a bare class name would pardon that
 * name webview-wide, so once `active` is exempted for a dock row, a future
 * `cell.classList.add('active')` on a `#content` node would pass the gate in
 * silence. Generic one-word names are exactly the ones most likely to be reused
 * on a content node, so the exemption has to name the file it was checked in.
 *
 * A group's comment is its burden of proof. Two kinds of entry live here:
 *
 *  - the element is **not inside `#content`** (body-mounted chrome: toolbar,
 *    TOC rail, right dock, popovers, drag handles and ghosts), so nothing it
 *    carries can ever reach the `.md`; or
 *  - the element **is inside `#content`** but the class is deliberately not
 *    transient — it is document markup a turndown rule reads back, or chrome
 *    another mechanism removes. Those groups say so explicitly, including the
 *    two that are KNOWN LEAKS on the raw-HTML path (see `dom-postprocess.ts`
 *    below) and are exempted here only because fixing them is a serialization
 *    change, not a registration one.
 *
 * This is a grandfather list, not a menu. Adding an entry means "I opened that
 * file, read that stamp site, and it is one of the two cases above". When it is
 * neither, register the class in `TRANSIENT_CLASSES` instead.
 */
export const OUTSIDE_CONTENT_CLASSES: readonly string[] = [
  // --- `main.ts`, `readability.ts`: `document.body` state flags — whole-window
  //     modes, never a content node. ---
  'main.ts | md-line-numbers',
  'main.ts | table-fit-mode',
  'main.ts | wordWrap',
  'readability.ts | reading-mode',
  'readability.ts | reading-no-anim',
  'readability.ts | reading-zen',
  'readability.ts | reading-zen-reveal',

  // --- `drag-drop.ts`, `table.ts`, `external-drop.ts`: drag & drop chrome.
  //     Handles, ghosts, drop lines and context menus are all
  //     `document.body.appendChild`-ed overlays, not document nodes. `dd-dragging`
  //     is a body flag. The drag-drop classes that DO land on a content node
  //     (`dd-hover-outline`, `dd-hover-outline-cell`, `dd-source-muted`,
  //     `dd-drop-target-cell`) are registered instead. ---
  'drag-drop.ts | dd-dragging',
  'drag-drop.ts | dd-drop-line',
  'drag-drop.ts | dd-ghost',
  'drag-drop.ts | dd-ghost-badge',
  'drag-drop.ts | dd-handle',
  'drag-drop.ts | dd-handle--section',
  'drag-drop.ts | dd-li-handle',
  'drag-drop.ts | dd-menu-item',
  'drag-drop.ts | dd-menu-label',
  'drag-drop.ts | dd-menu-popup',
  'drag-drop.ts | dd-menu-sep',
  'drag-drop.ts | dd-table-handle',
  'external-drop.ts | dd-drop-caret',
  'table.ts | dd-col-handle',
  'table.ts | dd-dragging',
  'table.ts | dd-drop-line',
  'table.ts | dd-drop-line-vertical',
  'table.ts | dd-ghost',
  'table.ts | dd-ghost-table',
  'table.ts | dd-handle',
  'table.ts | dd-menu-item',
  'table.ts | dd-menu-popup',
  'table.ts | dd-row-handle',
  'table.ts | dd-row-menu-popup',

  // --- `table.ts`: column measurement. These DO land on a live `#content`
  //     <table>, and are safe only because each add/remove pair is straight-line
  //     synchronous (table.ts:391/413, 430/437, 571/582) — no serialize can run
  //     between them. Introducing an `await`, a rAF, or an early `return` inside
  //     one of those pairs makes them leakable, and nothing here would notice;
  //     recorded as deferred work rather than pretended away. ---
  'table.ts | md-table-col-fit-measuring',
  'table.ts | md-table-col-min-measuring',

  // --- `table.ts`, `table-sticky-header.ts`: table overlays mounted on
  //     `document.body` — the floating sticky header, the floating horizontal
  //     scrollbar, and the table toolbar. ---
  'table-sticky-header.ts | visible',
  'table.ts | visible',
  'table.ts | toolbar-sep',

  // --- `toolbar.ts`: the toolbar strip and its popovers — siblings of
  //     `#content`, never inside it. `contains-task-list` here is the list-block
  //     toolbar action re-stamping document markup (see `dom-utils.ts` below). ---
  'toolbar.ts | active',
  'toolbar.ts | broken-ref-badge',
  'toolbar.ts | contains-task-list',
  'toolbar.ts | is-previewing',
  'toolbar.ts | selected',
  'toolbar.ts | split-btn',
  'toolbar.ts | split-caret',
  'toolbar.ts | split-divider',
  'toolbar.ts | split-main',
  'toolbar.ts | toolbar-more',
  'toolbar.ts | toolbar-more-options',
  'toolbar.ts | toolbar-popover-badge',
  'toolbar.ts | toolbar-popover-caption',
  'toolbar.ts | toolbar-popover-icon',
  'toolbar.ts | toolbar-popover-item',
  'toolbar.ts | toolbar-popover-label',
  'toolbar.ts | toolbar-popover-previewing',
  'toolbar.ts | toolbar-popover-sep',
  'toolbar.ts | toolbar-popover-swatch',
  'toolbar.ts | toolbar-push-right',
  'toolbar.ts | toolbar-sep',

  // --- `caption-edit.ts`, `quick-correct.ts`: single-field editing popovers on
  //     `document.body`. ---
  'caption-edit.ts | caption-edit-input',
  'quick-correct.ts | quick-correct-input',

  // --- `toc.ts`: the table-of-contents rail — its own dock panel, plus two
  //     `document.body` flags. ---
  'toc.ts | active',
  'toc.ts | toc-empty-hint',
  'toc.ts | toc-empty-icon',
  'toc.ts | toc-empty-msg',
  'toc.ts | toc-empty-reset',
  'toc.ts | toc-open',
  'toc.ts | toc-progress-fill',
  'toc.ts | toc-resizing',

  // --- `right-dock.ts`: the dock's tab strip, tab panels and overflow menu. ---
  'right-dock.ts | active',
  'right-dock.ts | open',
  'right-dock.ts | right-dock-menu',
  'right-dock.ts | right-dock-menu-btn',
  'right-dock.ts | right-dock-menu-check',
  'right-dock.ts | right-dock-menu-item',
  'right-dock.ts | right-dock-menu-label',
  'right-dock.ts | right-dock-menu-title',
  'right-dock.ts | right-dock-tab',
  'right-dock.ts | right-dock-tab-badge',
  'right-dock.ts | right-dock-tab-label',
  'right-dock.ts | right-dock-tablist',
  'right-dock.ts | right-dock-tabpanel',
  'right-dock.ts | right-dock-tabs',

  // --- Comment UI mounted on `document.body` (US-23.18's own field registry
  //     lists the same surfaces). The one comment class that DOES land on a
  //     content node, `comment-anchor-active`, is registered instead. ---
  'comment-gutter.ts | comment-gutter-active',
  'comment-gutter.ts | comment-gutter-pin-icon',
  'comment-menu.ts | comment-composer-input',
  'comment-panel.ts | active',
  'comment-panel.ts | comment-card-dragging',
  'comment-panel.ts | comment-reattach-filter',
  'comment-panel.ts | selected',
  'comment-popover.ts | comment-popover-edit-input',
  'comment-popover.ts | comment-popover-reply-input',

  // --- `trigger-popup.ts`: the `/`, `@` and `.` popup — a card on
  //     `document.body`, plus one body flag (`trigger-popup-open`). ---
  'trigger-popup.ts | trigger-popup',
  'trigger-popup.ts | trigger-popup-empty',
  'trigger-popup.ts | trigger-popup-ghost',
  'trigger-popup.ts | trigger-popup-ghost-text',
  'trigger-popup.ts | trigger-popup-group-label',
  'trigger-popup.ts | trigger-popup-hint',
  'trigger-popup.ts | trigger-popup-item-active',
  'trigger-popup.ts | trigger-popup-item-badge',
  'trigger-popup.ts | trigger-popup-item-detail',
  'trigger-popup.ts | trigger-popup-item-error',
  'trigger-popup.ts | trigger-popup-item-label',
  'trigger-popup.ts | trigger-popup-keycap',
  'trigger-popup.ts | trigger-popup-open',
  'trigger-popup.ts | trigger-popup-pill',
  'trigger-popup.ts | trigger-popup-pill-active',
  'trigger-popup.ts | trigger-popup-query',
  'trigger-popup.ts | trigger-popup-query-axis',
  'trigger-popup.ts | trigger-popup-query-input',
  'trigger-popup.ts | trigger-popup-results',
  'trigger-popup.ts | trigger-popup-scope',

  // --- `search.ts`, `match-options.ts`, `cross-file-search.ts`, `dom-utils.ts`:
  //     search-bar widgets, the overview-ruler tick, the cross-file result
  //     popover, the toast, and the generic body-mounted drag helper. ---
  'search.ts | current',
  'search.ts | no-result',
  'match-options.ts | active',
  'cross-file-search.ts | cross-file-search-group-single',
  'cross-file-search.ts | expanded',
  'dom-utils.ts | dragging',
  'dom-utils.ts | show',

  // --- INSIDE `#content`, deliberately NOT transient: GFM task-list markup
  //     (`dom-utils.ts`, `list-ops.ts`). turndown's `taskListItems` plugin reads
  //     these back to emit `- [ ]`; stripping them would silently turn a task
  //     list into a plain list. Verified to survive the raw-HTML table path. ---
  'dom-utils.ts | contains-task-list',
  'dom-utils.ts | task-list-item',
  'dom-utils.ts | task-list-item-checkbox',
  'list-ops.ts | task-list-item',
  'list-ops.ts | task-list-item-checkbox',

  // --- INSIDE `#content`, chrome removed by a DIFFERENT mechanism: the
  //     code-block header row and the math edit toggle carry
  //     `MD_CHROME_MARKER_ATTR`, so `stripInjectedChrome` deletes them wholesale
  //     (US-23.21 AC1b). Registering their classes would be the wrong tool. ---
  'dom-postprocess.ts | md-code-copy',
  'dom-postprocess.ts | md-code-header',
  'dom-postprocess.ts | md-code-lang',
  'dom-postprocess.ts | md-code-wrap',
  'dom-postprocess.ts | md-math-toggle',

  // --- INSIDE `#content`, KNOWN LEAK — exempted, not absolved. Each of these
  //     wrappers is normally replaced by its SOURCE form (`caption::NS_ID`,
  //     `$…$`, a fence) by a turndown RULE, and a rule does not run on the
  //     raw-HTML paths (`complexTableAsHtml`, `outerHtmlFallback`). Measured
  //     2026-07-28: a `caption::UC1` token or inline math inside a table that
  //     needs HTML serialization writes the wrapper, its classes AND
  //     `contenteditable="false"` (plus the whole rendered KaTeX subtree) into
  //     the user's `.md`. Registering the class names would not fix it — the
  //     wrapper element itself has to be replaced by its source text, which is a
  //     serialization change well outside this story. Recorded as deferred work;
  //     `md-mermaid-error` / `md-plantuml-error` are the same shape, reachable
  //     only through a hand-authored `<table>` around a fence. ---
  'dom-postprocess.ts | md-caption',
  'dom-postprocess.ts | md-caption-id',
  'dom-postprocess.ts | md-caption-ns',
  'dom-postprocess.ts | md-caption-prefix',
  'dom-postprocess.ts | md-math-block',
  'dom-postprocess.ts | md-math-inline',
  'dom-postprocess.ts | md-math-render',
  'mermaid.ts | md-mermaid-error',
  'plantuml.ts | md-plantuml-error',
];

/**
 * Stamp expressions the scan cannot resolve to a literal name, keyed
 * `<file> | <expression>`. A computed class name is a scan failure by design
 * (US-23.22 AC1: "cannot resolve = fail"), so each one is parked here with the
 * same burden of proof as `OUTSIDE_CONTENT_CLASSES` — the reason lives in the
 * group comment. The key deliberately omits the line number: these entries
 * should survive unrelated edits above them, and the expression text is already
 * specific enough to catch a real change.
 */
export const UNRESOLVED_STAMP_EXEMPTIONS: readonly string[] = [
  // --- Creation-helper and icon-builder sinks: the class arrives as a
  //     parameter. The caller's literal is NOT scanned — these are the sinks of
  //     the `el(tag, className)` shape named in the KNOWN GAP above, so the
  //     exemption rests on the builders themselves: every one of them
  //     (`el`/`bubbleIcon`/`matchOptionButton`/the math + diagram frame
  //     builders) constructs body-mounted chrome or chrome carrying
  //     `MD_CHROME_MARKER_ATTR`, verified 2026-07-28. ---
  'comment-menu.ts | className',
  'cross-file-search.ts | className',
  'dom-utils.ts | className',
  'match-options.ts | btnClass',
  'dom-postprocess.ts | opts.toggleClass',
  'dom-postprocess.ts | opts.toolbarClass',
  'dom-postprocess.ts | spec.wrapperClass',
  'dom-postprocess.ts | spec.zoomClass',
  'dom-postprocess.ts | spec.chartClass',
  'dom-postprocess.ts | spec.sourceClass',

  // --- Composed body-mounted chrome names (popover/pill/row state suffixes). ---
  'comment-popover.ts | `comment-popover-status status-${anchor.status.toLowerCase()}`',
  'toolbar.ts | extraClassName ? `toolbar-popover ${extraClassName}` : \'toolbar-popover\'',
  'trigger-popup.ts | \'trigger-popup-pill\' + (scope.id === currentActiveScopeId ? \' trigger-popup-pill-active\' : \'\')',
  'trigger-popup.ts | \'trigger-popup-item\' + (item.disabled ? \' trigger-popup-item-disabled\' : \'\')',
  'trigger-popup.ts | `trigger-popup-item-tint-${item.tint}`',
  'trigger-popup.ts | \'trigger-popup-more\' + (group.onMore ? \' trigger-popup-more-active\' : \'\')',
  'toc.ts | `toc-item toc-level-${level}`',
  'readability.ts | `reading-mode-${m}`',
  'match-utils.ts | tickClass + (i === current ? \' current\' : \'\')',

  // --- Inside `#content`, but not transient (same reasoning as the tail of
  //     OUTSIDE_CONTENT_CLASSES): the gutter's line-number spans are injected
  //     chrome, and `language-*` is highlight.js's own content markup that
  //     turndown reads back to rebuild the fence's language tag. ---
  'gutter.ts | isEnd ? \'md-line-number md-line-number-end\' : \'md-line-number\'',
  'input-rules.ts | `language-${fence[1] || \'plaintext\'}`',
  'toolbar.ts | `language-${lang}`',
];

/** `const NAME = 'literal'`, with or without a type annotation. */
const CONST_DECL_RE = /\bconst ([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*'([^']*)'/g;
/** The same, restricted to exported declarations (AC2's requirement). */
const EXPORT_CONST_DECL_RE = /\bexport const ([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*'([^']*)'/g;
/** `import { a, b as c } from './module'`, with or without a default binding. */
const IMPORT_RE = /import\s+(?:[\w$]+\s*,\s*)?(?:type\s+)?\{([^}]*)\}\s*from\s*'\.\/([\w-]+)'/g;
/** `export * from './module'` (pipeline.ts's barrel re-export). */
const REEXPORT_RE = /export\s+\*\s+from\s*'\.\/([\w-]+)'/g;
/**
 * The stamp forms this scans. The first three are US-23.22 AC1's list; `+=`,
 * `classList.replace` and the optional-chain spelling are the same three forms
 * written differently, and leaving them out would have been a silent hole
 * (`el.className += ' x'` is the ordinary way to APPEND a class).
 *
 * `=(?!=)` keeps `.className ===` / `!==` comparisons out. The call forms
 * deliberately stop BEFORE their `(` so `readCallArgs` can count that paren
 * itself — matching through it made a call whose arguments start on the next
 * line read as empty (and therefore as "nothing stamped here").
 */
const STAMP_RE =
  /(classList\??\.(?:add|toggle|replace)\s*(?=\()|\.className\s*\+?=(?!=)|setAttribute\s*(?=\())/g;

/** Longest expression `readAssignment` will follow before giving up. */
const MAX_EXPR_CHARS = 600;

/**
 * Length of the string/template literal starting at `source[i]`, or 0 when that
 * position is not a quote. Shared by every scan pass so a quote can never be
 * mistaken for code: `'https://x'` must not read as a line comment, and
 * `'has)paren'` must not close an argument list.
 */
function quotedLength(source: string, i: number): number {
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    return 0;
  }
  for (let j = i + 1; j < source.length; j++) {
    const c = source[j];
    if (c === '\\') {
      j++;
    } else if (c === quote) {
      return j - i + 1;
    } else if (c === '\n' && quote !== '`') {
      // Unterminated single-line string: treat the quote as a lone character
      // rather than swallowing the rest of the file.
      return 1;
    }
  }
  return source.length - i;
}

/**
 * Replaces every `//` and block comment body with spaces, keeping newlines so
 * line numbers stay exact. Run before any other pass: without it, a doc comment
 * that merely SHOWS `classList.add('example')` (this repo comments heavily, and
 * `turndown.ts` itself documents the strip mechanism) would fail the gate with a
 * demand to register a class that does not exist.
 */
export function maskComments(source: string): string {
  const out: string[] = [];
  for (let i = 0; i < source.length; ) {
    const quoted = quotedLength(source, i);
    if (quoted > 0) {
      out.push(source.slice(i, i + quoted));
      i += quoted;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i++) {
        out.push(source[i] === '\n' ? '\n' : ' ');
      }
      continue;
    }
    out.push(source[i]);
    i++;
  }
  return out.join('');
}

/**
 * Reads the argument list of a call whose `(` sits at `source[i]`, returning the
 * text between the parens. String-aware and newline-tolerant: termination is the
 * matching `)`, never a line break, so a wrapped call reads exactly like the
 * one-line spelling. Returns `undefined` when the parens never close.
 */
function readCallArgs(source: string, i: number): string | undefined {
  let depth = 0;
  let out = '';
  for (; i < source.length; i++) {
    const quoted = quotedLength(source, i);
    if (quoted > 0) {
      out += source.slice(i, i + quoted);
      i += quoted - 1;
      continue;
    }
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        return out.slice(1);
      }
    }
    out += c;
  }
  return undefined;
}

/**
 * Reads the right-hand side of a `className =` / `+=` assignment: everything up
 * to the terminating `;` at depth 0. Newline-tolerant for the same reason as
 * `readCallArgs` — a wrapped ternary (`= cond\n  ? 'a'\n  : 'b';`) must read as
 * one expression, not truncate to `cond`. Returns `undefined` when no `;`
 * arrives within `MAX_EXPR_CHARS`.
 */
function readAssignment(source: string, i: number): string | undefined {
  let depth = 0;
  let out = '';
  for (; i < source.length && out.length <= MAX_EXPR_CHARS; i++) {
    const quoted = quotedLength(source, i);
    if (quoted > 0) {
      out += source.slice(i, i + quoted);
      i += quoted - 1;
      continue;
    }
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        return out;
      }
      depth--;
    } else if (c === ';' && depth === 0) {
      return out;
    }
    out += c;
  }
  return undefined;
}

/** Splits on commas at nesting depth 0 only, string-aware. */
function splitTopLevel(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const quoted = quotedLength(expr, i);
    if (quoted > 0) {
      cur += expr.slice(i, i + quoted);
      i += quoted - 1;
      continue;
    }
    const c = expr[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** A single-quoted / double-quoted / interpolation-free template literal. */
function literalValue(expr: string): string | undefined {
  const m =
    /^'([^']*)'$/.exec(expr) ?? /^"([^"]*)"$/.exec(expr) ?? /^`([^`${]*)`$/.exec(expr);
  return m ? m[1] : undefined;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source[i] === '\n') {
      line++;
    }
  }
  return line;
}

/** Every `const NAME = 'literal'` one file declares itself, imports excluded. */
export function declaredConstants(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of maskComments(source).matchAll(CONST_DECL_RE)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/**
 * The subset of `declaredConstants` written `export const`. AC2 asks for an
 * EXPORTED constant, and a module-private one could not be the shared
 * declaration site the rule is about.
 */
export function exportedConstants(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of maskComments(source).matchAll(EXPORT_CONST_DECL_RE)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/**
 * Identifiers a single file declares TWICE with different values — typically one
 * `const FLASH_CLASS` per function. `declaredConstants` flattens a file into one
 * map, so the later declaration would win and a stamp in the earlier function
 * would resolve to the wrong class name with nothing reporting it. Detect the
 * ambiguity and fail on it instead of silently picking.
 */
export function findAmbiguousConstants(files: SourceFile[]): string[] {
  const ambiguous: string[] = [];
  for (const { file, source } of files) {
    const seen = new Map<string, string>();
    for (const m of maskComments(source).matchAll(CONST_DECL_RE)) {
      const previous = seen.get(m[1]);
      if (previous !== undefined && previous !== m[2]) {
        ambiguous.push(`${file} | ${m[1]}`);
      }
      seen.set(m[1], m[2]);
    }
  }
  return ambiguous;
}

/**
 * Per-file map of identifier -> class-name literal, honouring local
 * declarations, `import { X as Y }` aliases and `export *` barrels. Per-file
 * rather than global on purpose: `mermaid.ts` and `plantuml.ts` both declare
 * their own `ERROR_CLASS` with different values, and one flat namespace would
 * silently resolve the wrong one.
 */
export function collectClassConstants(files: SourceFile[]): Map<string, Map<string, string>> {
  const declared = new Map<string, Map<string, string>>();
  const byName = new Map<string, SourceFile>();
  for (const f of files) {
    byName.set(f.file, f);
    declared.set(f.file, declaredConstants(f.source));
  }

  const exportsOf = (file: string, seen = new Set<string>()): Map<string, string> => {
    const own = declared.get(file);
    if (!own || seen.has(file)) {
      return new Map();
    }
    seen.add(file);
    const out = new Map(own);
    const source = maskComments(byName.get(file)?.source ?? '');
    for (const m of source.matchAll(REEXPORT_RE)) {
      for (const [k, v] of exportsOf(`${m[1]}.ts`, seen)) {
        out.set(k, v);
      }
    }
    return out;
  };

  const scopes = new Map<string, Map<string, string>>();
  for (const f of files) {
    const scope = new Map(declared.get(f.file));
    for (const m of maskComments(f.source).matchAll(IMPORT_RE)) {
      const exported = exportsOf(`${m[2]}.ts`);
      for (const raw of m[1].split(',')) {
        const binding = raw.trim();
        if (!binding) {
          continue;
        }
        const [imported, local = imported] = binding.split(/\s+as\s+/).map((p) => p.trim());
        const value = exported.get(imported);
        if (value !== undefined) {
          scope.set(local, value);
        }
      }
    }
    scopes.set(f.file, scope);
  }
  return scopes;
}

/** Parses the identifiers inside `turndown.ts`'s `TRANSIENT_CLASSES = [...]`. */
export function readTransientClassIdentifiers(turndownSource: string): string[] {
  const masked = maskComments(turndownSource);
  const body = /const TRANSIENT_CLASSES\s*=\s*\[([^\]]*)\]/.exec(masked)?.[1] ?? '';
  return body
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Scans every stamp site in `files`, resolving names through `scopes`. */
export function scanStampedClasses(
  files: SourceFile[],
  scopes: Map<string, Map<string, string>>
): ScanResult {
  const names = new Map<string, StampSite[]>();
  const literalNames = new Map<string, StampSite[]>();
  const unresolved: UnresolvedStamp[] = [];

  const record = (target: Map<string, StampSite[]>, name: string, site: StampSite): void => {
    const list = target.get(name);
    if (list) {
      list.push(site);
    } else {
      target.set(name, [site]);
    }
  };

  for (const { file, source: raw } of files) {
    const source = maskComments(raw);
    const scope = scopes.get(file) ?? new Map<string, string>();
    for (const m of source.matchAll(STAMP_RE)) {
      const kind = m[1];
      const site: StampSite = { file, line: lineOf(source, m.index) };
      const isAssignment = kind.startsWith('.className');
      const body = isAssignment
        ? readAssignment(source, m.index + m[0].length)
        : readCallArgs(source, m.index + m[0].length);
      if (body === undefined) {
        // Unreadable is never silent: the whole point of the gate is that it
        // cannot report success on a stamp it failed to parse.
        unresolved.push({ ...site, expr: '(unparsable stamp expression)' });
        continue;
      }
      const args = splitTopLevel(body);
      let parts: string[];
      if (isAssignment) {
        parts = [body];
      } else if (kind.includes('setAttribute')) {
        // Every `setAttribute` matches; only the ones setting `class` count, and
        // for those the class name is the SECOND argument.
        const attr = literalValue(args[0]?.trim() ?? '');
        if (attr !== 'class') {
          continue;
        }
        parts = [args[1] ?? ''];
      } else if (kind.includes('toggle')) {
        // `toggle(name, force)` — the force argument is not a class name.
        parts = [args[0] ?? ''];
      } else {
        // `add(a, b)` / `replace(old, new)` — every argument is a class name.
        parts = args;
      }
      const readable = parts
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && part !== 'undefined');
      if (readable.length === 0) {
        unresolved.push({ ...site, expr: '(empty stamp expression)' });
        continue;
      }
      for (const expr of readable) {
        const literal = literalValue(expr);
        if (literal !== undefined) {
          const tokens = literal.split(/\s+/).filter(Boolean);
          if (tokens.length === 0) {
            // `add('')` / `className = ''` — no name, but not something to pass
            // over in silence either.
            unresolved.push({ ...site, expr: '(empty class literal)' });
            continue;
          }
          for (const name of tokens) {
            record(names, name, site);
            record(literalNames, name, site);
          }
          continue;
        }
        const resolved = /^[A-Z][A-Z0-9_]*$/.test(expr) ? scope.get(expr) : undefined;
        if (resolved !== undefined) {
          record(names, resolved, site);
        } else {
          unresolved.push({ ...site, expr: expr.replace(/\s+/g, ' ') });
        }
      }
    }
  }
  return { names, literalNames, unresolved };
}
