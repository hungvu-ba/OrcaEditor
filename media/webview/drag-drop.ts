/**
 * Drag & drop reorder for top-level blocks (US-17.3) and list items
 * (US-17.5, M3) — HLR section 17.
 *
 * Undo mechanism (F1, spike decision): a move never mutates the DOM directly
 * (appendChild/insertBefore/remove) — that would desync the browser's native
 * undo stack the same way raw DOM surgery does for
 * fixOrphanNestedListItems/replaceBlockTag (main.ts / dom-utils.ts). Instead,
 * exactly like those two, a move selects a single Range spanning every
 * top-level block between the old and new position (inclusive) and replaces
 * it with ONE `execCommand('insertHTML', ...)` call carrying the same blocks
 * in their new order. One Range + one execCommand call = one native undo
 * step, regardless of how far the block travels or how many blocks a
 * section-move carries along.
 *
 * DOM stays the source of truth (architecture note in the code plan): the
 * live #content DOM is read fresh on every drag start, nothing is cached
 * across renders. Block Map (US-18.1) is intentionally NOT used here — it is
 * only rebuilt on full renderDocument() and can be stale mid-session; a move
 * only needs "current top-level children with a real markdown source range",
 * which is exactly what readSrcRange() (already shared with block-map.ts and
 * gutter.ts) tells us, filtered straight off content.children.
 */
import { readSrcRange } from './block-info';
import { MERMAID_CLASS, MATH_BLOCK_CLASS } from './pipeline';
import { isValidSiblingGap, computeSiblingMove, applySiblingMove, applyBlockMove } from './sibling-move';
import type { LineGutter } from './gutter';
import type { DomHelpers } from './dom-utils';

export interface DragDropDeps {
  scheduleSync: () => void;
  dom: DomHelpers;
  lineGutter: LineGutter;
}

export interface DragDropController {
  /** Call after #content is fully rebuilt (renderDocument) — drops any stale hover/drag state that referenced old nodes. */
  refresh(): void;
}

type DragState = 'idle' | 'armed' | 'dragging';
type DragKind = 'block' | 'li';
/** M3: horizontal drag past this threshold re-indents the list item IN PLACE instead of reordering it — a drag gesture is either a vertical reorder OR a horizontal indent/outdent, not a combined diagonal move (see drag-drop.ts M3 header note in the requirement doc for the scope call). */
type IndentDir = 'in' | 'out' | null;

const HEADING_RE = /^H([1-6])$/;
const DRAG_THRESHOLD_PX = 4;
const LIST_INDENT_THRESHOLD_PX = 32;
/** Must match `.dd-handle`'s CSS `width` (editor.css) — `climbLiFrom` reserves this much
 * space left of a `<li>`'s own handle position as "still hovering this item" before climbing
 * to an ancestor, or past the outermost item to the whole-list block handle. */
const HANDLE_WIDTH_PX = 22;
/** Manual tuning knob: shifts the block handle this many px to the right of its default
 * anchor (flush against the block's own left edge). Adjust by hand to taste. */
const BLOCK_HANDLE_SHIFT_RIGHT_PX = 12;
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
const LI_HANDLE_SHIFT_RIGHT_PX = 24;
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

function headingLevel(el: Element): number | null {
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

/** Top-level children of `content` with a real markdown source range — excludes the trailing caret-trap <p> (same filter as block-map.ts). Exported for reuse (TOC-drag, US-17.7/M5). */
export function draggableTopLevelBlocks(content: HTMLElement): HTMLElement[] {
  return (Array.from(content.children) as HTMLElement[]).filter((el) => readSrcRange(el) !== null);
}

export function initDragDrop(content: HTMLElement, deps: DragDropDeps): DragDropController {
  function draggableBlocks(): HTMLElement[] {
    return draggableTopLevelBlocks(content);
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

  /** Hit column spans the block's own full height and sits flush (zero gap) against the
   * block's own left edge — `right` (not `left`) anchoring guarantees the flush fit
   * regardless of the icon's CSS width, and removes the dead zone a moving cursor used
   * to cross before reaching the old fixed tiny-icon offset (bug 0716 #4). */
  function positionHandle(block: HTMLElement | null): void {
    if (!block) {
      handleEl.style.display = 'none';
      return;
    }
    const blockRect = block.getBoundingClientRect();
    handleEl.style.display = 'flex';
    handleEl.style.top = `${blockRect.top}px`;
    handleEl.style.height = `${blockRect.height}px`;
    handleEl.style.right = `${window.innerWidth - blockRect.left - BLOCK_HANDLE_SHIFT_RIGHT_PX}px`;
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
      menuTargetBlock.classList.remove('dd-hover-outline');
      menuTargetBlock = null;
    }
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
    if (movedEl) {
      const r = document.createRange();
      r.selectNodeContents(movedEl);
      r.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      content.focus();
    }
    deps.lineGutter.refreshFromDom();
    deps.scheduleSync();
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

  function openMenu(block: HTMLElement): void {
    closeMenu();
    const blocks = draggableBlocks();
    const idx = blocks.indexOf(block);
    if (idx < 0) {
      return;
    }
    const span = computeHeadingSectionSpan(block, blocks);
    const spanEndIdx = idx + span.length - 1;

    addMenuItem('Move up', idx === 0, () => moveBlockToGap(block, idx - 1));
    addMenuItem('Move down', spanEndIdx >= blocks.length - 1, () => moveBlockToGap(block, spanEndIdx + 2));

    const headings = blocks.filter((b) => headingLevel(b) !== null && !span.includes(b));
    if (headings.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'dd-menu-sep';
      menuPopupEl.appendChild(sep);
      const label = document.createElement('div');
      label.className = 'dd-menu-label';
      label.textContent = 'Move to…';
      menuPopupEl.appendChild(label);
      for (const h of headings) {
        const gapIdx = blocks.indexOf(h) + 1; // just after this heading's own line
        const text = (h.textContent ?? '').trim() || '(untitled)';
        addMenuItem(text, false, () => moveBlockToGap(block, gapIdx));
      }
    }

    // Anchor to the icon's own vertical center, not the hit column's bottom edge — the
    // hit column now spans the whole block's height (bug 0716 #4), so for a tall block
    // `rect.bottom` would place the menu far below where the (vertically centered) icon
    // and the user's click actually were. A table's own menu is opened via tableHandleEl
    // (armDrag(hoveredTableBlock, ...) always originates there, never handleEl, which stays
    // hidden the whole time), so anchor to whichever handle actually triggered this menu —
    // otherwise the popup renders at handleEl's stale zero-rect position (bug 0716 round 2,
    // #1 follow-up: confirmed live, popup appeared at the viewport's top-left corner).
    const anchorEl = block.tagName === 'TABLE' ? tableHandleEl : handleEl;
    const rect = anchorEl.getBoundingClientRect();
    menuPopupEl.style.display = 'block';
    menuPopupEl.style.top = `${rect.top + rect.height / 2}px`;
    menuPopupEl.style.left = `${rect.right + 4}px`;

    menuTargetBlock = block;
    block.classList.add('dd-hover-outline');
  }

  document.addEventListener('mousedown', (e) => {
    if (isMenuOpen() && !menuPopupEl.contains(e.target as Node)) {
      closeMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isMenuOpen()) {
      closeMenu();
    }
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
    hoveredBlock?.classList.remove('dd-hover-outline');
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
  /** Block armed via `armDrag` (mousedown on the block handle) — read back in `onDocMouseUp`'s
   * non-dragging branch to open the handle menu when the click never crossed the drag
   * threshold (bug 0716 #5: merges the removed kebab button into the handle click). */
  let armedBlock: HTMLElement | null = null;
  /** Block whose `.dd-hover-outline` is being kept alive by an open handle menu — set by
   * `openMenu`, cleared by `closeMenu`. Lets `resetState()` (which runs synchronously right
   * after `openMenu` in the click path) skip clearing this specific block's outline, so the
   * menu doesn't visually open against a block with no highlight. */
  let menuTargetBlock: HTMLElement | null = null;

  // M3 list-item drag state — reuses the same ghost/drop-line/threshold/Esc
  // machinery above, just a different target shape (one <li> among its own
  // parent list's direct children, not a run of #content's top-level children).
  let liDragged: HTMLLIElement | null = null;
  let liParent: HTMLElement | null = null;
  let liSiblings: HTMLLIElement[] = [];
  let liIdx = -1;
  let liIndentDir: IndentDir = null;

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
    const gap = gapAt(dragBlocks, clientY);
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

  /** gap index among `liSiblings` (mirrors gapAt, kept separate since the element list is per-drag, not a closure over `content`). */
  function liGapAt(clientY: number): number {
    for (let i = 0; i < liSiblings.length; i++) {
      const r = liSiblings[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        return i;
      }
    }
    return liSiblings.length;
  }

  /**
   * M3: horizontal drag past LIST_INDENT_THRESHOLD_PX switches to re-indent
   * mode — draws a short indent guide near the hovered item instead of a
   * full-width line, and drop() will call execCommand('indent'/'outdent')
   * (see performListIndent) instead of a sibling reorder. Reuses the native
   * indent/outdent mechanism already proven for Tab/Shift+Tab in main.ts
   * (including its DOM-quirk cleanup at serialize time, normalizeListDom) —
   * safer than hand-rolling custom nesting DOM surgery.
   */
  function updateLiDropLine(clientX: number, clientY: number): void {
    if (!liParent || !liDragged) {
      return;
    }
    const dx = clientX - startX;
    const gap = liGapAt(clientY);
    currentGap = gap;
    if (Math.abs(dx) > LIST_INDENT_THRESHOLD_PX) {
      liIndentDir = dx > 0 ? 'in' : 'out';
      currentGapValid =
        liIndentDir === 'in' ? liIdx > 0 : !!liParent.parentElement?.closest('li') && content.contains(liParent);
      if (!currentGapValid) {
        dropLineEl.style.display = 'none';
        return;
      }
      const anchor = liSiblings[Math.min(Math.max(gap, 0), liSiblings.length - 1)] ?? liDragged;
      const r = anchor.getBoundingClientRect();
      dropLineEl.className = 'dd-drop-line dd-indent-guide';
      dropLineEl.style.display = 'block';
      dropLineEl.style.top = `${r.top}px`;
      dropLineEl.style.left = `${r.left + (liIndentDir === 'in' ? 24 : -24)}px`;
      dropLineEl.style.width = '20px';
      dropLineEl.style.height = '2px';
      return;
    }
    liIndentDir = null;
    currentGapValid = isValidSiblingGap(gap, liIdx, liIdx);
    if (!currentGapValid || liSiblings.length === 0) {
      dropLineEl.style.display = 'none';
      return;
    }
    const parentRect = liParent.getBoundingClientRect();
    let y: number;
    if (gap === 0) {
      y = liSiblings[0].getBoundingClientRect().top;
    } else if (gap === liSiblings.length) {
      y = liSiblings[liSiblings.length - 1].getBoundingClientRect().bottom;
    } else {
      y = (liSiblings[gap - 1].getBoundingClientRect().bottom + liSiblings[gap].getBoundingClientRect().top) / 2;
    }
    dropLineEl.className = 'dd-drop-line';
    dropLineEl.style.display = 'block';
    dropLineEl.style.top = `${y}px`;
    dropLineEl.style.left = `${parentRect.left}px`;
    dropLineEl.style.width = `${parentRect.width}px`;
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
    liDragged = null;
    liParent = null;
    liSiblings = [];
    liIdx = -1;
    liIndentDir = null;
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
    document.removeEventListener('mousemove', onDocMouseMove);
    document.removeEventListener('mouseup', onDocMouseUp);
    document.removeEventListener('keydown', onDocKeyDown);
  }

  function finishBlockMove(): void {
    const movedEl = performMove(dragSpan, dragBlocks, currentGap);
    if (movedEl) {
      const r = document.createRange();
      r.selectNodeContents(movedEl);
      r.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      content.focus();
    }
  }

  /** Places the caret inside `li` then calls the native indent/outdent command — same mechanism as Tab/Shift+Tab in main.ts, including its existing Chromium DOM-quirk cleanup at serialize time. */
  function performListIndent(li: HTMLLIElement, dir: 'indent' | 'outdent'): void {
    const range = document.createRange();
    range.selectNodeContents(li);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    content.focus();
    document.execCommand(dir);
  }

  function finishLiMove(): void {
    if (!liParent || !liDragged) {
      return;
    }
    if (liIndentDir) {
      performListIndent(liDragged, liIndentDir === 'in' ? 'indent' : 'outdent');
      return;
    }
    const result = computeSiblingMove(liSiblings, liIdx, liIdx, currentGap);
    const movedEl = applySiblingMove(liParent, result);
    if (movedEl) {
      const r = document.createRange();
      r.selectNodeContents(movedEl);
      r.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      content.focus();
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
        openMenu(armedBlock);
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

  function armDrag(block: HTMLElement, clientX: number, clientY: number): void {
    state = 'armed';
    kind = 'block';
    startX = clientX;
    startY = clientY;
    dragBlocks = draggableBlocks();
    dragSpan = computeHeadingSectionSpan(block, dragBlocks);
    armedBlock = block;
    block.classList.add('dd-hover-outline');
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    document.addEventListener('keydown', onDocKeyDown);
  }

  function armLiDrag(li: HTMLLIElement, clientX: number, clientY: number): void {
    const parent = li.parentElement;
    if (!parent) {
      return;
    }
    state = 'armed';
    kind = 'li';
    startX = clientX;
    startY = clientY;
    liDragged = li;
    liParent = parent;
    liSiblings = Array.from(parent.children).filter((c) => c.tagName === 'LI') as HTMLLIElement[];
    liIdx = liSiblings.indexOf(li);
    li.classList.add('dd-hover-outline');
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    document.addEventListener('keydown', onDocKeyDown);
  }

  handleEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hoveredBlock || isComposing) {
      return;
    }
    e.preventDefault();
    armDrag(hoveredBlock, e.clientX, e.clientY);
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
