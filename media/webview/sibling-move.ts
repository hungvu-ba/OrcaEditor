/**
 * Shared primitive: reorder a contiguous span of DOM siblings by replacing a
 * single Range with ONE `execCommand('insertHTML', ...)` call, so the whole
 * move lands as one native undo step regardless of how many siblings the span
 * covers or how far it travels — same technique already proven in this
 * codebase for `fixOrphanNestedListItems`/`replaceBlockTag` (main.ts /
 * dom-utils.ts): select a Range spanning every affected node, replace it with
 * those same nodes' outerHTML in the new order.
 *
 * Used by drag-drop.ts (top-level block / heading-section reorder, US-17.3)
 * and table.ts (table row reorder, US-17.4) — both are "reorder a contiguous
 * run of element siblings under one parent" at heart, just with different
 * hit-testing (block gaps vs. row gaps) and a different `needsSpacer` rule
 * (block reorder must not land two atom blocks — Mermaid/math — back to
 * back; rows never need a spacer).
 */

export interface SiblingMoveResult {
  /** Replacement HTML for the Range [low, high] (inclusive), in the new order. */
  html: string;
  /** First sibling of the affected range — Range.setStartBefore anchor. */
  low: HTMLElement;
  /** Last sibling of the affected range — Range.setEndAfter anchor. */
  high: HTMLElement;
  /** Sibling immediately before the affected range, captured before the mutation (or null if the range starts at the first sibling) — anchor for locating the moved element afterwards, since `low`/`high` are detached once the Range is replaced. */
  beforeEl: HTMLElement | null;
  /** nextElementSibling hops from `beforeEl` (or from `parent.firstElementChild` if null) to reach the moved span's first element in the live DOM after the move. */
  movedHopCount: number;
}

/**
 * A gap is a no-op/self-drop — reject — when it would put the span back at
 * the exact position it already occupies: physically inside the span
 * (spanStartIdx < gap <= spanEndIdx), OR the two boundary gaps that are the
 * span's OWN current position (gap === spanStartIdx — "insert right before
 * itself" — and gap === spanEndIdx + 1 — "insert right after itself"). Only
 * gaps strictly outside [spanStartIdx, spanEndIdx + 1] are a real move.
 */
export function isValidSiblingGap(gap: number, spanStartIdx: number, spanEndIdx: number): boolean {
  return gap < spanStartIdx || gap > spanEndIdx + 1;
}

/**
 * Computes the minimal-diff replacement for moving `siblings[spanStartIdx..spanEndIdx]`
 * to gap index `gap` (gap g means "insert before siblings[g]"; g === siblings.length
 * means "insert at the end"). `needsSpacer(prev, cur)`, if given, inserts an empty
 * `<p><br></p>` between two elements that would otherwise land directly adjacent —
 * e.g. two Mermaid/math blocks with no caret position between them — folded into
 * this SAME html string so it stays part of the one execCommand call.
 */
export function computeSiblingMove(
  siblings: HTMLElement[],
  spanStartIdx: number,
  spanEndIdx: number,
  gap: number,
  needsSpacer?: (prev: HTMLElement, cur: HTMLElement) => boolean
): SiblingMoveResult {
  const span = siblings.slice(spanStartIdx, spanEndIdx + 1);
  const remaining = siblings.filter((_, i) => i < spanStartIdx || i > spanEndIdx);
  const insertionIndex = gap <= spanStartIdx ? gap : gap - span.length;
  const newOrder = [...remaining.slice(0, insertionIndex), ...span, ...remaining.slice(insertionIndex)];
  const lowOrig = Math.min(spanStartIdx, gap);
  const highOrig = Math.max(spanEndIdx, gap - 1);
  const newSpanEls = newOrder.slice(lowOrig, highOrig + 1);
  const movedFirstIdx = newOrder.indexOf(span[0]) - lowOrig;
  const beforeEl = lowOrig > 0 ? siblings[lowOrig - 1] : null;
  const afterEl = highOrig < siblings.length - 1 ? siblings[highOrig + 1] : null;

  const parts: string[] = [];
  let movedHopCount = 0;
  for (let i = 0; i < newSpanEls.length; i++) {
    const prev = i === 0 ? beforeEl : newSpanEls[i - 1];
    const cur = newSpanEls[i];
    if (prev && needsSpacer?.(prev, cur)) {
      parts.push('<p><br></p>');
    }
    if (i === movedFirstIdx) {
      movedHopCount = parts.length;
    }
    parts.push(cur.outerHTML);
  }
  const last = newSpanEls[newSpanEls.length - 1];
  if (last && afterEl && needsSpacer?.(last, afterEl)) {
    parts.push('<p><br></p>');
  }

  return { html: parts.join(''), low: siblings[lowOrig], high: siblings[highOrig], beforeEl, movedHopCount };
}

/**
 * Same signature/return shape as `applySiblingMove`, but replaces the
 * Range-select-then-`execCommand('insertHTML')` body with
 * `Range.deleteContents()` + `Range.insertNode()` on a `<template>`-parsed
 * fragment. WebKit's `ReplaceSelectionCommand` (which backs
 * `execCommand('insertHTML')`) applies a "smart merge" heuristic whenever the
 * replaced range's end boundary lands next to an untouched sibling, silently
 * folding that sibling's content into the inserted HTML and dropping
 * `data-block-id`s (bug 0716 round 3) — reproduced even for the simplest case
 * (swapping two adjacent paragraphs). `deleteContents`/`insertNode` never go
 * through `ReplaceSelectionCommand`, so the heuristic never fires.
 *
 * Trade-off (accepted, same as `finishRowMove` in table.ts:611-629): the move
 * no longer lands on the native undo stack as its own step. Do not "fix" this
 * back to `execCommand('insertHTML')` — that's the corruption this function
 * exists to avoid.
 */
export function applyBlockMove(parent: Element, result: SiblingMoveResult): HTMLElement | null {
  const range = document.createRange();
  range.setStartBefore(result.low);
  range.setEndAfter(result.high);
  range.deleteContents();

  const template = document.createElement('template');
  template.innerHTML = result.html;
  range.insertNode(template.content);

  let el: Element | null = result.beforeEl ? result.beforeEl.nextElementSibling : parent.firstElementChild;
  for (let i = 0; i < result.movedHopCount && el; i++) {
    el = el.nextElementSibling;
  }
  return el as HTMLElement | null;
}

/** Where a cross-level `<li>` move (US-17.7, M6) lands: `container` is the destination
 * `<ul>`/`<ol>`, and the moved item is inserted before `beforeEl` (or appended if null). */
export interface LiReparentTarget {
  container: Element;
  beforeEl: Element | null;
}

/**
 * Re-parents `li` (own nested subtree carried verbatim) into `target.container`. Unlike
 * `applySiblingMove`/`applyBlockMove` — a same-parent reorder expressed as ONE Range spanning
 * the whole affected run — a cross-level move's source and destination are two different
 * parents, so this is two Range operations instead: one `Range.deleteContents()` to detach `li`
 * (re-created from a `<template>` reparse of its own `outerHTML`, the same technique
 * `applyBlockMove` uses and for the same reason — not `execCommand('insertHTML')`, which WebKit's
 * `ReplaceSelectionCommand` can corrupt across a parent boundary), then a second
 * `Range.insertNode()` at the destination.
 */
export function applyLiReparentMove(li: HTMLLIElement, target: LiReparentTarget): HTMLLIElement | null {
  // Build+validate the replacement BEFORE detaching the original — `li` must stay live in the
  // DOM until a valid replacement exists, so a parse failure never leaves the source deleted
  // with nothing inserted in its place.
  const template = document.createElement('template');
  template.innerHTML = li.outerHTML;
  const newLi = template.content.firstElementChild as HTMLLIElement | null;
  if (!newLi) {
    return null;
  }

  const oldParentList = li.parentElement;
  const delRange = document.createRange();
  delRange.selectNode(li);
  delRange.deleteContents();
  // A nested `<ul>`/`<ol>` left with no `<li>` children after the move is an orphaned wrapper —
  // remove it. Only ever a nested sublist (its own parent is an `<li>`), never the root list
  // block itself, since a cross-level move stays within the same root list and always has at
  // least one other item remaining there.
  if (oldParentList && oldParentList.parentElement?.tagName === 'LI' && oldParentList.children.length === 0) {
    oldParentList.remove();
  }

  const insRange = document.createRange();
  if (target.beforeEl) {
    insRange.setStartBefore(target.beforeEl);
  } else {
    insRange.selectNodeContents(target.container);
    insRange.collapse(false);
  }
  insRange.insertNode(newLi);
  return newLi;
}
