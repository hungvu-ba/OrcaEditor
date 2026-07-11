# Changelog

All notable changes to the **Orca Editor** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Multiple changes released on the same day are grouped under that day's latest version.

## \[0.6.7\] - 2026-07-11

### Added

-   Extension icon (blue dolphin) at `images/icon.png`, declared in `package.json`.
-   `THIRD-PARTY-NOTICES.md` listing the licenses of all bundled dependencies (mermaid, dompurify, katex, …).
-   `release` subcommand in `build.sh` — checks for a clean git tree and `vsce` login, bumps the version, runs tests, packages, publishes to the Marketplace, and tags git; supports `--dry-run`.
-   Bilingual EN/JP sample (`sample/SAMPLE_EN_JP.md`) covering every supported format, for testing the preview with Japanese text.
-   The table-of-contents panel now auto-hides when the tab is narrower than half the screen (split editor); it can still be reopened from the toolbar.

### Changed

-   Renamed the command IDs and `viewType` from `markdownWysiwyg.*` to `orcaEditor.*`, consistent with the setting names.
-   Translated all remaining user-facing Vietnamese strings (toolbar, table of contents, search, tables, notifications, Mermaid errors) to English.

### Fixed

-   Overhauled toolbar list/checkbox conversions: switching between bullet/numbered/task lists now converts every selected line (not just the caret or last line), keeps numbered lists numbered when removing checkboxes, cleans up leftover empty paragraphs and stray leading spaces, and undoes correctly.
-   The ¶/H1–H3 buttons now change tags via `execCommand` instead of raw DOM manipulation, so undo reverts one step at a time instead of resetting all formatting.
-   The code-block button with a mid-sentence selection now splits the text before/after the selection into separate paragraphs cleanly, instead of letting the browser split it unpredictably.
-   Toolbar tooltips didn't appear on some icons — replaced native `title` attributes with a custom tooltip (shown on hover/focus) that displays consistently on every button.
-   The toolbar no longer wraps onto a second row in narrow windows — formatting buttons that don't fit move into an overflow "..." menu.

## \[0.6.6\] - 2026-07-11

### Added

-   Type-safe `postMessage` channel between the extension host and the webview (`src/shared/messages.ts`, a `WebviewToHost`/`HostToWebview` union).
-   48 unit tests covering `computeMinimalEdit`, `normalizeForSearch`, `relativePath`, `classifyLink`, and the message contract; extracted `src/text-utils.ts` to make this logic testable.
-   Prepared the extension for Marketplace publishing: removed `private: true`, added a `publish` script, excluded internal docs from the packaged `.vsix`.

### Changed

-   Split the `pipeline.ts` module into `render` / `dom-postprocess` / `dom-serialize-prep` / `turndown` / `dom-portable`, with no behavior change.
-   Merged duplicate helpers and debounce constants, and enabled stricter TypeScript checks plus ESLint (`typescript-eslint`, `eslint-plugin-security`).
-   Renamed the extension to **Orca Editor** (package name, tab context menu, settings); renamed the build output file accordingly.
-   Merged `build.sh` / `install.sh` / `build-and-install.sh` into a single `build.sh` (with `build`/`install` subcommands), excluded from the packaged `.vsix`.
-   Renamed 3 settings from `markdownWysiwyg.*` to `orcaEditor.*`; `autoOpenToc` and `showLineNumbers` now apply immediately when changed, without reopening the preview.

### Fixed

-   Security: tightened the webview CSP, added realpath symlink protection in the link-open handler, switched to a crypto-based nonce, narrowed `localResourceRoots`, and added error logging.
-   Performance: debounced host updates, cached `findFiles`/Mermaid rendering, debounced the search input, and gated gutter parsing; production bundling reduced `main.js` by 56%, and KaTeX now ships woff2-only fonts.
-   The gutter now numbers each bullet/list item individually at every nesting depth, instead of only showing the first line of the whole list.
-   Cmd/Ctrl+X couldn't cut a selection — added a Clipboard API fallback, since VS Code's nested webview doesn't always fire the native `cut` event.
-   List items typed during editing didn't show a line number until after an undo.
-   Clicking a task-list checkbox didn't toggle checked/unchecked.
-   Clicking the toolbar checkbox button a second time left a bare bullet instead of reverting to a plain paragraph.
-   Resolved 2 `vsce` packaging warnings by adding a `repository` field to `package.json` and a `LICENSE` file.
-   README now separates **Install** (from the Marketplace) from **Build from source**.

## \[0.5.14\] - 2026-07-10

### Added

-   Real gutter line numbers (from the source `.md` file) to the left of every content block.
-   "Open WYSIWYG Preview" in the editor context menu and the editor tab context menu.

### Changed

-   Renamed the extension to "Orca MD Preview" and the menu label to "Open Orca Preview".

### Fixed

-   Gutter line numbers for Mermaid/KaTeX blocks now show the start line at the top edge and the end line at the bottom edge, instead of a single number.

## \[0.5.10\] - 2026-07-09

### Added

-   Baseline release: start of version history tracking.

### Fixed

-   The table-insert button created a nested table when the caret was already inside another table's cell, corrupting the surrounding Markdown.
-   Copying a table or list and pasting it back lost formatting, because the clipboard captured plain text instead of Markdown.
-   Couldn't add a new line below a Mermaid/code/table/formula block at the end of the document — an escape paragraph is now always guaranteed at the end.
