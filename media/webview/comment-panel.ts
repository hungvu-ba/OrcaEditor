/**
 * Req 23 US-23.4 AC4: the "Unresolved location" panel — where a comment lands
 * once all four anchor tiers have failed, and the two equal routes back into the
 * document.
 *
 * The list is uncapped and scrolls: a large edit can strand a dozen threads at
 * once and none of them may be collapsed away behind a "+N more" or dropped.
 * Cards are ordered newest-created first, because the author is looking for a
 * comment they remember writing, not for whichever anchor broke most recently.
 *
 * Re-attaching is offered twice over, on purpose: drag a card onto a node, or
 * open the Re-attach… picker and choose one. Both call the same
 * `reattach(threadId, el)` on comment-resolve.ts, so the pointer route and the
 * keyboard/screen-reader route cannot drift apart. Suggestions in the picker are
 * RANKED, never applied — automatic matching is precisely what already failed
 * for these threads.
 *
 * Nothing here writes to the `.md`: re-attaching only moves a session-only DOM
 * attribute and the native thread's Range (US-23.6), and it never touches the
 * Open/Resolved/Closed status axis (US-23.3) — floating is orthogonal to it.
 */
import { anchorCandidates, type AnchorCandidateNode } from './block-map';
import { normalizeAnchorText, rankReattachTargets, type ReattachTarget } from './comment-anchor';
import type { CommentResolveController, ThreadAnchor } from './comment-resolve';
import {
  COMMENT_PANEL_DRAG_THRESHOLD_PX,
  COMMENT_PANEL_REATTACH_SUGGESTIONS,
  COMMENT_PANEL_SNIPPET_CHARS,
} from './constants';
import { el, positionNear, showToast } from './dom-utils';
import { truncateDisplay } from './trigger-popup';
import { initPopoverDismiss, registerEscapeHandler, ESCAPE_PRIORITY, type Disposable } from './escape-stack';

export interface CommentPanelController {
  /** Open/close the docked panel (the toolbar button's action). */
  toggle(): void;
  isOpen(): boolean;
  /** How many threads are floating right now — the toolbar button's badge. */
  floatingCount(): number;
}

/** The drop target currently under the pointer/selection, plus the overlay marking it. */
interface AimState {
  node: HTMLElement;
  chip: HTMLElement;
  outline: HTMLElement;
}

const OPEN_BODY_CLASS = 'comment-panel-open';

function formatTimestamp(iso: string): string {
  if (iso === '') {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  // Locale-shaped and short (the handoff's "Jul 24, 10:12"), with no relative
  // "3 days ago" arithmetic — a review can sit for weeks and an absolute stamp
  // stays true whenever the panel is reopened.
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
  resolve: CommentResolveController
): CommentPanelController {
  let open = false;

  const panel = el('aside', 'comment-panel');
  panel.id = 'comment-panel';
  panel.setAttribute('aria-label', 'Unresolved comment locations');
  const header = el('div', 'comment-panel-header');
  const title = el('span', 'comment-panel-title', 'Unresolved location');
  const count = el('span', 'comment-panel-count');
  header.appendChild(title);
  header.appendChild(count);
  const hint = el('div', 'comment-panel-hint');
  const list = el('div', 'comment-panel-list');
  panel.appendChild(header);
  panel.appendChild(hint);
  panel.appendChild(list);
  document.body.appendChild(panel);

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

  function onCardKeyDown(e: KeyboardEvent, thread: ThreadAnchor): void {
    // The ⋯ button lives inside the card and has its own keyboard contract —
    // swallowing Space here would stop it opening the picker.
    if ((e.target as HTMLElement).closest('.comment-panel-more')) {
      return;
    }
    const walking = walk?.threadId === thread.threadId;
    if (e.key === ' ') {
      e.preventDefault();
      // Space is both halves of the gesture: pick this card up, or drop the one
      // already in hand. Pressing it on a DIFFERENT card takes that card
      // instead of silently doing nothing.
      if (walking) {
        commitWalk();
      } else {
        startWalk(thread);
      }
      return;
    }
    if (!walking) {
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      stepWalk(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commitWalk();
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

  function card(thread: ThreadAnchor): HTMLElement {
    const item = el('div', 'comment-panel-card');
    item.tabIndex = 0;
    item.dataset.threadId = thread.threadId;

    const handle = el('span', 'comment-panel-handle', '⠿');
    handle.setAttribute('aria-hidden', 'true');

    const meta = el('div', 'comment-panel-meta');
    meta.appendChild(el('span', 'comment-panel-author', thread.author));
    meta.appendChild(el('span', 'comment-panel-time', formatTimestamp(thread.createdAt)));

    const more = el('button', 'comment-panel-more', '⋯');
    (more as HTMLButtonElement).type = 'button';
    more.title = 'Re-attach…';
    more.setAttribute('aria-label', `Re-attach “${snippet(thread.body)}”`);
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openPicker(thread, more.getBoundingClientRect());
    });

    const body = el('div', 'comment-panel-body');
    const quote = el('div', 'comment-panel-quote', `“${snippet(thread.recordedText)}”`);
    body.appendChild(quote);
    body.appendChild(el('div', 'comment-panel-text', thread.body));

    const main = el('div', 'comment-panel-card-main');
    const topRow = el('div', 'comment-panel-card-top');
    topRow.appendChild(meta);
    topRow.appendChild(more);
    main.appendChild(topRow);
    main.appendChild(body);

    item.appendChild(handle);
    item.appendChild(main);

    item.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.comment-panel-more')) {
        return;
      }
      e.preventDefault(); // keep the editor selection; the card is not a text surface
      // preventDefault also suppresses the focus the click would have given, and
      // the keyboard route needs the card focused to be reachable at all.
      item.focus();
      startDrag(thread.threadId, e);
    });
    item.addEventListener('keydown', (e) => onCardKeyDown(e, thread));
    return item;
  }

  function build(): void {
    const floating = resolve.floatingThreads();
    count.textContent = String(floating.length);
    list.textContent = '';
    if (floating.length === 0) {
      // Plain statement, no illustration and no call to action (handoff): the
      // hint line goes with the cards, since there is nothing left to drag.
      hint.hidden = true;
      const empty = el('div', 'comment-panel-empty');
      empty.appendChild(el('div', 'comment-panel-empty-title', 'No unresolved comments'));
      empty.appendChild(
        el(
          'div',
          'comment-panel-empty-note',
          'Every thread in this file still points at a line. Comments land here only when their anchor is lost.'
        )
      );
      list.appendChild(empty);
      return;
    }
    hint.hidden = false;
    hint.textContent = 'Drag a card onto the document to re-attach it, or use ⋯ → Re-attach…';
    for (const thread of floating) {
      list.appendChild(card(thread));
    }
  }

  function refresh(): void {
    if (!open) {
      return;
    }
    build();
  }

  resolve.onChange(() => {
    refresh();
    // The toolbar badge tracks the count whether or not the panel is open.
    document.dispatchEvent(new CustomEvent('orca-comment-floating-changed'));
  });

  return {
    toggle(): void {
      open = !open;
      document.body.classList.toggle(OPEN_BODY_CLASS, open);
      if (open) {
        build();
      } else {
        endDrag();
        endWalk();
        pickerDismiss.close();
      }
    },
    isOpen(): boolean {
      return open;
    },
    floatingCount(): number {
      return resolve.floatingThreads().length;
    },
  };
}
