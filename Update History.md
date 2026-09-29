# Update History

| Version | Date | Update Content |
| --- | --- | --- |
| 1.2.2 | 2026-09-29 | Fix: Table fit mode treats each CJK glyph as its own word, so a long unbroken Japanese/Chinese run no longer pins its column at ~650px. |
| 1.2.2 | 2026-09-29 | Fix: table cells top-align and use text-wrap: pretty to avoid mid-row float and one-word wrap lines (T1.2) |
| 1.2.2 | 2026-09-29 | Feature: Fit-mode tables gain a pure height-first column-width solver core (line model, role floors, single and joint row moves, free shrink, scroll floor) — not wired in yet (US-19.27). |
| 1.2.2 | 2026-09-29 | Feature: area-fit cell measure adapter (measureCellLines: word/CJK break units, gaps, hard breaks, fixedH) plus TableAreaFitDebug test bundle and shared table fixtures (US-19.27, T1.9). |
| 1.2.2 | 2026-09-29 | Feature: area-fit table solver stops at the knee (5% H), keeps a 15% knee floor, and holds applied widths within a 5%/2% hysteresis band with grow-only column support. |
| 1.2.2 | 2026-09-29 | Fix: area-fit cell measure adapter counts inline-box padding, block-child line breaks, KaTeX formula height and <br>-only lines, and keeps non-breaking spaces inside words (US-19.27, T1.9 review). |
| 1.2.2 | 2026-09-29 | Feature: GATE A probe measures the area-fit line model against Chromium (99.8% exact); the solver's column upper bound now covers the model's one-line width (US-19.27, T1.3). |
| 1.2.2 | 2026-09-29 | Fix: area-fit knee floor keeps Σ maxW after the model-line hi raise; GATE A probe counts atomic inline and wrapped KaTeX boxes, asserts pin drift. |
| 1.2.2 | 2026-09-29 | Fix: area-fit cell measure keeps kinsoku glyphs (、。，．：；？！・closing brackets, 々ゝゞヽヾ〜) with the unit before them, matching Chromium line starts. |
| 1.2.2 | 2026-09-29 | Fix: area-fit measure takes line-break units from Chromium itself (1px layout) instead of hand-written rules; GATE A 441/441 exact, CJK rows match. |
| 1.2.2 | 2026-09-29 | Feature: Table fit mode now picks column widths with the area-fit solver — lowest total row height, CJK-aware read floors, stops at the knee instead of filling the panel (US-19.27). |
