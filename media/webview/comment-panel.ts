/**
 * Req 23 US-23.9: the Comment tab — every thread in the file, grouped by status,
 * hosted in US-23.7's shared right dock beside the TOC. It exists for the one
 * thing the gutter cannot do: a Closed thread keeps no pin and no highlight
 * (US-23.2), so this list is the only route back to it.
 *
 * It also absorbs US-23.4's standalone "Unresolved location" `<aside>`: a
 * floating thread is one GROUP here rather than a separate panel that used to
 * fight the TOC for the same dock slot. Every re-attach affordance that panel
 * shipped survives unchanged on a floating row — drag the handle onto a node,
 * the ⋯ picker, or the Space/↑↓/Enter keyboard walk. All three still call the
 * same `reattach(threadId, el)` on comment-resolve.ts, so the pointer route and
 * the keyboard/screen-reader route cannot drift apart, and the picker's
 * suggestions are RANKED, never applied — automatic matching is precisely what
 * already failed for these threads.
 *
 * The list is uncapped and scrolls, groups are never filtered away (only
 * "Hide closed" is offered, opt-in), and empty groups are omitted entirely.
 *
 * Rows are navigation only: activating one scrolls to the anchor and hands the
 * thread to US-23.2's popover, which owns every mutation. Nothing here writes to
 * the `.md` — re-attaching moves a session-only DOM attribute and the native
 * thread's Range (US-23.6), and never touches the Open/Resolved/Closed axis
 * (US-23.3), because floating is orthogonal to it.
 */
import { anchorCandidates, commentAnchorLineRange, type AnchorCandidateNode } from './block-map';
import { normalizeAnchorText, rankReattachTargets, type ReattachTarget } from './comment-anchor';
import type { CommentResolveController, ThreadAnchor } from './comment-resolve';
import {
  ANCHOR_REEVAL_DEBOUNCE_MS,
  COMMENT_COPY_MARKDOWN_TIMEOUT_MS,
  COMMENT_PANEL_DRAG_THRESHOLD_PX,
  COMMENT_PANEL_REATTACH_SUGGESTIONS,
  COMMENT_PANEL_SNIPPET_CHARS,
} from './constants';
import {
  copyDisabledReason,
  renderCommentsMarkdown,
  type ExportComment,
  type ExportLocation,
  type ExportSnapshot,
  type ExportThread,
} from './comment-copy-markdown';
import { el, positionNear, showToast } from './dom-utils';
import type { RightDockTab } from './right-dock';
import { truncateDisplay } from './trigger-popup';
import { initPopoverDismiss, registerEscapeHandler, ESCAPE_PRIORITY, type Disposable } from './escape-stack';
import type { CommentSidecarState } from '../../src/shared/messages';
import type { VsCodeApi } from './vscode-api';

export interface CommentPanelController {
  /** The dock tab descriptor — registered by main.ts on the shared container. */
  tab: RightDockTab;
  /** Every non-tombstoned thread — the tab-strip count badge (absent at 0). */
  threadCount(): number;
  /** How many threads are floating right now — the toolbar `⚑` button's badge. */
  floatingCount(): number;
  /**
   * A `commentThreadsSync` snapshot arrived, carrying the host's report on the
   * sidecar itself (still loading, foreign, unreadable, refused, or holding
   * orphaned lines) — none of which the thread list can express.
   */
  setSidecarState(state: CommentSidecarState | undefined): void;
  /** Back to the loading state — a new document, whose snapshot has not arrived. */
  beginLoad(): void;
  /** Rebuild now (coalesced). Safe to call while the tab is hidden. */
  refresh(): void;
  /** Req 24 US-23.12: the doc uri/relative path the export header and its `docUri` guard need. */
  setDocument(uri: string, relativePath: string): void;
  /**
   * Req 24 US-23.12 AC1: the `orcaEditor.copyCommentsAsMarkdown` command asked
   * THIS panel to build its export using its own live sort/"Hide closed" state.
   */
  handleExportRequest(requestId: number): void;
  /** Req 24 US-23.12 AC2: reply to this panel's own menu-triggered `copyCommentsAsMarkdown`. */
  notifyCopyResult(requestId: number, ok: boolean, error?: string): void;
}

/** The drop target currently under the pointer/selection, plus the overlay marking it. */
interface AimState {
  node: HTMLElement;
  chip: HTMLElement;
  outline: HTMLElement;
}

/** The status groups, in the handoff's fixed order — live work first, archive last. */
type GroupKey = 'open' | 'floating' | 'resolved' | 'closed';

const GROUP_ORDER: GroupKey[] = ['open', 'floating', 'resolved', 'closed'];

const GROUP_LABEL: Record<GroupKey, string> = {
  open: 'Open',
  floating: 'Unresolved location',
  resolved: 'Resolved',
  closed: 'Closed',
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The handoff's row stamp: "2h ago", "Yesterday", "Jul 21". Relative near the
 * present because that is what a reviewer scans for, absolute past a day because
 * "17d ago" is arithmetic the reader has to undo. Falls back to '' on an
 * unparseable stamp rather than printing "Invalid Date".
 */
function formatRelative(iso: string): string {
  if (iso === '') {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  // Clock skew between two machines sharing one sidecar can put a stamp in the
  // future; clamping keeps that "Just now" rather than a negative-hour reading.
  const elapsed = Math.max(0, Date.now() - date.getTime());
  if (elapsed < MINUTE_MS) {
    return 'Just now';
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  }
  if (elapsed < 2 * DAY_MS) {
    return 'Yesterday';
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Which group a thread belongs to. Floating wins: it is orthogonal to status,
 *  but it is the fact that decides whether the row can be navigated to at all. */
function groupOf(thread: ThreadAnchor): GroupKey {
  if (thread.state === 'floating') {
    return 'floating';
  }
  return thread.status === 'Resolved' ? 'resolved' : thread.status === 'Closed' ? 'closed' : 'open';
}

/** AC5: the row's stamp is the LAST TRANSITION, falling back to creation for a
 *  thread that has never left Open (the schema's derived-status rule). */
function lastTransitionAt(thread: ThreadAnchor): string {
  // US-23.11 AC2 kept the full trail on the thread; the row shows only its LAST
  // entry (design handoff) — the popover is where the whole history is listed.
  //
  // `??` is not enough: the sidecar validator accepts `timestamp: ''` and the
  // host forwards it verbatim, and an empty string would print a blank stamp and
  // sort to one end of its group instead of falling back to creation.
  const transition = thread.statusChanges[thread.statusChanges.length - 1]?.timestamp;
  return transition === undefined || transition === '' ? thread.createdAt : transition;
}

/** Milliseconds for ordering. An unparseable stamp sorts oldest, deterministically,
 *  rather than dragging the whole group into lexicographic order. */
function transitionTime(thread: ThreadAnchor): number {
  const parsed = Date.parse(lastTransitionAt(thread));
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

/** One-line form of a block of text — shared truncation, so the ellipsis rule lives in one place. */
function snippet(text: string): string {
  return truncateDisplay(text.replace(/\s+/g, ' ').trim(), COMMENT_PANEL_SNIPPET_CHARS);
}

/** The kind of node a picker row points at, as the design handoff labels its rows. */
function nodeTypeLabel(el: HTMLElement): string {
  switch (el.tagName) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return 'Heading';
    case 'LI':
      return 'List item';
    case 'TD':
    case 'TH':
      return 'Table cell';
    case 'TR':
      return 'Table row';
    case 'PRE':
      return 'Code';
    case 'BLOCKQUOTE':
      return 'Quote';
    default:
      return 'Paragraph';
  }
}

export function initCommentPanel(
  content: HTMLElement,
  resolve: CommentResolveController,
  /**
   * Hand a thread to US-23.2's popover, positioned against `rect` (the row's own
   * box for a floating thread, which has nothing to scroll to) and returning
   * focus to `returnFocusTo` when it closes. Injected rather than imported so the
   * list never reaches into the popover's internals.
   */
  openThread: (threadId: string, rect: DOMRect, returnFocusTo?: HTMLElement) => void,
  /** Req 24 US-23.12: posts `copyCommentsAsMarkdown`/its reply — this tab owns the export's own trigger. */
  vscode: VsCodeApi
): CommentPanelController {
  // The tab BODY, not a panel: the dock owns the panel, the strip and visibility.
  // It carries an author `display: flex`, so editor.css owes it a paired
  // `#comment-tabpanel[hidden]` rule at matching ID specificity — without one the
  // dock's `hidden` toggle loses and both tab bodies paint at once (US-23.7).
  const panel = el('div', 'comment-tab');
  panel.id = 'comment-tabpanel';
  const banner = el('div', 'comment-tab-banner');
  banner.hidden = true;
  const list = el('div', 'comment-panel-list');
  panel.appendChild(banner);
  panel.appendChild(list);

  // --- Aiming (shared by the drag route and the keyboard route) --------------

  let aim: AimState | undefined;

  function clearAim(): void {
    if (!aim) {
      return;
    }
    aim.chip.remove();
    aim.outline.remove();
    aim = undefined;
  }

  /**
   * Outline `node` and pin the "Re-attach here" chip to it. One visual language
   * for both routes (design handoff: "the drag path and the keyboard path share
   * one visual language"), so a screen-reader user sees exactly what a dragging
   * user sees.
   */
  function aimAt(node: HTMLElement): void {
    if (aim?.node === node) {
      // Same target, but it may have moved (the document scrolled under the
      // pointer, or the block reflowed) — re-measure rather than leave the
      // marker behind.
      positionAim(aim, node.getBoundingClientRect());
      return;
    }
    clearAim();
    const chip = el('div', 'comment-drop-chip', 'Re-attach here');
    // An overlay, never a class on the document node: a class written into
    // `#content` survives into the raw-HTML serialization path (turndown's
    // TRANSIENT_ATTRS strips attributes, not classes), so a marker left behind
    // by an abandoned drag could reach the user's `.md`.
    const outline = el('div', 'comment-drop-outline');
    outline.setAttribute('aria-hidden', 'true');
    document.body.appendChild(outline);
    document.body.appendChild(chip);
    aim = { node, chip, outline };
    positionAim(aim, node.getBoundingClientRect());
  }

  function positionAim(state: AimState, rect: DOMRect): void {
    state.outline.style.top = `${rect.top}px`;
    state.outline.style.left = `${rect.left}px`;
    state.outline.style.width = `${rect.width}px`;
    state.outline.style.height = `${rect.height}px`;
    positionNear(state.chip, rect);
  }

  /** Bring `node` into view before aiming at it, so the chip is never off-screen. */
  function revealAndAim(node: HTMLElement): boolean {
    if (!node.isConnected) {
      // The document was re-rendered under a pickup that captured this node.
      clearAim();
      return false;
    }
    const rect = node.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      node.scrollIntoView({ block: 'center' });
    }
    aimAt(node);
    return true;
  }

  /**
   * Where a floating thread may be re-attached: AC4 names "any other anchorable
   * node (heading/paragraph/list item)". `#content` itself is an anchor US-23.1
   * can mint but not a place a lost comment should be parked — re-attaching to
   * the whole document says nothing about where the comment belongs.
   */
  function attachTargets(): AnchorCandidateNode[] {
    return anchorCandidates(content).filter((candidate) => candidate.el !== content);
  }

  function candidateAt(clientX: number, clientY: number): HTMLElement | undefined {
    const target = document.elementFromPoint(clientX, clientY);
    if (!(target instanceof HTMLElement) || !content.contains(target)) {
      return undefined;
    }
    const candidates = dragTargets.length > 0 ? dragTargets : attachTargets();
    // Innermost match wins for the same reason tier 3 prefers depth: a list item
    // is a more specific answer than the list around it.
    let best: AnchorCandidateNode | undefined;
    for (const candidate of candidates) {
      if (candidate.el.contains(target) && (!best || candidate.depth > best.depth)) {
        best = candidate;
      }
    }
    return best?.el;
  }

  /**
   * The single commit point all three routes share (AC4: drag and the non-drag
   * equivalent must produce the identical result). A node captured before a
   * re-render is no longer in the document — `reattach` refuses it, and that
   * refusal has to be visible rather than looking like a dropped action.
   */
  function attach(threadId: string, node: HTMLElement): void {
    clearAim();
    if (!node.isConnected || !resolve.reattach(threadId, node)) {
      showToast('That location changed — pick another node.');
      refresh();
      return;
    }
    // No refresh() here: reattach notifies, and the change listener rebuilds.
  }

  // --- Card drag -------------------------------------------------------------

  let dragThreadId: string | undefined;
  let dragStart: { x: number; y: number } | undefined;
  let dragging = false;
  let escapeDisposable: Disposable | undefined;
  /**
   * The drop targets for THIS drag, resolved once at pickup. Rebuilding the list
   * per `mousemove` would walk the whole document on every pointer event — the
   * hot-handler trap CLAUDE.md names — and the document cannot change while a
   * pointer is held down anyway.
   */
  let dragTargets: AnchorCandidateNode[] = [];
  let dragFrame: number | undefined;
  /**
   * Set by a drag that actually moved, so the `click` it leaves behind does not
   * also open the popover over the re-attach just committed. Cleared on the next
   * task rather than by the row's own click handler: a successful drop ends with
   * `mouseup` over `#content`, so `click` is dispatched on the common ancestor
   * (`<body>`) and never reaches the row — a handler-cleared flag would stay
   * latched and silently swallow the user's NEXT click on any row.
   */
  let justDragged = false;

  function endDrag(): void {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragUp);
    escapeDisposable?.dispose();
    escapeDisposable = undefined;
    if (dragFrame !== undefined) {
      cancelAnimationFrame(dragFrame);
      dragFrame = undefined;
    }
    document.body.classList.remove('comment-card-dragging');
    dragThreadId = undefined;
    dragStart = undefined;
    dragTargets = [];
    dragging = false;
    clearAim();
  }

  function onDragMove(e: MouseEvent): void {
    if (!dragStart) {
      return;
    }
    // The button came back up somewhere we never heard about (released outside
    // the window, or over a native menu). Without this the drag stays armed and
    // the user's next click anywhere would silently commit it.
    if (e.buttons === 0) {
      endDrag();
      return;
    }
    if (!dragging) {
      if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) < COMMENT_PANEL_DRAG_THRESHOLD_PX) {
        return;
      }
      dragging = true;
      document.body.classList.add('comment-card-dragging');
    }
    // The hit test and the chip's rect read are layout-forcing: one per frame.
    const { clientX, clientY } = e;
    if (dragFrame !== undefined) {
      cancelAnimationFrame(dragFrame);
    }
    dragFrame = requestAnimationFrame(() => {
      dragFrame = undefined;
      const node = candidateAt(clientX, clientY);
      if (node) {
        aimAt(node);
      } else {
        clearAim();
      }
    });
  }

  function onDragUp(): void {
    const threadId = dragThreadId;
    const node = aim?.node;
    const wasDragging = dragging;
    endDrag();
    justDragged = wasDragging;
    if (wasDragging) {
      setTimeout(() => {
        justDragged = false;
      }, 0);
    }
    if (wasDragging && threadId && node) {
      attach(threadId, node);
    }
  }

  function startDrag(threadId: string, e: MouseEvent): void {
    // Never stack two drags: re-arming without tearing the previous one down
    // would leak its Escape handler and leave a second pair of listeners live.
    endDrag();
    endWalk();
    // A click that never crosses the threshold must stay a click, so the card's
    // own controls keep working — the drag only arms here.
    dragThreadId = threadId;
    dragStart = { x: e.clientX, y: e.clientY };
    dragTargets = attachTargets();
    dragging = false;
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragUp);
    escapeDisposable = registerEscapeHandler(ESCAPE_PRIORITY.DRAG, () => {
      if (!dragThreadId) {
        return false;
      }
      endDrag();
      return true;
    });
  }

  // --- Keyboard route --------------------------------------------------------

  let walk: { threadId: string; candidates: AnchorCandidateNode[]; index: number } | undefined;
  let walkEscape: Disposable | undefined;

  function endWalk(): void {
    walk = undefined;
    walkEscape?.dispose();
    walkEscape = undefined;
    clearAim();
  }

  function stepWalk(delta: number): void {
    if (!walk || walk.candidates.length === 0) {
      return;
    }
    // Skip past anything a re-render detached rather than aiming at a node that
    // is no longer in the document.
    for (let tried = 0; tried < walk.candidates.length; tried++) {
      walk.index = (walk.index + delta + walk.candidates.length) % walk.candidates.length;
      if (revealAndAim(walk.candidates[walk.index].el)) {
        return;
      }
    }
    endWalk();
    showToast('That location changed — reopen the card to pick a node.');
  }

  function startWalk(thread: ThreadAnchor): void {
    endDrag();
    endWalk();
    const candidates = attachTargets();
    if (candidates.length === 0) {
      showToast('This document has no block to attach a comment to.');
      return;
    }
    walk = { threadId: thread.threadId, candidates, index: -1 };
    // Escape goes through the shared arbiter, not this card's own keydown: the
    // stack listens in the capture phase, so a bubble-phase handler would never
    // see an Escape that Zen mode or an open popover claimed first.
    walkEscape = registerEscapeHandler(ESCAPE_PRIORITY.DRAG, () => {
      if (!walk) {
        return false;
      }
      endWalk();
      return true;
    });
    stepWalk(1);
  }

  function commitWalk(): void {
    const node = aim?.node;
    const threadId = walk?.threadId;
    endWalk();
    if (node && threadId) {
      attach(threadId, node);
    }
  }

  function onCardKeyDown(e: KeyboardEvent, thread: ThreadAnchor, row: HTMLElement): void {
    // The ⋯ button lives inside the row and has its own keyboard contract —
    // swallowing Space here would stop it opening the picker.
    if ((e.target as HTMLElement).closest('.comment-panel-more')) {
      return;
    }
    // The re-attach walk belongs to a floating row and only to a floating row:
    // there is nothing to re-attach on a row whose anchor is fine, and Space
    // there has to mean the same as Enter (activate), per the button convention.
    const floating = thread.state === 'floating';
    const walking = walk?.threadId === thread.threadId;
    if (e.key === ' ' && floating) {
      e.preventDefault();
      // Space is both halves of the gesture: pick this row up, or drop the one
      // already in hand. Pressing it on a DIFFERENT row takes that row
      // instead of silently doing nothing.
      if (walking) {
        commitWalk();
      } else {
        startWalk(thread);
      }
      return;
    }
    if (walking) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        stepWalk(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        commitWalk();
      }
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateRow(thread, row);
    }
  }

  // --- Re-attach… picker -----------------------------------------------------

  const picker = el('div', 'comment-reattach-picker');
  picker.hidden = true;
  const pickerFilter = document.createElement('input');
  pickerFilter.className = 'comment-reattach-filter';
  pickerFilter.type = 'text';
  pickerFilter.placeholder = 'Filter nodes';
  pickerFilter.setAttribute('aria-label', 'Filter nodes');
  const pickerList = el('div', 'comment-reattach-list');
  const pickerHint = el('div', 'comment-reattach-hint', '↑↓ move · Enter attach · Esc close');
  picker.appendChild(el('div', 'comment-reattach-title', 'Re-attach to…'));
  picker.appendChild(pickerFilter);
  picker.appendChild(pickerList);
  picker.appendChild(pickerHint);
  document.body.appendChild(picker);

  const pickerDismiss = initPopoverDismiss(picker, () => {
    pickerThread = undefined;
    clearAim();
  });
  let pickerThread: ThreadAnchor | undefined;
  let pickerRows: Array<{ row: HTMLElement; node: HTMLElement }> = [];
  let pickerIndex = 0;
  let pointerMoved = false;
  picker.addEventListener('mousemove', () => {
    pointerMoved = true;
  });

  function highlightPickerRow(index: number): void {
    if (pickerRows.length === 0) {
      return;
    }
    pickerIndex = (index + pickerRows.length) % pickerRows.length;
    for (let i = 0; i < pickerRows.length; i++) {
      pickerRows[i].row.classList.toggle('active', i === pickerIndex);
    }
    // Hovering/highlighting a row previews it: the document scrolls to the node
    // and shows the same chip a drop would (handoff, "Hovering a row previews it").
    revealAndAim(pickerRows[pickerIndex].node);
  }

  function pickerRow(candidate: AnchorCandidateNode, target: ReattachTarget, withScore: boolean): HTMLElement {
    const row = el('button', 'comment-reattach-row');
    (row as HTMLButtonElement).type = 'button';
    row.appendChild(el('span', 'comment-reattach-line', candidate.line > 0 ? `Ln ${candidate.line}` : ''));
    row.appendChild(el('span', 'comment-reattach-type', nodeTypeLabel(candidate.el)));
    row.appendChild(el('span', 'comment-reattach-text', snippet(candidate.text)));
    if (withScore) {
      row.appendChild(el('span', 'comment-reattach-score', `${Math.round(target.score * 100)}%`));
    }
    return row;
  }

  function buildPicker(): void {
    const thread = pickerThread;
    if (!thread) {
      return;
    }
    pickerList.textContent = '';
    pickerRows = [];
    const candidates = attachTargets();
    const { suggested, all } = rankReattachTargets(
      thread.recordedText,
      candidates,
      pickerFilter.value,
      COMMENT_PANEL_REATTACH_SUGGESTIONS
    );

    const addRow = (target: ReattachTarget, withScore: boolean): void => {
      const candidate = candidates[target.index];
      const row = pickerRow(candidate, target, withScore);
      row.addEventListener('mouseenter', () => {
        // The picker opens under the pointer that clicked ⋯, so the row that
        // happens to land there fires mouseenter without the user aiming at it —
        // and would steal the highlight from the top suggestion on every
        // keystroke. Only a real pointer move counts as hovering.
        if (pointerMoved) {
          highlightPickerRow(pickerRows.findIndex((r) => r.row === row));
        }
      });
      row.addEventListener('click', () => {
        const threadId = thread.threadId;
        pickerDismiss.close();
        attach(threadId, candidate.el);
      });
      pickerList.appendChild(row);
      pickerRows.push({ row, node: candidate.el });
    };

    // Suggestions only lead the UNfiltered list: once the author is filtering
    // they have already said what they are looking for, and repeating the hit
    // under both "Suggested" and its heading group would just show it twice
    // (the design handoff's filtered state is a flat "N matches" list).
    const filtering = pickerFilter.value.trim() !== '';
    if (filtering) {
      pickerList.appendChild(
        el('div', 'comment-reattach-group', `${all.length} match${all.length === 1 ? '' : 'es'}`)
      );
    }
    if (!filtering && suggested.length > 0) {
      pickerList.appendChild(el('div', 'comment-reattach-group', 'Suggested'));
      for (const target of suggested) {
        addRow(target, true);
      }
    }
    // null, not '': a candidate's heading legitimately IS '' above the first
    // heading, and that group still needs its own header row.
    let heading: string | null = null;
    const suggestedIndices = new Set(filtering ? [] : suggested.map((target) => target.index));
    for (const target of all) {
      // A suggestion already has its own row; repeating it under its heading
      // would make the same node appear twice in one list.
      if (suggestedIndices.has(target.index)) {
        continue;
      }
      const candidate = candidates[target.index];
      if (normalizeAnchorText(candidate.heading) !== heading) {
        heading = normalizeAnchorText(candidate.heading);
        pickerList.appendChild(el('div', 'comment-reattach-group', heading === '' ? 'Document' : heading));
      }
      addRow(target, false);
    }
    if (pickerRows.length === 0) {
      pickerList.appendChild(
        el(
          'div',
          'comment-reattach-empty',
          candidates.length === 0 ? 'This document has no block to attach to.' : 'No node matches that filter.'
        )
      );
      // Nothing to preview any more — the previous row's marker would otherwise
      // keep pointing at a node the list no longer offers.
      clearAim();
      return;
    }
    // Start on the top suggestion so the picker always has a current row: Enter
    // is then meaningful immediately, and the preview chip shows what it would
    // attach to before anything is committed.
    pickerIndex = 0;
    highlightPickerRow(0);
  }

  function openPicker(thread: ThreadAnchor, anchorRect: DOMRect): void {
    pickerThread = thread;
    pickerFilter.value = '';
    pointerMoved = false;
    picker.hidden = false;
    buildPicker();
    positionNear(picker, anchorRect);
    pickerDismiss.arm();
    pickerFilter.focus();
  }

  pickerFilter.addEventListener('input', buildPicker);
  picker.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      highlightPickerRow(pickerIndex + (e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = pickerRows[pickerIndex];
      const thread = pickerThread;
      if (chosen && thread) {
        const threadId = thread.threadId;
        pickerDismiss.close();
        attach(threadId, chosen.node);
      }
    }
  });

  // --- Rendering -------------------------------------------------------------

  /** `⋯` menu state. Both are view-only — neither reaches the sidecar. */
  let newestFirst = true;
  let hideClosed = false;
  /** The row the user last activated, redrawn as selected across a re-render. */
  let selectedThreadId: string | undefined;
  /** The host's report on the sidecar; `undefined` until the first snapshot. */
  let sidecar: CommentSidecarState | undefined;
  let loading = true;
  /** Req 24 US-23.12: echoed on `copyCommentsAsMarkdown`/`copyCommentsAsMarkdownResult`. */
  let docUri = '';
  let docRelativePath = '';
  let copyRequestSeq = 0;
  /** In-flight guard for THIS tab's own menu-triggered export only (AC2) — a
   *  host-triggered `requestCommentsMarkdownExport` replies once and needs none. */
  let inFlightCopyRequest: number | undefined;
  let copyTimeoutHandle: number | undefined;

  function activateRow(thread: ThreadAnchor, row: HTMLElement): void {
    // Anything still in hand belongs to the row the user just left: a walk armed
    // on another row would keep its aim overlay painted over the document and
    // would take the next Escape (DRAG outranks the popover's tier).
    endDrag();
    endWalk();
    selectedThreadId = thread.threadId;
    for (const other of list.querySelectorAll('.comment-row.selected')) {
      other.classList.remove('selected');
    }
    row.classList.add('selected');
    // The popover reveals a connected carrier itself and re-measures against it,
    // which is AC8's "scroll first, then position". A floating thread has no
    // carrier and nowhere to scroll to, so it opens against the row's own box.
    // Neither path can raise US-23.3's anchor-lost notice: that is armed only on
    // the transition INTO floating, which opening a row is not.
    openThread(thread.threadId, row.getBoundingClientRect(), row);
  }

  /** One line of anchored text, or the stated fallback for a textless anchor
   *  (caret anchor, image, diagram) — never a blank cell. */
  function anchorSnippet(thread: ThreadAnchor): { text: string; empty: boolean } {
    const text = snippet(thread.recordedText);
    return text === '' ? { text: 'No anchored text', empty: true } : { text: `“${text}”`, empty: false };
  }

  function row(thread: ThreadAnchor): HTMLElement {
    const floating = thread.state === 'floating';
    const item = el('div', 'comment-row');
    // Focusable, but deliberately NOT role="button": ARIA makes a button's
    // subtree presentational, which would strip the nested `⋯` Re-attach control
    // — the keyboard/screen-reader route this story promises to keep working —
    // out of the accessibility tree while leaving it in the tab order.
    item.tabIndex = 0;
    item.dataset.threadId = thread.threadId;
    item.dataset.group = groupOf(thread);
    if (thread.threadId === selectedThreadId) {
      item.classList.add('selected');
    }

    const top = el('div', 'comment-row-top');
    // One pill per row for every status, except a floating row, whose pill says
    // the anchor is gone — its resolve status moves down to line 2, because
    // floating is orthogonal to status and must not look like a replacement.
    const pillText = floating ? 'No anchor' : thread.status;
    const pill = el('span', 'comment-row-pill', pillText);
    pill.dataset.status = floating ? 'anchor' : thread.status.toLowerCase();
    top.appendChild(pill);
    if (!floating && thread.state === 'approximate') {
      // AC6: a guessed location is never presented silently on this surface.
      const approx = el('span', 'comment-row-approx', 'Approximate');
      approx.title = 'This comment was relocated by a content match — its position is a best guess.';
      top.appendChild(approx);
    }
    if (floating) {
      top.appendChild(el('span', 'comment-row-snippet empty', 'Unresolved location'));
    } else {
      const { text, empty } = anchorSnippet(thread);
      // textContent throughout `el()` — a recorded anchor can hold raw HTML
      // (an <img>), and this surface must render it as characters (US-23.10 AC9).
      top.appendChild(el('span', `comment-row-snippet${empty ? ' empty' : ''}`, text));
    }

    const meta = el('div', 'comment-row-meta');
    // The thread's OPENER, not the last replier — the identity US-23.2 AC4 and
    // the schema's `delete` rule both gate on.
    meta.appendChild(el('span', 'comment-row-author', thread.author));
    meta.appendChild(separatorDot());
    meta.appendChild(
      el('span', 'comment-row-where', floating ? thread.status : `Ln ${thread.lastKnownLine}`)
    );
    const stamp = lastTransitionAt(thread);
    const time = el('span', 'comment-row-time', formatRelative(stamp));
    // The relative form is computed once per render and never ticks; the absolute
    // stamp on hover is what makes "2h ago" checkable hours later.
    time.title = stamp;
    meta.appendChild(time);

    const main = el('div', 'comment-row-main');
    main.appendChild(top);
    main.appendChild(meta);

    if (floating) {
      // The absorbed US-23.4 affordances, unchanged: the handle drags onto a
      // node, the ⋯ opens the ranked picker, and onCardKeyDown owns the walk.
      const handle = el('span', 'comment-panel-handle', '⠿');
      handle.setAttribute('aria-hidden', 'true');
      item.appendChild(handle);
    }
    item.appendChild(main);
    if (floating) {
      const more = el('button', 'comment-panel-more', '⋯');
      (more as HTMLButtonElement).type = 'button';
      more.title = 'Re-attach…';
      more.setAttribute('aria-label', `Re-attach “${snippet(thread.body)}”`);
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        openPicker(thread, more.getBoundingClientRect());
      });
      item.appendChild(more);
      item.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('.comment-panel-more')) {
          return;
        }
        e.preventDefault(); // keep the editor selection; the row is not a text surface
        // preventDefault also suppresses the focus the click would have given, and
        // the keyboard route needs the row focused to be reachable at all.
        item.focus();
        startDrag(thread.threadId, e);
      });
    }
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.comment-panel-more')) {
        return;
      }
      // A drag that ended over its own row still fires a click; opening the
      // popover on top of the re-attach the user just committed would bury it.
      if (justDragged) {
        justDragged = false;
        return;
      }
      activateRow(thread, item);
    });
    item.addEventListener('keydown', (e) => onCardKeyDown(e, thread, item));
    return item;
  }

  /** Decorative "·" between meta fields — hidden from AT, which would otherwise
   *  read "reviewer middle dot Ln 7". */
  function separatorDot(): HTMLElement {
    const dot = el('span', 'comment-row-dot', '·');
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  }

  function groupHeader(label: string, count: number, note?: string): HTMLElement {
    const header = el('div', 'comment-group');
    header.appendChild(el('span', 'comment-group-label', label));
    // Every count on this surface is derived from the rows it heads — never a
    // separately-maintained number that can disagree with what is listed.
    header.appendChild(el('span', 'comment-group-count', String(count)));
    if (note !== undefined) {
      header.appendChild(el('span', 'comment-group-note', note));
    }
    return header;
  }

  /** The four distinguishable reasons the list can be empty (AC12). */
  function emptyState(): HTMLElement | undefined {
    const problem = sidecar?.problem;
    if (problem !== undefined) {
      return emptyBlock('Comments unavailable', problem, 'problem');
    }
    if (loading) {
      return emptyBlock('Loading comments…');
    }
    if (hideClosed && resolve.allThreads().length > 0) {
      // Threads exist and "Hide closed" is what left nothing on screen. Saying
      // "no comments in this file" here would be a lie the user cannot act on —
      // and the branch is gated on the toggle, so a future reason for an empty
      // list cannot inherit this wording or its useless "Show closed" button.
      const block = emptyBlock('No comments to show', 'Every thread in this file is Closed.');
      const action = el('button', 'comment-empty-action', 'Show closed comments');
      (action as HTMLButtonElement).type = 'button';
      action.addEventListener('click', () => {
        hideClosed = false;
        flush();
      });
      block.appendChild(action);
      return block;
    }
    return emptyBlock(
      'No comments in this file',
      'Select some text and choose Add comment, or right-click a line in the gutter.'
    );
  }

  function emptyBlock(title: string, note?: string, kind?: string): HTMLElement {
    const block = el('div', 'comment-empty');
    if (kind !== undefined) {
      block.dataset.kind = kind;
    }
    block.appendChild(el('div', 'comment-empty-title', title));
    if (note !== undefined) {
      block.appendChild(el('div', 'comment-empty-note', note));
    }
    return block;
  }

  function orphanRow(orphan: NonNullable<CommentSidecarState['orphans']>[number]): HTMLElement {
    const item = el('div', 'comment-row orphan');
    const top = el('div', 'comment-row-top');
    const pill = el('span', 'comment-row-pill', orphan.kind === 'reply' ? 'Reply' : 'Status');
    pill.dataset.status = 'anchor';
    top.appendChild(pill);
    top.appendChild(el('span', 'comment-row-snippet', snippet(orphan.detail)));
    const meta = el('div', 'comment-row-meta');
    meta.appendChild(el('span', 'comment-row-author', orphan.author));
    meta.appendChild(separatorDot());
    meta.appendChild(el('span', 'comment-row-where', 'No parent comment'));
    meta.appendChild(el('span', 'comment-row-time', formatRelative(orphan.timestamp)));
    const main = el('div', 'comment-row-main');
    main.appendChild(top);
    main.appendChild(meta);
    item.appendChild(main);
    return item;
  }

  /** The tab's current group/"Hide closed" filter, shared by the row list and the export. */
  function groupedThreads(): Map<GroupKey, ThreadAnchor[]> {
    const grouped = new Map<GroupKey, ThreadAnchor[]>();
    for (const thread of resolve.allThreads()) {
      const key = groupOf(thread);
      if (key === 'closed' && hideClosed) {
        continue;
      }
      const bucket = grouped.get(key);
      if (bucket === undefined) {
        grouped.set(key, [thread]);
      } else {
        bucket.push(thread);
      }
    }
    return grouped;
  }

  /** The tab's current sort — shared by the row list and the export (AC3). */
  function compareByCurrentSort(a: ThreadAnchor, b: ThreadAnchor): number {
    // Parsed, not lexicographic: the sidecar is a plain JSONL file a merge or a
    // hand edit can leave holding `+07:00` offsets and millisecond-less stamps,
    // which string-compare in the wrong order. Same rule as sidecar-format.ts's
    // own `byTimestamp`.
    const delta = transitionTime(b) - transitionTime(a);
    // Ties broken by thread id, so the order is total and a re-render with
    // identical data can never reshuffle rows under the reader.
    return (newestFirst ? delta : -delta) || a.threadId.localeCompare(b.threadId);
  }

  function exportableThreadCount(): number {
    let n = 0;
    for (const bucket of groupedThreads().values()) {
      n += bucket.length;
    }
    return n;
  }

  function closedThreadCount(): number {
    let n = 0;
    for (const thread of resolve.allThreads()) {
      if (groupOf(thread) === 'closed') {
        n++;
      }
    }
    return n;
  }

  /** AC8: read fresh on every menu open AND on invoke (the last thread can be deleted while the menu stays open). */
  function currentCopyDisabledReason(): string | undefined {
    return copyDisabledReason({
      sidecarProblem: sidecar?.problem,
      loading,
      sidecarForeign: sidecar?.foreign === true,
      totalThreadCount: resolve.allThreads().length,
      exportableThreadCount: exportableThreadCount(),
      hideClosed,
    });
  }

  /** AC3: this group's threads in the tab's own current sort — never a hardcoded default. */
  function exportableThreadsSorted(): ThreadAnchor[] {
    const grouped = groupedThreads();
    const ordered: ThreadAnchor[] = [];
    for (const key of GROUP_ORDER) {
      const bucket = grouped.get(key);
      if (bucket === undefined) {
        continue;
      }
      ordered.push(...[...bucket].sort(compareByCurrentSort));
    }
    return ordered;
  }

  /** AC4: `Whole document` for a missing/unmappable carrier — never `Ln 0`. */
  function resolveExportLocation(thread: ThreadAnchor): ExportLocation {
    if (thread.state === 'floating') {
      return { kind: 'floating' };
    }
    const approximate = thread.state === 'approximate';
    const carrier = thread.carrier;
    // A re-render (main.ts) leaves every carrier stale until the debounced
    // re-resolution pass runs (ANCHOR_REEVAL_DEBOUNCE_MS later) — the same
    // window comment-gutter.ts/comment-highlight.ts guard with `isConnected`
    // before trusting a carrier (review finding, 2026-07-28).
    if (carrier !== undefined && carrier !== content && carrier.isConnected) {
      const range = commentAnchorLineRange(content, carrier);
      if (range !== null) {
        return range.start === range.end
          ? { kind: 'line', line: range.start, approximate }
          : { kind: 'range', start: range.start, end: range.end, approximate };
      }
    }
    // Carrier missing, detached, or unmappable — fall back to the last
    // resolved single line rather than dropping straight to "Whole document",
    // which loses more information than this plain number still carries.
    return thread.lastKnownLine > 0
      ? { kind: 'line', line: thread.lastKnownLine, approximate }
      : { kind: 'wholeDocument', approximate };
  }

  function toExportThread(thread: ThreadAnchor): ExportThread {
    // AC4: the LAST transition's author/time, not the row's own (the opener) —
    // falls back to the opener only for a thread that has never left Open.
    const lastTransition = thread.statusChanges[thread.statusChanges.length - 1];
    const comments: ExportComment[] = [
      { author: thread.author, timestamp: thread.createdAt, body: thread.body },
      ...thread.replies.map((reply) => ({ author: reply.author, timestamp: reply.timestamp, body: reply.body })),
    ];
    // `??` alone is not enough: the sidecar validator accepts `timestamp: ''`
    // and the host forwards it verbatim (same trap `lastTransitionAt` above
    // already guards against) — an empty string would export a heading with a
    // dangling trailing separator instead of falling back to creation
    // (review finding, 2026-07-28).
    const lastTransitionTimestamp =
      lastTransition?.timestamp === undefined || lastTransition.timestamp === ''
        ? thread.createdAt
        : lastTransition.timestamp;
    return {
      group: groupOf(thread),
      status: thread.status,
      location: resolveExportLocation(thread),
      lastTransitionAuthor: lastTransition?.author ?? thread.author,
      lastTransitionTimestamp,
      anchorText: thread.recordedText,
      comments,
    };
  }

  type CopyExportPayload =
    | { exportable: true; markdown: string; threadCount: number; hiddenClosedCount?: number }
    | { exportable: false; reason: string };

  /** AC2/AC3/AC7: one synchronous pass — grouped/sorted/filtered, rendered, and
   *  returned in one call, so nothing landing mid-build can split the output. */
  function buildExportPayload(): CopyExportPayload {
    const reason = currentCopyDisabledReason();
    if (reason !== undefined) {
      return { exportable: false, reason };
    }
    const exportable = exportableThreadsSorted();
    const snapshot: ExportSnapshot = {
      docRelativePath,
      exportedAtIso: new Date().toISOString(),
      foreignSidecar: sidecar?.foreign === true,
      threads: exportable.map(toExportThread),
    };
    const closed = closedThreadCount();
    return {
      exportable: true,
      markdown: renderCommentsMarkdown(snapshot),
      threadCount: exportable.length,
      hiddenClosedCount: hideClosed && closed > 0 ? closed : undefined,
    };
  }

  function postCopyPayload(requestId: number, payload: CopyExportPayload): void {
    if (payload.exportable) {
      vscode.postMessage({
        type: 'copyCommentsAsMarkdown',
        requestId,
        docUri,
        exportable: true,
        markdown: payload.markdown,
        threadCount: payload.threadCount,
        hiddenClosedCount: payload.hiddenClosedCount,
      });
    } else {
      vscode.postMessage({
        type: 'copyCommentsAsMarkdown',
        requestId,
        docUri,
        exportable: false,
        reason: payload.reason,
      });
    }
  }

  /** AC1/AC2: the menu row's own trigger — self-mints a requestId and guards
   *  against a second click while the first is still in flight. */
  function triggerMenuCopy(): void {
    if (inFlightCopyRequest !== undefined) {
      return;
    }
    const payload = buildExportPayload();
    if (!payload.exportable) {
      // The row is disabled for exactly this reason — nothing to send.
      return;
    }
    const requestId = ++copyRequestSeq;
    inFlightCopyRequest = requestId;
    copyTimeoutHandle = window.setTimeout(() => {
      if (inFlightCopyRequest === requestId) {
        inFlightCopyRequest = undefined;
        copyTimeoutHandle = undefined;
        showToast('Copying as Markdown timed out — try again.');
      }
    }, COMMENT_COPY_MARKDOWN_TIMEOUT_MS);
    postCopyPayload(requestId, payload);
  }

  function build(): void {
    // Scroll and focus have to survive a re-render triggered by someone else's
    // reply landing (AC10) — the user did not ask to be moved.
    const scrollTop = list.scrollTop;
    const focusedRow =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>('.comment-row')
        : null;
    const focusedId = focusedRow?.dataset.threadId;
    // AC10: a row whose thread left the snapshot is removed and focus moves to
    // the NEXT row — so the position has to be remembered as well as the id.
    const focusedIndex =
      focusedRow === null
        ? -1
        : Array.from(list.querySelectorAll('.comment-row')).indexOf(focusedRow);
    // A picker anchored to a row that is about to be destroyed has nothing left
    // to point at, and its captured thread may have been pruned by this very
    // snapshot — closing is the honest answer.
    if (pickerThread !== undefined && resolve.anchorOf(pickerThread.threadId) === undefined) {
      pickerDismiss.close();
    }
    list.textContent = '';

    // AC13: one banner naming the cause.
    banner.hidden = sidecar?.foreign !== true;
    banner.textContent =
      sidecar?.foreign === true
        ? 'None of the text these comments were written against is still in this file — the sidecar may describe a different document.'
        : '';

    const grouped = groupedThreads();

    const orphans = sidecar?.orphans ?? [];
    let rendered = 0;
    for (const key of GROUP_ORDER) {
      const bucket = grouped.get(key);
      // Empty groups are omitted entirely: a file with only closed threads shows
      // one group, not four.
      if (bucket === undefined || bucket.length === 0) {
        continue;
      }
      bucket.sort(compareByCurrentSort);
      list.appendChild(
        groupHeader(GROUP_LABEL[key], bucket.length, key === 'closed' ? 'no gutter pin' : undefined)
      );
      for (const thread of bucket) {
        list.appendChild(row(thread));
      }
      rendered += bucket.length;
    }
    if (orphans.length > 0) {
      // Read-only, after Closed: merge-orphaned content stays recoverable rather
      // than being held invisibly in host memory (US-23.5 AC4 only logged it).
      list.appendChild(groupHeader('Orphaned', orphans.length, 'no parent comment'));
      for (const orphan of orphans) {
        list.appendChild(orphanRow(orphan));
      }
      rendered += orphans.length;
    }

    if (rendered === 0) {
      const empty = emptyState();
      if (empty !== undefined) {
        list.appendChild(empty);
      }
    }

    if (focusedId !== undefined) {
      const rowsNow = Array.from(list.querySelectorAll<HTMLElement>('.comment-row'));
      const same = list.querySelector<HTMLElement>(
        `.comment-row[data-thread-id="${CSS.escape(focusedId)}"]`
      );
      // Same thread if it survived; otherwise the row that took its place, so a
      // deleted thread never drops the keyboard user out to <body> — which would
      // also disarm main.ts's dock Escape handler, since that requires focus
      // inside the panel.
      const target = same ?? rowsNow[Math.min(focusedIndex, rowsNow.length - 1)];
      // preventScroll: focus() scrolls its target into view, which would undo the
      // scroll restore below on a list taller than the panel.
      target?.focus({ preventScroll: true });
    }
    list.scrollTop = scrollTop;
  }

  /**
   * Coalesced at US-23.4 AC5's rate: one burst of snapshots (a reload settling,
   * a debounced re-resolution finishing) rebuilds the list once, not per event.
   */
  let rebuildTimer: number | undefined;
  function refresh(): void {
    if (rebuildTimer !== undefined) {
      clearTimeout(rebuildTimer);
    }
    rebuildTimer = window.setTimeout(() => {
      rebuildTimer = undefined;
      build();
    }, ANCHOR_REEVAL_DEBOUNCE_MS);
  }

  /** Rebuild NOW and drop any pending one, so a state change the user is waiting
   *  on (the loading state ending, a menu pick) is not held behind the debounce. */
  function flush(): void {
    if (rebuildTimer !== undefined) {
      clearTimeout(rebuildTimer);
      rebuildTimer = undefined;
    }
    build();
  }

  resolve.onChange(() => {
    refresh();
    // The toolbar badge tracks the count whether or not the tab is showing.
    document.dispatchEvent(new CustomEvent('orca-comment-floating-changed'));
  });

  const tab: RightDockTab = {
    id: 'comment',
    label: 'Comment',
    body: panel,
    menuItems: () => [
      {
        label: 'Newest first',
        section: 'Sort',
        selection: 'single',
        checked: newestFirst,
        onSelect: () => {
          newestFirst = true;
          flush();
        },
      },
      {
        label: 'Oldest first',
        section: 'Sort',
        selection: 'single',
        checked: !newestFirst,
        onSelect: () => {
          newestFirst = false;
          flush();
        },
      },
      {
        label: 'Hide closed',
        section: 'Show',
        selection: 'multiple',
        checked: hideClosed,
        onSelect: () => {
          hideClosed = !hideClosed;
          flush();
        },
      },
      (() => {
        // AC8: registered and disabled, never withheld — the row stays in the
        // menu even with nothing exportable, reason shown as a tooltip.
        const reason = currentCopyDisabledReason();
        return {
          label: 'Copy all as Markdown',
          section: 'Export',
          disabled: reason !== undefined,
          reason,
          onSelect: triggerMenuCopy,
        };
      })(),
    ],
  };

  return {
    tab,
    threadCount: () => resolve.allThreads().length,
    floatingCount: () => resolve.floatingThreads().length,
    setSidecarState(state): void {
      // `loading` stays set while the host says the sidecar read is still in
      // flight: the `ready` handler posts a snapshot the moment the webview
      // registers, which is usually BEFORE the disk read settles, and treating
      // that as "loaded, nothing to report" would flash "No comments in this
      // file" over a document that turns out to have twenty.
      const wasLoading = loading;
      loading = state?.loading === true;
      sidecar = loading ? undefined : state;
      // Only the loading→loaded transition jumps the queue; every other snapshot
      // goes through the debounce, so a burst rebuilds the list once (AC10).
      if (wasLoading && !loading) {
        flush();
      } else {
        refresh();
      }
    },
    beginLoad(): void {
      loading = true;
      sidecar = undefined;
      // Anything armed against the outgoing document is meaningless now.
      endDrag();
      endWalk();
      pickerDismiss.close();
      selectedThreadId = undefined;
      flush();
    },
    refresh,
    setDocument(uri, relativePath): void {
      docUri = uri;
      docRelativePath = relativePath;
    },
    handleExportRequest(requestId): void {
      postCopyPayload(requestId, buildExportPayload());
    },
    notifyCopyResult(requestId, ok, error): void {
      if (requestId !== inFlightCopyRequest) {
        return;
      }
      inFlightCopyRequest = undefined;
      if (copyTimeoutHandle !== undefined) {
        clearTimeout(copyTimeoutHandle);
        copyTimeoutHandle = undefined;
      }
      if (!ok) {
        showToast(error ?? 'Could not copy comments as Markdown.');
      }
    },
  };
}
