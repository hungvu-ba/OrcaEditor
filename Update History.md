# Update History

| Version | Date | Update Content |
| --- | --- | --- |
| 1.2.2 | 2026-09-29 | Fix: Table fit mode treats each CJK glyph as its own word, so a long unbroken Japanese/Chinese run no longer pins its column at ~650px. |
| 1.2.2 | 2026-09-29 | Fix: table cells top-align and use text-wrap: pretty to avoid mid-row float and one-word wrap lines (T1.2) |
| 1.2.2 | 2026-09-29 | Feature: Fit-mode tables gain a pure height-first column-width solver core (line model, role floors, single and joint row moves, free shrink, scroll floor) — not wired in yet (US-19.27). |
| 1.2.2 | 2026-09-29 | Feature: area-fit cell measure adapter (measureCellLines: word/CJK break units, gaps, hard breaks, fixedH) plus TableAreaFitDebug test bundle and shared table fixtures (US-19.27, T1.9). |
