# Update History

| Version | Date | Update Content |
| --- | --- | --- |
| 1.2.2 | 2026-09-30 | Fix: fit-mode tables meet area targets: #8b and #20 lower than the old ladder; scrolling tables judged by scroll width; CJK 36ch floor only where it sets row height. |
| 1.2.2 | 2026-09-30 | Feature: fit-mode tables keep existing column widths when a row or column is added or deleted, unless re-solving saves over 5% height (US-19.27) |
| 1.2.2 | 2026-09-30 | Feature: Fit-mode tables keep column edges still while typing; only the edited column widens under overflow or growth pressure, paste/undo re-fit at once, IME-safe, caret row anchored. |
| 1.2.2 | 2026-09-30 | Fix: pasted/dropped images inside a fit-mode table cell now re-fit immediately, not only on overflow/2-line-growth heuristics that a single insert never trips |
| 1.2.2 | 2026-09-30 | Feature: fit-mode tables settle a typing-widened column back on table leave, editor blur or 2 s idle; panel resize keeps widths until 150 ms after the last event. |
| 1.2.2 | 2026-09-30 | Feature: Fit-mode tables use area-optimal column widths with calm re-fits (US-19.27 shipped); phase gate green: unit 1041, roundtrip 25/25, webview 915, 0 flaky. |
| 1.2.2 | 2026-09-30 | Fix: Table area fit no longer keeps a column wider than its content, and stacked images in a cell add one height per line (review fixes T1.8.p1, T1.9.p1). |
| 1.2.2 | 2026-09-30 | Fix: Table area fit splits words correctly under a small line-height, in RTL text and at <wbr>; a pasted image re-fits the table once it has loaded. |
| 1.2.2 | 2026-09-30 | Fix: Table area fit adds up a cell's hard lines, so an image with a wrapped caption under it counts both heights (T1.7.p3). |
| 1.2.2 | 2026-09-30 | Fix: Fit-mode tables keep column widths after a row delete, like deleting text; columns narrow only when the table settles (2 s idle or caret leaves) (T1.7.p2). |
| 1.2.2 | 2026-09-30 | Fix: Cross-file search keeps file text across queries, checked by mtime and size, so repeat searches no longer re-read every file from disk (audit L-5). |
| 1.2.2 | 2026-09-30 | Fix: TOC panel slides with a transform and the content reflows once per toggle, removing show/hide lag on large tables |
| 1.2.2 | 2026-09-30 | Feature: TOC reading stats count words without cloning the document, and debounced TOC builds keep the list when no heading changed. |
| 1.2.2 | 2026-09-30 | Fix: TOC toggle keeps the reading line with one scroll correction and two re-holds instead of a per-frame pin loop |
| 1.2.2 | 2026-09-30 | Feature: Documents with an indented code block now serialize per block on each sync instead of re-serializing the whole document (audit L-10). |
| 1.2.2 | 2026-09-30 | Feature: drag-and-drop hover and drop-gap hit tests binary-search the top-level blocks, and large table/list drag ghosts carry only their first 10 rows (L-11) |
| 1.2.2 | 2026-09-30 | Fix: dragging the TOC resize handle moves only the panel; content re-lays out after a 150 ms pause and on release |
| 1.2.2 | 2026-09-30 | Fix: TOC show/hide and resize lag on large tables closed — one content reflow per toggle, debounced reserve while dragging |
| 1.2.2 | 2026-09-30 | Fix: re-render after undo/redo reuses cached code highlighting and math typesetting for unchanged blocks |
| 1.2.2 | 2026-09-30 | Fix: external or undo updates post-process only the changed blocks and keep a short hash per block instead of its full HTML |
| 1.2.2 | 2026-09-30 | Fix: typing in a file without entity declarations no longer makes every open editor re-check entity references; declaration files are stat-ed once per check |
| 1.2.2 | 2026-09-30 | Fix: mermaid and PlantUML keep at most 32 rendered diagrams in memory per tab instead of every diagram ever shown |
| 1.2.2 | 2026-09-30 | Fix: in documents with more than 32 mermaid or PlantUML diagrams, paste, undo and external changes no longer re-render existing diagrams |
| 1.2.2 | 2026-09-30 | Fix: an escaped dollar sign keeps its backslash when the document is saved, so it no longer turns into a formula after reopening |
| 1.2.2 | 2026-09-30 | Fix: a formula KaTeX cannot parse keeps its original text when the document is saved instead of being replaced by the error message |
| 1.2.2 | 2026-09-30 | Fix: a formula KaTeX cannot parse now behaves like a valid one, one unit with an Edit button; Enter or Backspace beside it no longer duplicates it or loses text |
