/**
 * Shared compute-then-commit-via-insertHTML primitive (HLR 22, execCommand
 * List/Block Verb Replacement, Phase 1). `computeIndent`/`computeOutdent`/
 * `computeToList` are PURE tree-transform functions — Element(s) in, a
 * replacement-plan object out, zero live-DOM mutation/execCommand/Selection-API
 * access — so they can be exercised with a domino-built DOM in roundtrip tests.
 * `commitListOp`/`commitListOpDirect` are the only functions that touch the
 * live DOM. `commitListOp` (toList: single-root replacement html) uses
 * one `execCommand('insertHTML')` call — one native undo step. `commitListOpDirect`
 * (outdent: multi-root; indent: single-root that collapses two sibling `<li>`s
 * into one) uses `Range.deleteContents()` + `Range.insertNode()` instead —
 * `execCommand('insertHTML')` is confirmed to corrupt those shapes (see
 * commitListOpDirect's own doc comment) — no native undo step, same accepted
 * trade-off as sibling-move.ts's `applyBlockMove`.
 * Both restore the caret via a stable ancestor + getOffsetWithin/
 * placeCaretAtOffsets, mirroring dom-utils.ts's `replaceBlockTag`. Phase 2
 * wires each of the 14 call sites to this primitive one at a time — outdent
 * (main.ts's Shift+Tab handler) as of Phase 2.1 and indent (Tab handler) as of
 * Phase 2.2, both via commitListOpDirect; the rest are not.
 */
import { getOffsetWithin } from './dom-utils';

/**
 * Direct-child lookup by tag name (never a descendant) — used instead of
 * `:scope > selector` because domino (the DOM engine test/roundtrip/list-ops.ts
 * runs against) has broken/partial `:scope` support outside the querying
 * root, returning `undefined` instead of `null`/a match; plain `children`
 * iteration works identically there and in real Chromium.
 */
function directChildByTag(parent: Element, tags: string[]): Element | null {
  return Array.from(parent.children).find((c) => tags.includes(c.tagName)) ?? null;
}

// Any target holding a nested `<ul>`/`<ol>` → flattening/re-nesting is out of
// scope for retag/unwrap/taskify (legacy execCommand handles that case); those
// compute functions bail to null. Shared opening guard for all three.
function hasNestedSublist(targets: Element[]): boolean {
  return targets.some((t) => directChildByTag(t, ['UL', 'OL']) !== null);
}

/**
 * Temporary marker attribute a compute function sets on ONE clone in its
 * `html` — the clone corresponding to `ListOpPlan.caretAnchor` (the original
 * live-DOM element the caret is expected to still be inside). commit strips
 * it again right after using it. See `ListOpPlan.caretAnchor`'s own doc for
 * why this exists.
 */
const CARET_ANCHOR_ATTR = 'data-list-op-caret-anchor';

export interface ListOpPlan {
  /** Ancestor that survives the mutation untouched — used to save/restore caret via
   *  getOffsetWithin/placeCaretAtOffsets. Must NOT be inside [rangeStart, rangeEnd]. */
  stableRoot: Element;
  rangeStart: Element; // Range.setStartBefore(rangeStart)
  rangeEnd: Element; // Range.setEndAfter(rangeEnd) -- may equal rangeStart
  html: string; // replacement HTML for [rangeStart, rangeEnd]
  /**
   * Original live-DOM element the caret is expected to still be inside, if
   * collapsed/ranged there — its corresponding clone in `html` must carry
   * `CARET_ANCHOR_ATTR`. Restoring the caret relative to this single element
   * (a LOCAL character offset) instead of `stableRoot` (a document-wide one)
   * sidesteps a real bug: `stableRoot`-wide counting treats an EMPTY sibling
   * `<li>` (e.g. one freshly created by Enter, before the user types into it)
   * as contributing zero characters, making "end of the previous item" and
   * "start of that empty item" the exact same offset — `locateOffset`
   * (dom-utils.ts) then always resolves to the former, so a Tab pressed
   * immediately after Enter silently indents into the WRONG item (caret jumps
   * back to the parent). Optional: omit when no single element is known to
   * contain the caret (falls back to the coarser `stableRoot`-wide restore).
   */
  caretAnchor?: Element;
}

interface SavedCaret {
  useAnchor: boolean; // true: start/end are LOCAL to plan.caretAnchor; false: stableRoot-wide
  start: number;
  end: number;
}

/**
 * Chrome sometimes normalizes a Range edge to the PARENT of the actual `<li>`
 * (container = `<ul>`/`<ol>`, offset = the `<li>`'s child index) instead of a
 * position inside the `<li>` itself — especially right after something else
 * just mutated the DOM (already documented/worked around in toolbar.ts's
 * `getListSelection`). `Element.contains()`/`getOffsetWithin` don't see
 * through this: `anchor.contains(anchor.parentElement)` is false, so the
 * caretAnchor path would silently miss every such case without this
 * normalization. Returns the equivalent (node, offset) INSIDE `anchor` itself
 * (0 if the edge sits right before it, `anchor.childNodes.length` if right
 * after), or null if `container`/`offset` don't actually border `anchor`.
 */
function normalizeToAnchor(anchor: Element, container: Node, offset: number): { node: Node; offset: number } | null {
  if (anchor.contains(container)) {
    return { node: container, offset };
  }
  if (container !== anchor.parentElement) {
    return null;
  }
  if (container.childNodes[offset] === anchor) {
    return { node: anchor, offset: 0 };
  }
  if (container.childNodes[offset - 1] === anchor) {
    return { node: anchor, offset: anchor.childNodes.length };
  }
  return null;
}

/** Shared by commitListOp/commitListOpDirect — prefers `plan.caretAnchor` (see its
 *  own doc) over the coarser `stableRoot`-wide offset whenever the live selection
 *  actually resolves against it. */
function saveCaretState(plan: ListOpPlan): SavedCaret | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return null;
  }
  const r = sel.getRangeAt(0);
  if (plan.caretAnchor) {
    const anchor = plan.caretAnchor;
    const startPos = normalizeToAnchor(anchor, r.startContainer, r.startOffset);
    if (startPos) {
      const start = getOffsetWithin(anchor, startPos.node, startPos.offset);
      if (start !== null) {
        let end: number | null = start;
        if (!sel.isCollapsed) {
          const endPos = normalizeToAnchor(anchor, r.endContainer, r.endOffset);
          end = endPos ? getOffsetWithin(anchor, endPos.node, endPos.offset) : null;
        }
        if (end !== null) {
          return { useAnchor: true, start, end };
        }
      }
    }
  }
  const start = getOffsetWithin(plan.stableRoot, r.startContainer, r.startOffset);
  if (start === null) {
    return null;
  }
  const end = sel.isCollapsed ? start : getOffsetWithin(plan.stableRoot, r.endContainer, r.endOffset);
  if (end === null) {
    return null;
  }
  return { useAnchor: false, start, end };
}

function restoreCaretState(
  plan: ListOpPlan,
  saved: SavedCaret | null,
  placeCaretAtOffsets: (el: Element, start: number, end: number) => void
): void {
  if (!saved) {
    return;
  }
  if (saved.useAnchor) {
    const target = plan.stableRoot.querySelector(`[${CARET_ANCHOR_ATTR}]`);
    if (target) {
      target.removeAttribute(CARET_ANCHOR_ATTR);
      placeCaretAtOffsets(target, saved.start, saved.end);
    }
    // Marked clone not found (shouldn't happen) -- `saved.start/end` are LOCAL
    // to caretAnchor, not stableRoot-wide, so there's no safe fallback offset
    // to apply against stableRoot here; leave the caret wherever the browser
    // put it rather than risk a wrong position from mismatched units.
    return;
  }
  placeCaretAtOffsets(plan.stableRoot, saved.start, saved.end);
}

/**
 * Indent `li` under its previous sibling: appended to the previous sibling's
 * existing sublist if it has one, else a new sublist (same list type as the
 * shared parent) is created — always `li > ul`/`li > ol`, never `ul > ul`.
 * Returns null if `li` has no previous sibling (nothing to indent under), or
 * if that previous sibling is not itself an `<li>` (e.g. a malformed bare
 * `<ul>`/`<ol>` sibling left behind by an unmigrated call site) — nesting
 * under a non-`<li>` would reproduce the very `ul > ul` malformation this
 * primitive exists to eliminate, so bail out to the legacy execCommand path
 * instead of silently building on top of already-malformed DOM.
 */
export function computeIndent(li: Element): ListOpPlan | null {
  const list = li.parentElement;
  const prev = li.previousElementSibling;
  if (!list || !prev || prev.tagName !== 'LI') {
    return null;
  }

  const prevClone = prev.cloneNode(true) as Element;
  const liClone = li.cloneNode(true) as Element;
  liClone.setAttribute(CARET_ANCHOR_ATTR, '');
  let sublist = directChildByTag(prevClone, ['UL', 'OL']);
  if (!sublist) {
    sublist = prevClone.ownerDocument!.createElement(list.tagName.toLowerCase());
    prevClone.appendChild(sublist);
  }
  sublist.appendChild(liClone);

  return {
    stableRoot: list,
    rangeStart: prev,
    rangeEnd: li,
    html: prevClone.outerHTML,
    caretAnchor: li,
  };
}

/**
 * Outdent `li` out of its sublist into its parent `<li>`'s own list: later
 * siblings in `li`'s sublist re-nest as `li`'s own children (its own sublist),
 * and an emptied sublist is removed entirely — no orphan empty `<ul>`. Returns
 * null if `li`'s sublist is already top-level (its parent is not a `<li>`).
 */
export function computeOutdent(li: Element): ListOpPlan | null {
  const sublist = li.parentElement;
  const parentLi = sublist?.parentElement;
  const grandList = parentLi?.parentElement;
  if (!sublist || !parentLi || parentLi.tagName !== 'LI' || !grandList) {
    return null;
  }

  const parentLiClone = parentLi.cloneNode(true) as Element;
  const sublistClone = directChildByTag(parentLiClone, ['UL', 'OL']) as Element;
  const childrenClone = Array.from(sublistClone.children);
  const index = Array.from(sublist.children).indexOf(li);
  const outdentedLiClone = childrenClone[index];
  outdentedLiClone.setAttribute(CARET_ANCHOR_ATTR, '');
  const laterSiblings = childrenClone.slice(index + 1);

  outdentedLiClone.remove();
  if (laterSiblings.length) {
    // The outdented item may already have its own nested sublist (cloned along
    // with it) -- merge later siblings into that existing sublist rather than
    // appending a second sibling <ul>/<ol>, which would reproduce the same
    // "ul>ul-like" malformation this primitive exists to eliminate.
    const existingSublist = directChildByTag(outdentedLiClone, ['UL', 'OL']);
    const targetSublist = existingSublist ?? sublist.ownerDocument!.createElement(sublist.tagName.toLowerCase());
    laterSiblings.forEach((sibling) => targetSublist.appendChild(sibling));
    if (!existingSublist) {
      outdentedLiClone.appendChild(targetSublist);
    }
  }
  if (sublistClone.children.length === 0) {
    sublistClone.remove();
  }

  return {
    stableRoot: grandList,
    rangeStart: parentLi,
    rangeEnd: parentLi,
    html: parentLiClone.outerHTML + outdentedLiClone.outerHTML,
    caretAnchor: li,
  };
}

/**
 * Build a tight `<ul>`/`<ol>` from `blocks` (top-level block elements) — each
 * block's own `innerHTML` placed directly in a `<li>`, no wrapping `<p>`,
 * mirroring toolbar.ts's `toggleTaskItem` pattern (~line 1390-1410). A block
 * that is itself already a `<ul>`/`<ol>` contributes its `<li>`s directly
 * (flattened), matching the same edge case that function already handles.
 *
 * Blank blocks (a `<p>`/`<li>` with no text, e.g. `<p><br></p>` between two
 * selected paragraphs) are dropped entirely rather than becoming their own
 * empty `<li>` — a blank line in a text selection is spacing, not content the
 * user meant to turn into a bullet (bug 0717 round2's empty-`<li>` corruption
 * is also less exposed this way). If every block in the selection is blank,
 * one empty `<li>` is kept so there's still something to convert into.
 */
export function computeToList(blocks: Element[], ordered: boolean): ListOpPlan {
  const tag = ordered ? 'ol' : 'ul';
  const itemsHtml = blocks.map(blockToListItemsHtml).join('');

  return {
    stableRoot: blocks[0].parentElement as Element,
    rangeStart: blocks[0],
    rangeEnd: blocks[blocks.length - 1],
    html: `<${tag}>${itemsHtml || '<li><br></li>'}</${tag}>`,
  };
}

/**
 * Tags a single top-level block can contribute as list item(s): a `<p>` or
 * heading becomes one `<li>` from its inline `innerHTML` (blank -> nothing);
 * a `<ul>`/`<ol>` contributes its own non-blank `<li>`s flattened. Any other
 * tag is NOT a convertible block (see `isConvertibleBlock`) and must never be
 * passed here. Shared by `computeToList` and `computeToListAroundAtoms` so both
 * agree on exactly what a convertible block turns into.
 */
const CONVERTIBLE_ITEM_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL']);

function isConvertibleBlock(el: Element): boolean {
  return CONVERTIBLE_ITEM_TAGS.has(el.tagName);
}

/**
 * A block/item counts as "empty" for list conversion only when it has neither
 * text NOR embedded media -- a blank `<p>`/`<li>` (or `<p><br></p>`) is empty
 * and gets dropped, but an image-only `<p>`/`<li>` (empty `textContent`, real
 * content -- the render of a lone `![](img)`) is NOT, and must survive the
 * conversion. Mirrors `removeStrayEmptyParagraphNear`'s media guard in
 * toolbar.ts; without it, converting a selection that includes an image-only
 * line silently deletes the image.
 */
const LIST_ITEM_MEDIA_SELECTOR = 'img,input,video,audio,iframe,picture,svg';

function isEmptyForList(el: Element): boolean {
  return (el.textContent ?? '').trim() === '' && !el.querySelector(LIST_ITEM_MEDIA_SELECTOR);
}

function blockToListItemsHtml(el: Element): string {
  if (el.tagName === 'UL' || el.tagName === 'OL') {
    return Array.from(el.children)
      .filter((c) => c.tagName === 'LI' && !isEmptyForList(c))
      .map((li) => `<li>${li.innerHTML}</li>`)
      .join('');
  }
  return !isEmptyForList(el) ? `<li>${el.innerHTML}</li>` : '';
}

/**
 * Atom-aware sibling of `computeToList`: convert a run of top-level blocks to a
 * list, but SPLIT the list around any block that can't be a list item (an
 * "atom": `<table>`/`<pre>`/`<hr>`/`<blockquote>`/math/mermaid/front-matter/
 * unknown tag) — each atom is emitted back verbatim between two separate lists
 * instead of being swallowed. Convertible blocks (`<p>`, `<h1>`-`<h6>`,
 * `<ul>`/`<ol>`) become `<li>`s via `blockToListItemsHtml`.
 *
 * Exists so `toggleTaskItem` can accept an uncharacterized selection (a table/
 * heading/... in the range) WITHOUT the corruption-prone native
 * `execCommand('insertUnorderedList')` (bug 0717r3 #11: native merged unrelated
 * lists / demoted headings). The plan's `html` may have MULTIPLE roots, so
 * callers MUST commit it with `commitListOpDirect` (not `commitListOp`, whose
 * `insertHTML`/`ReplaceSelectionCommand` mangles multi-root/table shapes).
 * Returns null when the run has NO convertible block (nothing to turn into a
 * list, e.g. a selection resolving to only a table) — caller should no-op.
 */
export function computeToListAroundAtoms(blocks: Element[], ordered: boolean): ListOpPlan | null {
  const tag = ordered ? 'ol' : 'ul';
  const parts: string[] = [];
  let openItems = '';
  let hasConvertible = false;

  const flushList = () => {
    if (openItems) {
      parts.push(`<${tag}>${openItems}</${tag}>`);
      openItems = '';
    }
  };

  for (const el of blocks) {
    if (!isConvertibleBlock(el)) {
      // Atom (table/pre/hr/blockquote/math/mermaid/front-matter/unknown tag):
      // break the current list and keep the block verbatim so the list splits
      // AROUND it -- never dropped (an <hr> stays an <hr>, a rendered math/
      // mermaid block with empty textContent is not mistaken for blank).
      flushList();
      parts.push(el.outerHTML);
      continue;
    }
    const items = blockToListItemsHtml(el);
    if (items) {
      hasConvertible = true;
      openItems += items;
    }
    // convertible but blank -> dropped (contributes nothing)
  }
  flushList();

  if (!hasConvertible) {
    return null;
  }

  return {
    stableRoot: blocks[0].parentElement as Element,
    rangeStart: blocks[0],
    rangeEnd: blocks[blocks.length - 1],
    html: parts.join(''),
  };
}

/**
 * Split `list.children` around `targets` (a contiguous run of direct-child
 * `<li>`s) into before/middle/after HTML: untouched items before/after the
 * run stay wrapped in a list of `list`'s own tag, `middleHtml` (built by the
 * caller) replaces the targeted run itself. Returns null if any `targets`
 * element isn't found among `list.children` (nothing to split).
 */
function buildListSplitHtml(list: Element, targets: Element[], middleHtml: string): string | null {
  const all = Array.from(list.children);
  const start = all.indexOf(targets[0]);
  const end = all.indexOf(targets[targets.length - 1]);
  // `targets` must be an exact contiguous slice of `all[start..end]` -- if a
  // caller ever passed a non-contiguous or out-of-order set, silently using
  // `targets` for the middle segment (instead of `all.slice(start, end + 1)`)
  // would drop whatever's skipped over entirely. Both callers only ever build
  // contiguous ranges today, but this guard makes that a checked invariant
  // instead of an unenforced doc comment.
  if (start === -1 || end === -1 || end - start + 1 !== targets.length) {
    return null;
  }
  const tag = list.tagName.toLowerCase();
  const wrap = (items: Element[]) => {
    if (!items.length) {
      return '';
    }
    // Carry `contains-task-list` over to the split-off before/after list when
    // any of its untouched items still has a checkbox -- markdown.css's
    // ul.contains-task-list/ol.contains-task-list rules (hide the bullet/number
    // marker, position the checkbox) key off this class on the LIST, not the
    // <li>, so a freshly-built wrapper without it would show a doubled
    // marker+checkbox for those items. `task-list-item` lives directly on the
    // <li> (dom-utils.ts's addCheckbox), so no `:scope` child query needed.
    const cls = items.some((li) => li.classList.contains('task-list-item')) ? ' class="contains-task-list"' : '';
    return `<${tag}${cls}>${items.map((li) => li.outerHTML).join('')}</${tag}>`;
  };
  return wrap(all.slice(0, start)) + middleHtml + wrap(all.slice(end + 1));
}

/**
 * Convert a targeted sub-range of `list`'s `<li>`s to their own `<ul>`/`<ol>`
 * of `ordered`'s type ("retag"), splitting the untouched before/after items
 * into their own list of `list`'s ORIGINAL type -- e.g. caret in one item of
 * a 3-item `<ol>`, convert to bullet: before/after items stay `<ol>`, only
 * the targeted item becomes its own lone `<ul>`. Returns null if any target
 * has a nested `<ul>`/`<ol>` child (flattening/re-nesting is out of scope —
 * legacy `execCommand` handles that case unchanged) or if `targets` isn't
 * found among `list.children`.
 */
export function computeRetagListRange(list: Element, targets: Element[], ordered: boolean): ListOpPlan | null {
  if (hasNestedSublist(targets)) {
    return null;
  }
  const tag = ordered ? 'ol' : 'ul';
  const middleHtml = `<${tag}>${targets.map((t) => t.outerHTML).join('')}</${tag}>`;
  const html = buildListSplitHtml(list, targets, middleHtml);
  if (html === null) {
    return null;
  }
  return { stableRoot: list.parentElement as Element, rangeStart: list, rangeEnd: list, html };
}

/**
 * The `<p>`(s) an unwrapped `<li>` becomes. A LOOSE item already wraps its
 * content in block `<p>`(s) (blank-line-separated list items; markdown-it
 * renders `<li><p>…</p></li>`) -- reuse those `<p>`s verbatim instead of nesting
 * them inside a fresh `<p>` (`<p><p>…</p></p>` parses to a stray empty paragraph
 * that then serializes to a spurious blank line, bug ExcelCmd #5 review). A
 * TIGHT item's inline content is wrapped in one fresh `<p>`; an empty item keeps
 * a `<br>` so the paragraph survives.
 */
function paragraphHtmlForUnwrappedItem(li: Element): string {
  const children = Array.from(li.children);
  if (children.length > 0 && children.every((c) => c.tagName === 'P')) {
    return children.map((p) => p.outerHTML).join('');
  }
  return `<p>${li.innerHTML.trim() ? li.innerHTML : '<br>'}</p>`;
}

/**
 * Unwrap a targeted sub-range of `list`'s `<li>`s to plain `<p>`s, splitting
 * the untouched before/after items into their own list of `list`'s original
 * type -- e.g. caret in one item of a 3-item `<ul>`, toggle bullet off:
 * before/after items stay `<ul>`, only the targeted item becomes a `<p>`.
 * Same nested-sublist/not-found null contract as `computeRetagListRange`.
 */
export function computeUnwrapListRange(list: Element, targets: Element[]): ListOpPlan | null {
  if (hasNestedSublist(targets)) {
    return null;
  }
  const middleHtml = targets.map((t) => paragraphHtmlForUnwrappedItem(t)).join('');
  const html = buildListSplitHtml(list, targets, middleHtml);
  if (html === null) {
    return null;
  }
  return { stableRoot: list.parentElement as Element, rangeStart: list, rangeEnd: list, html };
}

/**
 * Convert a targeted sub-range of `list`'s `<li>`s into task items in their own
 * `<ul class="contains-task-list">`, splitting the untouched before/after items
 * into their own list of `list`'s ORIGINAL type -- the task-list sibling of
 * `computeRetagListRange`. Used for the OL→task case: a numbered item can't hold
 * a checkbox cleanly (turndown would emit "2. [ ] foo") and `contains-task-list`
 * on the whole `<ol>` shifts the untouched numbered siblings left (markdown.css),
 * so the target is peeled out into its own task `<ul>` while the siblings stay a
 * clean `<ol>`. Same nested-sublist/not-found null contract as
 * `computeRetagListRange`. The checkbox markup mirrors dom-utils.ts's
 * `addCheckbox`; nodes are built via `ownerDocument` (not a global `document`)
 * so this stays pure and domino-safe for roundtrip tests.
 */
export function computeTaskifyListRange(list: Element, targets: Element[]): ListOpPlan | null {
  if (hasNestedSublist(targets)) {
    return null;
  }
  const taskLi = (t: Element): string => {
    const clone = t.cloneNode(true) as Element;
    clone.classList.add('task-list-item');
    const input = t.ownerDocument.createElement('input');
    input.setAttribute('type', 'checkbox');
    input.setAttribute('class', 'task-list-item-checkbox');
    // Tight item (<li>Bravo</li>) → checkbox as a direct <li> child; loose item
    // (<li><p>Bravo</p></li>, produced by blank-line-separated source) → checkbox
    // INSIDE the <p> (<li><p><input>Bravo</p></li>). Only the latter shape is the
    // one findTaskCheckbox (dom-utils.ts) and turndown's taskCheckbox rule accept
    // as a task item; a checkbox placed as a direct <li> child before the <p>
    // serializes to a stray "[ ] " marker line + a detached "Bravo" paragraph
    // (checkbox lost, "[ ]" shown as literal text on reload). `addCheckbox` uses
    // the tight placement unconditionally, so we do NOT mirror it for loose here.
    const firstEl = clone.firstElementChild;
    const host = firstEl && firstEl.tagName === 'P' ? firstEl : clone;
    host.insertBefore(input, host.firstChild);
    return clone.outerHTML;
  };
  const middleHtml = `<ul class="contains-task-list">${targets.map(taskLi).join('')}</ul>`;
  const html = buildListSplitHtml(list, targets, middleHtml);
  if (html === null) {
    return null;
  }
  return { stableRoot: list.parentElement as Element, rangeStart: list, rangeEnd: list, html };
}

/**
 * The only function in this module touching the live DOM/Selection API:
 * selects [rangeStart, rangeEnd], replaces it in one `execCommand('insertHTML')`
 * call (one native undo step), then restores the caret — precisely, relative
 * to `plan.caretAnchor` when the plan provides one and the live selection
 * resolves against it, else at the same character offset within `stableRoot`
 * (same approach as dom-utils.ts's `replaceBlockTag`; see `caretAnchor`'s own
 * doc for why the precise path exists). `placeCaretAtOffsets` is injected
 * (rather than imported from createDomHelpers) so this module stays free of
 * the #content/focus() coupling that closure carries.
 */
// Shared caret-save → build [rangeStart, rangeEnd] Range → commit → caret-restore
// skeleton for the two commit functions below. Only the middle `commit(range)`
// step differs (insertHTML vs. deleteContents/insertNode); everything around it
// is identical.
function commitListPlan(
  plan: ListOpPlan,
  placeCaretAtOffsets: (el: Element, start: number, end: number) => void,
  commit: (range: Range) => void
): void {
  const saved = saveCaretState(plan);

  const range = document.createRange();
  range.setStartBefore(plan.rangeStart);
  range.setEndAfter(plan.rangeEnd);
  commit(range);

  restoreCaretState(plan, saved, placeCaretAtOffsets);
}

export function commitListOp(
  plan: ListOpPlan,
  placeCaretAtOffsets: (el: Element, start: number, end: number) => void
): void {
  commitListPlan(plan, placeCaretAtOffsets, (range) => {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('insertHTML', false, plan.html);
  });
}

/**
 * Same caret-save/restore contract as `commitListOp`, but for plans whose
 * `html` `execCommand('insertHTML')` is confirmed (real-Chromium test) to
 * corrupt. Two such shapes: outdent (one selected `<li>` replaced by TWO
 * sibling `<li>`s — the two-root fragment left an orphan `<li><ul></ul></li>`
 * remnant that drove `fixOrphanNestedListItems`'s self-heal loop to its
 * 50-iteration safety cap) and indent onto an existing sublist (a single-root
 * replacement that COLLAPSES two sibling `<li>`s into one — insertHTML's
 * ReplaceSelectionCommand left phantom empty `<li>`s and stray bullet lines,
 * worst on loose/`<p>`-wrapped items — bug 0717 round3 #3).
 * `Range.deleteContents()` + `Range.insertNode()` on a `<template>`-parsed
 * fragment never goes through `ReplaceSelectionCommand` (the WebKit command
 * backing `execCommand('insertHTML')`), so the corruption never fires — same
 * pattern as `sibling-move.ts`'s `applyBlockMove`. Trade-off (accepted, same as
 * `applyBlockMove`/`finishRowMove`): the op does not land on the native undo
 * stack as its own step. Do not "fix" this back to `execCommand('insertHTML')`.
 */
export function commitListOpDirect(
  plan: ListOpPlan,
  placeCaretAtOffsets: (el: Element, start: number, end: number) => void
): void {
  commitListPlan(plan, placeCaretAtOffsets, (range) => {
    range.deleteContents();
    const template = document.createElement('template');
    template.innerHTML = plan.html;
    range.insertNode(template.content);
  });
}
