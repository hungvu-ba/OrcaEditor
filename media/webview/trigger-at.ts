/**
 * `@` Reference trigger (Req 20 US-20.1/US-20.6/US-20.7), built on the shared
 * trigger-popup.ts shell — the shell owns chrome/positioning/keyboard-nav/
 * Escape/staleness (US-20.4); this module owns ONLY the `@` trigger-detection
 * (start-of-word rule + selection-aware keydown intercept + the `](` alternate
 * trigger via the `input` event), the scope-tab data sources (All/Files/
 * Headings), the ghost-text single-match fast path, and wiring each pick to the
 * SAME insert functions the toolbar already exposes (toolbar.ts's
 * runAtInsertLink / runAtInsertImage / runAtSetHrefOnSelection) — no parallel
 * implementation. Also the Link/Image toolbar buttons' entry point (US-20.8,
 * openFromToolbar) — the old prompt.ts modal is gone; both buttons now open
 * this SAME popup instead of a separate dialog.
 *
 * Files scope reuses the existing `searchFiles`/`fileSearchResult` host
 * contract (the same pair quick-correct.ts's Search-again uses); no new host
 * message shape. `input-rules.ts` stands down on its own via `hasInputOwner()` once the shell's
 * open() calls `setInputOwner('trigger')`, so this module needs no guard for that.
 */
import { closestElement, encodeLinkPath, relativeLinkPath } from './dom-utils';
import { postProcessEntityRefs } from './dom-postprocess';
import { normalizeForSearch } from '../../src/text-utils';
import { slugifyHeadingText } from './broken-ref';
import { runAtInsertLink, runAtInsertImage, runAtSetHrefOnSelection } from './toolbar';
import type {
  TriggerPopupController,
  TriggerPopupGroup,
  TriggerPopupItem,
  TriggerScope,
} from './trigger-popup';
import type {
  EntitySuggestion,
  FileSuggestion,
  NamespaceSummary,
  TriggerMode,
  WebviewToHost,
} from '../../src/shared/messages';

export interface TriggerAtController {
  /** Message-handler hook: forward a `fileSearchResult` reply here (own requestId sequence — ignored if stale). */
  notifyFileSearchResult(requestId: number, files: FileSuggestion[]): void;
  /**
   * Req 20 US-20.8 — toolbar Link/Image buttons invoke this instead of the
   * old prompt.ts modal. `imageMode` picks the commit shape (bare `<img>`
   * vs `<a>`) and restricts the popup to the Files scope (no Headings tab —
   * a heading fragment is never a valid image `src`).
   */
  openFromToolbar(imageMode: boolean): void;
  /** Req 21 US-21.5 — set/refresh the `orcaEditor.triggerActions.mode` gate (seed + live `configUpdate`). */
  setTriggerMode(m: TriggerMode): void;
  /** Req 21 US-21.2 — set from `InitConfig.docUri`; used to relativize an Entities-scope pick's href. */
  setDocUri(uri: string): void;
  /** Req 21 US-21.2 — reply to `namespaceList` (own requestId sequence — ignored if stale). */
  notifyNamespaceListResult(requestId: number, ready: boolean, namespaces: NamespaceSummary[]): void;
  /** Req 21 US-21.2 — reply to `entitySearch` (own requestId sequence — ignored if stale). */
  notifyEntityResult(requestId: number, ready: boolean, entities: EntitySuggestion[]): void;
}

/**
 * Req 20 US-20.7 — the `@` scopes. Labeled exactly "All / Files / Headings" in
 * `simple` mode; `entities` (Req 21 US-21.2/US-21.5) is `advancedOnly` —
 * `visibleAtScopes()` below filters generically by that flag. NOT folded into
 * the merged "All" scope (deliberately out of this story's scope — All stays
 * Files+Headings only).
 */
type AtScope = 'all' | 'files' | 'headings' | 'entities';
interface AtScopeDef extends TriggerScope {
  /** Req 21 US-21.5 — hidden unless `orcaEditor.triggerActions.mode` is `advanced`. */
  advancedOnly?: boolean;
}
const ALL_SCOPES: AtScopeDef[] = [
  { id: 'all', label: 'All' },
  { id: 'files', label: 'Files' },
  { id: 'headings', label: 'Headings' },
  { id: 'entities', label: 'Entities', advancedOnly: true },
];

/** Per-group cap in the merged "All" view (US-20.7; prototype value, revisit against a large workspace). */
const GROUP_CAP = 5;

/** Resolved insert target behind one popup row (kept in a side map keyed by the row id the shell echoes back on pick). */
interface AtTarget {
  href: string;
  display: string;
}

/** Diacritic-insensitive substring match on the visible text only (US-20.1). */
function matchesFilter(text: string, q: string): boolean {
  if (!q) return true;
  return normalizeForSearch(text).includes(normalizeForSearch(q));
}

/**
 * Ghost-text completion remainder (US-20.6): the part of `label` after a
 * case-insensitive prefix match of `q`. Empty when `label` isn't a clean prefix
 * completion of `q` — the caller then falls back to the dropdown rather than
 * inventing a misleading ghost.
 */
function ghostRemainder(q: string, label: string): string {
  if (label.length <= q.length) return '';
  return label.slice(0, q.length).toLowerCase() === q.toLowerCase() ? label.slice(q.length) : '';
}

/**
 * Text from the start of `block` to `range`'s start — used to judge the
 * "start of word" trigger condition and to locate the `](` run (COPIED, small,
 * from trigger-slash.ts's own private textBeforeCaret — deliberately not shared
 * so a future change to one is a conscious edit in both).
 */
function textBeforeCaret(block: Element, range: Range): string {
  const probe = document.createRange();
  probe.selectNodeContents(block);
  try {
    probe.setEnd(range.startContainer, range.startOffset);
  } catch {
    return '';
  }
  return probe.toString();
}

export function initTriggerAt(
  content: HTMLElement,
  popup: TriggerPopupController,
  postToHost: (msg: WebviewToHost) => void
): TriggerAtController {
  /**
   * Session-global sticky scope (US-20.7). Module-level per webview: it persists
   * across every `@` open in THIS editor. Cross-editor/split-pane persistence
   * would need host-held state and is out of this story's scope.
   */
  let activeScope: AtScope = 'all';

  /** Req 21 US-21.5 — gates visibility only (see `visibleAtScopes`), never restyles/hides written content. */
  let triggerMode: TriggerMode = 'advanced';

  /** Req 21 US-21.2 — `InitConfig.docUri`, used to relativize an Entities-scope pick's href. */
  let docUri = '';

  /** Req 21 US-21.5 guard — filters the canonical scope list by `advancedOnly`, not a hardcoded id check. */
  function visibleAtScopes(): TriggerScope[] {
    return ALL_SCOPES.filter((s) => triggerMode === 'advanced' || !s.advancedOnly).map(({ id, label }) => ({ id, label }));
  }

  // 'toolbar' (US-20.8): the Link/Image toolbar buttons — no literal '@'/'['
  // ever touches the document; deleteRange is the caret/selection the button
  // was clicked from (deferred delete, same mechanics as mention/bracket).
  type AtMode = 'mention' | 'bracket' | 'selection' | 'toolbar';
  let mode: AtMode | undefined;
  /** The deletable trigger run (`@…` or `[text](`) — replaced on commit; unused in selection mode. */
  let deleteRange: Range | undefined;
  /** Selection-mode: the ORIGINAL selection to re-target on pick / restore on Escape. */
  let savedSelection: Range | undefined;
  /** Bracket-mode display text (the `[text]` between the brackets) — kept untouched on insert (US-20.6). */
  let bracketDisplay = '';
  /** Set true once a pick commits, so onClose does not restore/undo a just-applied selection insert. */
  let committed = false;
  /**
   * Bug 9 — set true right before a selection-mode popup is auto-closed because
   * the user NAVIGATED AWAY (the live selection left `savedSelection`). onClose's
   * selection-restore is meant for the cancel/Escape case (preserve the user's
   * selection); on a navigate-away abandon it must NOT fire, or it would snap the
   * caret back onto the old link and the next keystroke would delete it.
   */
  let abandonedSelection = false;
  /** US-20.8: true while the CURRENT popup session was opened by the toolbar's Image button. */
  let imageMode = false;
  /** Set by 'beforeinput' when the NEXT 'input' should open the collapsed-caret mention popup. */
  let pendingOpen = false;
  /** Row id the ghost overlay currently offers (US-20.6); Tab-accept commits it. */
  let pendingGhostId: string | undefined;

  /** id → resolved target, rebuilt on every buildAtDataSource() call. */
  let targetsById = new Map<string, AtTarget>();

  // ---- Files scope: async host round-trip over the shared searchFiles channel
  let searchSeq = 0;
  let pendingFileSearch: { requestId: number; resolve: (files: FileSuggestion[]) => void } | undefined;

  function fileSearch(q: string): Promise<FileSuggestion[]> {
    // Settle any previous in-flight promise so it never dangles unresolved.
    pendingFileSearch?.resolve([]);
    const requestId = ++searchSeq;
    postToHost({ type: 'searchFiles', query: q, requestId });
    return new Promise<FileSuggestion[]>((resolve) => {
      pendingFileSearch = { requestId, resolve };
    });
  }

  // ---- Entities scope (Req 21 US-21.2): own requestId sequences for
  // namespaceList/entitySearch, same "settle the dangling promise with an
  // empty/not-ready value" discipline as fileSearch above — a stale render is
  // discarded by the shell's own staleness guard regardless of what a
  // superseded promise resolves with.
  let entityNamespaceBrowse: string | undefined; // undefined = bare namespace-browse list; set = narrowed into that namespace's id list.

  let namespaceReqSeq = 0;
  let pendingNamespaceReq:
    | { requestId: number; resolve: (r: { ready: boolean; namespaces: NamespaceSummary[] }) => void }
    | undefined;

  function fetchNamespaceList(): Promise<{ ready: boolean; namespaces: NamespaceSummary[] }> {
    pendingNamespaceReq?.resolve({ ready: false, namespaces: [] });
    const requestId = ++namespaceReqSeq;
    postToHost({ type: 'namespaceList', requestId });
    return new Promise((resolve) => {
      pendingNamespaceReq = { requestId, resolve };
    });
  }

  let entityReqSeq = 0;
  let pendingEntityReq:
    | { requestId: number; resolve: (r: { ready: boolean; entities: EntitySuggestion[] }) => void }
    | undefined;

  function fetchEntities(query: string, namespace?: string): Promise<{ ready: boolean; entities: EntitySuggestion[] }> {
    pendingEntityReq?.resolve({ ready: false, entities: [] });
    const requestId = ++entityReqSeq;
    postToHost({ type: 'entitySearch', requestId, query, namespace });
    return new Promise((resolve) => {
      pendingEntityReq = { requestId, resolve };
    });
  }

  // ---- Group builders ------------------------------------------------------
  function moreLabelFor(scope: AtScope, hidden: number): string | undefined {
    // In "All", the overflow footnote points at the single-scope tab (US-20.7
    // microcopy); the actual switch is via the scope pills / Ctrl+Tab. In a
    // single scope, undefined = the shell's default "+N more — keep typing to narrow".
    return scope === 'all' ? `+${hidden} more — switch scope` : undefined;
  }

  function headingsGroup(scope: AtScope, q: string): TriggerPopupGroup {
    // Re-scan on every query (US-20.1: current-document headings, H1–H3 only).
    const heads = Array.from(content.querySelectorAll('h1, h2, h3'));
    const matched = heads
      .map((h) => ({ text: h.textContent ?? '', tag: h.tagName }))
      .filter((h) => matchesFilter(h.text, q));
    const shown = matched.slice(0, GROUP_CAP);
    const items: TriggerPopupItem[] = shown.map((h, i) => {
      const id = `h${i}`;
      targetsById.set(id, { href: `#${slugifyHeadingText(h.text)}`, display: h.text });
      // Bare-state rows show the level badge + text, no source-filename label
      // (the document is implicit) — the badge carries the level.
      return { id, label: h.text, badge: h.tag };
    });
    const group: TriggerPopupGroup = { label: 'Headings', items };
    if (matched.length > shown.length) {
      group.total = matched.length;
      group.moreLabel = moreLabelFor(scope, matched.length - shown.length);
    }
    return group;
  }

  function filesGroup(scope: AtScope, files: FileSuggestion[]): TriggerPopupGroup {
    const shown = files.slice(0, GROUP_CAP);
    const items: TriggerPopupItem[] = shown.map((f, i) => {
      const id = `f${i}`;
      targetsById.set(id, { href: encodeLinkPath(f.path), display: f.name });
      // NOTE (deferred): the design file shows a per-row "Recent" pill on
      // recently-opened files, but whether it is an always-on badge or an
      // active-row-only accent is an unresolved design question (PO left it open
      // 2026-07-19). Intentionally NOT built here — do not add it as `badge`
      // without a design confirmation. Cross-file rows add a right-aligned muted
      // folder label (the source is no longer implicit once results leave the
      // current document).
      return { id, label: f.name, detail: f.dir };
    });
    const group: TriggerPopupGroup = { label: 'Files', items };
    if (files.length > shown.length) {
      group.total = files.length;
      group.moreLabel = moreLabelFor(scope, files.length - shown.length);
    }
    return group;
  }

  /** Req 21 US-21.2 — namespace-narrow "back" row id, and the id prefix a bare-browse namespace row commits. */
  const ENTITY_NS_PREFIX = 'entns:';
  const ENTITY_BACK_ID = `${ENTITY_NS_PREFIX}__back__`;
  const ENTITY_PREFIX = 'ent:';

  /** Req 21 US-21.2 — relative href for one entity result (declaring-file uri, relativized against docUri, + the full id as anchor). */
  function entityHref(e: EntitySuggestion): string {
    return `${encodeLinkPath(relativeLinkPath(docUri, e.file))}#${e.namespace}${e.id}`;
  }

  /** Req 21 US-21.2 — distinct "still indexing" state (not a no-match empty state). */
  function entityIndexingGroup(): TriggerPopupGroup {
    return { label: 'Entities', items: [{ id: 'ent:__indexing__', label: 'Indexing workspace…', disabled: true }] };
  }

  /** Req 21 US-21.2 — bare Entities tab: capped namespace list, sorted by entity-count desc (already the host's `namespaces()` order). */
  function namespaceBrowseGroup(namespaces: NamespaceSummary[]): TriggerPopupGroup {
    const shown = namespaces.slice(0, GROUP_CAP);
    const items: TriggerPopupItem[] = shown.map((n) => ({
      id: `${ENTITY_NS_PREFIX}${n.name}`,
      label: n.name,
      detail: String(n.count),
    }));
    const group: TriggerPopupGroup = { label: 'Namespaces', items };
    if (namespaces.length > shown.length) {
      group.total = namespaces.length;
      group.moreLabel = `+${namespaces.length - shown.length} more — keep typing`;
    }
    return group;
  }

  /** Req 21 US-21.2 — one entity row (registers its commit target as a side effect), shared by the narrowed id list and the flat search results. */
  function entityItemsFrom(entities: EntitySuggestion[]): TriggerPopupItem[] {
    return entities.map((e) => {
      const id = `${ENTITY_PREFIX}${e.namespace}${e.id}`;
      targetsById.set(id, { href: entityHref(e), display: `${e.namespace}${e.id}` });
      return { id, label: `${e.namespace}${e.id}`, detail: e.title || undefined, tint: 'entity' as const };
    });
  }

  /** Req 21 US-21.2 — narrowed into one namespace: a `‹ All namespaces` back-row followed by its id+title list. */
  function namespaceIdGroup(namespace: string, entities: EntitySuggestion[]): TriggerPopupGroup {
    const backItem: TriggerPopupItem = { id: ENTITY_BACK_ID, label: '‹ All namespaces' };
    return { label: namespace, items: [backItem, ...entityItemsFrom(entities)] };
  }

  /** Req 21 US-21.2 — typed query: combined id+title fuzzy match across ALL namespaces (the host's `entitySearch` already does the matching/ranking/cap). */
  function entitySearchGroup(entities: EntitySuggestion[]): TriggerPopupGroup {
    return { label: 'Entities', items: entityItemsFrom(entities) };
  }

  /**
   * Req 21 US-21.2 — Entities scope data source. Bare query browses (namespace
   * list, or a narrowed namespace's id list if `entityNamespaceBrowse` is
   * set); ANY typed query switches to the flat combined search, regardless of
   * browse position (narrowing is a bare-query-only browse aid, not a search
   * filter).
   */
  function buildEntityGroups(q: string): Promise<TriggerPopupGroup[]> {
    if (!q) {
      if (entityNamespaceBrowse) {
        const ns = entityNamespaceBrowse;
        return fetchEntities('', ns).then(({ ready, entities }) =>
          ready ? [namespaceIdGroup(ns, entities)] : [entityIndexingGroup()]
        );
      }
      return fetchNamespaceList().then(({ ready, namespaces }) =>
        ready ? [namespaceBrowseGroup(namespaces)] : [entityIndexingGroup()]
      );
    }
    return fetchEntities(q).then(({ ready, entities }) => (ready ? [entitySearchGroup(entities)] : [entityIndexingGroup()]));
  }

  /**
   * Req 20 US-20.7 — build the result groups for the active scope. Reads the
   * live sticky `activeScope` (the shell re-runs this same dataSource after a
   * scope switch), not a captured argument. Bare `@` (empty query) shows only
   * the current document's headings — no full workspace dump (US-20.1/20.7).
   */
  function buildAtDataSource(scope: AtScope, q: string): TriggerPopupGroup[] | Promise<TriggerPopupGroup[]> {
    targetsById = new Map();
    popup.hideGhost();
    pendingGhostId = undefined;

    if (scope === 'entities') {
      return buildEntityGroups(q); // no ghost fast path for this scope (not asked for).
    }
    if (scope === 'headings') {
      const groups = [headingsGroup(scope, q)];
      evaluateGhost(q, groups);
      return groups;
    }
    if (scope === 'files') {
      if (!q) return []; // no bare file dump
      return fileSearch(q).then((files) => {
        const groups = [filesGroup(scope, files)];
        evaluateGhost(q, groups);
        return groups;
      });
    }
    // 'all'
    if (!q) {
      const groups = [headingsGroup(scope, q)]; // bare-@ default: current-doc headings only
      evaluateGhost(q, groups);
      return groups;
    }
    return fileSearch(q).then((files) => {
      const groups = [filesGroup(scope, files), headingsGroup(scope, q)];
      evaluateGhost(q, groups);
      return groups;
    });
  }

  /**
   * Req 20 US-20.8 — Image toolbar button's data source: Files scope ONLY
   * (no "All"/Headings — a heading fragment `#slug` is never a valid image
   * `src`, and inventing an image-specific asset picker beyond the existing
   * file search is out of scope). Bare-open shows nothing, same as the
   * Files-scope-with-empty-query rule in buildAtDataSource.
   */
  function buildImageDataSource(q: string): TriggerPopupGroup[] | Promise<TriggerPopupGroup[]> {
    targetsById = new Map();
    popup.hideGhost();
    pendingGhostId = undefined;
    if (!q) return [];
    return fileSearch(q).then((files) => {
      const groups = [filesGroup('files', files)];
      evaluateGhost(q, groups);
      return groups;
    });
  }

  // ---- Ghost-text fast path (US-20.6) --------------------------------------
  function evaluateGhost(q: string, groups: TriggerPopupGroup[]): void {
    // "Single match" is counted WITHIN the active scope only (never an unscoped
    // total): `groups` already reflects the active scope, so a flat count of 1
    // is exactly one match in-scope.
    const flat = groups.flatMap((g) => g.items);
    if (q && flat.length === 1) {
      const remainder = ghostRemainder(q, flat[0].label);
      if (remainder) {
        pendingGhostId = flat[0].id;
        showGhostAtCaret(remainder);
        return;
      }
    }
    pendingGhostId = undefined;
    popup.hideGhost();
  }

  function showGhostAtCaret(text: string): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(false);
    popup.showGhost(text, r);
  }

  // ---- Commit / insert -----------------------------------------------------
  function commitById(id: string): void {
    const target = targetsById.get(id);
    if (!target) return;
    committed = true;
    if (mode === 'selection') {
      // Active-selection branch: `@` was intercepted at keydown so it never
      // touched the document; restore the original selection and set only its
      // href, keeping the visible display text (mirrors insertLink()'s
      // non-collapsed branch).
      if (savedSelection) runAtSetHrefOnSelection(target.href, savedSelection);
      // Req 21 US-21.3: instant muted-pill feedback for an Entities-scope pick
      // (idempotent — see postProcessEntityRefs's own no-op-on-mismatch guard)
      // rather than waiting for the next full re-render, same discipline as
      // trigger-slash.ts's Declare-entity instant feedback.
      postProcessEntityRefs(content);
      return;
    }
    if (!deleteRange) return;
    if (imageMode) {
      // US-20.8: bare `<img>`, no alt-text UX invented — mirrors the deleted
      // toolbar modal's insertImage() exactly (always `alt=""`).
      runAtInsertImage(target.href, deleteRange);
      return;
    }
    // Collapsed / bracket branch: delete the trigger run and insert a fresh <a>.
    // Bracket mode keeps the hand-typed `[text]` as display; mention mode uses
    // the picked row's label.
    const display = mode === 'bracket' ? bracketDisplay : target.display;
    runAtInsertLink(target.href, display, deleteRange);
    postProcessEntityRefs(content);
  }

  /**
   * Req 21 US-21.2 — an Entities-scope namespace-narrow/back row is a
   * NAVIGATION pick, not a commit: the shared shell always `close()`s right
   * after `onPick` fires (no "stay open" hook for a normal row — unlike the
   * "+N more" footnote's `onMore`, which the shell deliberately never wires
   * through onPick/close). Same close+reopen-via-`queueMicrotask` idiom
   * trigger-slash.ts's Declare-entity steps already use for this exact
   * "pick advances to the next step" shape: capture the live anchor/mode NOW
   * (before the shell's close() → onPopupClose() wipes them), then reopen the
   * SAME `@` session, narrowed/un-narrowed, right after.
   */
  function handleAtPick(item: TriggerPopupItem): void {
    if (activeScope === 'entities' && (item.id === ENTITY_BACK_ID || item.id.startsWith(ENTITY_NS_PREFIX))) {
      const capturedMode = mode;
      const capturedRange = (deleteRange ?? savedSelection)?.cloneRange();
      const capturedBracketDisplay = bracketDisplay;
      entityNamespaceBrowse = item.id === ENTITY_BACK_ID ? undefined : item.id.slice(ENTITY_NS_PREFIX.length);
      if (!capturedRange) return;
      queueMicrotask(() => {
        mode = capturedMode;
        bracketDisplay = capturedBracketDisplay;
        if (capturedMode === 'selection') {
          savedSelection = capturedRange;
        } else {
          deleteRange = capturedRange;
        }
        openPopup('');
      });
      return;
    }
    commitById(item.id);
  }

  // ---- Open / close --------------------------------------------------------
  /** `forImage` (US-20.8): swaps in buildImageDataSource + drops the scope tabs (Files-only, no pills to show). */
  function openPopup(seed: string, forImage = false): void {
    committed = false;
    const anchor = (deleteRange ?? savedSelection)?.cloneRange();
    if (!anchor) return;
    popup.open({
      axis: '@',
      // Bug 10: selection mode has no live editor text backing the query (the
      // selection stays intact for the href-only commit), so the shell must own
      // the filter — Backspace/typing edits the popup, never the selected link.
      ownsTextInput: mode === 'selection',
      anchorRange: anchor,
      dataSource: { query: (q) => (forImage ? buildImageDataSource(q) : buildAtDataSource(activeScope, q)) },
      onPick: forImage ? (item) => commitById(item.id) : handleAtPick,
      onClose: onPopupClose,
      scopes: forImage ? undefined : visibleAtScopes(),
      activeScopeId: forImage ? undefined : activeScope,
      onScopeChange: forImage
        ? undefined
        : (id) => {
            activeScope = id as AtScope;
            entityNamespaceBrowse = undefined; // switching tabs resets any Entities-scope drill-down.
          },
      onGhostAccept: () => {
        // Ghost-accept beats list-indent / cell-nav — the shell fires this ahead
        // of main.ts's content keydown (which bails via hasInputOwner() while the
        // popup owns input), so no separate Tab-priority wiring is needed there.
        if (pendingGhostId) {
          commitById(pendingGhostId);
          popup.close();
        }
      },
    });
    // The shell runs query('') on open; re-run with the seed for bracket/selection.
    if (seed) popup.updateQuery(seed);
  }

  function onPopupClose(): void {
    if (mode === 'selection' && !committed && !abandonedSelection && savedSelection) {
      // Escape / cancel with an active selection preserves it. NOT on a
      // navigate-away abandon (Bug 9) — the user already moved the caret, so
      // restoring the old link selection would fight that move and let the next
      // keystroke delete the link.
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(savedSelection);
    }
    abandonedSelection = false;
    mode = undefined;
    deleteRange = undefined;
    savedSelection = undefined;
    bracketDisplay = '';
    pendingGhostId = undefined;
    imageMode = false;
  }

  function openMention(): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    const start = document.createRange();
    if (r.startContainer.nodeType === Node.TEXT_NODE && r.startOffset >= 1) {
      start.setStart(r.startContainer, r.startOffset - 1); // include the just-typed '@'
    } else {
      start.setStart(r.startContainer, r.startOffset);
    }
    start.setEnd(r.startContainer, r.startOffset);
    mode = 'mention';
    deleteRange = start;
    entityNamespaceBrowse = undefined; // a genuinely new `@` session starts a fresh Entities browse.
    openPopup('');
  }

  function openBracket(display: string, range: Range): void {
    mode = 'bracket';
    deleteRange = range;
    bracketDisplay = display;
    entityNamespaceBrowse = undefined;
    openPopup(display);
  }

  function openSelection(selectionRange: Range, seed: string): void {
    mode = 'selection';
    savedSelection = selectionRange.cloneRange();
    entityNamespaceBrowse = undefined;
    openPopup(seed.trim());
  }

  /**
   * Req 20 US-20.8 — Link/Image toolbar button entry point (replaces the old
   * prompt.ts modal). Link with a non-collapsed selection reuses the exact
   * 'selection' branch real `@` typing uses (createLink, display text
   * preserved); every other case (Link collapsed, Image collapsed OR with a
   * selection — always replaced, matching the deleted modal's `alt=""`) is a
   * deferred delete-range commit, same mechanics as mention/bracket.
   */
  function openFromToolbar(imgMode: boolean): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    if (!content.contains(closestElement(r.startContainer))) return;
    if (!imgMode && !r.collapsed) {
      // Link with an active text selection: preserve the selected text as
      // display, only set its href — same createLink branch real `@` typing uses.
      openSelection(r, sel.toString());
      return;
    }
    imageMode = imgMode;
    mode = 'toolbar';
    deleteRange = r.cloneRange();
    entityNamespaceBrowse = undefined;
    // Image with an active selection: seed the query with the selected text,
    // ONE SHOT, same as the 'selection' mode's seed above — further typing
    // over a still-live (not yet deleted) selection would let the browser's
    // native contenteditable behavior replace it out from under deleteRange,
    // so (like 'selection' mode) this doesn't attempt to support live refinement.
    const seed = imgMode && !r.collapsed ? sel.toString().trim() : '';
    openPopup(seed, imgMode);
  }

  // ---- Trigger detection ---------------------------------------------------
  /** True when a collapsed caret at `range` sits at a start-of-word `@`-triggerable spot (US-20.1). */
  function detectAtTrigger(range: Range): boolean {
    const elt = closestElement(range.startContainer);
    if (!elt || !content.contains(elt)) return false;
    if (elt.closest('pre, code, td, th')) return false; // never in code / a table cell
    const block = elt.closest('p, h1, h2, h3, li, blockquote'); // headings H1–H3 only
    if (!block || !content.contains(block)) return false;
    const before = textBeforeCaret(block, range);
    return before === '' || /\s$/.test(before);
  }

  /**
   * `](` alternate trigger (US-20.6): detects a `(` typed immediately after a
   * closing `]` that has a matching non-nested `[…]` before it, via the `input`
   * event (NOT keydown — so it never collides with input-rules.ts's task-list
   * `[ ]` rule). Returns the display text + the `[…](` run to replace, or null.
   */
  function detectMarkdownLinkTrigger(ie: InputEvent): { display: string; range: Range } | null {
    if (ie.inputType !== 'insertText' || ie.data !== '(' || ie.isComposing) return null; // paste never opens it
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    const elt = closestElement(r.startContainer);
    if (!elt || !content.contains(elt) || elt.closest('pre, code, td, th')) return null;
    const block = elt.closest('p, h1, h2, h3, li, blockquote');
    if (!block || !content.contains(block)) return null;
    const before = textBeforeCaret(block, r); // includes the just-typed '('
    // Non-nested `[text](` at the caret; `[^\[\]]*` rejects nested/unbalanced brackets.
    const m = /\[([^[\]]*)\]\($/.exec(before);
    if (!m) return null;
    const range = rangeFromBlockOffsets(block, before.length - m[0].length, before.length);
    if (!range) return null;
    return { display: m[1], range };
  }

  /** Map character offsets within `block`'s text content to a DOM Range (walks text nodes). */
  function rangeFromBlockOffsets(block: Element, start: number, end: number): Range | null {
    const range = document.createRange();
    let acc = 0;
    let startDone = false;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const len = node.textContent?.length ?? 0;
      if (!startDone && start <= acc + len) {
        range.setStart(node, start - acc);
        startDone = true;
      }
      if (startDone && end <= acc + len) {
        range.setEnd(node, end - acc);
        return range;
      }
      acc += len;
    }
    return null;
  }

  function updateMentionQuery(): void {
    if (!deleteRange) return;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) {
      popup.close();
      return;
    }
    const r = sel.getRangeAt(0);
    let text: string;
    try {
      deleteRange.setEnd(r.startContainer, r.startOffset);
      text = deleteRange.toString();
    } catch {
      popup.close();
      return;
    }
    if (mode === 'toolbar') {
      // US-20.8: no literal '@' was typed — the whole accumulated run since
      // the button click IS the filter, no leading-char stripping.
      popup.updateQuery(text);
      return;
    }
    if (!text.startsWith('@')) {
      popup.close(); // the '@' itself is gone (Backspaced past it).
      return;
    }
    const filter = text.slice(1);
    if (filter === ' ' || filter.charCodeAt(0) === 0xa0) {
      // Space-while-empty literalizes the '@' (Notion/Slack pattern). Chromium
      // commits a lone trailing space as U+00A0, so match that too.
      popup.close();
      return;
    }
    popup.updateQuery(filter);
  }

  // ---- Wiring --------------------------------------------------------------
  // Selection-aware `@`: intercepted at keydown so it never replaces the
  // selection. Collapsed `@` falls through to the input path (mention flow).
  content.addEventListener('keydown', (e) => {
    if (popup.isOpen()) return;
    if (e.key !== '@' || e.ctrlKey || e.metaKey || e.altKey) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return; // collapsed → input-path mention
    const r = sel.getRangeAt(0);
    const elt = closestElement(r.commonAncestorContainer);
    if (!elt || !content.contains(elt) || elt.closest('pre, code, td, th')) return;
    const block = elt.closest('p, h1, h2, h3, li, blockquote');
    if (!block || !content.contains(block)) return;
    e.preventDefault();
    openSelection(r, sel.toString());
  });

  content.addEventListener('beforeinput', (e) => {
    const ie = e as InputEvent;
    if (popup.isOpen()) {
      // Bug 10: in selection mode the query is shell-owned and the original
      // selection must stay intact — block ALL editor input (IME/paste/typing)
      // so nothing mutates the selected link until the pick commits. Other modes
      // keep the old behavior (a second '@' is an ordinary filter character).
      if (mode === 'selection') e.preventDefault();
      return;
    }
    if (ie.inputType !== 'insertText' || ie.data !== '@' || ie.isComposing) return;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return; // selection case handled at keydown.
    if (!detectAtTrigger(sel.getRangeAt(0))) return;
    pendingOpen = true;
  });

  content.addEventListener('input', (e) => {
    const ie = e as InputEvent;
    // While the popup is open, keep filtering even MID-IME-COMPOSITION. A
    // Vietnamese IME (Telex/VNI/Unikey) composes every letter, so each keystroke
    // fires `input` with isComposing=true; bailing on that (as the open-detection
    // paths below must) would drop every letter's query update — the user sees the
    // char land in the editor with no filtering, while digits (never composed)
    // still filter. Reading deleteRange live gives the in-progress composed text.
    if (popup.isOpen()) {
      if (mode === 'mention' || mode === 'toolbar') updateMentionQuery();
      return;
    }
    if (ie.isComposing) return; // never OPEN a trigger mid-composition
    if (pendingOpen) {
      pendingOpen = false;
      openMention();
      return;
    }
    const ctx = detectMarkdownLinkTrigger(ie);
    if (ctx) openBracket(ctx.display, ctx.range);
  });

  // Caret moved out of the trigger run (mention/bracket only — selection mode's
  // caret intentionally stays put on the preserved selection). A NON-collapsed
  // selection is fine as long as it stays WITHIN the run: the user may select part
  // of the `@…` text to edit it. Close only when an endpoint leaves the run (check
  // BOTH ends via comparePoint, not just isCollapsed).
  document.addEventListener('selectionchange', () => {
    if (!popup.isOpen()) return;
    if (mode === 'selection') {
      // Bug 9: a selection-mode popup has no auto-close of its own. Close it as
      // soon as the editor selection leaves the saved selection (the user clicked
      // or arrowed away to pick another link) — otherwise isOpen + the input
      // owner stay stuck 'trigger' and every later `@` is swallowed. Opening
      // never moves the selection (the `@` keydown is preventDefault'd), so the
      // initial state matches savedSelection and this doesn't self-close.
      const s = window.getSelection();
      let leftSelection: boolean;
      if (!s || s.rangeCount === 0 || !savedSelection) {
        leftSelection = true;
      } else {
        const cur = s.getRangeAt(0);
        leftSelection =
          cur.startContainer !== savedSelection.startContainer ||
          cur.startOffset !== savedSelection.startOffset ||
          cur.endContainer !== savedSelection.endContainer ||
          cur.endOffset !== savedSelection.endOffset;
      }
      if (leftSelection) {
        abandonedSelection = true; // navigate-away: onPopupClose must not restore the old selection.
        popup.close();
      }
      return;
    }
    if ((mode !== 'mention' && mode !== 'bracket' && mode !== 'toolbar') || !deleteRange) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      popup.close();
      return;
    }
    const r = sel.getRangeAt(0);
    try {
      const startIn = deleteRange.comparePoint(r.startContainer, r.startOffset) === 0;
      const endIn = deleteRange.comparePoint(r.endContainer, r.endOffset) === 0;
      if (!startIn || !endIn) {
        popup.close();
      }
    } catch {
      popup.close();
    }
  });

  return {
    notifyFileSearchResult(requestId, files): void {
      if (!pendingFileSearch || pendingFileSearch.requestId !== requestId) return; // stale/superseded.
      const resolve = pendingFileSearch.resolve;
      pendingFileSearch = undefined;
      resolve(files);
    },
    openFromToolbar,
    setTriggerMode(m: TriggerMode): void {
      triggerMode = m;
    },
    setDocUri(uri: string): void {
      docUri = uri;
    },
    notifyNamespaceListResult(requestId, ready, namespaces): void {
      if (!pendingNamespaceReq || pendingNamespaceReq.requestId !== requestId) return; // stale/superseded.
      const resolve = pendingNamespaceReq.resolve;
      pendingNamespaceReq = undefined;
      resolve({ ready, namespaces });
    },
    notifyEntityResult(requestId, ready, entities): void {
      if (!pendingEntityReq || pendingEntityReq.requestId !== requestId) return; // stale/superseded.
      const resolve = pendingEntityReq.resolve;
      pendingEntityReq = undefined;
      resolve({ ready, entities });
    },
  };
}
