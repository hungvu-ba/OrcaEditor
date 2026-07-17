# Bug 0717 — Round 2

Follow-up on the original "Bug 0717" (pressing Enter mid-list leaves a genuinely
empty `<li>`, see `test/roundtrip/lists.ts` around line 221) after that fix
landed. User re-reported (with a screenshot, 2026-07-17) that pressing Enter in
a real bullet list still corrupts the raw markdown in two ways the original
fix's two synthetic fixtures (`<li><br></li>` and a zero-child `<li>`) don't
cover:

1.  The empty item's line comes out as `*   \` (a literal trailing backslash)
    instead of a clean `*   `.
2.  A spurious blank line appears between the empty item and the next item,
    splitting what should be one `<ul>` into two separate list blocks in the
    markdown — even though the preview still renders them as one visually
    continuous list.

Investigated live against the real compiled `dist/webview/main.js` via
Playwright (per this repo's Mandatory Rule — Webview Test), not just hand-built
HTML fixtures, since the original Bug 0717 fixtures already didn't reproduce
this. Two independent root causes confirmed, sharing no code path — write-up
below is split into two bugs accordingly.

---

**Parallel groups**: both bugs land in `media/webview/turndown.ts` but touch
different, non-overlapping rules (`emptyListItemBr` for #1, list/blockquote
serialization + a new DOM-merge step for #2) — no line overlap, safe to fix in
either order or in the same pass by one engineer.

---

## Bug #1 — Empty list item serializes to a literal backslash instead of a clean blank line

### Description

After the item that follows a real Enter/Backspace edit sequence in a bullet
list ends up "empty" (no visible text), the saved markdown shows a literal `\`
character on that line (e.g. `*   \`) instead of a clean empty `*   ` line,
per the screenshot's Section 1 list (`test/sample-18.4b-style-preservation.md`,
"Edit-me pad" note: click the empty bullet, type a character, then delete it).

### Root Cause

[`media/webview/turndown.ts:323-332`](../media/webview/turndown.ts#L323-L332),
rule `emptyListItemBr`, only strips a `<br>` when it is the **sole** child of
its `<li>`:

```ts
td.addRule('emptyListItemBr', {
  filter: (node) => {
    if (node.nodeName !== 'BR') return false;
    const li = node.parentElement;
    return !!li && li.nodeName === 'LI' && li.childNodes.length === 1;
  },
  replacement: () => '',
});
```

Combined with this branch's US-18.4b convention `br: '\\'` (backslash hard
break, `turndown.ts` init options), ANY `<li>` that browser-native Enter/
Backspace leaves with more than one child node around a `<br>` — even though
the item is still visually/textually "empty" — falls through to turndown's
default `br` rule and emits a literal `"\\\n"` plus an extra indented
continuation line.

Confirmed live (via a throwaway Playwright + `serializeHtml` repro run against
the real `prepareDomForSerialize` + `turndown` pipeline, not just a hand-typed
fixture):

-   `<li><br><br></li>` (two `<br>` elements — a plausible real-world residue
    of Chromium's Enter-into-empty-line handling) → `"*   a\n*   \\\n    \\\n    \n*   c\n"`,
    i.e. the backslash reproduces through the FULL production pipeline, not
    just a hand-built edge case.
-   A `<br>` with a trailing whitespace-only text-node sibling reproduces the
    same corruption when `prepareDomForSerialize`'s own normalization doesn't
    happen to collapse that particular text node away first — i.e. the bug is
    the rule's fragile `childNodes.length === 1` assumption, not one single
    exact DOM shape.

The original Bug 0717 fix's two fixtures (`<li><br></li>`, a single `<br>`) and
(`<li></li>`, zero children) are each exactly one `childNodes.length` value
(1 and 0) — neither exercises the `length >= 2` case that real Enter/Backspace
interaction can and does produce.

### Current State Snippet

See Root Cause above — the full current rule, verbatim, is the snippet.

### Solution Direction

Broaden `emptyListItemBr`'s filter from an exact child-count check to an
"is this `<li>` textually empty and does it contain only `<br>` element(s) (no
other non-whitespace content)" check — e.g. strip a `<br>` whenever its parent
`<li>`'s `textContent.trim() === ''` and every other child node is either
another `<br>` or a whitespace-only text node. This keeps the rule targeted
(never fires on an `<li>` with real content) while no longer depending on the
exact number of nodes Chromium happens to leave behind. Lands entirely in
`turndown.ts`'s `emptyListItemBr` rule — no other file needs to change for
this half of the bug.

### Acceptance Criteria

-   [ ] An `<li>` containing only `<br>` element(s) and/or whitespace-only text
    nodes (no real text) serializes to a clean empty bullet/ordinal line, with
    no literal `\` and no extra indented continuation line, regardless of how
    many `<br>`s/whitespace nodes it contains.
-   [ ] An `<li>` with REAL text content followed by a trailing `<br>` (an
    intentional in-item hard break) is unaffected — it must still serialize
    the hard break as `\` (that is correct, existing US-18.4b behavior, not
    part of this bug).
-   [ ] The two existing Bug 0717 fixtures (`test/roundtrip/lists.ts` ~line
    230-253) still pass unchanged.

### Test Requirements

Per the Mandatory Rule (Roundtrip Test) — add DOM cases to
`test/roundtrip/lists.ts` alongside the existing Bug 0717 cases: (a)
`<ul><li>a</li><li><br><br></li><li>c</li></ul>` → clean empty middle bullet,
no backslash; (b) an `<li>` with a `<br>` plus a whitespace-only trailing text
node → same. Also add a live Playwright case (per the Mandatory Rule — Webview
Test, since the real trigger is genuine Enter/Backspace browser behavior) to
`test/webview/` — e.g. extend `list-verbs-clean-target.spec.ts` or a new
`list-enter-empty.spec.ts`: place caret at end of a middle list item, press
Enter, type one character, delete it (Backspace), and assert the posted
markdown has a clean empty bullet line with no `\`. Run
`npx tsc --noEmit`, `npm run test:roundtrip:lists`, `npm run test:webview`.

### Isolation / Parallel Group

`media/webview/turndown.ts` (`emptyListItemBr` rule only). No overlap with
Bug #2's code path (see below) — safe in either order.

---

## Bug #2 — Enter twice at the end of a list item splits the list with a spurious blank line

### Description

Same screenshot: between two of the visually-contiguous bullet items, the raw
markdown has a blank line, which turns what the preview still shows as ONE
continuous `<ul>` into two separate list blocks in the saved `.md` file.

### Root Cause

Confirmed live via real keyboard-driven Playwright (`press('Enter')` twice at
the end of an existing list item's text, e.g. the "fsdf" item): Chromium's
native "exit the list on a second Enter at an empty line" behavior splits one
`<ul>` into two sibling `<ul>` elements with an empty paragraph in between.
Captured real DOM after the two Enters:

```html
<ul data-block-id="block-1"><li>keep plus df</li><li>fsdf</li></ul><p><br></p><ul data-block-id="block-1"><li>fdfskfd</li><li>dfsdfs</li><li>still plus</li></ul>
```

Feeding this exact HTML through the real production pipeline
(`prepareDomForSerialize` + `turndown`) gives:
`"*   keep plus df\n*   fsdf\n\n*   fdfskfd\n*   dfsdfs\n*   still plus\n"` —
matching the screenshot exactly, including the blank line. The `<p><br></p>`
itself is silently dropped by the existing `emptyParagraph` rule
(`media/webview/turndown.ts:419-433`), so it's cosmetically invisible in the
output, but the real cause is structural: turndown always separates two
sibling block-level elements with `"\n\n"`, and after the double-Enter there
genuinely are two `<ul>` elements, not one. Bonus confirmed side effect: the
second (split-off) `<ul>` loses this branch's custom bullet-marker tracking
(falls back to the default `*` marker) since it's no longer associated with
the original tracked block — not visible in this screenshot (both segments
already use `*`) but would corrupt a non-default marker.

Not the same mechanism as Bug #1 — `computeSiblingMove`/`applySiblingMove`
style corruption was ruled out; this is a plain native `execCommand`
list-exit behavior, nothing to do with `emptyListItemBr`.

### Current State Snippet

No single defective line — see Root Cause above for the captured DOM shape.
Relevant existing precedent for post-hoc DOM repair after a native
`execCommand` side effect: `fixOrphanNestedListItems` in
`media/webview/main.ts` (search for its definition and its call site in the
`input` event listener's inputType allowlist), which already repairs a
different Chromium list-corruption quirk the same way this bug would need to.

### Solution Direction

Two possible layers, pick at least one, both discussed in the existing
Group ExecCommand precedent from `test/bug 0716round 2.md`'s Bug #7 (two-layer
pattern: reduce accidental triggering + make the result safe regardless):

1.  **Normalize at serialize time**: in `dom-serialize-prep.ts`'s
    `prepareDomForSerialize` (or a new step in the same file), merge adjacent
    sibling `<ul>`/`<ol>` elements of the same list type when they're
    separated only by an empty/whitespace-only `<p>` — folding the second
    list's `<li>`s back into the first before turndown ever sees them. This
    fixes the output regardless of exactly how two adjacent lists came to
    exist.
2.  **Normalize live in the DOM**: following the exact precedent of
    `fixOrphanNestedListItems` (`media/webview/main.ts`), detect this same
    "two sibling same-type lists separated by an empty paragraph" shape in the
    `input` event listener and re-merge immediately, so the live document
    itself never carries the malformed structure (not just the saved
    markdown). Per this repo's Mandatory Rule (Reuse Shared Modules), the
    actual merge/re-nest logic belongs in `media/webview/list-ops.ts`
    (list-structure transforms), called from `main.ts`'s listener the same
    way `fixOrphanNestedListItems` is today.

Recommend doing both — (2) keeps the live DOM correct (matters for anything
else that reads `#content`, e.g. future edits, undo), (1) as a defense-in-depth
safety net at serialize time in case some other path produces the same shape.
Flag to the user/reviewer before implementing which layer(s) to actually do,
since this is a design decision, not a one-liner.

### Acceptance Criteria

-   [ ] Pressing Enter twice at the end of any list item, anywhere in the
    list (first, middle, last), never produces a blank-line split in the
    saved markdown — the list stays one block.
-   [ ] The custom bullet marker (or ordinal numbering, for `<ol>`) is
    preserved identically across what would have been the split point.
-   [ ] If the user's intent was genuinely to end the list (e.g. Enter twice
    at the very last item to start a new paragraph after the list), that
    still works — this fix must only merge lists that are still logically
    "the same list", not prevent intentionally exiting list mode at the end
    of the document.

### Test Requirements

Per both Mandatory Rules (Roundtrip Test AND Webview Interaction Test) — this
is real native `execCommand`/Enter-key behavior invisible to a hand-built DOM
snapshot. Add a live Playwright spec (`test/webview/`, e.g. extend
`list-verbs-clean-target.spec.ts` or a new `list-enter-split.spec.ts`): press
Enter twice at the end of a middle list item, assert the resulting saved
markdown has no blank line between the two segments and the bullet marker is
unchanged. Once a fix lands, add the corresponding DOM case (the exact
two-`<ul>`-plus-empty-`<p>` shape captured above) to `test/roundtrip/lists.ts`
so future turndown/prepareDomForSerialize changes can't silently regress it
without a live browser. Run `npx tsc --noEmit`, `npm run test:roundtrip:lists`,
`npm run test:webview`.

### Isolation / Parallel Group

`media/webview/dom-serialize-prep.ts` and/or `media/webview/main.ts` +
`media/webview/list-ops.ts` (depending on which layer(s) from Solution
Direction are implemented). No overlap with Bug #1's `turndown.ts`
`emptyListItemBr` rule — safe in either order or the same pass.
