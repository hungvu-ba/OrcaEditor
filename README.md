# Orca Editor

A VS Code extension that lets you **preview Markdown with pixel-accurate rendering while editing directly in the preview** (WYSIWYG). Every change is synced back to the `.md` file in real time.

## Features

- **Accurate, theme-aware Markdown rendering**: powered by the same markdown-it engine with equivalent configuration (`html: true`, `linkify`, `breaks` read from the `markdown.preview.*` settings), styled with CSS that mirrors VS Code's `markdown.css`, and automatically adapts to light/dark themes.
- **Direct in-preview editing**: type straight into the preview; keyboard shortcuts include **⌘B** bold, **⌘I** italic, **⌘⇧X** strikethrough, **⌘E** inline code, **Tab/⇧Tab** to indent lists.
- **Toolbar**: headings H1–H3 (click again to revert to a paragraph), bullet/numbered/task lists, blockquote (click again to remove), code block, table, horizontal rule, link, image, undo/redo.
- **Full Markdown tag support** (CommonMark + GFM, matching VS Code's Preview):
  - Headings 1–6 (ATX + Setext), paragraphs, hard/soft breaks
  - **Bold**, *italic*, ~~strikethrough~~, `inline code`
  - Nested lists (bulleted/numbered), task lists `- [ ]` / `- [x]` (checkboxes are clickable)
  - GFM tables with column alignment (`:---`, `:--:`, `---:`), `<br>` and `\|` inside cells
  - Code blocks with language + syntax highlighting, 4-space indented code
  - Nested blockquotes, links (inline/reference/autolink/bare URL), images (including relative paths)
  - Horizontal rules, escaped `\*`, HTML entities, inline/block HTML (`<kbd>`, `<details>`, `<div>`...), HTML comments
  - KaTeX math `$...$` and `$$...$$` (same as VS Code Markdown Math)
  - Mermaid diagrams (rendered directly in the preview)
  - YAML front matter (shown collapsed, preserved on save)
- **Visual table editing**: place the caret inside a table → a floating icon toolbar appears above it: **add row above/below**, **add column left/right**, **align a whole column left/center/right** (writes the correct GFM syntax `:---:` / `---:`), **delete row/column**, and **delete the whole table** (trash icon). **Tab/⇧Tab** moves between cells; **Tab in the last cell auto-creates a new row**. New columns are named "New Column" (pre-selected so you can type over it immediately); if the first column is a **sequence number**, adding a row auto-fills the next number and renumbers the rows below. Deleting the header row promotes the first data row to header (GFM always needs one); deleting the last column deletes the whole table. The table toolbar auto-hides after 3 seconds (hover over it to keep it visible); click the table to bring it back.
- **In-preview search**: **⌘F** opens a search bar, navigate between matches, with highlighting directly on the rendered content.
- **Gutter line numbers**: every content block (paragraph, heading, list, table, code, mermaid...) shows the line number from the original Markdown file, just like the raw text mode's gutter (can be toggled off in Settings).
- **Table of Contents panel**: opens automatically when a Markdown file is opened (can be toggled off in Settings).
- **Insert link with in-project file suggestions**: select text and click 🔗 → a popup automatically searches and lists workspace files whose name relates to that text (case/diacritic-insensitive — "Đăng ký sự kiện" matches `dang-ky-su-kien.md`). Type in the input to search by another term; pick a suggestion by clicking or ↑↓ + Enter to insert a relative link to that file. Entering a URL with a scheme (`https://`...) disables the suggestions.
- **Clickable task lists**: tick a checkbox directly in the preview → the file updates to `[x]`.
- **⌘+Click to open links** (external links open in the browser, relative links open the file in VS Code, `#` anchors scroll to the heading).
- **Clipboard-@ toolbar button**: copies `@file` to the clipboard for the Claude Code chat — automatically navigates to the open chat tab (revealing it if hidden, keeping the conversation intact) and focuses the input, so you just paste with **⌘V**. For fully automatic insertion (there will be a brief flicker since a text editor is opened temporarily) enable the auto-insert setting.

## How to open

- Open a `.md` file, click **Open Orca Editor to the Side** in the editor title bar (or `⌘⇧⌥V`).
- Or right-click the file in the Explorer / editor tab → **Open Orca Editor**.
- Or **Reopen Editor With... → Orca Editor** to replace the current editor.
- Save with **⌘S** as usual (changes in the preview mark the document "dirty" just like typing in a text editor).

## Install

Search **"Orca Editor"** in the VS Code Extensions view (`⌘⇧X`) and click **Install** — or run:

```bash
code --install-extension hungvu.orca-editor
```

## Build from source

For contributors who want to build the extension from this repository instead of installing it from the Marketplace.

The fastest way, using the scripts included at the project root:

```bash
./build.sh               # typecheck + round-trip test + package .vsix + install (all-in-one)
./build.sh build         # only build + package .vsix, don't install
./build.sh install       # only find the latest .vsix and install it (no build)
```

Options:

```bash
./build.sh --skip-tests   # skip typecheck & tests
./build.sh --bump         # bump the patch version before building
./build.sh --no-install   # only build the .vsix, don't install
```

After installing, reload VS Code: **Cmd+Shift+P → "Developer: Reload Window"**.

Manual install with npm:

```bash
npm install
npm run compile
npm run package         # creates the orca-editor-<version>.vsix file
```

Then in VS Code: **Extensions → ⋯ → Install from VSIX...** and select the `.vsix` file you just created.
Or try it without installing: open this folder in VS Code and press **F5** (Extension Development Host).

## Testing

```bash
npm run test:roundtrip   # round-trip test: markdown → HTML → markdown → HTML must be stable
npm run test:unit        # unit tests for individual modules
npm test                 # run both
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
```

## Directory structure

- `src/` — extension host code (`extension.ts`, `provider.ts` for the custom editor, `shared/messages.ts` defining the messages between host and webview).
- `media/webview/` — webview code (markdown-it rendering, DOM ↔ markdown sync via turndown, toolbar, tables, line-number gutter, table of contents, search, mermaid...).
- `media/*.css` — styles mirroring VS Code's `markdown.css` plus editor-specific styles.
- `test/` — round-trip tests, unit tests, and markdown fixtures.

## Design notes

- On your **first edit**, the whole file is re-serialized, so **Markdown style gets normalized** (Setext headings → ATX, `+`/`*` bullets → `-`, `_` italics → `*`...). Content and rendering stay the same, only the source syntax changes.
- KaTeX formulas and front matter are "atom" blocks: they render correctly, but to edit their content you need a text editor (both modes can stay open in parallel and stay in sync both ways).

## Third-party licenses

This extension bundles several open-source libraries (mermaid, KaTeX, highlight.js, markdown-it, turndown, and their dependencies). See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the full list and license texts.
