# Update History

| Version | Date | Update Content |
| --- | --- | --- |
| 1.2.2 | 2026-09-25 | Fix: line-number gutter no longer rebuilds markers on every relayout while showLineNumbers is off. |
| 1.2.2 | 2026-09-25 | Perf: the workspace entity index is now built file by file at activation, so only one markdown file's text is held in memory at a time. |
| 1.2.2 | 2026-09-25 | Feature: faster webview load — KaTeX bundled once, production CSS minified, test/debug artifacts excluded from the .vsix (T1.2). |
