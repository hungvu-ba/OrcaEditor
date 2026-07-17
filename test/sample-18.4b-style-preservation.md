# US-18.4b Sample Data — Non-Canonical Style Fixture

<!-- How to use (see test/manual/TC-18.4b-style-preservation.md for the full
     checklist): open this file with Orca Editor. For each check, edit ONLY
     the "Edit-me pad" paragraph below (click into it, type one character,
     delete it), then save (Cmd+S/Ctrl+S). Reopen in a plain text editor and
     diff against this file's original content.

     Expected per section:
     - Sections 1, 2, 4, 5, 6, 7, 9, 11 -> byte-identical (this fix's
       guarantee: an untouched block keeps its exact original syntax).
     - Section 3 -> the "-" marker is preserved (not flipped to "*"), but its
       SPACING normalizes ("- a" -> "-   a"); pre-existing turndown behavior,
       unrelated to this fix (see deferred-work.md).
     - Section 8 -> "_nails_", "*note*" and the "_v2_" inside the link URL
       must NOT swap delimiters (this fix's guarantee); the literal "2*4"
       becomes "2\*4" regardless — turndown's own base library always
       backslash-escapes every "*" unconditionally, pre-existing and
       unrelated to this fix. Renders identically either way.
     - Section 10 -> intended rewrite (two-space hard break -> backslash).
     - Section 12 -> free scratch area for testing brand-new content. -->

Edit-me pad — click here, type a character, then delete it before saving.

## Section 1 — Bullet marker — plus list (TC1)

+   keep plus df
+   fsdf
+   fdfskfd
+   dfsdfs
+   still plus

## Section 2 — Bullet marker — blockquoted dash list (TC2)

> -   quoted item
> -   another

## Section 3 — Bullet marker — mixed markers, first wins (TC3)

-   a
    -   b

## Section 4 — Code block — 4-space indented (TC5)

    function foo() {
      return 1;
    }

## Section 5 — Code block — tab-indented

	tab line
	second line

## Section 6 — Code block — tilde fence with language (TC7)

~~~python
print(1)
~~~

## Section 7 — Emphasis/strong — underscore delimiters (TC9, TC10)

first _underscore em_ and __strong__ words

second *star em*

## Section 8 — Emphasis — literal star/underscore false positives (TC11)

Buy 2\*4 lumber and _nails_.

[doc](https://example.com/_v2_) and *note*

## Section 9 — Horizontal rule — indented `***` variant (TC12)

  ***

## Section 10 — Hard break — two-space (INTENDED rewrite to backslash on save, TC13)

line one\
line two

## Section 11 — Golden Rule region — already fully canonical (TC14)

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

## Section 12 — Scratch area for new-content defaults (TC4 / TC6 / TC8)

<!-- Nothing pre-existing here on purpose: type a brand-new bullet list, add
     a line inside an existing indented block elsewhere, or insert a new code
     block via the toolbar, then check it follows Orca's NEW defaults
     (`*` bullet, backtick-fenced code) rather than the old ones. -->
