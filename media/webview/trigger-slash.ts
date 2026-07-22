/**
 * `/` Define + Execute trigger (Req 20 US-20.2/US-20.3), built on the shared
 * trigger-popup.ts shell — the shell owns chrome/positioning/keyboard-nav/
 * Escape/staleness (US-20.4); this module owns ONLY the `/` trigger-detection
 * (start-of-word rule, IME guard), the live `/`+filter Range tracking, the
 * location-sensitive item groups, and wiring each pick to the SAME insertion
 * functions the toolbar buttons already call (toolbar.ts's
 * runTriggerDefineInsert/runTriggerInsertDate/runTriggerDeleteOnly) — no
 * parallel implementation.
 *
 * `input-rules.ts` stands down on its own via `hasInputOwner()` (already
 * wired) once the shell's `open()` calls `setInputOwner('trigger')` — this
 * module does not need its own guard for that.
 */
import { closestElement, encodeLinkPath, relativeLinkPath } from './dom-utils';
import { normalizeForSearch } from '../../src/text-utils';
import { postProcessCaptions } from './dom-postprocess';
import {
  runTriggerDefineInsert,
  runTriggerDeleteOnly,
  runTriggerInsertDate,
  runTriggerInsertRelateLink,
  type TriggerDefineBlockId,
} from './toolbar';
import type { TriggerPopupController, TriggerPopupGroup, TriggerPopupItem } from './trigger-popup';
import type {
  EntitySuggestion,
  NamespaceSummary,
  TriggerConfig,
  TriggerMode,
  WebviewToHost,
} from '../../src/shared/messages';

export interface TriggerSlashController {
  /** Set once from the 'init' message — echoed back on `executeCommand` (US-20.3). */
  setDocUri(uri: string): void;
  /** Set/refresh from `InitConfig.trigger` (US-20.2/20.3 seed). */
  setConfig(cfg: TriggerConfig | undefined): void;
  /** Req 21 US-21.5 — set/refresh the `orcaEditor.triggerActions.mode` gate (seed + live `configUpdate`). */
  setTriggerMode(m: TriggerMode): void;
  /** Req 21 US-21.1 — reply to `namespaceList`, for the Declare-entity flow's step 1 (own requestId sequence — ignored if stale). */
  notifyNamespaceListResult(requestId: number, ready: boolean, namespaces: NamespaceSummary[]): void;
  /** Req 21 US-21.1 — reply to `entitySearch`, for the Declare-entity flow's step 2 duplicate check (own requestId sequence — ignored if stale). */
  notifyEntityResult(requestId: number, ready: boolean, entities: EntitySuggestion[]): void;
}

/**
 * Group-1 (block-level) items — only offered at the start of an otherwise-
 * empty paragraph. `advancedOnly` (Req 21 US-21.5, e.g. a future "Declare
 * entity" row) is filtered generically by `gateByMode` below, not by a
 * hardcoded id/label check.
 */
const BLOCK_ITEMS: { id: TriggerDefineBlockId; label: string; detail?: string; advancedOnly?: boolean }[] = [
  { id: 'heading-1', label: 'Heading 1', detail: '#' },
  { id: 'heading-2', label: 'Heading 2', detail: '##' },
  { id: 'heading-3', label: 'Heading 3', detail: '###' },
  { id: 'heading-4', label: 'Heading 4', detail: '####' },
  { id: 'heading-5', label: 'Heading 5', detail: '#####' },
  { id: 'heading-6', label: 'Heading 6', detail: '######' },
  { id: 'bullet', label: 'Bulleted list', detail: '-' },
  { id: 'numbered', label: 'Numbered list', detail: '1.' },
  { id: 'blockquote', label: 'Blockquote', detail: '>' },
  { id: 'table', label: 'Table' },
  { id: 'code-block', label: 'Code block', detail: '```' },
  { id: 'mermaid', label: 'Mermaid diagram' },
  { id: 'math-block', label: 'Math block', detail: '$$' },
  { id: 'hr', label: 'Horizontal rule', detail: '---' },
  { id: 'toc', label: 'Table of Contents' },
];

/** ID prefixes disambiguate what a picked TriggerPopupItem.id means to handlePick(). */
const BLOCK_PREFIX = 'block:';
const INLINE_DATE_ID = 'inline:insert-date';
const EXEC_PREFIX = 'exec:';
/** Req 20 US-20.5 — whole-document `/add reference` action (position-independent, not mode-gated). */
const ADD_REFERENCE_ID = 'action:add-reference';
/** Req 21 US-21.1 — entry point into the 3-step Declare Entity flow (advanced-only, see INLINE_ITEMS). */
const DECLARE_ENTITY_ID = 'action:declare-entity';
/** Req 21 US-21.4 — entry point into the `/relate` target-picker (advanced-only, see INLINE_ITEMS). */
const RELATE_ID = 'action:relate';

/**
 * Group-2 (inline) items — offered at any caret position (no empty-paragraph
 * requirement), gated the SAME generic `advancedOnly` way as BLOCK_ITEMS.
 * `detail` for INLINE_DATE_ID is filled in per-build (it's the live configurable
 * dateFormat, not a static string) — see buildGroups.
 */
const INLINE_ITEMS: { id: string; label: string; advancedOnly?: boolean }[] = [
  { id: INLINE_DATE_ID, label: "Insert today's date" },
  { id: ADD_REFERENCE_ID, label: 'Add reference' },
  { id: DECLARE_ENTITY_ID, label: 'Declare entity', advancedOnly: true },
  { id: RELATE_ID, label: 'Relate to entity', advancedOnly: true },
];

/** Req 21 US-21.1 — namespace-picker (step 1) row-id prefix; the pinned create-new row. */
const DECLARE_NS_PREFIX = 'declare-ns:';
const DECLARE_NS_CREATE_ID = 'declare-ns:__create__';
/** Req 21 US-21.1 — id-input (step 2)'s single "confirm" row. */
const DECLARE_CONFIRM_ID = 'declare-confirm';

/** `YYYY`/`MM`/`DD`/`HH`/`mm`/`ss` token replace — deterministic, not locale-dependent (US-20.2). */
function formatDate(format: string, d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const tokens: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
  };
  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => tokens[token]);
}

/** Diacritic-insensitive substring match on the item LABEL only — the dim shortcut hint (`detail`) never participates (US-20.2). */
function matchesFilter(label: string, q: string): boolean {
  if (!q) return true;
  return normalizeForSearch(label).includes(normalizeForSearch(q));
}

/**
 * Text from the start of `block` to `range`'s start — used ONLY to judge the
 * "start of word" trigger condition (COPIED, small, from input-rules.ts's own
 * private textBeforeCaret — deliberately not exported/shared so a future
 * change to one is a conscious edit in both, same rationale trigger-popup.ts
 * already documents for its anchoring helper).
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

export function initTriggerSlash(
  content: HTMLElement,
  popup: TriggerPopupController,
  postToHost: (msg: WebviewToHost) => void
): TriggerSlashController {
  let docUri = '';
  let dateFormat = 'YYYY-MM-DD';
  let executeCommands: { id: string; label: string }[] = [];
  /** Req 21 US-21.5 — gates visibility only (see `gateByMode`), never restyles/hides written content. */
  let triggerMode: TriggerMode = 'advanced';

  /** Req 21 US-21.5 guard — filters a canonical item list by `advancedOnly`, not a hardcoded id/label check. */
  function gateByMode<T extends { advancedOnly?: boolean }>(items: T[]): T[] {
    return triggerMode === 'advanced' ? items : items.filter((i) => !i.advancedOnly);
  }

  /** The <p> the `/` was typed into — reset on every close (any path). */
  let triggerBlock: HTMLElement | undefined;
  /** Live Range spanning from the `/` character to the current caret. */
  let triggerRange: Range | undefined;
  /** Set by 'beforeinput' when the NEXT 'input' should open the popup. */
  let pendingOpen = false;

  /**
   * Req 21 US-21.1 — which step of the Declare-entity flow `triggerRange` is
   * currently tracking, if any. Unlike the `/`+filter run, these steps have no
   * leading trigger character to strip: `triggerRange` starts COLLAPSED at the
   * insertion point and the WHOLE accumulated typed run since then is the query
   * verbatim (same "no leading-char stripping" rule trigger-at.ts's `toolbar`
   * mode already uses for its Link/Image button flow — see updateDeclareStepQuery).
   * `'relate'` (Req 21 US-21.4) reuses this exact same accumulated-typed-run
   * tracking for the `/relate` target-picker's search box — see openRelatePickStep.
   */
  let declareStep: 'namespace' | 'id' | 'relate' | undefined;

  /**
   * Req 21 US-21.1 — the paragraph the current Declare-entity step is typed
   * into. Tracked as an ELEMENT (kept a stable caret host by `ensureTextAnchor`)
   * rather than via a text-node Range: Chromium replaces/merges the anchor text
   * node between keystrokes, so a text-node-anchored range's container goes
   * stale, but the `<p>` element identity survives — its `textContent` is the
   * authoritative, lag-free typed run (see `updateDeclareStepQuery`).
   */
  let declareBlock: HTMLElement | undefined;

  /** Req 21 US-21.1 — namespace browse list, fetched once and cached for the whole webview session (namespaceListResult echoes `ready`; only a ready reply is cached). */
  let namespaceCache: NamespaceSummary[] | undefined;
  let namespaceReqSeq = 0;
  let pendingNamespaceReq: { requestId: number; resolve: (n: NamespaceSummary[]) => void } | undefined;

  function fetchNamespaces(forceRefresh = false): Promise<NamespaceSummary[]> {
    if (namespaceCache && !forceRefresh) {
      return Promise.resolve(namespaceCache);
    }
    const requestId = ++namespaceReqSeq;
    postToHost({ type: 'namespaceList', requestId });
    return new Promise<NamespaceSummary[]>((resolve) => {
      pendingNamespaceReq = { requestId, resolve };
    });
  }

  /** Req 21 US-21.1 — one namespace's full entity list, fetched fresh per Declare-entity session (step 2's duplicate check + id suggestion). */
  let entityReqSeq = 0;
  let pendingEntityReq: { requestId: number; resolve: (e: EntitySuggestion[]) => void } | undefined;

  function fetchEntitiesForNamespace(namespace: string): Promise<EntitySuggestion[]> {
    const requestId = ++entityReqSeq;
    postToHost({ type: 'entitySearch', requestId, query: '', namespace });
    return new Promise<EntitySuggestion[]>((resolve) => {
      pendingEntityReq = { requestId, resolve };
    });
  }

  /** Req 21 US-21.4 — `/relate`'s flat combined id+title search across ALL namespaces (no `namespace` filter), same request/reply channel as fetchEntitiesForNamespace. */
  function fetchEntitySearch(query: string): Promise<EntitySuggestion[]> {
    const requestId = ++entityReqSeq;
    postToHost({ type: 'entitySearch', requestId, query });
    return new Promise<EntitySuggestion[]>((resolve) => {
      pendingEntityReq = { requestId, resolve };
    });
  }

  /**
   * Req 21 US-21.1 — a collapsed Range whose container is an ELEMENT (e.g. the
   * `(<p>, 0)` point `collapseSelectionAfterTriggerDelete` (toolbar.ts) leaves
   * behind when its delete empties the paragraph down to a filler `<br>`) is
   * fragile as a long-lived "accumulate typed text since here" anchor: per the
   * DOM boundary-point-adjustment algorithm, inserting the FIRST typed
   * character at that exact same child index can push the boundary to (p, 1)
   * — now AFTER the just-inserted text node — so every further keystroke's
   * `Range.toString()` reads one character behind (confirmed empirically: the
   * `/`+filter flow never hits this because its anchor is always inside an
   * EXISTING text node, the trigger character itself). Normalize by inserting
   * an empty text node at the collapsed point and re-anchoring both the
   * tracked Range and the live selection INSIDE it — typing then lands inside
   * a real text node from the very first keystroke, sidestepping the
   * element-container adjustment case entirely.
   */
  function ensureTextAnchor(range: Range): Range {
    let anchorNode: Text;
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      anchorNode = range.startContainer as Text;
    } else {
      anchorNode = document.createTextNode('');
      range.insertNode(anchorNode);
    }
    // The typed-run anchor lives in a paragraph the trigger delete has just
    // emptied. An empty `<p>` whose only content is empty text node(s) is not a
    // stable caret host: Chromium's contentEditable destroys the `<p>` and
    // reparents the text node up to `#content` on the very first keystroke, and
    // the selection offset reported DURING that restructuring `input` event
    // lags one character behind — so every `updateDeclareStepQuery` read is off
    // by one (confirmed empirically; the `/`+filter path never hits this
    // because its anchor sits in a paragraph that already holds the real `/`
    // character, so no restructuring happens). Rebuild the emptied block to the
    // canonical `<p>[anchor]<br></p>` shape (a `<br>`-backed non-empty block
    // Chromium leaves intact, stray empty text nodes the delete left behind
    // cleared) so the paragraph survives and the live selection stays in sync
    // from the first keystroke.
    const block = closestElement(anchorNode);
    if (block && block !== content && (block.textContent ?? '') === '') {
      while (block.firstChild) {
        block.removeChild(block.firstChild);
      }
      block.appendChild(anchorNode);
      block.appendChild(document.createElement('br'));
    }
    const anchored = document.createRange();
    anchored.setStart(anchorNode, anchorNode.length);
    anchored.setEnd(anchorNode, anchorNode.length);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(anchored);
    }
    return anchored;
  }

  /** Req 21 US-21.1 — highest NUMERIC existing id in `entities` + 1, zero-padded to that id's width; '' when none is numeric (new namespace or all-non-numeric ids — no suggestion invented). */
  function computeNextId(entities: EntitySuggestion[]): string {
    let maxNum = -1;
    let width = 0;
    for (const e of entities) {
      if (/^\d+$/.test(e.id)) {
        const n = Number(e.id);
        if (n > maxNum) {
          maxNum = n;
          width = e.id.length;
        }
      }
    }
    return maxNum < 0 ? '' : String(maxNum + 1).padStart(width, '0');
  }

  /** Req 21 US-21.1 step 1 — namespace picker groups: a pinned "+ Create new namespace" row (valid only for a non-empty ALL-letters name not already taken, case-insensitively — the same namespace shape entity-index.ts's NAMESPACE_RE parses) followed by the filtered existing-namespace list. */
  function namespaceStepGroups(q: string, namespaces: NamespaceSummary[]): TriggerPopupGroup[] {
    const trimmed = q.trim();
    const filtered = namespaces.filter((n) => matchesFilter(n.name, q));
    const isNewValid = /^\p{L}+$/u.test(trimmed) && !namespaces.some((n) => n.name.toLowerCase() === trimmed.toLowerCase());
    const createItem: TriggerPopupItem = trimmed
      ? {
          id: DECLARE_NS_CREATE_ID,
          label: isNewValid ? `+ Create new namespace "${trimmed}"` : '+ Create new namespace',
          disabled: !isNewValid,
        }
      : { id: DECLARE_NS_CREATE_ID, label: '+ Create new namespace', disabled: true };
    const items: TriggerPopupItem[] = [
      createItem,
      ...filtered.map((n) => ({ id: `${DECLARE_NS_PREFIX}${n.name}`, label: n.name, detail: String(n.count) })),
    ];
    return [{ label: 'Namespace', items }];
  }

  /**
   * Req 21 US-21.1 step 2 — id-input groups: a single "confirm" row.
   *  - No id typed yet: offers `suggested` (highest existing numeric id + 1)
   *    as the default Enter-to-accept action when one exists (an existing
   *    namespace); otherwise an inert placeholder (nothing to confirm yet).
   *  - Duplicate id (exact match, case-sensitive — only the namespace half
   *    folds case): a disabled row + inline error naming the conflicting file
   *    (US-21.1's "refuse Enter, inline error").
   *  - Otherwise: the real "Declare NS_ID" confirm row.
   */
  function idStepGroups(q: string, namespace: string, entities: EntitySuggestion[], suggested: string): TriggerPopupGroup[] {
    const typed = q.trim();
    const id = typed || suggested;
    if (!id) {
      return [{ label: `New ${namespace} id`, items: [{ id: DECLARE_CONFIRM_ID, label: 'Type an id…', disabled: true }] }];
    }
    const conflict = entities.find((e) => e.id === id);
    if (conflict) {
      let fileName = conflict.file.split('/').pop() ?? conflict.file;
      try {
        fileName = decodeURIComponent(fileName);
      } catch {
        // malformed %-escape in the raw uri — show it encoded rather than throw.
      }
      return [
        {
          label: `${namespace}${id}`,
          items: [
            {
              id: DECLARE_CONFIRM_ID,
              label: 'Already declared',
              disabled: true,
              errorText: `${namespace}${id} is already declared in ${fileName}`,
            },
          ],
        },
      ];
    }
    const label = typed ? `Declare ${namespace}${id}` : `Declare ${namespace}${id} (suggested — type to change)`;
    return [{ label: `New ${namespace} id`, items: [{ id: DECLARE_CONFIRM_ID, label }] }];
  }

  /** Req 21 US-21.1 step 2 — id-input popup. Opened SYNCHRONOUSLY (in the reopen
   * microtask, before the user can type) with the namespace's entity list fetched
   * INSIDE the popup's async query — mirrors openDeclareNamespaceStep's
   * `fetchNamespaces().then()` query. Bug 7: the old shape opened the popup only
   * AFTER the fetch resolved, leaving a real async window in which typed text
   * (e.g. `UC`) and Enter landed as raw editor input — no popup owned them — so
   * the run stayed behind and the committed id was wrong. Opening up-front keeps
   * the popup (and its input-ownership + Enter capture) held across the fetch. */
  function openDeclareIdStep(insertionPoint: Range, namespace: string): void {
    triggerRange = insertionPoint.cloneRange();
    declareBlock = closestElement(insertionPoint.startContainer)?.closest('p') ?? undefined;
    declareStep = 'id';
    let lastQuery = '';
    // Entities (dup check + suggested id) resolve async; cache the single fetch
    // (fetchEntitiesForNamespace keeps one pending-request slot, so it must be
    // called exactly once) and the derived suggested id, filled on resolve.
    let entities: EntitySuggestion[] | undefined;
    let suggested = '';
    let entitiesPromise: Promise<EntitySuggestion[]> | undefined;
    function ensureEntities(): Promise<EntitySuggestion[]> {
      if (!entitiesPromise) {
        entitiesPromise = fetchEntitiesForNamespace(namespace).then((es) => {
          entities = es;
          suggested = computeNextId(es);
          return es;
        });
      }
      return entitiesPromise;
    }
    popup.open({
      axis: '/',
      anchorRange: triggerRange.cloneRange(),
      dataSource: {
        query: (q) => {
          lastQuery = q;
          if (entities) {
            return idStepGroups(q, namespace, entities, suggested);
          }
          return ensureEntities().then((es) => idStepGroups(q, namespace, es, suggested));
        },
      },
      onPick: (item) => {
        if (item.id !== DECLARE_CONFIRM_ID) {
          return;
        }
        const id = lastQuery.trim() || suggested;
        if (!id || !triggerRange) {
          return;
        }
        // Reuses runTriggerInsertDate as-is: it deletes triggerRange's
        // (possibly empty) typed run then inserts `text` as a plain text
        // node at the caret — the function's shape is generic (delete-range
        // + plain-text insert), not date-specific, so no parallel
        // implementation is added here for the caption text.
        runTriggerInsertDate(`caption::${namespace}${id}`, triggerRange);
        // Instant pill feedback (idempotent — see postProcessCaptions's own
        // ancestor guard) rather than waiting for the next full re-render.
        postProcessCaptions(content, document);
      },
      onClose: () => {
        triggerBlock = undefined;
        triggerRange = undefined;
        declareStep = undefined;
        declareBlock = undefined;
      },
    });
  }

  /** Req 21 US-21.1 step 1 — namespace-picker popup, opened right after `/declare entity`'s typed text is stripped. */
  function openDeclareNamespaceStep(insertionPoint: Range): void {
    triggerRange = insertionPoint.cloneRange();
    declareBlock = closestElement(insertionPoint.startContainer)?.closest('p') ?? undefined;
    declareStep = 'namespace';
    let lastQuery = '';
    popup.open({
      axis: '/',
      anchorRange: triggerRange.cloneRange(),
      dataSource: {
        query: (q) => {
          lastQuery = q;
          if (namespaceCache) {
            return namespaceStepGroups(q, namespaceCache);
          }
          return fetchNamespaces().then((list) => namespaceStepGroups(q, list));
        },
      },
      onPick: (item) => {
        const namespace = item.id === DECLARE_NS_CREATE_ID ? lastQuery.trim() : item.id.slice(DECLARE_NS_PREFIX.length);
        if (!namespace || !triggerRange) {
          return;
        }
        // Strip the typed namespace-filter run before moving to step 2 (same
        // "delete the trigger's own typed run" contract runTriggerDeleteOnly
        // already provides everywhere else in this file).
        runTriggerDeleteOnly(triggerRange);
        const point = ensureTextAnchor(triggerRange.cloneRange());
        queueMicrotask(() => openDeclareIdStep(point, namespace));
      },
      onClose: () => {
        triggerBlock = undefined;
        triggerRange = undefined;
        declareStep = undefined;
        declareBlock = undefined;
      },
    });
  }

  /** Req 21 US-21.4 — namespace-narrow/back row id prefix for the `/relate` target-picker (mirrors trigger-at.ts's Entities-scope ENTITY_NS_PREFIX/ENTITY_BACK_ID — no create-new-namespace row here, a relate target must already be declared). */
  const RELATE_NS_PREFIX = 'relate-ns:';
  const RELATE_BACK_ID = `${RELATE_NS_PREFIX}__back__`;
  const RELATE_ENTITY_PREFIX = 'relate-ent:';

  /** Req 21 US-21.4 — bare-query browse position: undefined = flat namespace list, set = narrowed into one namespace's id list. */
  let relateNamespaceBrowse: string | undefined;
  /** Req 21 US-21.4 — id → resolved commit target, rebuilt on every relateGroups() call (mirrors trigger-at.ts's targetsById). */
  let relateTargets = new Map<string, { fullId: string; href: string }>();

  /** Req 21 US-21.4 — relative href for one entity result (mirrors trigger-at.ts's own entityHref exactly — same formula, deliberately not shared, see this file's textBeforeCaret comment for the project's precedent on small per-module duplication). */
  function relateEntityHref(e: EntitySuggestion): string {
    return `${encodeLinkPath(relativeLinkPath(docUri, e.file))}#${e.namespace}${e.id}`;
  }

  function relateEntityItems(entities: EntitySuggestion[]): TriggerPopupItem[] {
    return entities.map((e) => {
      const id = `${RELATE_ENTITY_PREFIX}${e.namespace}${e.id}`;
      relateTargets.set(id, { fullId: `${e.namespace}${e.id}`, href: relateEntityHref(e) });
      return { id, label: `${e.namespace}${e.id}`, detail: e.title || undefined, tint: 'entity' as const };
    });
  }

  /**
   * Req 21 US-21.4 — `/relate` target-picker groups: bare query browses
   * (namespace list, or a narrowed namespace's id list), any typed query
   * switches to the flat combined search — same shape as trigger-at.ts's
   * Entities scope (buildEntityGroups), minus the create-new-namespace row
   * (a relate target must already exist).
   */
  function relateGroups(q: string): TriggerPopupGroup[] | Promise<TriggerPopupGroup[]> {
    relateTargets = new Map();
    if (!q) {
      if (relateNamespaceBrowse) {
        const ns = relateNamespaceBrowse;
        return fetchEntitiesForNamespace(ns).then((entities) => [
          { label: ns, items: [{ id: RELATE_BACK_ID, label: '‹ All namespaces' }, ...relateEntityItems(entities)] },
        ]);
      }
      // Always post a fresh `namespaceList` round trip for the `/relate`
      // namespace browse (mirrors trigger-at.ts's non-caching Entities scope):
      // the back-row must re-fetch, not reuse the session cache the Declare
      // flow relies on — so the browse never reads the cache here.
      return fetchNamespaces(true).then((namespaces) => [
        {
          label: 'Namespaces',
          items: namespaces.map((n) => ({ id: `${RELATE_NS_PREFIX}${n.name}`, label: n.name, detail: String(n.count) })),
        },
      ]);
    }
    return fetchEntitySearch(q).then((entities) => [{ label: 'Entities', items: relateEntityItems(entities) }]);
  }

  /** Req 21 US-21.4 — `/relate` target-picker popup, opened right after the typed `/relate` text is stripped. */
  function openRelatePickStep(insertionPoint: Range): void {
    triggerRange = insertionPoint.cloneRange();
    declareBlock = closestElement(insertionPoint.startContainer)?.closest('p') ?? undefined;
    declareStep = 'relate';
    popup.open({
      axis: '/',
      anchorRange: triggerRange.cloneRange(),
      dataSource: { query: relateGroups },
      onPick: (item) => {
        if (item.id === RELATE_BACK_ID || item.id.startsWith(RELATE_NS_PREFIX)) {
          // Navigation pick, not a commit — same close+reopen-via-queueMicrotask
          // idiom trigger-at.ts's namespace-narrow already uses (the shell
          // always close()s right after onPick fires).
          relateNamespaceBrowse = item.id === RELATE_BACK_ID ? undefined : item.id.slice(RELATE_NS_PREFIX.length);
          const captured = triggerRange?.cloneRange();
          if (!captured) return;
          queueMicrotask(() => openRelatePickStep(captured));
          return;
        }
        const target = relateTargets.get(item.id);
        if (!target || !triggerRange) return;
        // US-21.4: one-way write, single file — the target file/its References
        // section is never touched, no reverse line.
        runTriggerInsertRelateLink(target.href, target.fullId, triggerRange);
      },
      onClose: () => {
        // relateNamespaceBrowse deliberately survives this close: the
        // namespace-narrow/back nav pick above closes+reopens the SAME
        // session (mirrors trigger-at.ts's entityNamespaceBrowse, which its
        // own onPopupClose likewise never clears) — only a brand-new
        // `/relate` session (handlePick's RELATE_ID branch) resets it.
        triggerBlock = undefined;
        triggerRange = undefined;
        declareStep = undefined;
        declareBlock = undefined;
      },
    });
  }

  /**
   * Req 21 US-21.1 — Declare-entity steps 1/2 have no leading trigger char to
   * strip (unlike `/`+filter): `triggerRange` starts collapsed at the
   * insertion point, so the WHOLE accumulated typed run since then IS the
   * query verbatim (mirrors trigger-at.ts's `toolbar` mode).
   */
  function updateDeclareStepQuery(): void {
    if (!triggerRange) {
      return;
    }
    if (!declareBlock || !content.contains(declareBlock)) {
      popup.close();
      return;
    }
    // The query is the whole typed run, read straight from the trigger
    // paragraph's `textContent` — NOT from the live selection's offset. The
    // `input` event fires while the selection is still being reconciled: under
    // load Chromium reports the PRE-insertion caret offset here (a one-character
    // lag), so a selection-based `Range.toString()` intermittently drops the
    // just-typed character. The paragraph (kept a stable, non-hoisting caret
    // host by `ensureTextAnchor`) holds exactly the typed run after the trigger
    // delete, so its `textContent` is authoritative and lag-free. `triggerRange`
    // is re-spanned over the block's contents so the commit's delete (see
    // `openDeclareIdStep`'s `runTriggerInsertDate`) covers the whole typed run.
    triggerRange.selectNodeContents(declareBlock);
    popup.updateQuery(declareBlock.textContent ?? '');
  }

  /**
   * Emptiness judged EXCLUDING the `/`+filter run itself (US-20.2) — computed
   * by concatenating the block's text strictly before and strictly after
   * `triggerRange`, not a blind string search-and-strip (a filter that happens
   * to repeat elsewhere in the block must not be double-stripped).
   */
  function isTriggerParagraphEmpty(): boolean {
    if (!triggerBlock || !triggerRange) return false;
    // Group-1 (block-level) items are offered at the start of an otherwise-empty
    // top-level paragraph OR heading. An empty heading is a start-of-line context
    // that merely wears a markdown format, so `/` there behaves as if the line
    // were empty — handlePick normalizes the empty heading to a `<p>` before the
    // insert so every item runs the golden top-level-`<p>` path (no nesting/split).
    // A list item / blockquote is intentionally NOT included: only the inline
    // group shows there (a block nested in them can't serialize cleanly).
    const nn = triggerBlock.nodeName;
    const isTopLevelParagraphOrHeading =
      triggerBlock.parentElement === content && (nn === 'P' || nn === 'H1' || nn === 'H2' || nn === 'H3');
    if (!isTopLevelParagraphOrHeading) return false;
    const before = document.createRange();
    before.selectNodeContents(triggerBlock);
    before.setEnd(triggerRange.startContainer, triggerRange.startOffset);
    const after = document.createRange();
    after.selectNodeContents(triggerBlock);
    after.setStart(triggerRange.endContainer, triggerRange.endOffset);
    return (before.toString() + after.toString()).trim() === '';
  }

  function buildGroups(q: string): TriggerPopupGroup[] {
    const blockItems: TriggerPopupItem[] = isTriggerParagraphEmpty()
      ? gateByMode(BLOCK_ITEMS)
          .filter((b) => matchesFilter(b.label, q))
          .map((b) => ({
            id: `${BLOCK_PREFIX}${b.id}`,
            label: b.label,
            detail: b.detail,
          }))
      : [];
    const inlineItems: TriggerPopupItem[] = gateByMode(INLINE_ITEMS)
      .filter((it) => matchesFilter(it.label, q))
      .map((it) => ({ id: it.id, label: it.label, detail: it.id === INLINE_DATE_ID ? dateFormat : undefined }));
    const execItems: TriggerPopupItem[] = executeCommands
      .filter((c) => matchesFilter(c.label, q))
      .map((c) => ({ id: `${EXEC_PREFIX}${c.id}`, label: c.label }));
    return [
      { label: 'Blocks', items: blockItems },
      { label: 'Insert', items: inlineItems },
      { label: 'Execute', items: execItems },
    ];
  }

  /**
   * A block-level pick in an otherwise-empty top-level *heading* is treated as a
   * start-of-line pick: replace the empty heading with a fresh empty `<p>` and
   * return a collapsed range inside it, so runTriggerDefineInsert's convert AND
   * insert actions all run on the golden top-level-`<p>` path — identical to the
   * empty-paragraph case — instead of nesting/splitting the heading. Returns
   * undefined when triggerBlock is not an otherwise-empty heading (the caller
   * then keeps the original `/`+filter range, e.g. an empty `<p>` needs none).
   */
  function normalizeEmptyHeadingForBlockInsert(): Range | undefined {
    const block = triggerBlock;
    if (!block || block.parentElement !== content) return undefined;
    const nn = block.nodeName;
    if (nn !== 'H1' && nn !== 'H2' && nn !== 'H3') return undefined;
    if (!isTriggerParagraphEmpty()) return undefined;
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    block.replaceWith(p);
    triggerBlock = p;
    const r = document.createRange();
    r.setStart(p, 0);
    r.collapse(true);
    triggerRange = r;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    return r.cloneRange();
  }

  function handlePick(item: TriggerPopupItem): void {
    const range = triggerRange;
    if (!range) return;
    if (item.id.startsWith(BLOCK_PREFIX)) {
      const insertRange = normalizeEmptyHeadingForBlockInsert() ?? range;
      runTriggerDefineInsert(item.id.slice(BLOCK_PREFIX.length) as TriggerDefineBlockId, insertRange);
    } else if (item.id === INLINE_DATE_ID) {
      runTriggerInsertDate(formatDate(dateFormat), range);
    } else if (item.id === ADD_REFERENCE_ID) {
      // US-20.5: strip the typed `/add reference`, then ask the host to build/
      // update the References section (queued after the popup's synchronous
      // close(), same pattern as the Execute branch below).
      runTriggerDeleteOnly(range);
      queueMicrotask(() => postToHost({ type: 'addReference', docUri }));
    } else if (item.id.startsWith(EXEC_PREFIX)) {
      const commandId = item.id.slice(EXEC_PREFIX.length);
      // Delete-only (no textual trace) + settle caret NOW; dispatch the command
      // request only after the popup has actually closed (queued as a
      // microtask — the shell's close() runs synchronously right after this
      // handler returns, so by the time the microtask runs the popup is gone).
      runTriggerDeleteOnly(range);
      queueMicrotask(() => postToHost({ type: 'executeCommand', commandId, docUri }));
    } else if (item.id === DECLARE_ENTITY_ID) {
      // Req 21 US-21.1: strip the typed `/declare entity`, then reopen the SAME
      // shared popup shell at the now-collapsed caret for step 1 (namespace
      // picker) — queued after the popup's synchronous close(), same pattern
      // as Execute/Add-reference above.
      runTriggerDeleteOnly(range);
      const insertionPoint = ensureTextAnchor(range.cloneRange());
      queueMicrotask(() => openDeclareNamespaceStep(insertionPoint));
    } else if (item.id === RELATE_ID) {
      // Req 21 US-21.4: strip the typed `/relate`, then open the target-picker
      // at the now-collapsed caret — same close+reopen-via-queueMicrotask
      // pattern as Declare-entity above. A brand-new session always starts
      // un-narrowed (see openRelatePickStep's onClose for why this reset
      // does NOT happen there).
      runTriggerDeleteOnly(range);
      relateNamespaceBrowse = undefined;
      const insertionPoint = ensureTextAnchor(range.cloneRange());
      queueMicrotask(() => openRelatePickStep(insertionPoint));
    }
  }

  function openTrigger(): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    // Allowed block types = US-20.1's set (paragraph, heading H1–H3, list item,
    // blockquote), same as trigger-at.ts's `@` gate. MUST stay in sync with the
    // `beforeinput` gate below or openTrigger aborts a `/` beforeinput allowed.
    const block = closestElement(r.startContainer)?.closest<HTMLElement>('p, h1, h2, h3, li, blockquote');
    if (!block || !content.contains(block)) return;
    triggerBlock = block;
    const start = document.createRange();
    if (r.startContainer.nodeType === Node.TEXT_NODE && r.startOffset >= 1) {
      start.setStart(r.startContainer, r.startOffset - 1);
    } else {
      start.setStart(r.startContainer, r.startOffset);
    }
    start.setEnd(r.startContainer, r.startOffset);
    triggerRange = start;
    popup.open({
      axis: '/',
      anchorRange: triggerRange.cloneRange(),
      dataSource: { query: buildGroups },
      onPick: handlePick,
      onClose: () => {
        triggerBlock = undefined;
        triggerRange = undefined;
      },
    });
  }

  function updateTriggerRangeAndQuery(): void {
    if (!triggerRange) return;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) {
      popup.close();
      return;
    }
    const r = sel.getRangeAt(0);
    let text: string;
    try {
      triggerRange.setEnd(r.startContainer, r.startOffset);
      text = triggerRange.toString();
    } catch {
      // DOM mutated the trigger range's anchors out from under it — bail non-destructively.
      popup.close();
      return;
    }
    if (!text.startsWith('/')) {
      // The '/' itself is gone (e.g. Backspace past the filter, already applied
      // by the browser's default action) — nothing left to clean up.
      popup.close();
      return;
    }
    const filter = text.slice(1);
    if (filter === ' ' || filter.charCodeAt(0) === 0xa0) {
      // '/' + space escape (US-20.2, Notion/Slack pattern): literalize — close
      // without touching anything; the space is already typed as-is. Chromium's
      // contentEditable commits a lone trailing space as a non-breaking space
      // (U+00A0), so match that too or the escape silently never fires.
      popup.close();
      return;
    }
    popup.updateQuery(filter);
  }

  // ---- Trigger detection -----------------------------------------------------
  // Two-phase: 'beforeinput' judges the PRE-insertion caret/selection state
  // (start-of-word, not mid-word/non-collapsed/IME), then the paired 'input'
  // (same tick, DOM already mutated) opens the popup anchored right after the
  // now-inserted '/'.
  content.addEventListener('beforeinput', (e) => {
    const ie = e as InputEvent;
    if (popup.isOpen()) return; // a second '/' while open is an ordinary filter character.
    if (ie.inputType !== 'insertText' || ie.data !== '/' || ie.isComposing) return;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return; // non-collapsed selection → literal '/'.
    const anchor = sel.anchorNode;
    if (!anchor || !content.contains(anchor)) return;
    if (closestElement(anchor)?.closest('pre, code, td, th')) return;
    // US-20.1 allowed block types (H1–H3 only is intentional; H4–H6 excluded),
    // shared with `@` — MUST stay in sync with openTrigger's gate above.
    const block = closestElement(anchor)?.closest('p, h1, h2, h3, li, blockquote');
    if (!block || !content.contains(block)) return;
    const before = textBeforeCaret(block, sel.getRangeAt(0));
    if (before !== '' && !/\s$/.test(before)) return; // mid-word → literal '/'.
    pendingOpen = true;
  });

  content.addEventListener('input', (e) => {
    // While the popup is open, keep filtering even MID-IME-COMPOSITION. A
    // Vietnamese IME (Telex/VNI/Unikey) composes every letter, so each keystroke
    // fires `input` with isComposing=true; bailing on that (as the open path
    // below must) would drop every letter's query update — the user sees the char
    // land in the editor with no command filtering, while digits (never composed)
    // still filter.
    if (popup.isOpen() && triggerRange) {
      // Req 21 US-21.1: the Declare-entity steps track a plain accumulated
      // run with no leading trigger char (see updateDeclareStepQuery) — the
      // ordinary `/`+filter path below does not apply to them.
      if (declareStep) {
        updateDeclareStepQuery();
      } else {
        updateTriggerRangeAndQuery();
      }
      return;
    }
    if ((e as InputEvent).isComposing) return; // never OPEN a trigger mid-composition
    if (pendingOpen) {
      pendingOpen = false;
      openTrigger();
    }
  });

  // Caret moved out of the '/'+filter span (arrow keys past its edge, a click
  // elsewhere) — close, non-destructive. A NON-collapsed selection is fine as long
  // as it stays WITHIN the span: the user may select part of the `/…` text to edit
  // it. Close only when an endpoint leaves the run (comparePoint returns 0 for any
  // point between start and end inclusive, so check BOTH ends, not just isCollapsed).
  document.addEventListener('selectionchange', () => {
    if (!popup.isOpen() || !triggerRange) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      popup.close();
      return;
    }
    const r = sel.getRangeAt(0);
    try {
      const startIn = triggerRange.comparePoint(r.startContainer, r.startOffset) === 0;
      const endIn = triggerRange.comparePoint(r.endContainer, r.endOffset) === 0;
      if (!startIn || !endIn) {
        popup.close();
      }
    } catch {
      popup.close();
    }
  });

  return {
    setDocUri(uri: string): void {
      docUri = uri;
    },
    setConfig(cfg: TriggerConfig | undefined): void {
      if (!cfg) return;
      dateFormat = cfg.dateFormat || dateFormat;
      executeCommands = cfg.executeCommands ?? [];
      triggerMode = cfg.mode ?? triggerMode;
    },
    setTriggerMode(m: TriggerMode): void {
      triggerMode = m;
    },
    notifyNamespaceListResult(requestId, ready, namespaces): void {
      if (!pendingNamespaceReq || pendingNamespaceReq.requestId !== requestId) return; // stale/superseded.
      const resolve = pendingNamespaceReq.resolve;
      pendingNamespaceReq = undefined;
      if (ready) {
        namespaceCache = namespaces; // only a READY reply is cached — see fetchNamespaces.
      }
      resolve(namespaces);
    },
    notifyEntityResult(requestId, ready, entities): void {
      if (!pendingEntityReq || pendingEntityReq.requestId !== requestId) return; // stale/superseded.
      const resolve = pendingEntityReq.resolve;
      pendingEntityReq = undefined;
      resolve(ready ? entities : []);
    },
  };
}
