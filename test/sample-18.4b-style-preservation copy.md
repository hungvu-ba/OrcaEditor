# US-18.4b Manual Test Data & Checklist — Per-Block Style Preservation

<!-- Setup: verifies the fix in real Orca Editor (Extension Development
     Host), on top of the automated suite (`test:roundtrip`/`test:unit`/
     `test:webview`), which cannot observe real contentEditable typing + a
     real disk-file save.

     1. Run the extension (F5 in VS Code, or the `run` skill) -> Extension
        Development Host opens.
     2. Save THIS file once as plain text to fix the on-disk baseline, then
        reopen it with Orca Editor (right-click -> "Open With..." -> Orca
        Editor, or set as default).
     3. Work through every TC below in one sitting: perform each TC's WHEN
        action (they touch different blocks, so doing them all before saving
        is fine and also doubles as a cross-block-independence stress test).
     4. Save once (Cmd+S/Ctrl+S) to flush the pending sync.
     5. Reopen in a plain text editor (or `git diff` if tracked) and check
        each TC's THEN comment against the actual bytes.
     6. Fill in the Sign-off table at the bottom. -->

Edit-me pad — for any TC below whose says "edit elsewhere", click here, type a character, then delete it.

---

## TC1 — Bullet marker: untouched `+` list keeps `+`

<!-- WHEN: edit elsewhere (use the Edit-me pad above).
     THEN: this list still reads exactly "+   keep plus" / "+   still plus"
     (marker + 3 spaces) — not rewritten to "*". -->

+   keep plus
+   still plus

## TC2 — Bullet marker: list inside a blockquote keeps `-`

<!-- WHEN: add a new paragraph right after this section (type a word below
     the blockquote), save.
     THEN: both quoted lines still start with "> -", not "> *". -->

> -   quoted item
> -   another

## TC3 — Bullet marker: mixed markers in one list collapse to the first

<!-- WHEN: click at the end of "a" below and press End (no visible change),
     save.
     THEN: both lines use "-" (the first-encountered marker); no "*" remains
     in this list. Note: marker SPACING normalizes ("- a" -> "-   a",
     "  * b" -> "    -   b") — pre-existing turndown behavior, unrelated to
     this fix (see deferred-work.md). -->

-   a
    -   b

## TC4 — Bullet marker: brand-new list uses the new default `*`

*   `dfsdfsd`

<!-- WHEN: below this comment, press Enter twice, then use the toolbar's
     "Bulleted list" button (or type "- item" if the input rule
     auto-converts) to add a new list item, save.
     THEN: the new list serializes with "*" (Orca's new default), not "-". -->

## TC5 — Code block: untouched 4-space indented block staysf indented

<!-- WHEN: edit elsewhere (use the Edit-me pad above).
     THEN: this code block is still 4-space indented, no ``` fence appears
     anywhere near it. -->

    function foo() {
      return 1;
    }

## TC6 — Code block: edit *inside* an indented block keeps it indented

<!-- WHEN: click at the end of "line two" below (inside this code block),
     press Enter, type a 3rd line with the same 4-space indent (e.g.
     "    line three"), save.
     THEN: this block now has 3 lines, still indented, still no fence. -->

    line one
    line twoline three

## TC7 — Code block: `~~~` fence keeps `~~~` and its language

<!-- WHEN: edit elsewhere (use the Edit-me pad above).
     THEN: this fence is still "~~~python" / "~~~" — not converted to
     "```python". -->

~~~python
print(1)
~~~

## TC8 — Code block: new code block via toolbar is always fenced

```javascript
code
```

<!-- WHEN: below this comment, use the toolbar's "Insert code block" (or
     type ```js + Enter), save.
     THEN: the new block is backtick-fenced with the language — never
     emitted as 4-space indented. -->

## TC9 — Emphasis/strong/HR: canonical forms survive an fds unrelate d edit

<!-- WHEN: edit the "after" paragraph below (add then remove a character),
     save.
     THEN: `_em_` and `__strong__` above are unchanged; the `---` HR is
     unchanged. -->

uses _em_ and __strong__ words

---

after

## TC10 — Emphasis: two blocks with different delimiters don't bleed into each other

<!-- WHEN: edit only the "second" paragraph below (add a trailing space then
     remove it), save.
     THEN: the first paragraph still uses "_underscore em_"; the second
     still uses "*star em*". -->

first _underscore em_

second *star em*

## TC11 — Emphasis: literal `2*4` and URL underscores don't get mistaken for delimiters

<!-- WHEN: edit elsewhere (use the Edit-me pad above).
     THEN: "_nails_" stays "_"-delimited (not flipped to "*nails*" because of
     the literal "2*4"); "*note*" stays "*"-delimited (not flipped to
     "_note_" because of the "_v2_" inside the link URL). The literal "2*4"
     itself DOES become "2\*4" regardless — turndown's own base library
     always backslash-escapes every "*" unconditionally; pre-existing,
     unrelated to this fix, renders identically. -->

Buy 2\*4 lumber and _nails_.

[doc](https://example.com/_v2_) and *note*

## TC12 — HR: variant and leading indent are preserved

<!-- WHEN: edit the "after" paragraph below (add then remove a character),
     save.
     THEN: the HR line above is still exactly "  ***" (2-space indent,
     triple asterisk) — not rewritten to "---". -->

  ***

after

## TC13 — New hard-break default: two-space break becomes `\` (intended)

<!-- WHEN: edit "line two" below (or anything else in the file), save.
     THEN: the break becomes "line one\" (backslash) — NOT two trailing
     spaces. This is the intended new global default, not a bug. Verify
     "line one" below has exactly 2 trailing spaces BEFORE the first save
     (use a whitespace-visible view). -->

line one\
line two

## TC14 — Golden Rule: a fully-canonical file is byte-identical after any edit

<!-- WHEN: edit "Done." below (add then remove a character), save.
     THEN: every other line in this section is BYTE-IDENTICAL to before —
     diff and confirm zero unexpected changes. -->

# Title

Some *em* and **strong** text.

*   item one
*   item two

1.  first
2.  second

---

```js
const x = 1;
```

Done.

---

## Sign-off

| TC | Pass/Fail | Notes |
| --- | --- | --- |
| TC1 | Passed |  |
| TC2 | Passed |  |
| TC3 |  |  |
| TC4 |  |  |
| TC5 |  |  |
| TC6 |  |  |
| TC7 |  |  |
| TC8 |  |  |
| TC9 |  |  |
| TC10 |  |  |
| TC11 |  |  |
| TC12 |  |  |
| TC13 |  |  |
| TC14 |  |  |
