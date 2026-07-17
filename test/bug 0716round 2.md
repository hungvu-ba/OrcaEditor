# Bug 0716 — Round 2

Raw report (Vietnamese), preserved verbatim as originally filed:

1.  table cần 1 handle luôn hiện cùng với handle col, cell để drag cả table
2.  handle của bullet đang lỗi, ko select được handler của các item con.
3.  drag blockquote hoặc code block xuống dưới 1 item thì sẽ merge cả item đó vào trong content của block quote/code block, scope bị merge là toàn bộ item từ vị trí gốc đến chỗ drop
4.  gosh column cũng đang chỉ show column header -> ko show content mà chỉ show 1 cột giả chỉ có viền và background nhưng cùng cỡ với cột thật để kéo
5.  drag & drop của mermaid block chưa hoạt động.
6.  kéo block math xuống dưới block mermaid làm duplicate block math

All six are follow-ups on the drag & drop feature (HLR section 17) after the `test/bug 0716.md` batch (Group Handle/TOC) already landed — see that file for the design history of the hover/handle machinery these bugs build on (bug 0715 #7/#8/#11, bug 0716 #3/#4/#6).

---

**Parallel groups** (by which files each fix touches — bugs in *different* groups touch disjoint files and can be worked on simultaneously without merge conflicts; bugs in the *same* group share a file and should be sequenced / owned by one person):

-   **Group Handle** — `media/webview/drag-drop.ts` (`findBlockAt`, `findLiAt`) + `media/webview/table.ts` (new table-level handle) + `media/editor.css` (new handle CSS). Bugs #1 and #2. Internal order: none required — #1 (new `findTableBlockAt`/table handle) and #2 (`findLiAt`'s climb threshold) touch different functions with no line overlap; can be done by the same or different engineers in either order, just avoid overlapping `drag-drop.ts` edits landing in the same PR without a rebase.
-   **Group ExecCommand** — `media/webview/sibling-move.ts` (`applySiblingMove`) — the single shared move primitive used by ALL THREE of: `drag-drop.ts` block/heading-section moves, `drag-drop.ts` list-item moves, and `table.ts` row moves. Bugs #3, #5, #6. **This is one architectural root cause with three surfaced symptoms, not three independent bugs** — see Bug #3's Root Cause for the confirmed mechanism (a live-repro'd WebKit `execCommand('insertHTML')` merge-heuristic quirk) and Bugs #5/#6's entries for why the same seam is the leading suspect there too. Internal order: **fix #3 first** (only one with a confirmed, reproduced mechanism) as the reference implementation, then re-run the same live-Playwright-repro technique against #5 and #6 to confirm/rule out before assuming the same patch covers them — do NOT silently assume fixing #3 automatically fixes #5/#6 without verifying live. Whatever fix direction is chosen for #3 (see its Solution Direction's 3 options) should be validated against #5/#6's atom-block scenarios in the same pass, since a fix scoped only to "blockquote/pre" tags would not touch #5/#6's `contenteditable=false` atom-block scenario.
-   **Group Ghost** — `media/webview/table.ts` only (`tdStartDragging`'s column-ghost branch). Bug #4. Fully standalone — safe in parallel with Group Handle and Group ExecCommand (touches a different function in the same file as Group Handle's #1, if #1 ends up landing in `table.ts` — low overlap risk, different functions, but flag for awareness if both land close together).

Groups Handle, ExecCommand, and Ghost can each be assigned to a different person/agent in parallel; within Group ExecCommand, fix #3 first and re-verify #5/#6 against that fix before closing them.

---

## Bug #1 — Table needs its own "drag whole table" handle

**Status:** ✅ Fixed (2026-07-16) — implemented per Option B (confirmed with the user): a new `findTableBlockAt` in `drag-drop.ts` (pure rect math, no `elementFromPoint`) fires in a small band at the table's own top-left corner, extended `TABLE_HANDLE_CORNER_OVERLAP_PX` (4px) past the corner into the same pixels row-0/col-0's handles claim — an exact-boundary zone made "shows together with row/column handles" an unreachable knife-edge (confirmed via live diagnostic: floating-point rect measurements from the table vs. its header row don't reliably agree at a single pixel), so the zone needed genuine multi-pixel overlap. The new `tableHandleEl`/`hoveredTableBlock` reuse `armDrag`/`performMove`/`computeHeadingSectionSpan` as-is — no new move logic. Three-agent review (blind adversarial + edge-case hunter + acceptance auditor) converged on one critical implementation gap (not a spec gap): `hoveredTableBlock`/`tableHandleEl` weren't reset at every lifecycle point `hoveredBlock`/`handleEl` already were (`startDragging`, `resetState`, `onDocMouseUp`'s pre-move clear, `moveBlockToGap`) — the stale reference baked a permanent `.dd-hover-outline` into the moved table AND crashed the next drag attempt (`applyBlockMove`'s `range.setStartBefore(undefined)` throws on a detached node, sticking `state` at `'dragging'` and breaking all further drag-and-drop until reload). Fixed by mirroring `hoveredBlock`'s exact handling at all sites. Also fixed: `openMenu` hardcoded `handleEl` as its position anchor even when opened via `tableHandleEl`, rendering the popup at the viewport's top-left corner instead of near the table. A hypothesized adjacent-table/atom-block markdown-merge risk (`isAtomBlock` doesn't cover `<table>`) was checked via live repro and does NOT reproduce — TurndownService's own block-level serialization already guarantees blank-line separation between tables/atom blocks regardless. `npx tsc --noEmit` clean, `npx eslint` clean, full `test/webview/` suite (55 specs, up from 48) + roundtrip + unit all pass. Full spec: `_bmad-output/quick-dev/spec-bug-0716r2-1-table-block-handle.md`.

### Description

The table currently only offers row and column drag handles (`table.ts`). There is no way to drag the *entire table* as a single block to reorder it among its siblings. The user wants a handle that always shows together with the row/column handles, not exclusive of them, so the whole table can be picked up and moved. (Vietnamese: "table cần 1 handle luôn hiện cùng với handle col, cell để drag cả table.")

### Root Cause

[`media/webview/drag-drop.ts:135-145`](../media/webview/drag-drop.ts#L135-L145) (`findBlockAt`) deliberately excludes `<table>` from the block-hover hit-test:

```ts
/** Excludes <table> so hovering a cell only shows table.ts's own row/col handles, never the whole-block handle on top of them (bug 0715 #11). ... */
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
```

This filter was added for bug 0715 #11 to stop the whole-block handle and table.ts's row/col handles from fighting over the same hover — but its side effect is that a `<table>` can *never* become `hoveredBlock`, so no handle of any kind exists for "move this whole table." `table.ts` only ever offers `tdKind: 'row' | 'col'` (no `'table'` kind) — `deleteTable` is the only whole-table operation, and it deletes rather than moves.

```ts
// media/webview/table.ts:728-740 (positionRowHandle — flush left of the table)
function positionRowHandle(row: HTMLTableRowElement | null): void {
  if (!row) {
    rowHandleEl.style.display = 'none';
    return;
  }
  const table = row.closest('table') as HTMLTableElement;
  const tRect = table.getBoundingClientRect();
  // ... right: window.innerWidth - tRect.left
}
```

The underlying move machinery already supports moving a table as a unit: `draggableTopLevelBlocks()` (`drag-drop.ts:89-91`), used *unfiltered* by `computeHeadingSectionSpan`/`moveBlockToGap`/`armDrag`, still includes `<table>` as an ordinary sibling — e.g. a table inside a dragged heading section is already carried along correctly today. The gap is purely "no hover entry point," not a move-mechanism limitation.

### Current State Snippet

See Root Cause above (`drag-drop.ts:135-145`). Also relevant — `table.ts`'s existing row/column handle positioning pattern to mirror:

### Solution Direction

Add a third handle, positioned at the table's own **top-left corner** — e.g. `right: window.innerWidth - tRect.left; bottom: window.innerHeight - tRect.top` — the one corner not claimed by either the row handle (flush left, spans a row's height) or the column handle (flush above, spans a column's width), so all three can coexist without visual collision, satisfying the user's "always show together" requirement.

`positionColHandle` (~line 745-762) uses the mirror pattern anchored above the header row (`bottom: window.innerHeight - tRect.top`).

**Open design question (do not pick silently — needs a decision before implementing):** where should this live?

-   **Option A — extend `table.ts`**: add `tdKind: 'table'` alongside `'row'`/`'col'`. Downside: `table.ts`'s existing finish-move logic (`finishRowMove` et al.) is built around reordering `<tr>` siblings within one table, not moving the `<table>` element itself among *its own* top-level siblings — it would need to borrow `sibling-move.ts`'s Range+`execCommand` approach from scratch, duplicating machinery `drag-drop.ts` already has.
-   **Option B — extend `drag-drop.ts`**: add a `findTableBlockAt` (a variant of `findBlockAt` that does NOT filter out `<table>`, scoped to only fire on/near the table's own corner rather than anywhere over its rows) and reuse `armDrag`/`performMove`/`computeHeadingSectionSpan` as-is — these already move arbitrary top-level blocks including tables end-to-end. This is the closer functional fit and less new code.

Recommend Option B based on the investigation, but confirm with the user/reviewer before implementing, since it does mean `table.ts` and `drag-drop.ts` both need to coordinate hover state for the same `<table>` element (row/col handles vs. the new table-corner handle) without regressing bug 0715 #11's original fix (row/col and whole-block handles must not visually collide or fight for the same pixels).

### Acceptance Criteria

-   [x]  Hovering a table (anywhere that isn't already claimed by a row/column handle's own hit zone) shows a dedicated table-level handle.
-   [x]  The table handle can show *simultaneously* with a row handle and/or column handle when the cursor is positioned such that more than one would normally appear — no mutual exclusion between the three.
-   [x]  Dragging the table handle moves the entire `<table>` as one block among its top-level siblings (same reorder semantics as any other block move).
-   [x]  Existing row/column drag behavior (`table.ts`) is unaffected.
-   [x]  Bug 0715 #11's original fix (row and column handles can show together, without the old whole-block handle fighting them) still holds.

### Test Requirements

This alters raw `.md` content via drag reorder — per this repo's Mandatory Rule (Roundtrip Test), add coverage to `test/roundtrip/drag-drop.ts` for "move a whole table to a new sibling position." This also touches real interactive hover/click/drag behavior — per the Mandatory Rule (Webview Interaction Test), add a Playwright spec in `test/webview/` (new `table-block-drag.spec.ts`, alongside the existing `table-row-drag.spec.ts`) covering: table handle appears, table handle + row/col handle can coexist, dragging the table handle reorders it. Run `npx tsc --noEmit` + `npx eslint media/webview/drag-drop.ts media/webview/table.ts` once implemented.

### Isolation / Parallel Group

**Group Handle** — `media/webview/drag-drop.ts` (`findBlockAt` or new `findTableBlockAt`) + `media/webview/table.ts` (new table handle, wherever Option A/B lands) + `media/editor.css` (new handle class). See preamble.

---

## Bug #2 — Nested list item's own drag handle can't be selected

**Status:** ✅ Fixed (2026-07-16) — the Solution Direction below turned out to be necessary but not sufficient, confirmed via a live Playwright diagnostic against the compiled bundle: once a nested `<li>`'s handle has actually rendered over its own footprint, real browser hit-testing lets it self-intercept, so a *continuous* move from content into an *already-positioned* handle never actually broke. The real failure mode is a **cold arrival** — a jump landing directly in the handle's 22px band before that item's handle has been positioned — where `elementFromPoint` alternates between the enclosing `<ul>`'s own padding box and the `<li>`'s marker glyph, and a plain `.closest('li')` on a `<ul>` hit skips straight past the nested item to its ancestor, before the climb loop (and the `HANDLE_WIDTH_PX` offset below) is ever reached. Fix in `drag-drop.ts`'s `findLiAt` (`drag-drop.ts:361-386`): when the hit lands on a `<ul>`/`<ol>`, prefer whichever of its own direct `<li>` children's row (by `clientY`) contains the point — falling back to the vertically nearest child when none matches exactly (a "loose" list's blank-line-separated items open real gaps between sibling rows, where the same misresolution otherwise resurfaced) — before falling back to `.closest('li')`. The `HANDLE_WIDTH_PX`\-offset climb condition from the original Solution Direction was kept, still correct for the ancestor-climb decision once a starting `<li>` is resolved. Three-agent review (blind adversarial + edge-case hunter + acceptance auditor) found no `intent_gap`/`bad_spec` findings; two `patch`\-level test-robustness gaps were fixed (a fragile test boundary that coincided exactly with the browser's default 40px list indent, and height-only proxy assertions strengthened to compare x/y/height against a captured reference box) and a third patch closed the loose-list gap itself. `npx tsc --noEmit` clean, `npx eslint media/webview/drag-drop.ts` clean, full `test/webview/` suite (45 specs) passes. Full spec: `_bmad-output/quick-dev/spec-bug-0716r2-2-li-handle-dead-zone.md`.

### Description

The list-item drag handle is broken for nested (child) items — the user can't select/click a nested item's own handle. (Vietnamese: "handle của bullet đang lỗi, ko select được handler của các item con.")

### Root Cause

[`media/webview/drag-drop.ts:338-363`](../media/webview/drag-drop.ts#L338-L363) (`findLiAt`)'s ancestor-climb condition, combined with [`positionLiHandle`](../media/webview/drag-drop.ts#L368-L378)'s flush-left placement and the browser's default list indent (no custom `padding-left` override exists for plain lists in `media/markdown.css`/`editor.css` — confirmed, only `.contains-task-list` has one — so nesting uses the UA default, ~40px per level):

```ts
// drag-drop.ts:368-378 (positionLiHandle — flush against the li's own left edge)
function positionLiHandle(li: HTMLLIElement | null): void {
  if (!li) {
    liHandleEl.style.display = 'none';
    return;
  }
  const r = li.getBoundingClientRect();
  liHandleEl.style.display = 'flex';
  liHandleEl.style.top = `${r.top}px`;
  liHandleEl.style.height = `${r.height}px`;
  liHandleEl.style.right = `${window.innerWidth - r.left}px`;
}
```

```ts
// drag-drop.ts:338-363
function findLiAt(clientX: number, clientY: number): HTMLLIElement | null {
  const el = document.elementFromPoint(clientX, clientY);
  const li = (el as HTMLElement | null)?.closest?.('li');
  if (!li || !content.contains(li)) {
    return null;
  }
  let current = li as HTMLLIElement;
  for (;;) {
    if (clientX >= current.getBoundingClientRect().left) {
      break;
    }
    const parentLi = current.parentElement?.closest('li') as HTMLLIElement | null;
    if (!parentLi || !content.contains(parentLi)) {
      break;
    }
    const enclosingTable = current.closest('table');
    if (enclosingTable && parentLi.contains(enclosingTable)) {
      break;
    }
    current = parentLi;
  }
  return current;
}
```

`.dd-handle`'s CSS `width` is 22px (`editor.css:84`). The nested `<li>`'s own handle therefore occupies screen band `[li.left - 22px, li.left]`. But the browser's default list indent (~40px) means that band sits entirely *inside* the space that geometrically belongs to the **parent** `<ul>`'s own padding box, not to the child `<li>` — an 18px gap wider than the handle itself. As the mouse moves left from the child's own content toward its handle, intermediate `mousemove` samples land in that dead zone. There, `document.elementFromPoint` resolves to the enclosing `<ul>` (no `<li>` box covers its own padding), and `.closest('li')` on it returns the **parent** `<li>` directly — before the cursor ever reaches the child's handle rect. `onContentHover` then reassigns `hoveredLi` to the parent and repositions the handle to the parent's (further-left) location, out from under the cursor, before the click lands. This defeats itself only for nested items (depth ≥ 1); a depth-0 item's gutter sits inside `#content`'s own reserved margin, owned by nobody else, so it isn't affected — consistent with the user calling out "item con" (child items) specifically.

This climb loop was added to fix bug 0715 #8 (ancestor's own handle was unreachable while hovering deep inside a nested subtree, because `findLiAt` always resolved the innermost `<li>`). Bug #2 is the flip side of that same fix: the mechanism that makes the *ancestor* reachable now makes the *child*'s own handle unreachable, in the exact same function.

**Test coverage gap confirmed:** `test/webview/drag-handle.spec.ts:165-177` hovers the nested `<li>`'s center then jumps `page.mouse.move()` directly to the handle's coordinates in one step (no `steps` interpolation) — it never generates the intermediate mousemove samples that land in the dead zone, so it cannot catch this.

### Current State Snippet

See Root Cause above.

### Solution Direction

In `findLiAt`, reserve the handle's own width before climbing to an ancestor — change the break condition from `clientX >= current.getBoundingClientRect().left` to `clientX >= current.getBoundingClientRect().left - HANDLE_WIDTH_PX` (a new constant shared with `.dd-handle`'s CSS width, 22px, to avoid the two drifting apart). This keeps bug 0715 #8's ancestor-reachable fix intact (still climbs once the cursor is truly past the child's own handle band) while giving the child's own handle its full clickable width. Lands entirely in `drag-drop.ts`'s `findLiAt`.

**Refinement (2026-07-16, user-requested framing):** the user restated this fix as a general requirement rather than a bug description — "chỉ khi hover vào item con thì hiện lên handle, dẫn đến khi rời khỏi handle làm nó ẩn đi -> cần tính sẵn khu vực handle của từng item, hover lên trên đó cũng sẽ tính là hover lên item content" (the handle only shows on hovering a child item, so moving toward the handle itself hides it again — the fix must precompute each item's own handle zone and treat hovering that zone as hovering the item's own content). This is the exact same mechanism as the Solution Direction above, just phrased as the general contract the implementation must satisfy — recording it explicitly so a future coding session implements the *rule* ("the handle zone belongs to the item it activates"), not just a single magic-number tweak that happens to produce the right behavior today.

One implementation trap worth flagging explicitly, since it's the "obvious" shortcut and it's wrong: **do not** implement this by reusing the existing `isInHandleGutter` helper (`drag-drop.ts:407-413`, already used in the `mouseleave` handler) as-is inside `onContentHover`/`findLiAt`. `isInHandleGutter` is deliberately **unbounded** on how far left `x` can go (its own comment: "No lower bound on `x`") — correct for its actual job (don't clear hover state just because the cursor left `#content`'s box while still over the same item's handle column), but wrong for this job: if reused unbounded to short-circuit `findLiAt`'s fresh resolution, once `hoveredLi` is the child, *any* further-left `x` would keep resolving to the child forever, permanently blocking the ancestor climb that bug 0715 #8 relies on. The zone here must be **bounded** to exactly `[li.left - HANDLE_WIDTH_PX, li.left)` — i.e. a new, separate, bounded check (or the threshold-shifted `findLiAt` climb condition above, which is the bounded form of the same idea) — not a reuse of the unbounded gutter helper.

### Acceptance Criteria

-   [x]  The mouse can move continuously from a nested (depth ≥ 1) list item's own content into its own handle band and click/drag it, without the resolved `<li>` (and thus the handle's position) flipping to an ancestor mid-move.
-   [x]  The ancestor's own handle is still reachable when the cursor is genuinely further left, past the child's handle band (bug 0715 #8 must not regress).
-   [x]  Depth-0 items are unaffected (already correct today).

### Test Requirements

Interactive hover/hit-area behavior — per the Mandatory Rule (Webview Interaction Test), add/extend a Playwright spec in `test/webview/drag-handle.spec.ts` that moves the mouse with `steps: N` interpolation from a nested `<li>`'s content to its handle's coordinates (not a single-step jump, which is what let this slip through before) and asserts the handle stays targeted at the nested item throughout. Run `npx tsc --noEmit` + `npx eslint media/webview/drag-drop.ts`.

### Isolation / Parallel Group

**Group Handle** — `media/webview/drag-drop.ts` (`findLiAt` only). See preamble. No line overlap with Bug #1's `findBlockAt`/table-handle work.

---

## Bug #3 — Dragging a blockquote/code block below an item merges that item into it

**Status:** ✅ Fixed (2026-07-16) — root cause turned out broader than described here: a live Playwright repro against the real compiled bundle proved WebKit's `execCommand('insertHTML')` smart-merge corrupts content on ANY top-level block move whose Range end boundary lands next to an untouched sibling, not just blockquote/pre — even a plain adjacent-paragraph swap merged silently. Fix (Solution Direction's option 3 generalized, applied unconditionally): `sibling-move.ts` gained `applyBlockMove`, using `Range.deleteContents()`+`Range.insertNode()` instead of `execCommand('insertHTML')`; `drag-drop.ts`'s `performMove`/`moveBlockToGap` switched to it. List-item moves and table row/column moves confirmed unaffected live, left untouched. Trade-off: block moves lose native-undo-stack participation (same accepted trade-off `table.ts`'s `finishRowMove` already ships) — custom undo-stack deferred to a future story. Three-agent review (blind adversarial + edge-case hunter + acceptance auditor) found one `bad_spec` gap (missing test for the "move to true end of document" scenario, closed) and 3 `patch`\-level fixes (a real caret/focus-loss regression in the handle-menu move path, weakened test assertions that couldn't catch a dropped `data-block-id`, and a misleading test comment). `npx tsc --noEmit` clean, `npx eslint` clean, full `test/webview/` suite (46 specs) + full `test:roundtrip` (11/11) pass. Full spec: `_bmad-output/quick-dev/spec-bug-0716-group-execcommand.md`.

### Description

Dragging a blockquote or a fenced code block down, past another item, causes that other item to get merged INTO the dragged block's content — the merged scope spans everything from the dragged block's original position to its drop position. (Vietnamese: "drag blockquote hoặc code block xuống dưới 1 item thì sẽ merge cả item đó vào trong content của block quote/code block, scope bị merge là toàn bộ item từ vị trí gốc đến chỗ drop.")

### Root Cause

Confirmed via a live Playwright repro against the real compiled `dist/webview/main.js` (doc = `Alpha paragraph.` / `> Quote content.` / `Beta paragraph.` / `Gamma paragraph.`, dragging the blockquote to below Gamma). Resulting DOM:

```html
<p data-block-id="block-1">Alpha paragraph.</p>
<blockquote data-block-id="block-2" class="">
<p data-block-id="block-3">Beta paragraph.</p><p data-block-id="block-4">Gamma paragraph.</p><blockquote data-block-id="block-2" class="">
<p>Quote content.</p></blockquote></blockquote>
```

`data-block-id="block-2"` appears **twice** — once as an outer wrapper `<blockquote>`, once as the real content nested inside it. The string built by [`computeSiblingMove`](../media/webview/sibling-move.ts#L51-L88) (`parts.join('')`) is confirmed correct and flat (`<p>Beta…</p><p>Gamma…</p><blockquote>…</blockquote>`, three siblings, no nesting) — the corruption happens strictly inside the native call at [`sibling-move.ts:98`](../media/webview/sibling-move.ts#L91-L105):

```ts
// sibling-move.ts:91-105
export function applySiblingMove(parent: Element, result: SiblingMoveResult): HTMLElement | null {
  const range = document.createRange();
  range.setStartBefore(result.low);
  range.setEndAfter(result.high);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand('insertHTML', false, result.html);
  // ...
}
```

When the Range's *start* boundary sits immediately before a `<blockquote>`/`<pre>`, WebKit's `execCommand('insertHTML')` runs `ReplaceSelectionCommand`, which has built-in "smart merge" heuristics: content inserted at a position that was the start of a blockquote/pre gets merged into a synthesized container matching that context, WHILE the moved element's own serialized markup is *also* inserted verbatim inside it — producing the observed duplicate-id nested structure. This is a genuine browser-level behavior, not a bug in this codebase's index math (`lowOrig`/`highOrig`/`insertionIndex`/`gapAt`'s midpoint math all traced correctly by hand).

**Not container-specific.** The same live-repro technique against a plain `<p>` (dragging "Alpha" down so the Range's *end* boundary sits next to another `<p>`) produced two paragraphs silently **text-merged into one** (`<p data-block-id="block-1"><span style="caret-color:...">Alpha paragraph.</span><span style="caret-color:...">Gamma paragraph.</span></p>`, complete with WebKit's telltale inline `caret-color` spans) — the identical underlying mechanism, just subtle instead of catastrophic because a `<p>`+`<p>` merge doesn't visually nest.

**Confirmed identical for `<pre>` (code block):** dragging a fenced code block past two paragraphs produced the same duplicate-id wrap-and-nest shape (`<pre data-block-id="block-1">...<pre data-block-id="block-1">...</pre></pre>`). Same root cause, one fix needed for both tags, not two.

### Current State Snippet

See Root Cause above.

### Solution Direction

The single-`execCommand('insertHTML')` design (`sibling-move.ts:1-16`'s own header comment) is deliberate — it's what gets the whole move onto ONE native undo step regardless of distance. That constraint is exactly what forces `execCommand`, whose merge heuristics are the bug. This is a genuine architecture decision, not a one-liner — three options, none picked silently:

1.  Keep `execCommand('insertHTML')` but defeat the merge heuristic by wrapping the replacement HTML in a throwaway root element/marker WebKit won't merge into, then unwrapping post-insert. Fragile, WebKit-version-dependent.
2.  Abandon single-`execCommand` for a manual DOM move (`insertBefore`/`remove`) plus an explicit custom undo-stack entry. Bigger change — breaks the "one native undo step" guarantee unless undo is reimplemented for this path.
3.  Detect when the move's Range boundary abuts a blockquote/pre (or a contenteditable=false atom block, per Bugs #5/#6) and special-case those specific moves with a different insertion technique, leaving the existing fast path for ordinary blocks unchanged.

**This decision also governs Bugs #5 and #6** (see Group ExecCommand in the preamble) — whatever direction is chosen must be validated against the atom-block scenario too, not just blockquote/pre.

### Acceptance Criteria

-   [ ]  Dragging a blockquote or code block anywhere in the document (up or down, across any number of siblings) never merges/nests another sibling's content inside it.
-   [ ]  The same regression check applies to the plain-paragraph adjacent-merge case found during this investigation (two `<p>` elements must never silently text-merge into one during any block move).
-   [ ]  After any block move, the DOM has exactly the same number of top-level elements as before the move, each retaining a unique `data-block-id` (no duplicated ids).

### Test Requirements

This alters raw `.md` content via drag reorder, and the defect is a real browser `execCommand`/Selection behavior invisible to hand-built DOM snapshots — per both Mandatory Rules (Roundtrip Test AND Webview Interaction Test), this needs a live-browser Playwright regression test, not just a roundtrip fixture. Add to `test/webview/` (new `drag-merge.spec.ts` or extend `drag-handle.spec.ts`): drag a blockquote/pre past 2+ siblings and assert no duplicate `data-block-id` / no nested nodes appear; also assert the paragraph-adjacent-merge case doesn't occur. Run `npx tsc --noEmit` + `npx eslint media/webview/sibling-move.ts media/webview/drag-drop.ts media/webview/table.ts` (table.ts shares `sibling-move.ts` — see Ripple below).

### Isolation / Parallel Group

**Group ExecCommand** — `media/webview/sibling-move.ts` (`applySiblingMove`). Shared by `drag-drop.ts` (block and list-item moves) and `table.ts` (row moves) — see preamble for why #3/#5/#6 are one architectural fix, not three. **Ripple risk explicitly flagged by this investigation:** `<li>`\-to-`<li>` adjacent moves (`drag-drop.ts:735`) and `table.ts` row moves both call the same `computeSiblingMove`/`applySiblingMove` — the general "adjacent element merge" quirk demonstrated above for `<p>` is plausible at `<li>` boundaries too and should be spot-checked with the same live-Playwright technique before considering ANY of Group ExecCommand's bugs fully closed, even after #3's specific fix lands.

---

## Bug #4 — Table column drag ghost shows no content

**Status:** ✅ Fixed (2026-07-16) — `tdStartDragging`'s `'col'` branch (`table.ts:1041-1068`) now clones the header cell plus every row's own cell at `tdColIndex`, one per synthetic `<tr>` so they stack vertically instead of anonymous-table-generating into one row, each sized to its real row's height. `dd-hover-outline-cell`/`dd-hover-outline`/`dd-source-muted` stripped from the clones (a doubled-outline leak found during implementation — the source cells already carry `dd-hover-outline-cell` from `armColDrag` by clone time). Extended `test/webview/table-row-drag.spec.ts` with a new column-ghost-content test and updated `test/webview/drag-ghost.spec.ts`'s column test (previously asserted the old empty-placeholder behavior as correct — updated to assert real content + no leaked outline class). `npx tsc --noEmit` clean, `npx eslint media/webview/table.ts` clean, full `test/webview/` suite (35 specs) passes.

**Separate issue found during verification, NOT fixed here (out of scope for this bug):** `.dd-col-handle` has no clamp against the sticky toolbar's height (unlike `image-zoom.ts`'s equivalent fix from bug 0715 #6) — for a table sitting close enough to the top of the document that the column handle's reserved band (which sits *above* the header row) overlaps the toolbar's own band (`z-index: 160` vs. the handle's `z-index: 20`), the column handle becomes visually obscured and unclickable. Confirmed via a throwaway repro (table as the very first line in the document) before switching the real test to a document with a heading/paragraph above the table. Flagging for a future bug entry if the user wants it tracked — not filed as a numbered bug in this run since it wasn't the one asked for. **Manually re-checked by the user — this specific clamp issue does not reproduce; see the follow-up below for the actual size mismatch found instead.**

**Follow-up fix (2026-07-16):** user reported the column ghost's width/height didn't match the real column's. Root cause: the shared `.dd-ghost { max-height: 160px; overflow: hidden; }` base rule (meant to clip long block/li text-preview ghosts) was also clipping the column ghost's height on any table taller than 160px (more than a few rows) — the ghost's JS-set `style.height` (pinned to the real table height) was being overridden by that CSS clamp. Width was already correct. Fixed by raising `.dd-ghost-table`'s `max-height` from 160px to `90vh` (`media/editor.css`) — mirroring `.dd-ghost`'s own `max-width: 96vw` safety net against overflowing the viewport, rather than removing the cap outright. `.dd-ghost-table` is shared by both the row- and column-ghost, so this also lifts the old 160px clamp for an unusually tall single row (e.g. one containing an image or code block) — consistent with the existing "mirror the real row/column edge-to-edge" design intent for both, not a regression. Repro + regression test: `test/webview/table-row-drag.spec.ts` ("the ghost box matches the real column width and table height"), using an 8-row table to exceed the old 160px clip; confirmed failing pre-fix (clipped at exactly 160px) and passing post-fix. Full `test/webview/` suite (38 specs), roundtrip, and unit suites all pass; `npx tsc --noEmit` clean; `npx eslint` clean on changed files (one pre-existing unrelated `tsc` error in `drag-drop.ts:52` — `HANDLE_WIDTH_PX` declared but unused, a leftover from Bug #2's in-progress work, not touched by this fix).

### Description

Dragging a table column shows only an empty placeholder box (border + background, sized like the real column) — no header or cell content is visible in the drag preview. (Vietnamese: "gosh column cũng đang chỉ show column header -> ko show content mà chỉ show 1 cột giả chỉ có viền và background nhưng cùng cỡ với cột thật để kéo.")

### Root Cause

[`media/webview/table.ts:1041-1057`](../media/webview/table.ts#L1041-L1057) (`tdStartDragging`'s `'col'` branch) deliberately builds an empty ghost:

```ts
// table.ts:1041-1057
} else if (tdKind === 'col' && tdTable) {
  const headerRow = tdTable.tHead?.rows[0];
  const cell = headerRow?.cells[tdColIndex];
  if (cell) {
    // A column spans every row, so unlike the row/block ghost there's no single
    // element to clone that represents it — show a plain filled placeholder
    // (the ghost's own border/background) sized to the real column instead.
    const cellRect = cell.getBoundingClientRect();
    const tableRect = tdTable.getBoundingClientRect();
    tdGhostEl.replaceChildren();
    tdGhostEl.style.width = `${cellRect.width}px`;
    tdGhostEl.style.height = `${tableRect.height}px`;
  }
  for (const row of Array.from(tdTable.rows)) {
    row.cells[tdColIndex]?.classList.add('dd-source-muted');
  }
}
```

`tdGhostEl.replaceChildren()` with no arguments empties the ghost entirely — combined with `.dd-ghost-table { padding: 0 }` and base `.dd-ghost`'s `border`/`background` (`editor.css:170-192`), the result is exactly what the user describes: a bordered/filled box, correctly sized to the column, with zero content. Unlike the row-drag branch just above it (`table.ts:1032-1040`), which clones the real `<tr>` via `row.cloneNode(true)`, there's no equivalent single element to clone for a column (it's not one DOM node, it's one cell per row) — the code's own comment already documents this as a known simplification, not an oversight.

### Current State Snippet

See Root Cause above. Compare against the row branch, which does have real content:

```ts
// table.ts:1032-1040 (row branch, for contrast — already shows real content)
if (tdKind === 'row' && tdTable) {
  const row = tdRows[tdRowIdx];
  const rect = row.getBoundingClientRect();
  const clone = row.cloneNode(true) as HTMLElement;
  clone.classList.remove('dd-hover-outline');
  tdGhostEl.replaceChildren(clone);
  tdGhostEl.style.width = `${rect.width}px`;
  tdGhostEl.style.height = `${rect.height}px`;
  row.classList.add('dd-source-muted');
}
```

### Solution Direction

Build a real content-bearing ghost for columns the same way the row branch does, just assembled from multiple cells instead of cloning one element: clone the header cell plus every body row's cell at `tdColIndex` (`Array.from(tdTable.rows).map(r => r.cells[tdColIndex]?.cloneNode(true))`), and stack them vertically inside `tdGhostEl` (e.g. a small flex-column wrapper matching each row's real height, read from `row.getBoundingClientRect().height`, so the stacked clone visually lines up with the real column it's replacing). Lands entirely in `table.ts`'s `tdStartDragging` `'col'` branch; no `sibling-move.ts`/`drag-drop.ts` changes needed — this is a pure ghost-preview cosmetic fix, unrelated to the actual column-move logic (which already works correctly).

### Acceptance Criteria

-   [ ]  Dragging a table column shows a ghost preview that visibly resembles the real column — header cell content plus each row's cell content — not a blank box.
-   [ ]  The ghost's overall size still matches the real column's width/height (no regression to the existing sizing behavior).
-   [ ]  Row-drag ghost behavior is unaffected (different code branch).

### Test Requirements

Pure visual/DOM-content change to a drag-preview element, not `.md` serialization — the mandatory roundtrip-test rule doesn't apply (the actual column-move-and-serialize path is unchanged). Manual F5 test is the primary verification (drag a column, visually confirm the ghost shows content). Optionally extend `test/webview/table-row-drag.spec.ts`'s sibling coverage with a column-drag assertion that `tdGhostEl` has child nodes during a column drag. Run `npx tsc --noEmit` + `npx eslint media/webview/table.ts`.

### Isolation / Parallel Group

**Group Ghost** — `media/webview/table.ts` only (`tdStartDragging`). Standalone, safe in parallel with everything else. See preamble for the low-risk note against Bug #1 if both land in `table.ts` close together.

---

## Bug #5 — Mermaid block drag & drop doesn't work

**Status:** ✅ Fixed (2026-07-16) — confirmed to share Bug #3's root cause (`execCommand('insertHTML')` smart-merge), fixed by the same `applyBlockMove` change. Live Playwright regression added (`test/webview/drag-merge.spec.ts`: "mermaid block actually moves past a trailing paragraph") confirms the drag now completes and reorders correctly. See Bug #3 for the full fix writeup; full spec: `_bmad-output/quick-dev/spec-bug-0716-group-execcommand.md`.

### Description

Drag & drop for Mermaid diagram blocks isn't working. (Vietnamese: "drag & drop của mermaid block chưa hoạt động.")

### Root Cause

Traced the full chain end-to-end; **everything checks out on paper** — no static defect found in the code paths that would normally explain "doesn't work at all":

-   **The Mermaid wrapper IS recognized as a draggable top-level block.** [`postProcessMermaidDom`](../media/webview/dom-postprocess.ts#L140-L171) does not set `data-line`/`data-line-end` on the `.md-mermaid` wrapper div itself directly (unlike `postProcessMathDom`'s wrapper, which does) — but it doesn't need to: the original `<pre><code class="language-mermaid" data-line="…" data-line-end="…">` is kept as a child (`wrapper.appendChild(pre)`). [`ownOrNestedAttr`](../media/webview/block-info.ts#L10-L12) (`el.getAttribute(attr) ?? el.querySelector('[attr]')?.getAttribute(attr)`) finds it via `querySelector`, which searches descendants at any depth — so [`readSrcRange(wrapper)`](../media/webview/block-info.ts#L20-L27) succeeds, and [`draggableTopLevelBlocks`](../media/webview/drag-drop.ts#L89-L91) does include the mermaid wrapper.
-   **No CSS blocks it** — `.md-mermaid`/`.md-mermaid-chart` (`editor.css:916-988`) have no `pointer-events: none`.
-   **`mermaid.ts`'s own listeners are correctly scoped** — both its `mousedown` (line 53-57) and `click` (line 59-74) handlers start with `.closest('.md-mermaid-toggle')` and bail if not found; they never intercept events on the wrapper generally. The drag handle itself lives outside `#content` entirely (appended to `document.body`), so it's unaffected regardless.
-   **`isAtomBlock` has no hover/handle side effect** — it's only read by `needsSpacer` ([`drag-drop.ts:59-61`](../media/webview/drag-drop.ts#L59-L61), used at lines 118 and 206). `findBlockAt`/`onContentHover`/`armDrag` have zero mermaid-specific exclusions (only `<table>` is excluded).

**Confirmed gap instead: zero test coverage.** `grep` for "mermaid" across every `test/webview/*.spec.ts` file returns zero hits. `test/roundtrip/drag-drop.ts`'s own header comment states it does NOT exercise real `execCommand`/Selection behavior (hand-authors the expected post-move DOM instead of driving a real browser), and its one mermaid case only checks serialization of an already-separated pair — never an actual live drag. So this feature's real `execCommand('insertHTML')` behavior against a wholly-`contenteditable=false` block (Mermaid's entire visible surface is non-editable per `main.ts:340-343`'s own comment) has never been run against a real browser engine.

### Current State Snippet

No single defective snippet — see Bug #3's `applySiblingMove` snippet (`sibling-move.ts:91-105`), which is the shared suspect mechanism (see below).

### Solution Direction

Live-debug in the Webview Developer Tools first, in this order: (a) confirm the handle appears over a mermaid block on hover, (b) confirm `mousedown` on it fires `armDrag`, (c) confirm the ghost/drop-line render during the drag, (d) confirm whether `execCommand('insertHTML', ...)` on mouseup actually mutates the DOM at all. If (a)-(c) work but (d) silently no-ops, the cause is almost certainly the same class of Chromium `execCommand` quirk found (and live-repro'd) for Bug #3 — a Range whose content is entirely `contenteditable=false` behaving unreliably under `execCommand('insertHTML')`'s delete/insert heuristics. **Do not implement a fix for this bug independently of Bug #3's Group ExecCommand decision** — confirm first via a live Playwright repro (see Test Requirements) whether the same fix direction resolves this too.

### Acceptance Criteria

-   [ ]  A Mermaid block's drag handle appears on hover, identically to any other block.
-   [ ]  Dragging it reorders the block exactly once among its siblings, with no leftover/duplicate node and no content loss.

### Test Requirements

Per the Mandatory Rule (Webview Interaction Test) — this is exactly the kind of real interactive `execCommand`/Selection behavior that can't be verified from a hand-built DOM snapshot, and today has zero coverage. Add a new Playwright spec (`test/webview/mermaid-drag.spec.ts` or extend `drag-handle.spec.ts`) that: hovers a Mermaid block, confirms the handle appears, performs a real drag, and inspects `#content.innerHTML` after drop to confirm the move actually happened (or, if it silently no-ops, that becomes the confirmed repro to fix against). Run this BEFORE writing any fix — this bug currently has no confirmed mechanism, only a strong hypothesis. Run `npx tsc --noEmit` once any change lands.

### Isolation / Parallel Group

**Group ExecCommand** — see preamble and Bug #3. Do not treat as fully independent of #3/#6.

---

## Bug #6 — Dragging a math block below a mermaid block duplicates the math block

**Status:** ✅ Fixed (2026-07-16) — confirmed to share Bug #3's root cause (`execCommand('insertHTML')` smart-merge), fixed by the same `applyBlockMove` change. Live Playwright regression added (`test/webview/drag-merge.spec.ts`: "math block dragged next to a mermaid block yields exactly one .md-math-block") confirms no duplicate node after the move. See Bug #3 for the full fix writeup; full spec: `_bmad-output/quick-dev/spec-bug-0716-group-execcommand.md`.

### Description

Dragging a math block down to just below a mermaid block causes the math block to be duplicated in the document. (Vietnamese: "kéo block math xuống dưới block mermaid làm duplicate block math.")

### Root Cause

**Ruled out, with hand-traced confirmation:**

-   `computeSiblingMove`'s index math ([`sibling-move.ts:52-83`](../media/webview/sibling-move.ts#L52-L83)) — hand-traced against `[Math, Mermaid, After]` (drag Math to gap=2) and a second end-of-list scenario. `newSpanEls = newOrder.slice(lowOrig, highOrig+1)` can never contain the same element twice (`remaining`/`span` are disjoint by construction), so `result.html` contains exactly one `Math.outerHTML` in both traces. The `needsSpacer(Mermaid, Math)` → `<p><br></p>` insertion and `movedHopCount` bookkeeping both resolved correctly.
-   `turndown.ts`'s `mathBlock` rule ([`turndown.ts:199-205`](../media/webview/turndown.ts#L199-L205)) — a plain `classList.contains` filter visited once per DOM node by TurndownService; it can only emit two `$$...$$` blocks if the live DOM genuinely already contains two `.md-math-block` elements, not from a serialization-side bug.
-   `ensureCaretSpotAfterAtomBlocks`/`ensureTrailingParagraph` — grepped every call site (`main.ts:307, 671, 882`); both are only invoked from `insertMarkdownAtCaret` (toolbar insert) and initial `renderDocument`, never from the drag-drop/`sibling-move.ts` path.

**Leading suspect (inferred from Bug #3's confirmed mechanism, not yet independently live-repro'd for this exact scenario):** the same [`applySiblingMove`](../media/webview/sibling-move.ts#L91-L105) / `execCommand('insertHTML')` call implicated in Bug #3. Chromium's delete-selection algorithm inside `execCommand` can decline to remove a wholly-`contenteditable=false` node (treating it as "unremovable") while the paste step still inserts the fresh copy from `result.html` — leaving the *original* node behind alongside the newly-inserted one, i.e. two `.md-math-block` elements in the live DOM, which then both serialize on the next `scheduleSync()`. This is plausible specifically for a Mermaid-adjacent drop because, per `main.ts:340-343`'s own comment, Mermaid in chart view is "the heaviest" atom block — its entire visible surface is non-editable, more so than Math's (which still has an editable toggle button region).

### Current State Snippet

```ts
// drag-drop.ts:59-61 — isAtomBlock, and its one call site (needsSpacer)
function isAtomBlock(el: Element): boolean {
  return el.classList.contains(MERMAID_CLASS) || el.classList.contains(MATH_BLOCK_CLASS);
}
```

See Bug #3's `applySiblingMove` snippet (`sibling-move.ts:91-105`) for the suspect mechanism.

### Solution Direction

**Do not implement independently of Bug #3's Group ExecCommand decision** (see preamble). First, confirm the mechanism live: add a Playwright spec that drags Math to just after Mermaid and inspects `#content.innerHTML` immediately after drop, specifically checking whether the *original* Math node is still present in addition to the newly-inserted one. If confirmed, the fix likely means abandoning single-`execCommand('insertHTML')` for atom-adjacent moves in favor of explicit `Range.deleteContents()` + `Range.insertNode()`/`DocumentFragment` insertion (bypassing `execCommand`'s selection-deletion heuristics entirely) for this class of move — which is Option 3 from Bug #3's Solution Direction, generalized to cover atom blocks as well as blockquote/pre. This ripples into `applySiblingMove`, shared by `drag-drop.ts` block/heading-section moves AND `table.ts` row moves, so any fix needs to preserve the existing single-native-undo-step guarantee for the unaffected common case.

### Acceptance Criteria

-   [ ]  Dragging a math block to be adjacent to a mermaid block (either order) results in exactly one copy of the math block's content in the final DOM and in the serialized markdown.
-   [ ]  The two atom blocks remain separated by the existing spacer paragraph (`needsSpacer` behavior) — unaffected by this fix.
-   [ ]  No leftover/detached duplicate node remains in `#content` after the move.

### Test Requirements

Per the Mandatory Rule (Webview Interaction Test) — this is real `execCommand`/Selection behavior, unconfirmed by static reading, so a live Playwright repro is required BEFORE writing a fix (see Solution Direction). Add to `test/webview/` (new spec or extend `drag-handle.spec.ts`): drag Math to just after Mermaid, assert `document.querySelectorAll('.md-math-block').length === 1` post-drop. Once a fix lands, also add a roundtrip case to `test/roundtrip/drag-drop.ts` for the resulting markdown (single `$$...$$` block, not two). Run `npx tsc --noEmit` + `npx eslint media/webview/sibling-move.ts`.

### Isolation / Parallel Group

**Group ExecCommand** — see preamble and Bug #3. Shares `sibling-move.ts`'s `applySiblingMove` with #3 and (suspected) #5 — fix and verify together, not as three separate patches.

---

## Bug #7 — Dragging a list item with horizontal drift silently triggers indent, producing malformed nested-list DOM

**Status:** 🔴 Open — root cause confirmed via live Playwright repro; distinct from Bug #3/Group ExecCommand (different native command, different DOM shape).

### Description

Dragging a task-list item down and dropping it just below another item makes the task item become a nested (child) item of the item now below it. (User's own words: "drag task list item xuống dưới 1 item khác -> bản thân task item đó VÀ toàn bộ các element nằm giữa vị trí gốc của task và điểm thả đều bị biến thành nested item của item ngay dưới task" — the task item itself AND every element between its origin and the drop point become nested under the item right below.)

### Root Cause

Confirmed via a live Playwright repro against the real compiled `dist/webview/main.js` (using the existing `test/webview/_harness.ts` pattern). **This is NOT the same mechanism as Bug #3/Group ExecCommand** — that was independently ruled out first: `finishLiMove` (`drag-drop.ts:735-736`, `computeSiblingMove`/`applySiblingMove` on `liSiblings`) was live-tested with multi-hop moves, single-hop swaps, end-of-list drops, and drops adjacent to an `<li>` containing its own nested `<ul>` (the closest analog to Bug #3's blockquote/pre case) — every case produced a flat, correctly-ordered DOM with no nesting and no duplicate `data-block-id`. WebKit's `ReplaceSelectionCommand` "smart merge" quirk (Bug #3's confirmed cause) does not trigger for plain `<li>`\-to-`<li>` Range boundaries.

**The real, distinct cause:** [`updateLiDropLine`](../media/webview/drag-drop.ts#L587-L633)'s horizontal-drift indent detection:

```ts
// drag-drop.ts:591-597
const dx = clientX - startX;
const gap = liGapAt(clientY);
currentGap = gap;
if (Math.abs(dx) > LIST_INDENT_THRESHOLD_PX) {
  liIndentDir = dx > 0 ? 'in' : 'out';
  ...
```

`LIST_INDENT_THRESHOLD_PX` ([`drag-drop.ts:48`](../media/webview/drag-drop.ts#L48)) is **32px** — easily crossed by ordinary horizontal wobble during a vertical drag gesture (the li-handle itself sits 22px left of the item's own content, so even approaching the handle involves horizontal movement). Once crossed, `finishLiMove` takes a completely different branch:

```ts
// drag-drop.ts:731-734
if (liIndentDir) {
  performListIndent(liDragged, liIndentDir === 'in' ? 'indent' : 'outdent');
  return;
}
```

```ts
// drag-drop.ts:716-724 (performListIndent)
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
```

Live repro (dragging Task B down toward Task C with ~40px of natural horizontal drift — well within an ordinary mouse gesture) produced this persisted DOM:

```html
<ul class="contains-task-list" ...>
<li ...>Task A</li>
<ul><li ...>Task B</li></ul>
<li ...>Task C</li>
<li ...>Task D</li>
</ul>
```

A bare `<ul>` is inserted as a **direct sibling of `<li>` elements inside the parent `<ul>`** — invalid list nesting (should be `<li>Task A<ul><li>Task B</li></ul></li>`) — produced by Chromium's own native `execCommand('indent')`, not by anything in `sibling-move.ts`. **Identical shape for plain (non-task) lists** — confirmed not task-list-specific; the user's report likely just describes whichever list they happened to test with.

This malformed shape is never repaired: [`main.ts`](../media/webview/main.ts#L457-L461)'s `input` listener only runs `fixOrphanNestedListItems()` for `deleteContentBackward`/`Forward`/`Cut`/`Undo`/`Redo`/`Paste`\-class `inputType`s — `execCommand('indent')` isn't one of them — and `scheduleSync`/`syncNow` (`main.ts:394-406`) only serializes whatever DOM shape already exists, it never corrects it. So this malformed structure is exactly what gets turndown-serialized into the saved `.md`.

**Reconciling against the user's exact wording:** the confirmed repro only nests the single dragged item, not "every element between the origin and the drop point" as described. This is the closest, most concrete, reproducible match found — flagging the discrepancy explicitly rather than forcing a false match. If a live re-test shows a wider span genuinely getting nested (e.g. a different drag path, or several quick successive drags each accidentally triggering indent), that would need a follow-up repro rather than assuming this write-up already covers it.

### Current State Snippet

See Root Cause above (`drag-drop.ts:48, 591-597, 716-724, 731-734`).

### Solution Direction

Two independent layers, both worth doing (not either/or, mirrors Bug #10's two-layer pattern from `test/bug 0716.md`):

1.  **Reduce accidental triggering** — raise `LIST_INDENT_THRESHOLD_PX` and/or require the horizontal drift to be sustained (e.g. a minimum hold duration or hysteresis) rather than a single 32px crossing measured from the drag's start position, so ordinary vertical-drag wobble doesn't silently flip into indent mode. This is a UX tuning call, not purely mechanical — flag for a quick sanity check with the user on the new threshold/gesture feel rather than picking a number silently.
2.  **Make the indent result safe regardless of (1)** — normalize `execCommand('indent')`'s output the same way `fixOrphanNestedListItems` already normalizes other orphan-list shapes: either add indent-triggering to the `input` listener's inputType allowlist (`main.ts:457-461`, note `execCommand('indent')` may not fire a standard `inputType` the same way — verify what `input` event, if any, actually fires for this call), or extend `findOrphanNestedListPair`\-style detection to also catch a bare `<ul>` sibling among `<li>`s and re-nest it correctly. This is the safety net that keeps the document valid even if (1)'s threshold tuning doesn't fully eliminate accidental triggers.

### Acceptance Criteria

-   [ ]  Dragging a list item (task or plain) straight down/up to reorder it, with ordinary incidental horizontal mouse wobble, does not trigger indent mode or produce any nested-list structure.
-   [ ]  An intentional horizontal drag (past the tuned threshold, sustained) still triggers indent/outdent as designed — this is an existing feature (M3), not to be removed.
-   [ ]  If indent/outdent does fire (intentionally or not), the resulting DOM is always valid list nesting (`<ul>`/`<ol>` only ever appears as a child of an `<li>`, never as a direct sibling of `<li>` elements) — verified immediately after the `execCommand` call, not just eventually on next edit.
-   [ ]  Serializing to markdown after an indent/outdent never produces a structurally broken list.

### Test Requirements

This alters raw `.md` content via list indent, and the defect is a real `execCommand`/Selection behavior invisible to hand-built DOM snapshots — per both Mandatory Rules (Roundtrip Test AND Webview Interaction Test), needs a live Playwright regression test. Add to `test/webview/` (extend `drag-handle.spec.ts` or a new `drag-li-indent.spec.ts`): drag a list item with ~40px horizontal drift during an otherwise-vertical reorder and assert no bare `<ul>` ends up as a direct sibling of `<li>` elements; separately test an intentional threshold-crossing drag still indents correctly. Add a roundtrip case to `test/roundtrip/lists.ts` (or closest existing suite) confirming the post-indent markdown is well-formed. Run `npx tsc --noEmit` + `npx eslint media/webview/drag-drop.ts media/webview/main.ts`.

### Isolation / Parallel Group

**Group ListIndent** (new) — `media/webview/drag-drop.ts` (`updateLiDropLine`, `performListIndent`, `LIST_INDENT_THRESHOLD_PX`) + `media/webview/main.ts` (`fixOrphanNestedListItems`/orphan-list normalization, if Solution Direction's layer 2 is implemented). Shares `drag-drop.ts` with Group Handle (#1, #2) but touches different functions (list-indent detection vs. hover/handle hit-testing) — low overlap risk, sequence only if landing very close together in the same PR. Independent of Group ExecCommand (#3/#5/#6, confirmed distinct mechanism — see Root Cause) and Group Ghost (#4). Also worth noting: `table.ts` row drag shares `computeSiblingMove`/`applySiblingMove` with the li-move path but has no indent-mode equivalent, so it is NOT affected by this specific bug.
