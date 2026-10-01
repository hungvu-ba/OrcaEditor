# Update History

| Version | Date | Update Content |
| --- | --- | --- |
| 1.2.2 | 2026-10-01 | Fix: a slash or @ popup reopened while the math engine loads no longer loses its inserted item to an older host update |
| 1.2.2 | 2026-10-01 | Fix: a math engine load that never answers now gives up after 10 s; formulas show as stand-ins and the preview keeps working |
| 1.2.2 | 2026-10-01 | Fix: an external edit or undo beside an invalid $$ formula no longer strips the source line from every math block (line map, scroll sync) |
| 1.2.2 | 2026-10-01 | Fix: switching reading palette no longer animates every table cell; ET Book font ships as smaller woff2 |
| 1.2.2 | 2026-10-01 | Fix: fewer host round trips on low-end machines — one comment re-sync per anchor burst, deleted-image undo cache capped at 16 MB, sibling notes read without opening them |
| 1.2.2 | 2026-10-01 | Fix: image cleanup no longer misses references in unsaved or non-UTF-8 sibling notes; a re-deleted image stays undo-restorable |
| 1.2.2 | 2026-10-01 | Feature: table column-width lock state module (session-only, remap on column insert/delete/move, carry-over snapshot) for drag resize |
| 1.2.2 | 2026-10-01 | Feature: table fit measures column hard minimum in measureColumnHardMin; fitTableColumns applies session column-width locks before fitting |
| 1.2.2 | 2026-10-01 | Feature: drag a table column edge to resize it — hover highlight, whole table locks on first drag, minimum = widest word, session-only |
| 1.2.2 | 2026-10-01 | Fix: pressing a table column edge without dragging no longer locks the table; the lock starts at the first movement |
| 1.2.2 | 2026-10-01 | Feature: resized table column widths survive insert/delete/move column; table toolbar Reset column widths button restores automatic widths |
| 1.2.2 | 2026-10-01 | Feature: resized table column widths carry over host re-render when the column count is unchanged; sticky header follows while resizing |
| 1.2.2 | 2026-10-01 | Fix: large tables re-fit after typing without remeasuring unchanged cells (per-cell measure memo, cached font probes) |
| 1.2.2 | 2026-10-01 | Feature: table column resize (US-6.10) phase closed — drag edge, whole-table lock, Reset, re-render carry-over; requirement shipped |
| 1.2.2 | 2026-10-01 | Fix: packaged extension no longer carries the removed ET Book .woff fonts beside the .woff2 (font output folder cleaned on build) |
| 1.2.2 | 2026-10-01 | Fix: table column resize ends a drag after a lost mouseup or a mid-drag re-render, ignores ragged-row edges, keeps a lock off tables inserted above |
| 1.2.2 | 2026-10-01 | Fix: table column-width lock follows the resized table by header text across host updates, never moving to a same-width table inserted above |
