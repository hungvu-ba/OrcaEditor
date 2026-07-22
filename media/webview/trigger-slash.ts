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
import { closestElement, textBeforeCaret } from './dom-utils';
import { normalizeForSearch } from '../../src/text-utils';
import { postProcessCaptions } from './dom-postprocess';
import {
  runTriggerDefineInsert,
  runTriggerDeleteOnly,
  runTriggerInsertDate,
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

/**
 * Bug #10 (bug_General.md) — heading-4/5/6 stay in BLOCK_ITEMS (the type and
 * `runTriggerBlockAction` still handle every level, e.g. from the toolbar), but
 * the `/` command menu only offers Heading 1–3; deeper levels are hidden from
 * the list, not removed from the data.
 */
const MENU_HIDDEN_BLOCK_IDS = new Set<TriggerDefineBlockId>(['heading-4', 'heading-5', 'heading-6']);

/** ID prefixes disambiguate what a picked TriggerPopupItem.id means to handlePick(). */
const BLOCK_PREFIX = 'block:';
const INLINE_DATE_ID = 'inline:insert-date';
const EXEC_PREFIX = 'exec:';
/** Req 20 US-20.5 — whole-document `/add reference` action (position-independent, not mode-gated). */
const ADD_REFERENCE_ID = 'action:add-reference';
/** Req 21 US-21.1 — entry point into the 3-step Declare Entity flow (advanced-only, see INLINE_ITEMS). */
const DECLARE_ENTITY_ID = 'action:declare-entity';

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

  /**
   * Req 21 US-21.1 — capture the stored insertion caret the trigger delete
   * leaves behind (`collapseSelectionAfterTriggerDelete` in toolbar.ts collapses
   * the selection to that point), to hand to the next step's popup as its commit
   * anchor. The popup's focused query input owns filtering while the step is
   * open, so NO keystrokes reach the editor between here and the commit — the
   * old live-typing lag-proofing (empty-text-node insertion, `<p>[anchor]<br>`
   * rebuild, selection re-anchor) is gone: the point is only read again by the
   * commit's `deleteRange`. Prefer the live collapsed selection, falling back to
   * the passed `range` when none is available.
   */
  function ensureTextAnchor(range: Range): Range {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
      return sel.getRangeAt(0).cloneRange();
    }
    return range.cloneRange();
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
      // Bug B1 — reopened from inside the namespace-step Enter handler; same
      // IME double-Enter guard so it can't auto-commit the id/caption step.
      guardEnterUntilKeyup: true,
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
      },
    });
  }

  /** Req 21 US-21.1 step 1 — namespace-picker popup, opened right after `/declare entity`'s typed text is stripped. */
  function openDeclareNamespaceStep(insertionPoint: Range): void {
    triggerRange = insertionPoint.cloneRange();
    let lastQuery = '';
    popup.open({
      axis: '/',
      anchorRange: triggerRange.cloneRange(),
      // Bug B1 — reopened from inside the slash-menu Enter handler; guard against
      // an IME double-Enter committing this namespace step from the same keypress.
      guardEnterUntilKeyup: true,
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
      },
    });
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

  /**
   * Bug #10 (bug_General.md) — the `/` sits at the START of a top-level
   * paragraph OR heading that may ALREADY hold text: nothing is left of the
   * `/`+filter run. On a formatted line (e.g. a heading) the `#` markers are
   * hidden, so line-start `/` reads as "beginning of the line" to the user — the
   * full Blocks menu must show, exactly as on a fresh empty line, so they can
   * re-format that line. Judged on the `before` half only (unlike
   * isTriggerParagraphEmpty, which also requires the `after` half empty), so it
   * is a superset: an empty line is line-start too. Block set matches the
   * trigger open-gate (US-20.1: P/H1–H3; H4–H6 excluded there).
   */
  function isTriggerAtLineStart(): boolean {
    if (!triggerBlock || !triggerRange) return false;
    const nn = triggerBlock.nodeName;
    const isTopLevelParagraphOrHeading =
      triggerBlock.parentElement === content && (nn === 'P' || nn === 'H1' || nn === 'H2' || nn === 'H3');
    if (!isTopLevelParagraphOrHeading) return false;
    const before = document.createRange();
    before.selectNodeContents(triggerBlock);
    before.setEnd(triggerRange.startContainer, triggerRange.startOffset);
    return before.toString().trim() === '';
  }

  function buildGroups(q: string): TriggerPopupGroup[] {
    // Bug #10: block items show whenever `/` is at line-start (nothing before it)
    // of a top-level P/H1–H3 — the SAME full list as a fresh empty line, whether
    // or not the line already holds text. Heading 4–6 are hidden from the menu
    // (MENU_HIDDEN_BLOCK_IDS) though they remain in BLOCK_ITEMS.
    const blockSource = isTriggerAtLineStart()
      ? BLOCK_ITEMS.filter((b) => !MENU_HIDDEN_BLOCK_IDS.has(b.id))
      : [];
    const blockItems: TriggerPopupItem[] = gateByMode(blockSource)
      .filter((b) => matchesFilter(b.label, q))
      .map((b) => ({
        id: `${BLOCK_PREFIX}${b.id}`,
        label: b.label,
        detail: b.detail,
      }));
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
      // Bug 4/5 — typed `/` marker session: Escape / empty-query Space revert the
      // `/` to literal and restore the caret after it. Re-opened declare
      // sub-steps (openDeclareIdStep etc.) do NOT set this — they have no marker.
      restoreCaretOnCancel: true,
      dataSource: { query: buildGroups },
      onPick: handlePick,
      onClose: () => {
        triggerBlock = undefined;
        triggerRange = undefined;
      },
    });
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
    // While the popup is open ALL filter typing (ordinary `/`+filter and every
    // declare step alike) lands in the popup's focused query input
    // (T0.1), which drives runQuery natively — the editor is never read for
    // filtering, so there is nothing to do on an editor `input` here.
    if (popup.isOpen()) return;
    if ((e as InputEvent).isComposing) return; // never OPEN a trigger mid-composition
    if (pendingOpen) {
      pendingOpen = false;
      openTrigger();
    }
  });

  // Click-away dismiss. The old selectionchange+comparePoint auto-close tracked the
  // editor caret leaving the `/`+filter run — but with the focused-input model the
  // caret no longer lives in #content while the popup is open (it sits in the popup's
  // own <input>), so there is no editor-caret "left the run" event to watch, and that
  // old handler fired the instant open() moved focus into the input, closing the popup
  // immediately. The remaining close paths are: commit (onPick), Escape (shell escape-
  // stack), and this — a pointer press anywhere OUTSIDE the popup card. Bound on
  // mousedown (not the input's blur) on purpose: the programmatic content.focus() T0.2
  // runs at commit-start would fire a blur on the popup input and re-enter close(), so
  // a blur listener would reintroduce the commit-timing trap (mirrors trigger-at.ts).
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!popup.isOpen()) return;
      if ((e.target as Element | null)?.closest('.trigger-popup')) return; // inside the card — not a dismiss.
      popup.close();
    },
    true // capture phase, so it runs before the target's own handlers.
  );

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
