/**
 * Shared compute-then-commit-via-insertHTML primitive (HLR 22, execCommand
 * List/Block Verb Replacement, Phase 1). `computeIndent`/`computeOutdent`/
 * `computeToList` are PURE tree-transform functions — Element(s) in, a
 * replacement-plan object out, zero live-DOM mutation/execCommand/Selection-API
 * access — so they can be exercised with a domino-built DOM in roundtrip tests.
 * `commitListOp`/`commitListOpDirect` are the only functions that touch the
 * live DOM. `commitListOp` (indent, toList: single-root replacement html) uses
 * one `execCommand('insertHTML')` call — one native undo step. `commitListOpDirect`
 * (outdent: multi-root replacement html) uses `Range.deleteContents()` +
 * `Range.insertNode()` instead — `execCommand('insertHTML')` is confirmed to
 * corrupt that shape (see commitListOpDirect's own doc comment) — no native
 * undo step, same accepted trade-off as sibling-move.ts's `applyBlockMove`.
 * Both restore the caret via a stable ancestor + getOffsetWithin/
 * placeCaretAtOffsets, mirroring dom-utils.ts's `replaceBlockTag`. Phase 2
 * wires each of the 14 call sites to this primitive one at a time — nothing
 * here is wired up yet.
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

export interface ListOpPlan {
  /** Ancestor that survives the mutation untouched — used to save/restore caret via
   *  getOffsetWithin/placeCaretAtOffsets. Must NOT be inside [rangeStart, rangeEnd]. */
  stableRoot: Element;
  rangeStart: Element; // Range.setStartBefore(rangeStart)
  rangeEnd: Element; // Range.setEndAfter(rangeEnd) -- may equal rangeStart
  html: string; // replacement HTML for [rangeStart, rangeEnd]
}

/**
 * Indent `li` under its previous sibling: appended to the previous sibling's
 * existing sublist if it has one, else a new sublist (same list type as the
 * shared parent) is created — always `li > ul`/`li > ol`, never `ul > ul`.
 * Returns null if `li` has no previous sibling (nothing to indent under).
 */
export function computeIndent(li: Element): ListOpPlan | null {
  const list = li.parentElement;
  const prev = li.previousElementSibling;
  if (!list || !prev) {
    return null;
  }

  const prevClone = prev.cloneNode(true) as Element;
  const liClone = li.cloneNode(true) as Element;
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
  const laterSiblings = childrenClone.slice(index + 1);

  outdentedLiClone.remove();
  if (laterSiblings.length) {
    const newSublist = sublist.ownerDocument!.createElement(sublist.tagName.toLowerCase());
    laterSiblings.forEach((sibling) => newSublist.appendChild(sibling));
    outdentedLiClone.appendChild(newSublist);
  }
  if (sublistClone.children.length === 0) {
    sublistClone.remove();
  }

  return {
    stableRoot: grandList,
    rangeStart: parentLi,
    rangeEnd: parentLi,
    html: parentLiClone.outerHTML + outdentedLiClone.outerHTML,
  };
}

/**
 * Build a tight `<ul>`/`<ol>` from `blocks` (top-level block elements) — each
 * block's own `innerHTML` placed directly in a `<li>`, no wrapping `<p>`,
 * mirroring toolbar.ts's `toggleTaskItem` pattern (~line 1390-1410). A block
 * that is itself already a `<ul>`/`<ol>` contributes its `<li>`s directly
 * (flattened), matching the same edge case that function already handles.
 */
export function computeToList(blocks: Element[], ordered: boolean): ListOpPlan {
  const tag = ordered ? 'ol' : 'ul';
  const itemsHtml = blocks
    .map((el) => {
      if (el.tagName === 'UL' || el.tagName === 'OL') {
        return Array.from(el.children)
          .filter((c) => c.tagName === 'LI')
          .map((li) => `<li>${li.innerHTML.trim() ? li.innerHTML : '<br>'}</li>`)
          .join('');
      }
      return `<li>${el.innerHTML.trim() ? el.innerHTML : '<br>'}</li>`;
    })
    .join('');

  return {
    stableRoot: blocks[0].parentElement as Element,
    rangeStart: blocks[0],
    rangeEnd: blocks[blocks.length - 1],
    html: `<${tag}>${itemsHtml}</${tag}>`,
  };
}

/**
 * The only function in this module touching the live DOM/Selection API:
 * selects [rangeStart, rangeEnd], replaces it in one `execCommand('insertHTML')`
 * call (one native undo step), then restores the caret at the same character
 * offset within `stableRoot` — same approach as dom-utils.ts's `replaceBlockTag`.
 * `placeCaretAtOffsets` is injected (rather than imported from
 * createDomHelpers) so this module stays free of the #content/focus() coupling
 * that closure carries.
 */
export function commitListOp(
  plan: ListOpPlan,
  placeCaretAtOffsets: (el: Element, start: number, end: number) => void
): void {
  const selBefore = window.getSelection();
  let startOffset: number | null = null;
  let endOffset: number | null = null;
  if (selBefore && selBefore.rangeCount > 0) {
    const r = selBefore.getRangeAt(0);
    startOffset = getOffsetWithin(plan.stableRoot, r.startContainer, r.startOffset);
    endOffset = selBefore.isCollapsed ? startOffset : getOffsetWithin(plan.stableRoot, r.endContainer, r.endOffset);
  }

  const range = document.createRange();
  range.setStartBefore(plan.rangeStart);
  range.setEndAfter(plan.rangeEnd);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand('insertHTML', false, plan.html);

  if (startOffset !== null && endOffset !== null) {
    placeCaretAtOffsets(plan.stableRoot, startOffset, endOffset);
  }
}

/**
 * Same caret-save/restore contract as `commitListOp`, but for plans whose
 * `html` has MULTIPLE root elements (outdent: one selected `<li>` replaced by
 * two sibling `<li>`s). `execCommand('insertHTML')` is confirmed (real-Chromium
 * test) to corrupt this shape: replacing a single selected `<li>` with a
 * two-root fragment left an orphan `<li><ul></ul></li>` remnant, which then
 * drove `fixOrphanNestedListItems`'s self-heal loop to its 50-iteration safety
 * cap. `Range.deleteContents()` + `Range.insertNode()` on a `<template>`-parsed
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
  const selBefore = window.getSelection();
  let startOffset: number | null = null;
  let endOffset: number | null = null;
  if (selBefore && selBefore.rangeCount > 0) {
    const r = selBefore.getRangeAt(0);
    startOffset = getOffsetWithin(plan.stableRoot, r.startContainer, r.startOffset);
    endOffset = selBefore.isCollapsed ? startOffset : getOffsetWithin(plan.stableRoot, r.endContainer, r.endOffset);
  }

  const range = document.createRange();
  range.setStartBefore(plan.rangeStart);
  range.setEndAfter(plan.rangeEnd);
  range.deleteContents();

  const template = document.createElement('template');
  template.innerHTML = plan.html;
  range.insertNode(template.content);

  if (startOffset !== null && endOffset !== null) {
    placeCaretAtOffsets(plan.stableRoot, startOffset, endOffset);
  }
}
