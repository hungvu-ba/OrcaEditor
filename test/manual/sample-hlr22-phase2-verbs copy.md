# HLR 22 Phase 2 Manual Test Data & Checklist — execCommand List/Block Verb Replacement

<!-- Setup: verifies Phase 2.1-2.7 (see Plan/execCommand List-Block Verb
     Replacement — Code Plan.md) in the REAL Orca Editor (Extension
     Development Host), on top of the automated suite (`test:roundtrip`/
     `test:unit`/`test:webview`), which drives a Playwright harness that
     mimics but is not identical to the real VS Code webview.

     1. Run the extension (F5 in VS Code, or the `run` skill) -> Extension
        Development Host opens.
     2. Open THIS file with Orca Editor (right-click -> "Open With..." ->
        Orca Editor, or set as default).
     3. Work through every TC below in order — each TC has its own isolated
        content block so edits don't cross-contaminate. Undo (Ctrl/Cmd+Z)
        after each TC to reset that block before moving to the next one, OR
        just eyeball the THEN condition and move on (blocks are independent).
     4. For any TC, you can right-click -> Inspect (or open DevTools on the
        webview) to check the live DOM shape directly if the rendered
        preview alone doesn't make the shape obvious (e.g. "no `<p><ul>`
        nesting", "no stray `<span style=...>`").
     5. Save once at the end (Cmd+S/Ctrl+S) to flush pending sync, then check
        the saved markdown isn't corrupted (reopen in a plain text editor or
        `git diff`).
     6. Fill in the Sign-off table at the bottom. -->

---

## Phase 2.1 — Outdent (Shift+Tab)

### \

### TC2.1a — Basic outdent: later siblings re-nest under the outdented item

<!-- WHEN: put the caret anywhere in "Charlie", press Shift+Tab.
     THEN: Bravo stays nested under Alpha (unchanged). Charlie becomes
     Alpha's own sibling (top-level). Delta re-nests as CHARLIE's own child
     (its own new sublist) — not left as Alpha's child, not orphaned. No
     empty `<ul>` left behind under Alpha. No stray `<span style="...">`
     wrapping any text (right-click -> Inspect to confirm if unsure). -->

-   Alpha
    -   Bravo

*   Charlie
*   Delta

### TC2.1b — Outdent right after Enter (fresh empty nested item)

<!-- WHEN: click at the end of "Bravo", press Enter (creates a new EMPTY
     item nested under Alpha, right after Bravo), then immediately press
     Shift+Tab.
     THEN: the NEW empty item outdents (becomes Alpha's own sibling, empty).
     Bravo's own text/nesting is untouched — Shift+Tab must not accidentally
     act on Bravo instead of the fresh empty item. -->

-   Alpha
    -   Bravo
-   
-   Charlie

---

## Phase 2.2 — Indent (Tab)

### TC2.2a — Basic indent: creates `li > ul`, not `ul > ul`

<!-- WHEN: caret anywhere in "Bravo", press Tab.
     THEN: Bravo nests under Alpha as Alpha's own sublist item. Charlie
     remains a top-level sibling of Alpha (unaffected). Inspect if unsure:
     the shape must be `<li>Alpha<ul><li>Bravo</li></ul></li>`, never a bare
     `<ul>` sitting as a sibling of `<li>` elements. -->

-   Alpha
-   Bravo
-   Charlie

### TC2.2b — Indent when the previous sibling already has a sublist

<!-- WHEN: caret anywhere in "Bravo", press Tab.
     THEN: Bravo is appended as the LAST item inside Alpha's EXISTING
     sublist (after "existing child") — not a second, separate `<ul>` under
     Alpha. -->

-   Alpha
    -   existing child
-   Bravo

### TC2.2c — Indent right after Enter (fresh empty item)

<!-- WHEN: click at the end of "Bravo", press Enter (creates a new EMPTY
     top-level item right after Bravo), then immediately press Tab.
     THEN: the NEW empty item indents under Bravo (becomes Bravo's child).
     Bravo's own text is untouched — Tab must not accidentally indent Bravo
     itself under Alpha. -->

-   Alpha
-   Bravo

---

## Phase 2.3 — Bullet list button

### TC2.3a — Plain paragraphs (not yet in a list) → clean tight bullet list

<!-- WHEN: select from the start of "First paragraph" through the end of
     "Second paragraph", click the toolbar's Bullet button.
     THEN: both become ONE tight `<ul>` ("* First paragraph" / "* Second
     paragraph") — no leftover empty `<p>` nearby, and the `<ul>` is NOT
     nested inside a leftover `<p>` (inspect: no `p > ul`). -->

First paragraph

Second paragraph

### TC2.3b — Selection spanning a blank line → blank line dropped, no empty bullet

<!-- WHEN: click at the end of "Alpha" below, press Enter TWICE (creates a
     genuinely empty paragraph between Alpha and Bravo), then select from
     the start of "Alpha" through the end of "Bravo" (spanning that empty
     paragraph), click the toolbar's Bullet button.
     THEN: exactly TWO bullet items appear ("* Alpha", "* Bravo") — no empty
     bullet in between for the blank line. -->

Alpha

Bravo

### TC2.3c — In an `<ol>`: converting one item to bullet splits the list correctly

<!-- WHEN: caret anywhere in "Bravo" ONLY (do not select all three), click
     the toolbar's Bullet button.
     THEN: Bravo becomes its own single-item bullet list ("* Bravo"). Alpha
     stays numbered "1." above; Charlie becomes its own new `<ol>` below,
     renumbered starting at "1." (this is the documented split-list
     behavior, not a bug). -->

1.  Alpha
2.  Bravo
3.  Charlie

### TC2.3d — In a `<ul>`: toggling one item off reverts it to a plain paragraph

<!-- WHEN: caret anywhere in "Bravo" ONLY, click the toolbar's Bullet button
     (toggle off).
     THEN: Bravo becomes a plain paragraph (no bullet, no leftover styling
     span). Alpha and Charlie remain bulleted, split into their own `<ul>`s
     around Bravo. -->

*   Alpha
*   Bravo
*   Charlie

### TC2.3e — Task item → Bullet strips the checkbox

<!-- WHEN: caret in "Alpha" below, click the toolbar's Bullet button.
     THEN: the checkbox is removed; Alpha becomes a plain bullet ("* Alpha"),
     no longer a task item, no stray leading space where the checkbox was. -->

1.  [ ]  Alpha

-   [ ]  Alpha

1.  [ ]  V

---

## Phase 2.4 — Numbered list button (ordered mirror of 2.3)

### TC2.4a — Plain paragraph (not yet in a list) → clean numbered list

<!-- WHEN: select from the start of "Hello" through the end of "world" (one
     paragraph, or select across both lines below), click the toolbar's
     Numbered button.
     THEN: becomes a clean `<ol>` ("1. Hello" / "2. world" if two paragraphs,
     or a single "1. Hello world" item) — the `<ol>` is NOT nested inside a
     leftover `<p>` (inspect: no `p > ol`). -->

Hello

world

### TC2.4b — Selection spanning a blank line → blank line dropped

<!-- WHEN: click at the end of "Alpha" below, press Enter TWICE (creates a
     genuinely empty paragraph), then select from the start of "Alpha"
     through the end of "Bravo" (spanning that empty paragraph), click the
     toolbar's Numbered button.
     THEN: exactly TWO numbered items appear ("1. Alpha", "2. Bravo") — no
     empty item in between. -->

Alpha

Bravo

### TC2.4c — In a `<ul>`: converting one item to numbered splits the list correctly

<!-- WHEN: caret anywhere in "Bravo" ONLY, click the toolbar's Numbered
     button.
     THEN: Bravo becomes its own single-item numbered list ("1. Bravo").
     Alpha and Charlie remain bulleted, in their own `<ul>`(s) around Bravo. -->

*   Alpha

1.  Bravo

*   Charlie

### TC2.4d — In an `<ol>`: toggling one item off reverts it to a plain paragraph

<!-- WHEN: caret anywhere in "Bravo" ONLY, click the toolbar's Numbered
     button (toggle off).
     THEN: Bravo becomes a plain paragraph (no styling span). Alpha/Charlie
     remain numbered, split into their own `<ol>`s (each renumbering from
     "1.") around Bravo. -->

1.  Alpha

Bravo

Charlie

### TC2.4e — Task item → Numbered strips the checkbox, keeps it a list item

<!-- WHEN: caret in "Alpha" below, click the toolbar's Numbered button.
     THEN: the checkbox is removed; Alpha becomes "1. Alpha", no longer a
     task item. -->

1.  Alpha

---

## Phase 2.5 — Heading button (formatBlock)

### TC2.5a — Plain paragraph → Heading 2

<!-- WHEN: caret in "Hello world" below, click the toolbar's main Heading
     button (H2).
     THEN: becomes "## Hello world". -->

Hello world

TC2.5b — Heading toggled TWICE (H2 → paragraph) never nests headings

<!-- WHEN: caret in "Hello world" below, click the Heading button (becomes
     H2), then click it again (should revert to plain paragraph).
     THEN: after the SECOND click, it's back to a plain paragraph "Hello
     world" — no heading tag survives, and at no point does a heading end up
     nested inside another heading (inspect if unsure: no `h1 h1`/`h2 h2`/
     any `h# h#` combination). -->

Hello world

### TC2.5c — Heading level change via dropdown (H2 → H4)

<!-- WHEN: caret in "Hello world" below, click the Heading button once (→
     H2), then use the toolbar's heading dropdown to pick "Heading 4".
     THEN: becomes "#### Hello world" (H4), cleanly replacing H2 — no
     leftover H2 wrapper, no nested heading tags. -->

#### Hello world

---

## Phase 2.6 — Blockquote button + `>` input rule

### TC2.6a — Plain paragraph → Blockquote → toggle off, both clean

<!-- WHEN: caret in "Hello world" below, click the toolbar's Blockquote
     button.
     THEN: becomes a proper blockquote ("> Hello world") — canonical shape
     is `<blockquote><p>Hello world</p></blockquote>`, never
     `<p><blockquote>...` (inspect if unsure).
     WHEN (continued): with caret still inside the quoted text, click the
     Blockquote button again (toggle off).
     THEN: reverts to a clean plain paragraph "Hello world" — no leftover
     `<blockquote>`, no stray empty paragraph nearby. -->

> Hello world

### TC2.6b — `>` input rule auto-converts to blockquote while typing

<!-- WHEN: click at the start of the (empty) line below this comment, type
     `> ` (greater-than, then a space) followed by "Quoted line".
     THEN: it auto-converts to a blockquote ("> Quoted line") as you type —
     canonical `<blockquote><p>` shape, not nested inside a leftover `<p>`. -->

> Type here
> 
> \>

---

## Phase 2.7 — Task List button (consolidated tight-`<ul>` path)

### TC2.7a — Plain paragraphs (not yet in a list) → clean tight task list

<!-- WHEN: select from the start of "First paragraph" through the end of
     "Second paragraph", click the toolbar's Task List button.
     THEN: both become checkbox items ("* [ ] First paragraph" / "* [ ]
     Second paragraph") in ONE tight `<ul>` — same clean shape as TC2.3a,
     now with checkboxes. -->

*   First paragraph
*   Second paragraph

TC2.7b — Selection spanning a blank line → blank line dropped, no empty checkbox

<!-- WHEN: click at the end of "Alpha" below, press Enter TWICE (creates a
     genuinely empty paragraph), then select from the start of "Alpha"
     through the end of "Bravo" (spanning that empty paragraph), click the
     toolbar's Task List button.
     THEN: exactly TWO checkbox items appear ("* [ ] Alpha", "* [ ] Bravo")
     — no empty checkbox item for the blank line. -->

Alpha

Bravo

### TC2.7c — Task List button on content spanning a table/code block falls back gracefully

<!-- WHEN: select from "Before" through "After" below (spanning the table),
     click the toolbar's Task List button.
     THEN: this is an uncharacterized shape (falls back to the legacy
     execCommand path) — confirm it does NOT corrupt the document (no raw
     table markup dumped inside a `<li>`, no crash/frozen toolbar). Whatever
     it produces, the table's own content must still be intact and the
     document must remain editable afterward.
     NOTE: as of bug 0717 round3 #5, an <hr>/table/pre/blockquote in the span no
     longer takes the corrupting legacy execCommand path — the list is built with
     computeToListAroundAtoms, which keeps each such atom verbatim and splits the
     list AROUND it (a blank line, being a <p>, is still dropped as spacing). -->

Before

| A | B |
| --- | --- |
| 1 | 2 |

*   [ ] After

---

## Cross-cutting: Undo (Ctrl/Cmd+Z) sanity check

<!-- WHEN: pick any ONE of the TCs above, perform its WHEN action, then
     press Ctrl/Cmd+Z once.
     THEN: the document reverts to exactly its pre-action state (some of
     these ops — outdent, retag/unwrap, heading/blockquote replace — commit
     via a non-native Range insert and do NOT land on the browser's own undo
     stack by design; Ctrl+Z here is delegated to VS Code's TextDocument undo
     instead, per main.ts/provider.ts — confirm it still works as ONE clean
     undo step, not a partial/garbled revert). -->

---

## Sign-off

| TC | Pass/Fail | Notes |
| --- | --- | --- |
| TC2.1a |  |  |
| TC2.1b |  |  |
| TC2.2a |  |  |
| TC2.2b |  |  |
| TC2.2c |  |  |
| TC2.3a |  |  |
| TC2.3b |  |  |
| TC2.3c |  |  |
| TC2.3d |  |  |
| TC2.3e |  |  |
| TC2.4a |  |  |
| TC2.4b |  |  |
| TC2.4c |  |  |
| TC2.4d |  |  |
| TC2.4e |  |  |
| TC2.5a |  |  |
| TC2.5b |  |  |
| TC2.5c |  |  |
| TC2.6a |  |  |
| TC2.6b |  |  |
| TC2.7a |  |  |
| TC2.7b |  |  |
| TC2.7c |  |  |
| Undo sanity |  |  |
