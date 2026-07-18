/**
 * Drag & drop reorder for top-level blocks (US-17.3) and list items
 * (US-17.5, M3) — HLR section 17.
 *
 * Undo mechanism: a move commits through sibling-move.ts's Range APIs
 * (applyBlockMove / applyLiReparentMove — Range.deleteContents()+insertNode()),
 * not appendChild/insertBefore and not execCommand. Undo/redo is delegated
 * entirely to VS Code's TextDocument (main.ts / provider.ts replace
 * #content.innerHTML wholesale on every undo/redo), so the scheduleSync() after
 * a move records it as ONE TextDocument edit = one Ctrl+Z step, regardless of
 * how far the block travels or how many blocks a section-move carries along.
 * There is no native browser undo stack to keep in sync — the historical
 * `execCommand('insertHTML', ...)` approach (one *native* undo step per move)
 * is gone; raw Range surgery + a single host edit is the convention here, the
 * same one replaceBlockTag / commitListOpDirect (dom-utils / list-ops.ts) use.
 *
 * DOM stays the source of truth (architecture note in the code plan): the
 * live #content DOM is read fresh on every drag start, nothing is cached
 * across renders. Block Map (US-18.1) is intentionally NOT used here — it is
 * only rebuilt on full renderDocument() and can be stale mid-session; a move
 * only needs "current top-level children with a real markdown source range",
 * which is exactly what readSrcRange() (already shared with block-map.ts and
 * gutter.ts) tells us, filtered straight off content.children.
 *
 * Note (US-17.7, M6): `finishLiMove`'s cross-level move additionally runs a
 * `normalizeListDom(content)` cleanup pass directly on the live DOM after the
 * Range move — fine under the TextDocument-undo model above (one host edit, no
 * native stack to desync).
 */
import { readSrcRange } from './block-info';
import { MERMAID_CLASS, MATH_BLOCK_CLASS } from './pipeline';
import { isValidSiblingGap, computeSiblingMove, applyBlockMove, applyLiReparentMove } from './sibling-move';
import { normalizeListDom } from './dom-serialize-prep';
import { positionMenuClearOf, lockPageScroll, unlockPageScroll } from './menu-popup';
import type { LineGutter } from './gutter';
import type { DomHelpers } from './dom-utils';

export interface DragDropDeps {
  scheduleSync: () => void;
  dom: DomHelpers;
  lineGutter: LineGutter;
  /** Re-establish #content's caret-host invariants (trailing typable <p>, caret spots around
   * atoms/hr) after a direct DOM mutation whose host echo is suppressed so renderDocument won't
   * re-run — used by deleteSelectedBlock (bug General #1) to keep the doc editable after a delete. */
  ensureCaretHost: () => void;
}

export interface DragDropController {
  /** Call after #content is fully rebuilt (renderDocument) — drops any stale hover/drag state that referenced old nodes. */
  refresh(): void;
}

type DragState = 'idle' | 'armed' | 'dragging';
type DragKind = 'block' | 'li';

const HEADING_RE = /^H([1-6])$/;
const DRAG_THRESHOLD_PX = 4;
/** Horizontal drag distance (px) that shifts the target nesting depth by one level during an li
 * drag (US-17.7, M6) — target depth is `liOrigDepth + round(dx / LIST_INDENT_THRESHOLD_PX)`,
 * clamped to whatever depths are valid at the chosen vertical gap (liDepthRangeAtGap). */
const LIST_INDENT_THRESHOLD_PX = 32;
/** Must match `.dd-handle`'s CSS `width` (editor.css) — `climbLiFrom` reserves this much
 * space left of a `<li>`'s own handle position as "still hovering this item" before climbing
 * to an ancestor, or past the outermost item to the whole-list block handle. */
const HANDLE_WIDTH_PX = 22;
/** Manual tuning knob: shifts the block handle this many px to the right of its default
 * anchor (flush against the block's own left edge). Adjust by hand to taste. */
const BLOCK_HANDLE_SHIFT_RIGHT_PX = 0;
/** Gap between the li handle's right edge and the `<li>`'s OWN content-left edge, so the handle
 * sits snug just left of that item's own right-aligned marker (bullet/number) with a balanced
 * gap — not out at the enclosing list's left edge (which pushed a nested item's handle into its
 * PARENT's marker column, far from the child's own number). Tuned by on-screen verification:
 * the marker renders at the sequential position (single-digit for lists under ~10 items),
 * right-aligned toward `li.left`; ~26px lands the handle just left of it with a ~6px gap.
 * Each nesting level uses the same rule, so parent/child handles are one indent step apart. */
const LI_HANDLE_MARKER_GAP_PX = 26;
/** Floor for the li handle's own-content height (positionLiHandle) — a parent `<li>` whose only
 * child is its nested list has ~0 own content, so clamp to keep a grabbable handle. */
const LI_HANDLE_MIN_HEIGHT_PX = 20;
/** Manual tuning knob: shifts the li handle (and its hitzone, via `liHandleAnchorLeft`) this many
 * px to the right of its default anchor. Adjust by hand to taste. */
const LI_HANDLE_SHIFT_RIGHT_PX = 8;
/** Size of the table-level handle's own corner hit zone (bug 0716 round 2, #1) — matches
 * `.dd-handle`'s base 22×24 footprint (editor.css). */
const TABLE_HANDLE_WIDTH_PX = 22;
const TABLE_HANDLE_HEIGHT_PX = 24;
/** How far the corner hit zone extends PAST the table's own top-left corner, into the same
 * pixels row-0/col-0's own handles claim — a genuine overlap band, not a knife-edge, so
 * "shows together with row/column handles" is actually reachable (see findTableBlockAt). */
const TABLE_HANDLE_CORNER_OVERLAP_PX = 4;
const AUTOSCROLL_EDGE_PX = 56;
const AUTOSCROLL_SPEED_PX = 16;
const AUTOSCROLL_INTERVAL_MS = 16;
const HANDLE_GLYPH = '⠿'; // ⠿

export function headingLevel(el: Element): number | null {
  const m = HEADING_RE.exec(el.tagName);
  return m ? Number(m[1]) : null;
}

function isAtomBlock(el: Element): boolean {
  return el.classList.contains(MERMAID_CLASS) || el.classList.contains(MATH_BLOCK_CLASS);
}

/**
 * Section-move (F7 companion, also reused for TOC-drag — US-17.7/M5): dragging
 * a heading carries every following block up to (not including) the next
 * heading of the same or higher level — same "which level closes this
 * section" rule TOC would need for a tree, but TOC only builds a flat list
 * (toc.ts) so this lives here instead. Module-scope (not a closure over
 * `content`) so other callers can reuse it against their own block list.
 */
export function computeHeadingSectionSpan(startEl: HTMLElement, blocks: HTMLElement[]): HTMLElement[] {
  const startIdx = blocks.indexOf(startEl);
  const level = headingLevel(startEl);
  if (level === null) {
    return [startEl];
  }
  const span = [startEl];
  for (let i = startIdx + 1; i < blocks.length; i++) {
    const lvl = headingLevel(blocks[i]);
    if (lvl !== null && lvl <= level) {
      break;
    }
    span.push(blocks[i]);
  }
  return span;
}

export interface HeadingSiblingGaps {
  /** Start index of every same-level, same-parent sibling section (including the moved heading's own). */
  siblingStarts: number[];
  /** Gap index at the end of the parent's scope (`levels.length` when the parent is the document root). */
  scopeEndGap: number;
  /** Gap to move the heading up one sibling (largest valid gap before its own start), or null when it is the first sibling. */
  moveUpGap: number | null;
  /** Gap to move the heading down one sibling (smallest valid gap after its own section), or null when it is the last sibling. */
  moveDownGap: number | null;
}

/**
 * Pure outline math for the same-level/same-parent heading move restriction (bug_General #2
 * follow-up): given each block's heading level (`null` for non-heading blocks) and the index of
 * the heading being moved, return the sibling-section boundaries its move/drag may target. The
 * heading's PARENT is the nearest preceding heading with a level `< L` (or the document root when
 * none); the parent's scope ends at the next heading of level `≤ parentLevel`; SIBLINGS are the
 * level-`L` headings that are direct children of that same parent. The parent's scope ends at the
 * first following heading of level `< L`, so a heading can never be moved past a shallower heading
 * and nest under it. Level changes are out of scope here — that is Tab/Shift+Tab's job.
 * DOM-free so it is unit-testable on plain level arrays.
 */
export function headingSiblingGaps(levels: Array<number | null>, idx: number): HeadingSiblingGaps {
  const L = levels[idx];
  if (L === null) {
    // Not a heading — caller should never restrict; return a trivial "own position only" result.
    return { siblingStarts: [idx], scopeEndGap: idx + 1, moveUpGap: null, moveDownGap: null };
  }
  // Parent = nearest preceding heading of level < L (its index bounds the sibling scan below);
  // the document root when none, i.e. parentIdx = -1.
  let parentIdx = -1;
  for (let i = idx - 1; i >= 0; i--) {
    const lv = levels[i];
    if (lv !== null && lv < L) {
      parentIdx = i;
      break;
    }
  }
  // Scope ends at the first heading of level < L (whether it is a shallower/parent-level heading
  // that leaves the section, OR a heading of level between parentLevel and L that would start a
  // subsection the moved heading must not be dragged into/past). Using `< L` — not `≤ parentLevel`
  // — is what stops e.g. an H3 (under an H1) from being moved BELOW a following H2 and nesting
  // under it. Within [parentIdx+1, scopeEndGap) there is then no heading of level < L at all, so
  // every level-L heading in that range is a direct sibling — no per-candidate parent re-check.
  let scopeEndGap = levels.length;
  for (let j = idx + 1; j < levels.length; j++) {
    const lv = levels[j];
    if (lv !== null && lv < L) {
      scopeEndGap = j;
      break;
    }
  }
  const siblingStarts: number[] = [];
  for (let k = parentIdx + 1; k < scopeEndGap; k++) {
    if (levels[k] === L) {
      siblingStarts.push(k);
    }
  }
  // The moved heading's own section runs from its start up to the next sibling start (or scope end).
  const ownPos = siblingStarts.indexOf(idx);
  const ownEnd = ownPos + 1 < siblingStarts.length ? siblingStarts[ownPos + 1] : scopeEndGap;
  const moveUpGap = ownPos > 0 ? siblingStarts[ownPos - 1] : null;
  // Move down = past the next sibling's whole section = the sibling-start after `ownEnd`, or scope end.
  let moveDownGap: number | null = null;
  if (ownEnd < scopeEndGap) {
    const afterNext = siblingStarts.find((s) => s > ownEnd);
    moveDownGap = afterNext ?? scopeEndGap;
  }
  return { siblingStarts, scopeEndGap, moveUpGap, moveDownGap };
}

/** Top-level children of `content` with a real markdown source range — excludes the trailing caret-trap <p> (same filter as block-map.ts). Exported for reuse (TOC-drag, US-17.7/M5). */
export function draggableTopLevelBlocks(content: HTMLElement): HTMLElement[] {
  return (Array.from(content.children) as HTMLElement[]).filter((el) => readSrcRange(el) !== null);
}

export function initDragDrop(content: HTMLElement, deps: DragDropDeps): DragDropController {
  function draggableBlocks(): HTMLElement[] {
    return draggableTopLevelBlocks(content);
  }

  /** Heading level per block (`null` for non-heading) — the DOM→levels adapter feeding the pure
   * `headingSiblingGaps` outline math (bug_General #2 follow-up). */
  function blockLevels(blocks: HTMLElement[]): Array<number | null> {
    return blocks.map((b) => headingLevel(b));
  }

  /** Gap index g means "insert before blocks[g]" (g === blocks.length means "insert at the end"). */
  function gapAt(blocks: HTMLElement[], clientY: number): number {
    for (let i = 0; i < blocks.length; i++) {
      const r = blocks[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        return i;
      }
    }
    return blocks.length;
  }

  /** Performs the move (Range deleteContents/insertNode, via sibling-move.ts — see applyBlockMove for why not execCommand) and returns the moved block's new live element, for caret placement. */
  function performMove(span: HTMLElement[], blocks: HTMLElement[], gap: number): HTMLElement | null {
    const spanStartIdx = blocks.indexOf(span[0]);
    const spanEndIdx = spanStartIdx + span.length - 1;
    const result = computeSiblingMove(
      blocks,
      spanStartIdx,
      spanEndIdx,
      gap,
      (prev, cur) => isAtomBlock(prev) && isAtomBlock(cur)
    );
    return applyBlockMove(content, result);
  }

  // ---------------------------------------------------------------------
  // Hover handle
  // ---------------------------------------------------------------------

  const handleEl = document.createElement('div');
  handleEl.className = 'dd-handle';
  handleEl.textContent = HANDLE_GLYPH;
  handleEl.style.display = 'none';
  document.body.appendChild(handleEl);

  let hoveredBlock: HTMLElement | null = null;

  /** Excludes <table> so hovering a cell only shows table.ts's own row/col handles, never the whole-block handle on top of them (bug 0715 #11). draggableBlocks() itself stays unfiltered — section-move/menu-move (computeHeadingSectionSpan, moveBlockToGap) still need tables in the list so a table inside a dragged heading section is carried along. */
  function findBlockAt(clientY: number): HTMLElement | null {
    const blocks = draggableBlocks().filter((b) => b.tagName !== 'TABLE');
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        return b;
      }
    }
    return null;
  }

  /** The blocks a drag starting on `block` would actually move — a heading's whole section
   * (computeHeadingSectionSpan), else just the block itself. Single source of truth for both
   * the handle's span rect (positionHandle) and the hover-preview outline, so the grab
   * affordance always matches what a real drag carries (bug General #2). */
  function blockOutlineSpan(block: HTMLElement): HTMLElement[] {
    if (headingLevel(block) === null) {
      return [block];
    }
    // A stale/detached heading (e.g. cleared after a host-driven re-render) is not in the live
    // top-level list, so computeHeadingSectionSpan would scan from index 0 and return the wrong
    // blocks — fall back to [block] so a clear only ever touches the block itself, never wrong
    // live siblings (matches the harmlessness of the old single-node `classList.remove`).
    const blocks = draggableBlocks();
    return blocks.includes(block) ? computeHeadingSectionSpan(block, blocks) : [block];
  }

  function addBlockSpanOutline(block: HTMLElement | null): void {
    if (!block) {
      return;
    }
    for (const el of blockOutlineSpan(block)) {
      el.classList.add('dd-hover-outline');
    }
  }

  function removeBlockSpanOutline(block: HTMLElement | null): void {
    if (!block) {
      return;
    }
    for (const el of blockOutlineSpan(block)) {
      el.classList.remove('dd-hover-outline');
    }
  }

  /** Hit column spans the block's own full height and sits flush (zero gap) against the
   * block's own left edge — `right` (not `left`) anchoring guarantees the flush fit
   * regardless of the icon's CSS width, and removes the dead zone a moving cursor used
   * to cross before reaching the old fixed tiny-icon offset (bug 0716 #4). A heading's handle
   * spans its WHOLE section (heading + the content a drag carries), not just the heading's own
   * box (bug General #2), and top-aligns its glyph via `dd-handle--section` so the grab icon
   * stays at the heading row instead of floating in the middle of a tall section. */
  function positionHandle(block: HTMLElement | null): void {
    if (!block) {
      handleEl.style.display = 'none';
      handleEl.classList.remove('dd-handle--section');
      return;
    }
    const span = blockOutlineSpan(block);
    const firstRect = span[0].getBoundingClientRect();
    const bottom = span[span.length - 1].getBoundingClientRect().bottom;
    handleEl.style.display = 'flex';
    handleEl.classList.toggle('dd-handle--section', span.length > 1);
    handleEl.style.top = `${firstRect.top}px`;
    handleEl.style.height = `${bottom - firstRect.top}px`;
    handleEl.style.right = `${window.innerWidth - firstRect.left - BLOCK_HANDLE_SHIFT_RIGHT_PX}px`;
  }

  // ---------------------------------------------------------------------
  // Table-level handle (bug 0716 round 2, #1): drag a whole <table> as one
  // block. Tracked fully independently of hoveredBlock/hoveredLi (never
  // forced null by either, and vice versa) so it can show at the same time
  // as table.ts's own row/column handles — only the small corner zone below
  // is claimed, leaving their own hit zones untouched (bug 0715 #11 stays
  // intact). Reuses armDrag/performMove/computeHeadingSectionSpan as-is; no
  // new move logic (Option B, see deferred-work.md).
  // ---------------------------------------------------------------------

  const tableHandleEl = document.createElement('div');
  tableHandleEl.className = 'dd-handle dd-table-handle';
  tableHandleEl.textContent = HANDLE_GLYPH;
  tableHandleEl.style.display = 'none';
  document.body.appendChild(tableHandleEl);

  let hoveredTableBlock: HTMLElement | null = null;

  /** Pure rect math, no `elementFromPoint` (unlike findLiAt) — safe to call from a
   * `mouseleave` exit point outside #content's own box, no climb-style refactor needed.
   * Fires in the band flush above-left of a table's own corner, the one spot not otherwise
   * claimed by the row handle's own column or the column handle's own row — extended a few
   * px PAST the table's own top-left corner (not stopping exactly at it) so the zone
   * genuinely overlaps table.ts's own row-0/col-0 hit zones instead of only meeting them at
   * a knife-edge boundary pixel (which floating-point rect math from two different elements
   * can't reliably agree on, and which a real mouse can't reliably land on either) — the
   * "table handle can show together with row/column handles" acceptance criterion needs an
   * actually reachable overlap, not just a technically-non-conflicting one. */
  function findTableBlockAt(clientX: number, clientY: number): HTMLElement | null {
    for (const b of draggableBlocks()) {
      if (b.tagName !== 'TABLE') {
        continue;
      }
      const r = b.getBoundingClientRect();
      if (
        clientX >= r.left - TABLE_HANDLE_WIDTH_PX &&
        clientX <= r.left + TABLE_HANDLE_CORNER_OVERLAP_PX &&
        clientY >= r.top - TABLE_HANDLE_HEIGHT_PX &&
        clientY <= r.top + TABLE_HANDLE_CORNER_OVERLAP_PX
      ) {
        return b;
      }
    }
    return null;
  }

  /** Same as `setHighlightedBlock`, for the table-level hover handle. */
  function setHighlightedTableBlock(block: HTMLElement | null): void {
    if (block === hoveredTableBlock) {
      return;
    }
    hoveredTableBlock?.classList.remove('dd-hover-outline');
    hoveredTableBlock = block;
  }

  /** Flush against the table's own top-left corner — `right`/`bottom` anchoring mirrors
   * `positionRowHandle`/`positionColHandle`'s technique in table.ts. */
  function positionTableHandle(block: HTMLElement | null): void {
    if (!block) {
      tableHandleEl.style.display = 'none';
      return;
    }
    const r = block.getBoundingClientRect();
    tableHandleEl.style.display = 'flex';
    tableHandleEl.style.right = `${window.innerWidth - r.left}px`;
    tableHandleEl.style.bottom = `${window.innerHeight - r.top}px`;
  }

  // ---------------------------------------------------------------------
  // Handle menu (US-17.7, M5; merged into the handle click by bug 0716 #5):
  // a click (not a drag) on the block handle → "Move up / Move down / Move to
  // <heading>…" — a mouse-only shortcut for long blocks that would otherwise
  // need a long drag (F11: no keyboard nav in MVP). Reuses the exact same
  // computeHeadingSectionSpan/sibling-move.ts primitives as an actual drag —
  // a menu move IS a drag, just with the gap picked from a list instead of a
  // drop-line position.
  // ---------------------------------------------------------------------

  const menuPopupEl = document.createElement('div');
  menuPopupEl.className = 'dd-menu-popup';
  menuPopupEl.style.display = 'none';
  document.body.appendChild(menuPopupEl);

  function isMenuOpen(): boolean {
    return menuPopupEl.style.display !== 'none';
  }

  function closeMenu(): void {
    menuPopupEl.style.display = 'none';
    menuPopupEl.replaceChildren();
    // The block stays highlighted for as long as its menu is open (bug 0716 #6 extended
    // to the click-to-menu path) — clear it here, when the menu actually goes away,
    // instead of `resetState()` clearing it the instant the menu opens.
    if (menuTargetBlock) {
      removeBlockSpanOutline(menuTargetBlock);
      menuTargetBlock = null;
    }
    // Release the scroll freeze taken in openMenu (bug General R2 #3) — ref-counted, so a stray
    // close while nothing is locked is a safe no-op.
    unlockPageScroll();
  }

  function moveBlockToGap(block: HTMLElement, gap: number): void {
    const blocks = draggableBlocks();
    const idx = blocks.indexOf(block);
    if (idx < 0) {
      return;
    }
    const span = computeHeadingSectionSpan(block, blocks);
    const spanEndIdx = idx + span.length - 1;
    const clampedGap = Math.max(0, Math.min(gap, blocks.length));
    if (!isValidSiblingGap(clampedGap, idx, spanEndIdx)) {
      return;
    }
    const result = computeSiblingMove(blocks, idx, spanEndIdx, clampedGap, (prev, cur) => isAtomBlock(prev) && isAtomBlock(cur));
    // Same leak as the drag path (bug 0715 #12 loopback): clear the highlight
    // before applyBlockMove captures outerHTML, otherwise it bakes
    // .dd-hover-outline into the newly-created node at the destination. Also clears
    // hoveredTableBlock (bug 0716 round 2, #1 follow-up) — a table's own "Move up/Move
    // down/Move to…" menu item calls this same generic function.
    if (block === hoveredBlock) {
      setHighlightedBlock(null);
    }
    if (block === hoveredTableBlock) {
      setHighlightedTableBlock(null);
    }
    const movedEl = applyBlockMove(content, result);
    // Unlike the old execCommand('insertHTML') path, applyBlockMove's Range APIs never
    // leave a selection behind — restore the caret explicitly (bug 0716 round 3), same
    // pattern as finishBlockMove's drag path, or the menu-triggered move drops focus
    // out of #content entirely (closeMenu already removed the clicked button from the DOM).
    deps.dom.placeCaretIn(movedEl);
    deps.lineGutter.refreshFromDom();
    deps.scheduleSync();
    // Bug #1 (mở rộng): "Move up/Move down" từ menu dời block nhưng chuột đứng yên
    // (không có mousemove đảm bảo sau click) — tay cầm position:fixed sẽ đứng lại ở
    // vị trí cũ. refresh() ẩn/đặt lại toàn bộ handle, tự hiện lại khi di chuột.
    refresh();
  }

  /**
   * Bug General #1: Delete/Backspace on a handle-selected block removes the whole block.
   * DOM removal via Range (selectNode + deleteContents, the module's Range-based convention)
   * + scheduleSync() — the host commits it as one TextDocument edit, so Ctrl+Z restores it;
   * no native undo stack to desync. Caret goes to the previous top-level block, or the next
   * one when the deleted block was first.
   */
  function deleteSelectedBlock(block: HTMLElement): void {
    const blocks = draggableBlocks();
    const idx = blocks.indexOf(block);
    closeMenu();
    // Stale/detached target (e.g. a host-driven re-render between the click and the keypress) —
    // nothing left to delete; bail before selectNode() throws on a parent-less node.
    if (idx < 0) {
      return;
    }
    // Capture caret neighbours BEFORE the delete (prefer the previous block, else the next).
    const prev = blocks[idx - 1] ?? null;
    const next = blocks[idx + 1] ?? null;
    const range = document.createRange();
    range.selectNode(block);
    range.deleteContents();
    // Re-establish the caret-host invariants renderDocument guarantees (a trailing typable <p>,
    // caret spots around atoms/hr). The host suppresses this delete's echo, so renderDocument
    // won't re-run — without this a plain single-paragraph doc is left with no caret host at all.
    deps.ensureCaretHost();
    // An atom block (mermaid/math) is contenteditable=false, so step off it onto the typable <p>
    // ensureCaretHost just placed beside it; fall back to the last child for an emptied doc.
    let caretTarget: Element | null = prev ?? next;
    if (caretTarget && isAtomBlock(caretTarget)) {
      caretTarget = caretTarget.nextElementSibling ?? caretTarget.previousElementSibling;
    }
    if (!caretTarget || !content.contains(caretTarget)) {
      caretTarget = content.lastElementChild;
    }
    deps.dom.placeCaretIn(caretTarget);
    deps.lineGutter.refreshFromDom();
    deps.scheduleSync();
    // Handles are position:fixed and only recompute on mousemove — drop/reset all handle
    // state so a stale one doesn't linger over the now-removed block (mirrors moveBlockToGap).
    refresh();
  }

  function addMenuItem(label: string, disabled: boolean, onClick: () => void): void {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'dd-menu-item';
    item.textContent = label;
    item.disabled = disabled;
    item.addEventListener('click', () => {
      closeMenu();
      if (!disabled) {
        onClick();
      }
    });
    menuPopupEl.appendChild(item);
  }

  function openMenu(block: HTMLElement, anchorX: number, anchorY: number): void {
    closeMenu();
    const blocks = draggableBlocks();
    const idx = blocks.indexOf(block);
    if (idx < 0) {
      return;
    }
    const span = computeHeadingSectionSpan(block, blocks);
    const spanEndIdx = idx + span.length - 1;

    // A HEADING is restricted to same-level siblings under its own parent (bug_General #2
    // follow-up): Move Up/Down step between sibling sections and "Move to…" lists only those
    // siblings. Any non-heading block keeps the original ±1-gap / all-headings behavior.
    const isHeading = headingLevel(block) !== null;
    const sib = isHeading ? headingSiblingGaps(blockLevels(blocks), idx) : null;

    if (sib) {
      addMenuItem('Move up', sib.moveUpGap === null, () => moveBlockToGap(block, sib.moveUpGap!));
      addMenuItem('Move down', sib.moveDownGap === null, () => moveBlockToGap(block, sib.moveDownGap!));
    } else {
      addMenuItem('Move up', idx === 0, () => moveBlockToGap(block, idx - 1));
      addMenuItem('Move down', spanEndIdx >= blocks.length - 1, () => moveBlockToGap(block, spanEndIdx + 2));
    }

    // "Move to…" targets: sibling headings only (heading), else every other heading (unchanged).
    const targets: Array<{ heading: HTMLElement; gap: number }> = sib
      ? sib.siblingStarts
          .filter((s) => s !== idx)
          .map((s) => ({ heading: blocks[s], gap: sib.siblingStarts.find((x) => x > s) ?? sib.scopeEndGap }))
      : blocks
          .filter((b) => headingLevel(b) !== null && !span.includes(b))
          .map((h) => ({ heading: h, gap: blocks.indexOf(h) + 1 }));
    if (targets.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'dd-menu-sep';
      menuPopupEl.appendChild(sep);
      const label = document.createElement('div');
      label.className = 'dd-menu-label';
      label.textContent = 'Move to…';
      menuPopupEl.appendChild(label);
      for (const t of targets) {
        const text = (t.heading.textContent ?? '').trim() || '(untitled)';
        // For a heading, "Move to <the sibling directly above me>" resolves to this heading's own
        // position — a self-drop moveBlockToGap would silently reject. Disable it instead of
        // showing a live-but-dead item (blind review F2); the non-heading path is left unchanged.
        const disabled = sib ? !isValidSiblingGap(t.gap, idx, spanEndIdx) : false;
        addMenuItem(text, disabled, () => moveBlockToGap(block, t.gap));
      }
    }

    menuPopupEl.style.display = 'block';
    // Anchor the popup at the handle click point (bug General R3 #1) rather than the whole block's
    // rect — a tall block/section used to open the menu far below where the handle was clicked. A
    // zero-size rect at (anchorX, anchorY) makes the shared helper open it like a context menu at
    // the cursor, keeping its flip-above and viewport/`#toolbar` clamps.
    positionMenuClearOf(menuPopupEl, new DOMRect(anchorX, anchorY, 0, 0));
    // Freeze page scroll while the menu is open so the fixed popup can't drift off its anchor
    // (bug General R2 #3); released in closeMenu.
    lockPageScroll();

    // Track the block by reference only (bug General R2 #1) — no native text selection; the
    // `.dd-hover-outline` outline is the "selected" cue and the Delete/Backspace handler keys
    // off `menuTargetBlock`, so atom blocks / tables still delete cleanly as whole elements.
    menuTargetBlock = block;
    // Outline the whole section a "Move" would carry (bug General #2), reusing the span already
    // computed above — matches the section-spanning handle so the menu targets what it says.
    span.forEach((el) => el.classList.add('dd-hover-outline'));
  }

  document.addEventListener('mousedown', (e) => {
    if (isMenuOpen() && !menuPopupEl.contains(e.target as Node)) {
      closeMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (!isMenuOpen()) {
      return;
    }
    if (e.key === 'Escape') {
      closeMenu();
      return;
    }
    // With a handle menu open its block is the tracked target (bug General #1/R2 #1 — outline
    // only, no text selection) — Delete/Backspace removes the whole block. preventDefault so any
    // native delete at whatever caret happens to be focused never runs alongside it.
    if ((e.key === 'Delete' || e.key === 'Backspace') && menuTargetBlock) {
      e.preventDefault();
      deleteSelectedBlock(menuTargetBlock);
      return;
    }
    // A bare modifier keydown is the start of a combo (e.g. Ctrl+Z), not an action on its own —
    // leave the menu open so the combo's final key below decides, instead of closing on the
    // modifier alone.
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
      return;
    }
    // Any other key (arrow, typing, a shortcut's final key) ends the selected-block mode: close
    // the menu so a later Delete/Backspace can't wipe a block the caret has since moved off of.
    // The key itself is left to act normally (no preventDefault).
    closeMenu();
  });

  // ---------------------------------------------------------------------
  // List-item hover handle (US-17.5, M3) — mutually exclusive with the block
  // handle above (onContentHover: `block = li ? null : findBlockAt(...)`), so
  // they never show at once inside a list. The li handle sits a small fixed gap
  // (LI_HANDLE_MARKER_GAP_PX) left of the hovered <li>'s OWN content-left edge —
  // snug just left of that item's own marker — so a deeper item's handle is
  // further RIGHT (nearer its own, more-indented number), and moving the cursor
  // LEFT off it enters the parent item's hover zone (climbLiFrom), the parent's
  // handle sitting snug to the parent's own marker one indent step further left.
  // ---------------------------------------------------------------------

  const liHandleEl = document.createElement('div');
  liHandleEl.className = 'dd-handle dd-li-handle';
  liHandleEl.textContent = HANDLE_GLYPH;
  liHandleEl.style.display = 'none';
  document.body.appendChild(liHandleEl);

  let hoveredLi: HTMLLIElement | null = null;

  /** Tracks whichever block is currently hovered and removes `.dd-hover-outline` when it
   * stops being hovered (bug 0715 #12 clear-path) — `hoveredBlock` itself is the tracked
   * "currently highlighted" element, so every assignment site funnels through here instead
   * of a separate shadow variable. Adding the class is NOT this function's job (bug 0716
   * #6): only `armDrag` (mousedown on the handle) adds it, so plain hover never shows it. */
  function setHighlightedBlock(block: HTMLElement | null): void {
    if (block === hoveredBlock) {
      return;
    }
    // Keep the menu target's section outlined while its menu is open (bug General #2 follow-up,
    // mirrors resetState's `hoveredBlock !== menuTargetBlock` guard) — otherwise ordinary mouse
    // movement over another block would strip the whole highlighted section out from under the
    // still-open menu.
    if (hoveredBlock !== menuTargetBlock) {
      removeBlockSpanOutline(hoveredBlock);
    }
    hoveredBlock = block;
  }

  /** Same as `setHighlightedBlock`, for the list-item hover handle. */
  function setHighlightedLi(li: HTMLLIElement | null): void {
    if (li === hoveredLi) {
      return;
    }
    hoveredLi?.classList.remove('dd-hover-outline');
    hoveredLi = li;
  }

  /** Climbs `li`'s own `<li>` ancestors (skipping the intermediate `<ul>`/`<ol>` via
   * `.closest('li')` on the parent) and prefers an ancestor as long as `clientX` is still
   * left of the current candidate's OWN handle left edge (`li.left − GAP − HANDLE_WIDTH`) —
   * i.e. the cursor sits in that ancestor's own (less-indented) zone, not over the inner
   * item's own content or its own handle. Returns `null` when the cursor is left of the
   * OUTERMOST item's band with no ancestor `<li>` left to climb to — the caller treats that as
   * "show the whole-list block handle". Pure rect math, no `elementFromPoint` — callable from a
   * known starting `<li>` even at points that don't hit any element at all, e.g. once the
   * cursor has left `#content`'s own rendered box (the `mouseleave` handler needs this same
   * climb, but has no fresh hit-test to start from). */
  function climbLiFrom(li: HTMLLIElement, clientX: number): HTMLLIElement | null {
    let current = li;
    for (;;) {
      // Band left edge = this item's own handle's left edge (`liHandleAnchorLeft` minus the
      // handle width) — still hovering `current` as long as the cursor is at/right of that. So
      // moving the cursor left just past the child handle's own left edge immediately enters
      // the parent's hover zone (no dead band). Uses the SAME clamped anchor as positionLiHandle
      // so the band tracks where the handle is actually drawn, even for narrow-gutter lists.
      const bandLeft = liHandleAnchorLeft(current) - HANDLE_WIDTH_PX;
      if (clientX >= bandLeft) {
        break;
      }
      const parentLi = current.parentElement?.closest('li') as HTMLLIElement | null;
      if (!parentLi || !content.contains(parentLi)) {
        // Cursor is left of the outermost `<li>`'s own band with no ancestor `<li>` to climb
        // to — signal "past the whole list" (null) so the caller surfaces the block handle for
        // the top-level block spanning this row (the `<ul>`/`<ol>` itself when the list is a
        // top-level block) instead of freezing on this item.
        return null;
      }
      // Don't climb past a <table> boundary — a table cell's own nested list
      // is hit-tested independently of any <li> that merely wraps the table;
      // row/column handles own that territory (bug 0715 #11).
      const enclosingTable = current.closest('table');
      if (enclosingTable && parentLi.contains(enclosingTable)) {
        break;
      }
      current = parentLi;
    }
    return current;
  }

  /**
   * elementFromPoint (not a rect scan like findBlockAt) finds the INNERMOST
   * <li> under the cursor first — a nested <li> containing its own sub-list
   * spans the same rect as its nested items, so it would otherwise never
   * surface its own handle (bug 0715 #8). But a point left of an <li>'s own
   * content — including its own reserved handle band and the browser's
   * default marker-glyph gutter — belongs to the enclosing <ul>/<ol>'s own
   * padding box, not to any <li>. There, `elementFromPoint` returns the list
   * element itself (or the marker), and a plain `.closest('li')` on it skips
   * straight past the item whose row this point is actually in, straight to
   * whichever ancestor <li> wraps the whole list (bug 0716 round 2, #2). So
   * when the hit lands on a <ul>/<ol>, prefer whichever of ITS OWN <li>
   * children's row (by clientY) contains the point — that item's own handle
   * band is what this pixel visually belongs to — before falling back to
   * `.closest('li')`.
   *
   * Once the starting <li> is found, `climbLiFrom` decides whether an ancestor's
   * gutter claims the cursor instead.
   *
   * A "loose" list (blank line between items, each <li> wraps its own <p>)
   * has real vertical gaps between sibling rows (the <p>'s own margin), so a
   * point can fall between two children's rects with no exact row match —
   * fall back to whichever child's row is vertically NEAREST, rather than
   * silently keeping whatever ancestor `.closest('li')` found, or the same
   * ancestor-misresolution this function exists to fix reappears in that gap.
   */
  function findLiAt(clientX: number, clientY: number): HTMLLIElement | null {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    let li = el?.closest?.('li') as HTMLLIElement | null;
    const listEl = el?.closest?.('ul, ol');
    if (listEl && content.contains(listEl)) {
      let nearest: HTMLLIElement | null = null;
      let nearestDist = Infinity;
      for (const child of Array.from(listEl.children)) {
        if (child.tagName !== 'LI') {
          continue;
        }
        const r = (child as HTMLElement).getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) {
          nearest = child as HTMLLIElement;
          break;
        }
        const dist = clientY < r.top ? r.top - clientY : clientY - r.bottom;
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = child as HTMLLIElement;
        }
      }
      if (nearest) {
        li = nearest;
      }
    }
    if (!li || !content.contains(li)) {
      return null;
    }
    return climbLiFrom(li, clientX);
  }

  /** X of the li handle's right edge: `LI_HANDLE_MARKER_GAP_PX` left of the item's OWN
   * content-left edge (snug just left of that item's own marker), but clamped to never go left
   * of the enclosing `<ul>`/`<ol>`'s own left edge — so a narrow-gutter list (e.g. a task list,
   * `padding: 1.2em`) or a very shallow item can't fling the handle off the left of the viewport;
   * it then just sits at the list edge (as it did before this change). */
  function liHandleAnchorLeft(li: HTMLElement): number {
    const listLeft = (li.parentElement ?? li).getBoundingClientRect().left;
    return (
      Math.max(listLeft, li.getBoundingClientRect().left - LI_HANDLE_MARKER_GAP_PX) +
      LI_HANDLE_SHIFT_RIGHT_PX
    );
  }

  /** Covers only the li's OWN content rows (top of the li → top of its first nested list, or the
   * full li height for a leaf), NOT the whole nested subtree, and sits `LI_HANDLE_MARKER_GAP_PX`
   * left of the li's OWN content-left edge — snug just left of that item's own marker (clamped,
   * see `liHandleAnchorLeft`). Sizing to the subtree made a parent handle's (vertically centered)
   * glyph float down in the MIDDLE of its children; own-content height keeps every level's handle
   * a uniform size next to its own marker. Same `right`-anchored technique as `positionHandle`. */
  function positionLiHandle(li: HTMLLIElement | null): void {
    if (!li) {
      liHandleEl.style.display = 'none';
      return;
    }
    const r = li.getBoundingClientRect();
    // Vertical extent = the item's OWN content only: down to the top of its first nested
    // `<ul>`/`<ol>` (its own line(s)), or the full height for a leaf. A parent whose only child
    // is its nested list has ~0 own content, so clamp to a grabbable minimum.
    const nestedList = li.querySelector(':scope > ul, :scope > ol');
    const ownHeight = nestedList
      ? Math.max(LI_HANDLE_MIN_HEIGHT_PX, nestedList.getBoundingClientRect().top - r.top)
      : r.height;
    // Right edge sits a small fixed gap left of the `<li>`'s OWN content-left edge, landing
    // just left of that item's own right-aligned marker (bullet/number). Anchoring at `r.left`
    // itself put the handle on top of the marker; anchoring at the enclosing list's left edge
    // pushed a nested item's handle all the way into its PARENT's marker column, far from the
    // child's own number — this keeps it snug to the item's own marker, one indent step per
    // nesting level (see LI_HANDLE_MARKER_GAP_PX / liHandleAnchorLeft).
    const anchorLeft = liHandleAnchorLeft(li);
    liHandleEl.style.display = 'flex';
    liHandleEl.style.top = `${r.top}px`;
    liHandleEl.style.height = `${ownHeight}px`;
    liHandleEl.style.right = `${window.innerWidth - anchorLeft}px`;
  }

  /** Innermost level under the cursor wins (bug 0716 #3): resolve the `<li>` first, and
   * whenever one is under the cursor (any depth, including a depth-0 item) the block handle
   * is forced off — a `<ul>`/`<ol>` is itself a top-level block, so without this both handles
   * used to show at once inside a list. */
  function onContentHover(e: MouseEvent): void {
    if (state !== 'idle') {
      return;
    }
    const li = findLiAt(e.clientX, e.clientY);
    const block = li ? null : findBlockAt(e.clientY);
    if (block !== hoveredBlock) {
      setHighlightedBlock(block);
      positionHandle(block);
    }
    if (li !== hoveredLi) {
      setHighlightedLi(li);
      positionLiHandle(li);
    }
    // Independent of block/li above (bug 0716 round 2, #1) — must be able to show at the
    // same time as a row/column handle, so it never reads or writes hoveredBlock/hoveredLi.
    const tableBlock = findTableBlockAt(e.clientX, e.clientY);
    if (tableBlock !== hoveredTableBlock) {
      setHighlightedTableBlock(tableBlock);
      positionTableHandle(tableBlock);
    }
  }

  /** True when `(x, y)` is still in the gutter band a hovered block/li's own handle lives
   * in — left of the target's own edge, vertically within its rows. A real mouse move can
   * skip clean over the (still fairly narrow) handle column in one sampled step without
   * ever landing on `handleEl`/`liHandleEl` itself, so `mouseleave`'s `relatedTarget` check
   * alone isn't enough (bug 0716 #4 follow-up). No lower bound on `x` — `findBlockAt` itself
   * never checks `x`, so "still hovering" shouldn't stop mattering just because the handle's
   * own rect was overshot. */
  function isInHandleGutter(target: HTMLElement | null, x: number, y: number): boolean {
    if (!target) {
      return false;
    }
    const r = target.getBoundingClientRect();
    return x < r.left && y >= r.top && y <= r.bottom;
  }

  /** Re-resolve the hovered li — or, once the climb runs past the outermost item, the
   * whole-list block handle — from a leftward exit point. Shared by #content's `mouseleave`
   * and the li handle's OWN `mouseleave`: once the cursor sits on the li handle (which lives in
   * / left of #content's own left gutter), moving further left OFF the handle no longer fires
   * #content's `mouseleave` — it already fired when the cursor first moved ONTO the handle — so
   * without the handle's own `mouseleave` a depth-0 item's whole-list block handle would never
   * surface (user report: "moving left off the handle shows nothing"). Returns true when the
   * exit point is still within the hovered li's own gutter (i.e. this consumed the exit). */
  function climbLiFromExit(clientX: number, clientY: number): boolean {
    if (!isInHandleGutter(hoveredLi, clientX, clientY)) {
      return false;
    }
    // `hoveredLi` can go stale if the DOM was mutated without a `refresh()` call — mirror
    // findLiAt's own `content.contains` guard rather than handing climbLiFrom a detached node.
    if (!content.contains(hoveredLi)) {
      setHighlightedLi(null);
      positionLiHandle(null);
      return true;
    }
    const climbed = climbLiFrom(hoveredLi as HTMLLIElement, clientX);
    if (climbed !== hoveredLi) {
      setHighlightedLi(climbed);
      positionLiHandle(climbed);
      if (!climbed) {
        // Past the outermost item's band — surface the block handle for the top-level block
        // spanning this y (the `<ul>`/`<ol>` itself when the list is a top-level block).
        const block = findBlockAt(clientY);
        setHighlightedBlock(block);
        positionHandle(block);
      }
    }
    return true;
  }

  content.addEventListener('mousemove', onContentHover);
  content.addEventListener('mouseleave', (e: MouseEvent) => {
    if (state !== 'idle') {
      return;
    }
    // The handles live outside #content (appended to document.body, offset to
    // its left), so moving the cursor onto them fires #content's mouseleave —
    // don't clear the hover state in that case, only when leaving toward
    // something unrelated to the handles themselves.
    const related = e.relatedTarget as Node | null;
    if (
      related &&
      (handleEl.contains(related) ||
        menuPopupEl.contains(related) ||
        liHandleEl.contains(related) ||
        tableHandleEl.contains(related))
    ) {
      return;
    }
    // Independent of block/li below (bug 0716 round 2, #1) — findTableBlockAt is pure rect
    // math (no elementFromPoint), so it's safe to re-run directly at the exit point, unlike
    // findLiAt's climb.
    const tableBlock = findTableBlockAt(e.clientX, e.clientY);
    if (tableBlock !== hoveredTableBlock) {
      setHighlightedTableBlock(tableBlock);
      positionTableHandle(tableBlock);
    }
    // `mousemove` (and its own ancestor-climb) never fires once the cursor has left
    // #content's own rendered box — only `mouseleave` does, and `elementFromPoint` at a
    // point outside that box doesn't hit any <li>/<ul> at all, so `findLiAt` can't be
    // reused here. Climb from the already-known `hoveredLi` by rect math instead (bug 0716
    // round 2, #2 follow-up), so exiting further into an ancestor's own gutter band shows
    // that ancestor's handle instead of freezing on the child forever.
    if (climbLiFromExit(e.clientX, e.clientY)) {
      return;
    }
    if (isInHandleGutter(hoveredBlock, e.clientX, e.clientY)) {
      return;
    }
    setHighlightedBlock(null);
    setHighlightedLi(null);
    positionHandle(null);
    positionLiHandle(null);
  });

  // Handles use position:fixed + viewport coordinates from
  // getBoundingClientRect(), recomputed only on mousemove over #content — a
  // scroll with the mouse stationary otherwise leaves them stuck at the old
  // position while the block underneath moves.
  window.addEventListener(
    'scroll',
    () => {
      if (state !== 'idle') {
        return;
      }
      positionHandle(hoveredBlock);
      positionLiHandle(hoveredLi);
    },
    { passive: true, capture: true }
  );

  // ---------------------------------------------------------------------
  // IME guard (F5)
  // ---------------------------------------------------------------------

  let isComposing = false;
  content.addEventListener('compositionstart', () => {
    isComposing = true;
  });
  content.addEventListener('compositionend', () => {
    isComposing = false;
  });

  // ---------------------------------------------------------------------
  // Drag state machine (F4: mousedown + threshold, not native draggable=true —
  // avoids fighting contentEditable's own drag handling)
  // ---------------------------------------------------------------------

  let state: DragState = 'idle';
  let kind: DragKind = 'block';
  let startX = 0;
  let startY = 0;
  let dragBlocks: HTMLElement[] = [];
  let dragSpan: HTMLElement[] = [];
  let currentGap = 0;
  let currentGapValid = false;
  /** For a HEADING drag, the sibling-section gaps its section may be dropped at (same level, same
   * parent scope — bug_General #2 follow-up); the drop-line snaps/clamps to these. `null` for a
   * non-heading drag, which stays fully unrestricted (today's behavior). */
  let dragValidGaps: number[] | null = null;
  /** Block armed via `armDrag` (mousedown on the block handle) — read back in `onDocMouseUp`'s
   * non-dragging branch to open the handle menu when the click never crossed the drag
   * threshold (bug 0716 #5: merges the removed kebab button into the handle click). */
  let armedBlock: HTMLElement | null = null;
  /** Block whose `.dd-hover-outline` is being kept alive by an open handle menu — set by
   * `openMenu`, cleared by `closeMenu`. Lets `resetState()` (which runs synchronously right
   * after `openMenu` in the click path) skip clearing this specific block's outline, so the
   * menu doesn't visually open against a block with no highlight. */
  let menuTargetBlock: HTMLElement | null = null;

  // List-item drag state (US-17.5 M3, extended to cross-level moves by US-17.7
  // M6) — reuses the same ghost/drop-line/threshold/Esc machinery above. The
  // drop target is chosen from EVERY <li> in the dragged item's own root list
  // (the top-level <ul>/<ol> block containing it, flattened depth-tagged in
  // document order and excluding the dragged item's own subtree), not just
  // its original siblings: the vertical gap is picked by Y like before, and
  // the nesting depth is derived from horizontal drag offset (X), clamped to
  // whatever depths are valid at that gap (see liDepthRangeAtGap).
  let liDragged: HTMLLIElement | null = null;
  let liRootListEl: HTMLElement | null = null;
  let liFlatEntries: FlatLiEntry[] = [];
  let liOrigDepth = 1;
  let currentLiDepth = 1;

  const ghostEl = document.createElement('div');
  ghostEl.className = 'dd-ghost';
  ghostEl.style.display = 'none';
  document.body.appendChild(ghostEl);

  const dropLineEl = document.createElement('div');
  dropLineEl.className = 'dd-drop-line';
  dropLineEl.style.display = 'none';
  document.body.appendChild(dropLineEl);

  let autoScrollTimer: ReturnType<typeof setInterval> | undefined;

  function stopAutoScroll(): void {
    if (autoScrollTimer !== undefined) {
      clearInterval(autoScrollTimer);
      autoScrollTimer = undefined;
    }
  }

  function maintainAutoScroll(clientY: number): void {
    const toolbarBottom = document.getElementById('toolbar')?.getBoundingClientRect().bottom ?? 0;
    const nearTop = clientY < toolbarBottom + AUTOSCROLL_EDGE_PX;
    const nearBottom = clientY > window.innerHeight - AUTOSCROLL_EDGE_PX;
    if (!nearTop && !nearBottom) {
      stopAutoScroll();
      return;
    }
    if (autoScrollTimer !== undefined) {
      return;
    }
    const dir = nearTop ? -1 : 1;
    autoScrollTimer = setInterval(() => window.scrollBy(0, dir * AUTOSCROLL_SPEED_PX), AUTOSCROLL_INTERVAL_MS);
  }

  function updateGhostPosition(clientX: number, clientY: number): void {
    ghostEl.style.left = `${clientX + 12}px`;
    ghostEl.style.top = `${clientY + 12}px`;
  }

  function updateBlockDropLine(clientY: number): void {
    const spanStartIdx = dragBlocks.indexOf(dragSpan[0]);
    const spanEndIdx = spanStartIdx + dragSpan.length - 1;
    let gap = gapAt(dragBlocks, clientY);
    if (dragValidGaps) {
      // Heading drag: snap the raw gap to the nearest allowed sibling boundary so the section
      // can only reorder among same-level siblings and never leaves its parent scope
      // (bug_General #2 follow-up). Only gaps that are also a real move (not self) count.
      const movable = dragValidGaps.filter((g) => isValidSiblingGap(g, spanStartIdx, spanEndIdx));
      if (movable.length === 0) {
        currentGap = gap;
        currentGapValid = false;
        dropLineEl.style.display = 'none';
        return;
      }
      gap = movable.reduce((best, g) => (Math.abs(g - gap) < Math.abs(best - gap) ? g : best), movable[0]);
    }
    currentGap = gap;
    currentGapValid = isValidSiblingGap(gap, spanStartIdx, spanEndIdx);
    if (!currentGapValid) {
      dropLineEl.style.display = 'none';
      return;
    }
    const contentRect = content.getBoundingClientRect();
    let y: number;
    if (gap === 0) {
      y = dragBlocks[0].getBoundingClientRect().top;
    } else if (gap === dragBlocks.length) {
      y = dragBlocks[dragBlocks.length - 1].getBoundingClientRect().bottom;
    } else {
      const prevBottom = dragBlocks[gap - 1].getBoundingClientRect().bottom;
      const nextTop = dragBlocks[gap].getBoundingClientRect().top;
      y = (prevBottom + nextTop) / 2;
    }
    dropLineEl.className = 'dd-drop-line';
    dropLineEl.style.display = 'block';
    dropLineEl.style.top = `${y}px`;
    dropLineEl.style.left = `${contentRect.left}px`;
    dropLineEl.style.width = `${contentRect.width}px`;
    dropLineEl.style.height = '2px';
  }

  /** One entry of a root list's flattened, depth-tagged, document-order `<li>` walk — depth 1 is
   * the root list's own direct children. */
  interface FlatLiEntry {
    li: HTMLLIElement;
    depth: number;
  }

  /** Number of `<li>` ancestors of `li`, including itself — root-level items are depth 1. */
  function liDepth(li: Element): number {
    let depth = 0;
    for (let cur: Element | null = li; cur; cur = cur.parentElement) {
      if (cur.tagName === 'LI') {
        depth++;
      }
    }
    return depth;
  }

  /** The top-level `<ul>`/`<ol>` block that owns `li` (climbs past every ancestor `<li>`'s own
   * enclosing list) — the scope a cross-level li drag stays within (spec: same root list only,
   * no cross-list dragging). */
  function liRootList(li: HTMLLIElement): HTMLElement | null {
    let list: HTMLElement | null = li.parentElement;
    while (list && list.tagName !== 'UL' && list.tagName !== 'OL') {
      list = list.parentElement;
    }
    if (!list) {
      return null;
    }
    for (;;) {
      const ownerLi: Element | null = list.parentElement?.closest('li') ?? null;
      if (!ownerLi) {
        return list;
      }
      const outer: HTMLElement | null = ownerLi.parentElement;
      if (!outer || (outer.tagName !== 'UL' && outer.tagName !== 'OL')) {
        return list;
      }
      list = outer;
    }
  }

  /** Flattens every `<li>` under `list` (depth-tagged, document order), excluding `exclude`'s own
   * subtree entirely — the self-drop guard: no gap can ever fall inside the dragged item's own
   * descendants, because they're simply never in this array (same spirit as isValidSiblingGap). */
  function flattenLiList(list: Element, exclude: HTMLLIElement, depth: number, out: FlatLiEntry[]): void {
    for (const child of Array.from(list.children)) {
      if (child.tagName !== 'LI' || child === exclude) {
        continue;
      }
      out.push({ li: child as HTMLLIElement, depth });
      const nested = Array.from(child.children).find((c) => c.tagName === 'UL' || c.tagName === 'OL');
      if (nested) {
        flattenLiList(nested, exclude, depth + 1, out);
      }
    }
  }

  /** gap index among `entries` by Y position (mirrors gapAt). */
  function liFlatGapAt(entries: FlatLiEntry[], clientY: number): number {
    for (let i = 0; i < entries.length; i++) {
      const r = entries[i].li.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        return i;
      }
    }
    return entries.length;
  }

  /**
   * Valid depth range at `gap` (Design Notes, spec-li-nested-drag-relevel.md): between flattened
   * item `i` (depth `d_i`) and item `i+1` (depth `d_(i+1)`), valid depths are `[d_(i+1), d_i+1]`
   * — cannot be shallower than the following item (or the nesting would jump more than one level)
   * and cannot nest deeper than one level under the preceding item. The two boundary gaps use
   * virtual sentinel depths: 0 before the very first item (so the ceiling there is 1 — nothing
   * precedes it to nest under) and 1 after the very last item (so a drop past everything can
   * always land back at the top level).
   */
  function liDepthRangeAtGap(entries: FlatLiEntry[], gap: number): [min: number, max: number] {
    const prevDepth = gap > 0 ? entries[gap - 1].depth : 0;
    const nextDepth = gap < entries.length ? entries[gap].depth : 1;
    return [nextDepth, prevDepth + 1];
  }

  /** Where a drop at `gap`/`depth` lands. `container` is the destination `<ul>`/`<ol>`, or null
   * when it doesn't exist yet and must be created (a new `wrapperTag` list, as the last child of
   * `newWrapperParent`) before inserting into it. */
  interface LiDropTarget {
    container: Element | null;
    beforeEl: Element | null;
    newWrapperParent: HTMLLIElement | null;
    wrapperTag: 'UL' | 'OL';
  }

  /**
   * Resolves the destination for a drop at `gap`/`depth`: climbs from the item just before the
   * gap to its ancestor at the target depth and inserts as that ancestor's next sibling (sibling
   * insert), or — when the target is exactly one level deeper than that item — targets its own
   * nested list (creating one if it doesn't exist yet, first child otherwise). `gap === 0` (no
   * item precedes it) always resolves to the very front of the root list itself.
   */
  function resolveLiDropTarget(rootList: HTMLElement, entries: FlatLiEntry[], gap: number, depth: number): LiDropTarget {
    if (gap === 0) {
      return { container: rootList, beforeEl: rootList.firstElementChild, newWrapperParent: null, wrapperTag: 'UL' };
    }
    const prev = entries[gap - 1];
    if (depth === prev.depth + 1) {
      const nested = Array.from(prev.li.children).find((c) => c.tagName === 'UL' || c.tagName === 'OL');
      if (nested) {
        return { container: nested, beforeEl: nested.firstElementChild, newWrapperParent: null, wrapperTag: 'UL' };
      }
      const wrapperTag: 'UL' | 'OL' = prev.li.parentElement?.tagName === 'OL' ? 'OL' : 'UL';
      return { container: null, beforeEl: null, newWrapperParent: prev.li, wrapperTag };
    }
    let ancestor: HTMLLIElement = prev.li;
    for (let steps = prev.depth - depth; steps > 0; steps--) {
      const parentLi = ancestor.parentElement?.closest('li') as HTMLLIElement | null;
      if (!parentLi) {
        // Depth invariant broken (malformed DOM) — signal "no valid target" rather than
        // resolving to a partially-climbed, wrong-depth ancestor.
        return { container: null, beforeEl: null, newWrapperParent: null, wrapperTag: 'UL' };
      }
      ancestor = parentLi;
    }
    return { container: ancestor.parentElement, beforeEl: ancestor.nextElementSibling, newWrapperParent: null, wrapperTag: 'UL' };
  }

  /** A resolved target is invalid when it isn't buildable (no container and no wrapper to create
   * one under) or when it resolves to inserting the dragged item right before ITSELF — i.e. its
   * own current position, still live in the DOM at resolve time. That self-reference is the
   * self-drop/no-op case (same spirit as `isValidSiblingGap`): landing on it would hand
   * `applyLiReparentMove` a `beforeEl` that gets detached by its own delete step, so it must
   * never reach the move — same UX as the existing self-drop guard (drop line hidden, drop
   * rejected, no DOM change). */
  function isLiDropTargetValid(li: HTMLLIElement, target: LiDropTarget): boolean {
    if (!target.container && !target.newWrapperParent) {
      return false;
    }
    return target.beforeEl !== li;
  }

  /** Visual left/width baseline for the drop line at a resolved target — the destination
   * container's own rect when it already exists, or the would-be parent's rect nudged in by one
   * indent step when the target nested list doesn't exist yet (about to be created on drop). */
  function liDropLineRect(target: LiDropTarget): { left: number; width: number } {
    if (target.container) {
      const r = (target.container as Element).getBoundingClientRect();
      return { left: r.left, width: r.width };
    }
    const r = target.newWrapperParent!.getBoundingClientRect();
    return { left: r.left + 24, width: Math.max(20, r.width - 24) };
  }

  /**
   * Picks the vertical gap by Y among every `<li>` in the dragged item's root list (not just its
   * original siblings, US-17.7 M6) and the target nesting depth from horizontal drag offset (X),
   * clamped to whatever depths are valid at that gap — then draws the drop line at the resolved
   * destination's own indent level, live feedback before release.
   */
  function updateLiDropLine(clientX: number, clientY: number): void {
    if (!liRootListEl || !liDragged) {
      return;
    }
    const dx = clientX - startX;
    const gap = liFlatGapAt(liFlatEntries, clientY);
    currentGap = gap;
    const [minDepth, maxDepth] = liDepthRangeAtGap(liFlatEntries, gap);
    const rawDepth = liOrigDepth + Math.round(dx / LIST_INDENT_THRESHOLD_PX);
    currentLiDepth = Math.max(minDepth, Math.min(maxDepth, rawDepth));

    const target = resolveLiDropTarget(liRootListEl, liFlatEntries, gap, currentLiDepth);
    currentGapValid = isLiDropTargetValid(liDragged, target);
    if (!currentGapValid) {
      dropLineEl.style.display = 'none';
      return;
    }
    const { left, width } = liDropLineRect(target);
    let y: number;
    if (liFlatEntries.length === 0) {
      y = liRootListEl.getBoundingClientRect().top;
    } else if (gap === 0) {
      y = liFlatEntries[0].li.getBoundingClientRect().top;
    } else if (gap === liFlatEntries.length) {
      y = liFlatEntries[liFlatEntries.length - 1].li.getBoundingClientRect().bottom;
    } else {
      y =
        (liFlatEntries[gap - 1].li.getBoundingClientRect().bottom +
          liFlatEntries[gap].li.getBoundingClientRect().top) /
        2;
    }
    dropLineEl.className = 'dd-drop-line';
    dropLineEl.style.display = 'block';
    dropLineEl.style.top = `${y}px`;
    dropLineEl.style.left = `${left}px`;
    dropLineEl.style.width = `${width}px`;
    dropLineEl.style.height = '2px';
  }

  function startDragging(): void {
    state = 'dragging';
    handleEl.style.display = 'none';
    closeMenu();
    liHandleEl.style.display = 'none';
    tableHandleEl.style.display = 'none';
    if (kind === 'block') {
      const rect = dragSpan[0].getBoundingClientRect();
      const clone = dragSpan[0].cloneNode(true) as HTMLElement;
      clone.classList.remove('dd-hover-outline');
      ghostEl.replaceChildren(clone);
      ghostEl.style.width = `${rect.width}px`;
      // Height is left auto: the ghost's own padding needs extra room beyond
      // the source's raw content height, or the bottom line renders clipped.
      if (dragSpan.length > 1) {
        const badge = document.createElement('div');
        badge.className = 'dd-ghost-badge';
        badge.textContent = String(dragSpan.length);
        ghostEl.appendChild(badge);
      }
      dragSpan.forEach((el) => el.classList.add('dd-source-muted'));
    } else if (liDragged) {
      const rect = liDragged.getBoundingClientRect();
      const clone = liDragged.cloneNode(true) as HTMLElement;
      clone.classList.remove('dd-hover-outline');
      ghostEl.replaceChildren(clone);
      ghostEl.style.width = `${rect.width}px`;
      liDragged.classList.add('dd-source-muted');
    }
    ghostEl.style.display = 'block';
    document.body.classList.add('dd-dragging');
  }

  function cleanupVisuals(): void {
    dragSpan.forEach((el) => el.classList.remove('dd-source-muted'));
    liDragged?.classList.remove('dd-source-muted');
    ghostEl.style.display = 'none';
    ghostEl.replaceChildren();
    dropLineEl.style.display = 'none';
    dropLineEl.className = 'dd-drop-line';
    document.body.classList.remove('dd-dragging');
    stopAutoScroll();
  }

  function resetState(): void {
    state = 'idle';
    kind = 'block';
    dragBlocks = [];
    dragSpan = [];
    currentGapValid = false;
    dragValidGaps = null;
    liDragged = null;
    liRootListEl = null;
    liFlatEntries = [];
    liOrigDepth = 1;
    currentLiDepth = 1;
    armedBlock = null;
    // Skip clearing the outline here when a handle menu is open for this exact block —
    // openMenu() (called just before resetState() in the click path) has already claimed
    // it via `menuTargetBlock`; closeMenu() clears it for real once the menu goes away.
    // Applies to hoveredTableBlock too (bug 0716 round 2, #1 follow-up) — a table's menu
    // is opened via the exact same armDrag/openMenu path, sharing menuTargetBlock.
    if (hoveredBlock !== menuTargetBlock) {
      setHighlightedBlock(null);
    }
    setHighlightedLi(null);
    if (hoveredTableBlock !== menuTargetBlock) {
      setHighlightedTableBlock(null);
    }
    detachDragListeners();
  }

  function finishBlockMove(): void {
    const movedEl = performMove(dragSpan, dragBlocks, currentGap);
    deps.dom.placeCaretIn(movedEl);
  }

  /**
   * Performs the resolved cross-level li move (US-17.7, M6): creates the destination nested list
   * first if `resolveLiDropTarget` says it doesn't exist yet (a new `<ul>`/`<ol>`, inserted via
   * Range like the move itself — not a raw `appendChild`), re-parents the dragged `<li>` (own
   * subtree intact) via `applyLiReparentMove`, then runs the existing list-DOM normalizer as a
   * safety net against any malformed shape before the caller schedules a sync.
   */
  function finishLiMove(): void {
    if (!liRootListEl || !liDragged) {
      return;
    }
    const target = resolveLiDropTarget(liRootListEl, liFlatEntries, currentGap, currentLiDepth);
    if (!isLiDropTargetValid(liDragged, target)) {
      return;
    }
    let container = target.container;
    if (!container && target.newWrapperParent) {
      const wrapper = document.createElement(target.wrapperTag.toLowerCase());
      const wrapperRange = document.createRange();
      wrapperRange.selectNodeContents(target.newWrapperParent);
      wrapperRange.collapse(false);
      wrapperRange.insertNode(wrapper);
      container = wrapper;
    }
    if (!container) {
      return;
    }
    const movedEl = applyLiReparentMove(liDragged, { container, beforeEl: target.beforeEl });
    // Clean up any malformed shape (e.g. Chromium DOM quirks) BEFORE placing the caret — a
    // normalization pass can relocate nodes, and doing it after selecting would risk silently
    // moving the caret away from where the user actually dropped.
    normalizeListDom(content);
    if (movedEl && content.contains(movedEl)) {
      deps.dom.placeCaretIn(movedEl);
    }
  }

  function onDocMouseMove(e: MouseEvent): void {
    if (state === 'armed') {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
        return;
      }
      startDragging();
    }
    if (state !== 'dragging') {
      return;
    }
    updateGhostPosition(e.clientX, e.clientY);
    if (kind === 'block') {
      updateBlockDropLine(e.clientY);
    } else {
      updateLiDropLine(e.clientX, e.clientY);
    }
    maintainAutoScroll(e.clientY);
  }

  function onDocMouseUp(): void {
    if (state === 'dragging') {
      const shouldMove = currentGapValid;
      const dragKind = kind;
      cleanupVisuals();
      if (shouldMove) {
        // Clear the highlight before the move rebuilds the DOM (outerHTML/cloneNode +
        // insertHTML, via sibling-move.ts) — otherwise resetState()'s own clear below
        // only touches the stale, now-detached original element, leaving the
        // newly-created node highlighted forever (bug 0715 #12). Applies to
        // hoveredTableBlock too (bug 0716 round 2, #1 follow-up) — a table drag also goes
        // through dragKind === 'block' (armDrag always sets kind='block'), and without
        // this, the stale reference to the now-detached original table crashes the NEXT
        // interaction: a later mousedown on the frozen tableHandleEl arms armDrag on a
        // detached node, computeSiblingMove can't find it in draggableBlocks() (index -1),
        // and applyBlockMove's range.setStartBefore(undefined) throws, leaving `state`
        // stuck at 'dragging' and breaking all further drag-and-drop until reload.
        setHighlightedBlock(null);
        setHighlightedLi(null);
        setHighlightedTableBlock(null);
        if (dragKind === 'block') {
          finishBlockMove();
        } else {
          finishLiMove();
        }
        deps.lineGutter.refreshFromDom();
        deps.scheduleSync();
      }
    } else {
      // Never crossed DRAG_THRESHOLD_PX — a click, not a drag. For the block handle
      // (armedBlock set), that click opens the same menu the removed kebab button used
      // to (bug 0716 #5). The li/row/col handles never set armedBlock, so they stay
      // drag-only (spec: no new li/row/col menu).
      cleanupVisuals();
      if (armedBlock) {
        // startX/startY still hold this click's handle-mousedown point (reset happens below in
        // resetState) — anchor the menu there so it opens at the cursor (bug General R3 #1).
        openMenu(armedBlock, startX, startY);
      }
    }
    resetState();
  }

  function onDocKeyDown(e: KeyboardEvent): void {
    // Cancel/Esc (F6): drop never touched the DOM before mouseup, so cancelling is pure visual cleanup.
    if (e.key === 'Escape') {
      cleanupVisuals();
      resetState();
    }
  }

  /** Bộ 3 listener document (mousemove/mouseup/keydown) dùng chung cho cả block-drag và li-drag — gắn khi arm, gỡ khi kết thúc. */
  function attachDragListeners(): void {
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    document.addEventListener('keydown', onDocKeyDown);
  }

  function detachDragListeners(): void {
    document.removeEventListener('mousemove', onDocMouseMove);
    document.removeEventListener('mouseup', onDocMouseUp);
    document.removeEventListener('keydown', onDocKeyDown);
  }

  function armDrag(block: HTMLElement, clientX: number, clientY: number): void {
    state = 'armed';
    kind = 'block';
    startX = clientX;
    startY = clientY;
    dragBlocks = draggableBlocks();
    const blockIdx = dragBlocks.indexOf(block);
    if (blockIdx < 0) {
      // Stale/detached target (DOM mutated without a refresh() while the handle was frozen over
      // it) — bail before computeHeadingSectionSpan/headingSiblingGaps scan from index 0 and hand
      // performMove a -1 span. Same idx<0 guard moveBlockToGap/openMenu/deleteSelectedBlock use;
      // the block/table handle mousedown lacked it (edge-case review). Reset the just-armed state.
      state = 'idle';
      return;
    }
    dragSpan = computeHeadingSectionSpan(block, dragBlocks);
    // A heading drag is confined to its same-level sibling boundaries under its own parent
    // (bug_General #2 follow-up); a non-heading drag stays unrestricted (`null`).
    if (headingLevel(block) !== null) {
      const sib = headingSiblingGaps(blockLevels(dragBlocks), blockIdx);
      dragValidGaps = [...sib.siblingStarts, sib.scopeEndGap];
    } else {
      dragValidGaps = null;
    }
    armedBlock = block;
    // Preview the whole span a drag will move (bug General #2) — dragSpan is exactly the section
    // for a heading, or [block] otherwise, so no recompute is needed here.
    dragSpan.forEach((el) => el.classList.add('dd-hover-outline'));
    attachDragListeners();
  }

  function armLiDrag(li: HTMLLIElement, clientX: number, clientY: number): void {
    const rootList = liRootList(li);
    if (!rootList) {
      return;
    }
    state = 'armed';
    kind = 'li';
    startX = clientX;
    startY = clientY;
    liDragged = li;
    liRootListEl = rootList;
    const entries: FlatLiEntry[] = [];
    flattenLiList(rootList, li, 1, entries);
    liFlatEntries = entries;
    liOrigDepth = liDepth(li);
    currentLiDepth = liOrigDepth;
    li.classList.add('dd-hover-outline');
    attachDragListeners();
  }

  handleEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hoveredBlock || isComposing) {
      return;
    }
    e.preventDefault();
    armDrag(hoveredBlock, e.clientX, e.clientY);
  });

  // Bug #3: hovering a handle GLYPH previews its drag target with the same
  // `.dd-hover-outline` an actual drag/menu uses, so the user sees exactly which
  // block will move before pressing. This is NOT a regression of bug 0716 #6 —
  // that removed the outline on plain CONTENT hover (it flickered while merely
  // reading a block); here the outline shows only while the cursor is on the
  // small handle itself. Skip while a drag is in flight (armDrag and the drag
  // path own the outline then) or while a menu is open (it keeps its own target
  // outlined until it closes — bug 0716 #6 click-to-menu path).
  handleEl.addEventListener('mouseenter', () => {
    // Guard isMenuOpen() like the matching mouseleave below: with a menu already open for another
    // block, a hover-preview add here would outline a SECOND section that closeMenu wouldn't clear
    // (bug General #2 follow-up).
    if (state !== 'idle' || isMenuOpen()) {
      return;
    }
    addBlockSpanOutline(hoveredBlock);
  });
  handleEl.addEventListener('mouseleave', () => {
    if (state !== 'idle' || isMenuOpen()) {
      return;
    }
    removeBlockSpanOutline(hoveredBlock);
  });

  // Bug #3: same hover preview for the li handle. Adding is a plain mouseenter;
  // removal is folded into the existing `mouseleave` below (which already runs
  // the leftward climb), so both effects share one exit handler.
  liHandleEl.addEventListener('mouseenter', () => {
    if (state !== 'idle') {
      return;
    }
    hoveredLi?.classList.add('dd-hover-outline');
  });

  liHandleEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hoveredLi || isComposing) {
      return;
    }
    e.preventDefault();
    armLiDrag(hoveredLi, e.clientX, e.clientY);
  });

  // Tall invisible hit zone for the li handle. The handle glyph is drawn only own-content tall
  // at the item's own marker row, but the item stays "hovered" across its whole subtree (the
  // hover/climb bands use the full `<li>` rect) — so after climbing to a parent from a CHILD
  // row, the drawn handle sits up at the parent's row and a mousedown down at the cursor would
  // otherwise arm nothing. Arm the drag on a mousedown anywhere in the hovered li's left gutter
  // band (its handle column, down through its full height), so grabbing the hovered item works
  // wherever its handle is currently promised, not only on the short drawn glyph.
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || isComposing || state !== 'idle' || !hoveredLi) {
      return;
    }
    // The handle's own mousedown already covers a hit on the drawn glyph; a detached hovered li
    // (DOM edited without refresh) is skipped to avoid arming on a stale node.
    if (liHandleEl.contains(e.target as Node) || !content.contains(hoveredLi)) {
      return;
    }
    const r = hoveredLi.getBoundingClientRect();
    const handleLeft = liHandleAnchorLeft(hoveredLi) - HANDLE_WIDTH_PX;
    if (e.clientX >= handleLeft && e.clientX < r.left && e.clientY >= r.top && e.clientY <= r.bottom) {
      e.preventDefault();
      armLiDrag(hoveredLi, e.clientX, e.clientY);
    }
  });

  // Moving the cursor left OFF the li handle: #content's own `mouseleave` already fired (with
  // relatedTarget = this handle → early-returned) when the cursor first moved onto the handle,
  // and won't fire again — so re-run the climb from here, or a depth-0 item's whole-list block
  // handle never surfaces when the user slides off the handle's left edge (user report).
  liHandleEl.addEventListener('mouseleave', (e) => {
    if (state !== 'idle') {
      return;
    }
    // Bug #3: leaving the glyph drops its hover preview outline. The climb below
    // only re-targets which handle shows (a bare gutter band is not a glyph, so it
    // re-adds no outline), and its `setHighlightedLi` wouldn't fire on the early
    // return-to-#content path — so clear it unconditionally here.
    hoveredLi?.classList.remove('dd-hover-outline');
    const related = e.relatedTarget as Node | null;
    // Back into #content, or onto another handle/menu — those handlers own the state from here.
    if (
      related &&
      (content.contains(related) ||
        handleEl.contains(related) ||
        menuPopupEl.contains(related) ||
        tableHandleEl.contains(related))
    ) {
      return;
    }
    climbLiFromExit(e.clientX, e.clientY);
  });

  // Reuses armDrag as-is (bug 0716 round 2, #1) — a table is an ordinary top-level block to
  // computeHeadingSectionSpan/performMove, so the same click-vs-drag/menu machinery applies
  // with no table-specific branch needed.
  tableHandleEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hoveredTableBlock || isComposing) {
      return;
    }
    e.preventDefault();
    armDrag(hoveredTableBlock, e.clientX, e.clientY);
  });

  // Bug #3: same hover preview for the whole-table handle. A table click opens a
  // menu too (armDrag sets armedBlock), so guard `mouseleave` with isMenuOpen()
  // exactly like the block handle.
  tableHandleEl.addEventListener('mouseenter', () => {
    if (state !== 'idle') {
      return;
    }
    hoveredTableBlock?.classList.add('dd-hover-outline');
  });
  tableHandleEl.addEventListener('mouseleave', () => {
    if (state !== 'idle' || isMenuOpen()) {
      return;
    }
    hoveredTableBlock?.classList.remove('dd-hover-outline');
  });

  function refresh(): void {
    if (state !== 'idle') {
      cleanupVisuals();
      resetState();
    }
    closeMenu();
    setHighlightedBlock(null);
    setHighlightedLi(null);
    setHighlightedTableBlock(null);
    positionHandle(null);
    positionLiHandle(null);
    positionTableHandle(null);
  }

  return { refresh };
}
