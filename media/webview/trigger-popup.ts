/**
 * Shared, trigger-agnostic popup shell for the @ (US-20.1) and / (US-20.2/3)
 * quick-action triggers (Req 20). Both triggers consume this ONE shell; no
 * trigger's items are hardcoded here — every result comes from the pluggable
 * `dataSource` passed to open().
 *
 * Foundation wiring (Req 20 US-20.4 / US-20.2):
 *  - Escape routed through the shared capture-phase Escape stack (POPUP tier).
 *  - Editor keyboard ownership claimed via input-ownership while open, released
 *    on EVERY teardown path (funnelled through a single close()).
 *  - Staleness: a MODULE-LEVEL monotonic request counter shared across ALL
 *    controller instances, so a late async dataSource response from a previous
 *    popup can never render into a newer one; plus a position-validity re-check.
 *
 * Chrome is styled ONLY through the Reading Mode token contract (--rp-* /
 * --reading-ui-*), so the popup restyles per Reading Mode option. No hardcoded
 * hex, no direct --vscode-* targeting.
 */
import { registerEscapeHandler, ESCAPE_PRIORITY, type Disposable } from './escape-stack';
import { setInputOwner } from './input-ownership';

export type TriggerAxis = '@' | '/';

export interface TriggerPopupItem {
  id: string;
  label: string;
  detail?: string;
  badge?: string;
  /**
   * Req 21 US-21.1 — shown but inert: Enter/click do nothing (used for an
   * invalid/duplicate "confirm" row so the popup stays open with the row's
   * `errorText` visible instead of committing or closing).
   */
  disabled?: boolean;
  /** Req 21 US-21.1 — inline error line rendered under a `disabled` row. */
  errorText?: string;
  /**
   * Req 21 US-21.2 — generic content-type tint hook (trigger-agnostic: the
   * shell doesn't know what "entity" means, just adds a `trigger-popup-item-
   * tint-<value>` class). Currently only `'entity'` (trigger-at.ts's Entities
   * scope, styled via --rp-entity-ref-bg).
   */
  tint?: 'entity';
}

export interface TriggerPopupGroup {
  label: string;
  items: TriggerPopupItem[];
  /** Total available in this group; when > items.length a "+N more" row is shown. */
  total?: number;
  /** Req 20 US-20.7 — override the default "+N more — keep typing to narrow" text (e.g. "+N more — switch scope"). */
  moreLabel?: string;
  /** Req 20 US-20.7 — when set, the "+N more" row becomes clickable (e.g. a scope-switch affordance). */
  onMore?(): void;
}

export interface TriggerDataSource {
  query(q: string): TriggerPopupGroup[] | Promise<TriggerPopupGroup[]>;
}

/** Req 20 US-20.7 — one `@` scope tab (All/Files/Headings). Trigger-agnostic: `/` never passes `scopes`. */
export interface TriggerScope {
  id: string;
  label: string;
}

export interface TriggerOpenArgs {
  axis: TriggerAxis;
  anchorRange: Range;
  dataSource: TriggerDataSource;
  onPick(item: TriggerPopupItem): void;
  onClose?(): void;
  /**
   * Req 20 US-20.7 — when provided, renders one pill per scope (instead of the
   * default static "All" pill) and enables `Ctrl+Tab`/`Ctrl+Shift+Tab` cycling.
   * Clicking a pill (or cycling) re-runs the last query — `dataSource.query`
   * is expected to read whatever scope state `onScopeChange` just updated.
   */
  scopes?: TriggerScope[];
  activeScopeId?: string;
  onScopeChange?(id: string): void;
  /** Req 20 US-20.6 — fires when Tab is pressed while the ghost overlay is showing. */
  onGhostAccept?(): void;
  /**
   * Bug 10 — the shell OWNS the query text for this session: Backspace and
   * printable single-character keys edit an internal filter buffer (re-running
   * the query) and are blocked from the editor, instead of the consumer feeding
   * the query from the editor DOM. Used by the `@` selection mode, where the
   * editor selection must stay intact (no live editor text backs the query).
   * ASCII/keydown path only — IME-composed input is not fed into the buffer.
   */
  ownsTextInput?: boolean;
}

export interface TriggerPopupController {
  open(a: TriggerOpenArgs): void;
  updateQuery(q: string): void;
  isOpen(): boolean;
  close(): void;
  /**
   * Req 20 US-20.6 — ghost-text single-match fast path. Renders `text` as a
   * floating, non-editable overlay right after `afterRange`'s end; the
   * consumer's own Tab handling (via `onGhostAccept`, passed at open()) fires
   * when the shell sees Tab while the ghost is showing.
   */
  showGhost(text: string, afterRange: Range): void;
  hideGhost(): void;
}

/** content = the editable the popup serves (focus/context). Anchoring itself is Range-based via anchorRange. */
export interface TriggerPopupDeps {
  content: HTMLElement;
}

const CARD_WIDTH_PX = 340;
const ANCHOR_GAP_PX = 4;
const VIEWPORT_MARGIN_PX = 4;

/** Bug 11 — max visible chars for a result row's label/detail before ellipsis. */
const RESULT_TEXT_MAX_CHARS = 20;

/**
 * Bug 11 — cap a result row's displayed label/detail so a long file name /
 * entity title can't overrun the fixed-width row and squeeze the sibling field
 * (detail is `flex: none`, so an un-capped title would push the label to an
 * unreadable stub). Display-only: the item's id / pick value is never touched.
 */
export function truncateDisplay(text: string, max = RESULT_TEXT_MAX_CHARS): string {
  // Count/slice by code point (Array.from), so a surrogate pair (emoji / non-BMP
  // char) landing on the boundary is never split into a lone-surrogate '�'.
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('') + '…';
}

/**
 * Monotonic request id shared across ALL controller instances. Each open/
 * updateQuery that dispatches a dataSource.query bumps it; a resolving promise
 * renders only if its stamped id still equals this — so a late response from a
 * previous popup (even a different controller instance) is always discarded.
 */
let globalRequestSeq = 0;

export function initTriggerPopup(deps: TriggerPopupDeps): TriggerPopupController {
  // ---- Chrome DOM (built once, hidden, appended to body) --------------------
  const card = document.createElement('div');
  card.className = 'trigger-popup';
  card.hidden = true;
  // Clicking ANYWHERE in the card must not blur #content — otherwise the editor
  // loses its selection and the consumer's selectionchange handler closes the
  // popup on any click (rows/pills already preventDefault; this covers the card's
  // own padding, the query row, scope-row gaps, and the hint row too).
  card.addEventListener('mousedown', (e) => e.preventDefault());

  // Query row = the "type here" surface (Req 20 bug fix): the axis marker
  // (@ or /), the live query text, and a blinking caret so the user can see
  // that typing filters here (the editor's own caret is hidden while open, see
  // `trigger-popup-open` in editor.css — one caret only, in the popup).
  const queryRow = document.createElement('div');
  queryRow.className = 'trigger-popup-query';
  const queryAxis = document.createElement('span');
  queryAxis.className = 'trigger-popup-query-axis';
  const queryText = document.createElement('span');
  queryText.className = 'trigger-popup-query-text';
  const queryCaret = document.createElement('span');
  queryCaret.className = 'trigger-popup-query-caret';
  queryCaret.setAttribute('aria-hidden', 'true');
  queryRow.appendChild(queryAxis);
  queryRow.appendChild(queryText);
  queryRow.appendChild(queryCaret);
  card.appendChild(queryRow);

  const scopeRow = document.createElement('div');
  scopeRow.className = 'trigger-popup-scope';
  card.appendChild(scopeRow);

  const resultsEl = document.createElement('div');
  resultsEl.className = 'trigger-popup-results';
  card.appendChild(resultsEl);

  const hintRow = document.createElement('div');
  hintRow.className = 'trigger-popup-hint';
  hintRow.textContent = '↑↓ navigate · ↵ select · Esc cancel';
  card.appendChild(hintRow);

  document.body.appendChild(card);

  // Ghost-text + Tab keycap affordance (US-20.6 fast path). Built as part of the
  // shell chrome, hidden; its inline caret rendering is wired by the consumer.
  const ghost = document.createElement('span');
  ghost.className = 'trigger-popup-ghost';
  ghost.hidden = true;
  const ghostText = document.createElement('span');
  ghostText.className = 'trigger-popup-ghost-text';
  ghost.appendChild(ghostText);
  const ghostKeycap = document.createElement('span');
  ghostKeycap.className = 'trigger-popup-keycap';
  ghostKeycap.textContent = 'Tab ⇥';
  ghost.appendChild(ghostKeycap);
  document.body.appendChild(ghost);

  // ---- State ---------------------------------------------------------------
  let isOpenFlag = false;
  let openToken = 0; // bumped per open(); guards a resolve against a since-closed/reopened popup
  let currentAxis: TriggerAxis = '@';
  let anchorRange: Range | undefined;
  let dataSource: TriggerDataSource | undefined;
  let onPickCb: ((item: TriggerPopupItem) => void) | undefined;
  let onCloseCb: (() => void) | undefined;
  let onGhostAcceptCb: (() => void) | undefined;
  let escDisposable: Disposable | undefined;
  let keyDisposable: (() => void) | undefined;
  let lastQueryText = '';

  // Bug 10 — when true, this session's query text is owned here (Backspace/
  // printable keys edit `ownedQuery` and never reach the editor), not fed from
  // the editor DOM by the consumer. Reset per open().
  let ownsTextInput = false;
  let ownedQuery = '';

  // ---- Req 20 US-20.7: scope tabs (trigger-agnostic — only populated when the
  // consumer passes `scopes`; `/` never does, so its default single "All" pill
  // is unaffected) --------------------------------------------------------
  let currentScopes: TriggerScope[] = [];
  let currentActiveScopeId: string | undefined;
  let onScopeChangeCb: ((id: string) => void) | undefined;

  // ---- Keyboard nav (↑↓ navigate · ↵ select) shared by every consumer -------
  // Flat, render-order list of the currently rendered rows/items, rebuilt on
  // every renderGroups() call. highlightedIdx is -1 only when the list is empty.
  let flatItems: TriggerPopupItem[] = [];
  let flatRows: HTMLElement[] = [];
  let highlightedIdx = -1;

  function setHighlight(idx: number): void {
    if (highlightedIdx >= 0 && flatRows[highlightedIdx]) {
      flatRows[highlightedIdx].classList.remove('trigger-popup-item-active');
    }
    highlightedIdx = idx;
    const row = flatRows[highlightedIdx];
    if (row) {
      row.classList.add('trigger-popup-item-active');
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveHighlight(delta: 1 | -1): void {
    if (flatItems.length === 0) return;
    const next = (highlightedIdx + delta + flatItems.length) % flatItems.length;
    setHighlight(next);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!isOpenFlag) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      moveHighlight(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      moveHighlight(-1);
    } else if (e.key === 'Enter') {
      // Bugs 5–8: while the popup is open the session owns Enter unconditionally.
      // Consume it here regardless of whether a row is currently committable —
      // an empty / async-pending / disabled list used to fall through, letting
      // Enter reach #content as a literal paragraph break AND leaving the typed
      // filter run behind (no commit ran to delete it). preventDefault first,
      // then commit only when a real enabled row exists.
      e.preventDefault();
      e.stopPropagation();
      const item = flatItems[highlightedIdx];
      if (item && !item.disabled) {
        onPickCb?.(item);
        close();
      }
      // else (empty / pending / disabled — Req 21 US-21.1 duplicate confirm row):
      // keep the popup open, no commit, its inline error (if any) still visible.
    } else if (e.key === 'Tab' && (e.ctrlKey || e.metaKey) && currentScopes.length > 0) {
      // Req 20 US-20.7: Ctrl+Tab / Ctrl+Shift+Tab cycles scope tabs. Plain Tab
      // is reserved for the ghost-accept fast path (US-20.6) below.
      e.preventDefault();
      e.stopPropagation();
      cycleScope(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Tab' && !ghost.hidden) {
      // Req 20 US-20.6: ghost-accept beats list-indent/cell-nav — this fires
      // ahead of main.ts's content keydown handler (which already bails via
      // hasInputOwner() while the popup session is open), so no separate
      // priority wiring is needed there.
      e.preventDefault();
      e.stopPropagation();
      onGhostAcceptCb?.();
    } else if (
      ownsTextInput &&
      (e.key === 'Backspace' || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing))
    ) {
      // Bug 10: the shell owns the filter — Backspace trims the buffer, a
      // printable key appends; either way re-query and keep the key off the
      // editor so a selection-mode `@` never lets typing/Backspace mutate the
      // still-selected link. Single-char `e.key` is the ASCII/keydown path;
      // IME-composed input arrives as composition/`beforeinput`, which
      // trigger-at blocks separately in selection mode.
      e.preventDefault();
      e.stopPropagation();
      ownedQuery = e.key === 'Backspace' ? ownedQuery.slice(0, -1) : ownedQuery + e.key;
      runQuery(ownedQuery);
    }
  }

  // ---- Anchoring (COPIED from cross-file-search.ts per plan — deliberately
  // not imported so a future anchoring change is a conscious edit in both) ----
  function getAnchorRect(range: Range): DOMRect {
    const rects = range.getClientRects();
    if (rects.length > 0) {
      return rects[rects.length - 1];
    }
    const rect = range.getBoundingClientRect();
    // A collapsed Range on an empty block (e.g. declaring `/` on a fresh empty
    // line) yields a zero rect in Chromium — anchor to the caret's block element
    // instead of (0,0), so the popup lands on the line, not the top-left corner.
    if (rect.top === 0 && rect.left === 0 && rect.width === 0 && rect.height === 0) {
      const node = range.startContainer;
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      if (el) return el.getBoundingClientRect();
    }
    return rect;
  }

  // Bug 4: the vertical position established on the FIRST reposition of a popup
  // session, kept stable across later repositions so the card doesn't jump when
  // a scope switch (All/Files/Headings…) resizes it under a caret that never
  // moved. Reset per open()/close().
  let frozenTop: number | undefined;

  let repositionScheduled = false;
  function scheduleReposition(): void {
    if (repositionScheduled || !isOpenFlag || !anchorRange) return;
    repositionScheduled = true;
    // rAF-coalesce the layout-forcing getClientRects/getBoundingClientRect reads
    // (layout-read trap) — anchoring must never read layout uncoalesced.
    requestAnimationFrame(() => {
      repositionScheduled = false;
      if (!isOpenFlag || !anchorRange) return;
      const rect = getAnchorRect(anchorRange);
      // Below-left of the caret: left clamped so the 340px card stays in the
      // viewport.
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN_PX, rect.left),
        window.innerWidth - CARD_WIDTH_PX - VIEWPORT_MARGIN_PX
      );
      // Vertical placement: prefer below the caret, but flip above when the card
      // would overflow the viewport bottom AND there is more room above than
      // below (else it would just clip off-screen and its rows be unreachable).
      // Height is read here (same rAF as the rect read) so it's coalesced too.
      const cardHeight = card.offsetHeight;
      const roomBelow = window.innerHeight - rect.bottom;
      const roomAbove = rect.top;
      const fitsBelow = roomBelow >= cardHeight + ANCHOR_GAP_PX + VIEWPORT_MARGIN_PX;
      let top: number;
      if (!fitsBelow && roomAbove > roomBelow) {
        top = Math.max(VIEWPORT_MARGIN_PX, rect.top - ANCHOR_GAP_PX - cardHeight);
      } else {
        // Below the caret, but never past the viewport bottom: clamp up so the
        // card's bottom edge stays on-screen (its internal results area scrolls
        // if the card is taller than the remaining room).
        top = Math.max(
          VIEWPORT_MARGIN_PX,
          Math.min(rect.bottom + ANCHOR_GAP_PX, window.innerHeight - cardHeight - VIEWPORT_MARGIN_PX)
        );
      }
      // Bug 4: reuse the first-render top so a scope-switch resize doesn't move
      // the card — but re-clamp (and re-freeze) when the frozen top would push
      // the card's new height off the viewport edge, so it never clips.
      if (frozenTop === undefined) {
        frozenTop = top;
      } else if (frozenTop + cardHeight <= window.innerHeight - VIEWPORT_MARGIN_PX) {
        top = frozenTop;
      } else {
        frozenTop = top;
      }
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
    });
  }

  // ---- Rendering -----------------------------------------------------------
  function selectScope(id: string): void {
    if (currentActiveScopeId === id) return;
    currentActiveScopeId = id;
    // Let the consumer update whatever scope state its dataSource closure
    // reads BEFORE re-running the query.
    onScopeChangeCb?.(id);
    renderScopeTabs();
    runQuery(lastQueryText);
  }

  function cycleScope(delta: 1 | -1): void {
    if (currentScopes.length === 0) return;
    const idx = currentScopes.findIndex((s) => s.id === currentActiveScopeId);
    const next = currentScopes[(idx + delta + currentScopes.length) % currentScopes.length];
    selectScope(next.id);
  }

  function renderScopeTabs(): void {
    scopeRow.textContent = '';
    if (currentScopes.length === 0) {
      // Trigger-agnostic default scope pill (e.g. `/`, which never passes `scopes`).
      const pill = document.createElement('span');
      pill.className = 'trigger-popup-pill trigger-popup-pill-active';
      pill.textContent = 'All';
      scopeRow.appendChild(pill);
      return;
    }
    for (const scope of currentScopes) {
      const pill = document.createElement('span');
      pill.className =
        'trigger-popup-pill' + (scope.id === currentActiveScopeId ? ' trigger-popup-pill-active' : '');
      pill.textContent = scope.label;
      pill.addEventListener('mousedown', (e) => e.preventDefault());
      pill.addEventListener('click', () => selectScope(scope.id));
      scopeRow.appendChild(pill);
    }
  }

  function renderGroups(groups: TriggerPopupGroup[]): void {
    resultsEl.textContent = '';
    flatItems = [];
    flatRows = [];
    highlightedIdx = -1;
    for (const group of groups) {
      // Shared collapse rule: a zero-item group is omitted entirely (no empty header).
      if (group.items.length === 0) continue;

      const header = document.createElement('div');
      header.className = 'trigger-popup-group-label';
      header.textContent = group.label;
      resultsEl.appendChild(header);

      for (const item of group.items) {
        const row = document.createElement('div');
        row.className = 'trigger-popup-item' + (item.disabled ? ' trigger-popup-item-disabled' : '');
        row.setAttribute('role', 'option');
        if (item.disabled) {
          row.setAttribute('aria-disabled', 'true');
        }
        if (item.tint) {
          row.classList.add(`trigger-popup-item-tint-${item.tint}`);
        }

        const label = document.createElement('span');
        label.className = 'trigger-popup-item-label';
        label.textContent = truncateDisplay(item.label);
        row.appendChild(label);

        if (item.detail) {
          const detail = document.createElement('span');
          detail.className = 'trigger-popup-item-detail';
          detail.textContent = truncateDisplay(item.detail);
          row.appendChild(detail);
        }
        if (item.badge) {
          const badge = document.createElement('span');
          badge.className = 'trigger-popup-item-badge';
          badge.textContent = item.badge;
          row.appendChild(badge);
        }

        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', () => {
          if (item.disabled) {
            return; // Req 21 US-21.1: an inert row — see the Enter branch's same rule.
          }
          onPickCb?.(item);
          close();
        });
        resultsEl.appendChild(row);
        flatItems.push(item);
        flatRows.push(row);

        if (item.errorText) {
          // A sibling line (not appended INSIDE row) so the row's own flex
          // layout (label/detail/badge) is unaffected.
          const err = document.createElement('div');
          err.className = 'trigger-popup-item-error';
          err.textContent = item.errorText;
          resultsEl.appendChild(err);
        }
      }

      // "+N more — keep typing to narrow": non-interactive overflow footnote when
      // the group has more available than shown (visual pattern from
      // cross-file-search renderOverflowRow, not its code).
      if (group.total !== undefined && group.total > group.items.length) {
        const more = document.createElement('div');
        more.className = 'trigger-popup-more' + (group.onMore ? ' trigger-popup-more-active' : '');
        more.textContent = group.moreLabel ?? `+${group.total - group.items.length} more — keep typing to narrow`;
        if (group.onMore) {
          const onMore = group.onMore;
          more.addEventListener('mousedown', (e) => e.preventDefault());
          more.addEventListener('click', () => onMore());
        }
        resultsEl.appendChild(more);
      }
    }

    // Req 20 US-20.2: explicit non-interactive "No matches" row when every
    // offered group resolved empty — the popup stays open rather than vanishing.
    if (flatItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'trigger-popup-empty';
      empty.textContent = 'No matches';
      resultsEl.appendChild(empty);
    } else {
      // Highlight the first ENABLED item — a leading disabled row (the namespace
      // step's inert "+ Create new namespace" when the typed name already
      // exists, or a duplicate-id confirm row) must not eat Enter and leave the
      // user unable to pick the real match below it.
      const firstEnabled = flatItems.findIndex((it) => !it.disabled);
      setHighlight(firstEnabled >= 0 ? firstEnabled : 0);
    }
  }

  // ---- Query dispatch + staleness guard ------------------------------------
  function isResponseValid(rid: number, forToken: number): boolean {
    return (
      rid === globalRequestSeq &&
      isOpenFlag &&
      forToken === openToken &&
      // Position-validity re-check: the anchor must still live inside content
      // (caret hasn't left the trigger context / DOM wasn't torn down).
      !!anchorRange &&
      deps.content.contains(anchorRange.commonAncestorContainer)
    );
  }

  function runQuery(q: string): void {
    if (!dataSource) return;
    lastQueryText = q;
    queryText.textContent = q;
    const rid = ++globalRequestSeq;
    const forToken = openToken;
    const result = dataSource.query(q);
    if (result instanceof Promise) {
      result.then((groups) => {
        if (!isResponseValid(rid, forToken)) return;
        renderGroups(groups);
        scheduleReposition();
      });
    } else {
      if (!isResponseValid(rid, forToken)) return;
      renderGroups(result);
      scheduleReposition();
    }
  }

  // ---- Public API ----------------------------------------------------------
  function open(a: TriggerOpenArgs): void {
    // Re-entrant open: tear the previous down cleanly first (releases input owner
    // + Escape registration) so no state leaks.
    if (isOpenFlag) close();

    currentAxis = a.axis;
    anchorRange = a.anchorRange;
    dataSource = a.dataSource;
    onPickCb = a.onPick;
    onCloseCb = a.onClose;
    onGhostAcceptCb = a.onGhostAccept;
    currentScopes = a.scopes ?? [];
    currentActiveScopeId = a.activeScopeId ?? currentScopes[0]?.id;
    onScopeChangeCb = a.onScopeChange;
    ownsTextInput = a.ownsTextInput ?? false;
    ownedQuery = '';
    openToken++;
    isOpenFlag = true;
    frozenTop = undefined; // fresh session — recompute the anchored top on first reposition.

    card.dataset.axis = currentAxis;
    queryAxis.textContent = currentAxis;
    renderScopeTabs();
    card.hidden = false;
    // Suppress the editor's own caret while the popup owns typing, so the only
    // visible caret is the popup query row's (editor.css `body.trigger-popup-open`).
    document.body.classList.add('trigger-popup-open');

    setInputOwner('trigger');
    escDisposable = registerEscapeHandler(ESCAPE_PRIORITY.POPUP, () => {
      if (!isOpenFlag) return false;
      close();
      return true;
    });
    // ↑↓ navigate / ↵ select — capture phase, ahead of the editor's own (input-
    // ownership-gated) keydown handlers, so Enter never falls through to insert
    // a paragraph break in #content while the popup is open.
    document.addEventListener('keydown', onKeyDown, true);
    keyDisposable = () => document.removeEventListener('keydown', onKeyDown, true);

    // A freshly (re)opened popup must NOT carry the previous session's rendered
    // items. When the first query is async (a host round-trip), renderGroups
    // won't run until it resolves, so without this reset flatItems still holds
    // the prior render — and Enter in that window would commit a STALE item
    // against the NEW onPick. That is bug 6/7: reopening the shell for the
    // declare namespace step left the slash menu's "Declare entity" row
    // committable, so Enter fed `action:declare-entity` into the namespace
    // pick (→ a corrupt `are-entity` namespace) instead of being inert.
    resultsEl.textContent = '';
    flatItems = [];
    flatRows = [];
    highlightedIdx = -1;

    runQuery('');
    scheduleReposition();
  }

  function updateQuery(q: string): void {
    if (!isOpenFlag) return;
    // Bug 10: seed the owned buffer so subsequent Backspace/printable edits
    // build on the initial query (e.g. the selection-mode link-text seed).
    if (ownsTextInput) ownedQuery = q;
    runQuery(q);
  }

  function isOpen(): boolean {
    return isOpenFlag;
  }

  // Single teardown funnel — every path (Escape, pick, re-open, error) goes
  // through here so the input-ownership flag and Escape registration can never
  // leak (which would permanently disable editor input).
  function close(): void {
    if (!isOpenFlag) return;
    isOpenFlag = false;
    card.hidden = true;
    ghost.hidden = true;
    frozenTop = undefined;
    // Restore the editor's own caret (mirrors the open() suppression above) —
    // this is the single teardown funnel, so it can never leak the hidden state.
    document.body.classList.remove('trigger-popup-open');
    escDisposable?.dispose();
    escDisposable = undefined;
    keyDisposable?.();
    keyDisposable = undefined;
    setInputOwner(null);
    anchorRange = undefined;
    dataSource = undefined;
    onPickCb = undefined;
    onGhostAcceptCb = undefined;
    currentScopes = [];
    currentActiveScopeId = undefined;
    onScopeChangeCb = undefined;
    const cb = onCloseCb;
    onCloseCb = undefined;
    cb?.();
  }

  // ---- Ghost-text fast path (US-20.6) ---------------------------------------
  function showGhost(text: string, afterRange: Range): void {
    ghostText.textContent = text;
    // rAF-coalesce the layout-forcing getClientRects/getBoundingClientRect read
    // (layout-read trap), same discipline as scheduleReposition().
    requestAnimationFrame(() => {
      if (!isOpenFlag) return;
      const rect = getAnchorRect(afterRange);
      ghost.style.left = `${rect.right}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.hidden = false;
    });
  }

  function hideGhost(): void {
    ghost.hidden = true;
  }

  return { open, updateQuery, isOpen, close, showGhost, hideGhost };
}
