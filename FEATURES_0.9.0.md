# What's New — Orca Editor 0.9.0

A quick tour of the features shipped this round. Three pillars: **Trigger system (`@` / `/`)**, the **Entity declare & reference** model, and the **Reading Mode + UI** redesign.

---

## 1. Mention & Trigger — `@` and `/`

Type a trigger character in the editor and a popup lets you pick without leaving the keyboard.

- **`@` — Mention an entity.** Search across your docs and insert a link to a declared entity. The inserted text shows the entity's **full human name** (`UC01 Submit Leave Request`), while the link fragment stays clean (`#UC01`).
- **`/` — Define / Execute.** A block menu (Heading 1–3, lists, etc.) at the start of a line, plus commands. `/heading` on an empty line pre-selects a level; on a line with text, `/` reformats the whole block.
- **Real input field.** The popup filters through a native focused `<input>` — proper caret + IME (Vietnamese typing works), the trigger marker stays inline, and only the picked result is written back.
- **No leaks.** Filter text and the committing Enter never spill into the document. Escape restores the caret right after the marker; Space on an empty filter cancels to a literal `@` / `/`.

**Demo path:** open a doc → type `@` → search a UC → Enter → a named entity link appears.

---

## 2. Entity Declare, Index & Reference

A lightweight cross-document linking model built on a `caption::` declaration.

- **Declare:** write `caption::NS_ID` to mark a block as an entity (e.g. a use case, a requirement). It renders as a **declaration badge** followed by its label.
- **Index:** all declarations are indexed automatically, powering `@`-mention search. Malformed captures (trailing punctuation, `caption::` inside inline code) are filtered out.
- **Reference & navigate:** an entity link resolves through the index. **Cmd/Ctrl-click** opens the target file *and* scrolls to the `caption::` declaration, flashing the badge. Works even for targets outside the workspace (whole-document text search fallback).
- **Hover tooltip:** hovering a mention shows `UC01 in …` plus a short preview of the text after the declaration — so a bare code is understandable at a glance.
- **Broken references:** an unresolved link gets a **warning-triangle marker**. Hover it for a fix popup → **"Search again →"** re-points the link at the correct declaring file.

**Demo path:** declare `caption::UC01 …` in file A → `@`-mention it in file B → Cmd-click to jump to the declaration.

---

## 3. Reading Mode & UI Redesign

- **3 Reading Modes** — Standard / Sepia / Paper — each a self-contained color set applied per mode, chosen from a dropdown with swatches.
- **Popup styling follows the mode.** The trigger query input is a soft-ring field (`--orca-input-*`) with caret/selection colors themed per Reading Mode.
- **Toolbar redesign.** Reordered to the wireframe with explicit overflow-collapse priority; control sizes derive from one `--toolbar-base-height` knob; Link/Image buttons disable inside code blocks.
- **TOC rail redesign** — palette theming, reading-stats header, empty state, proportional width, resize/truncation fixes.
- **View-only actions stay clean.** Switching Reading Mode / Focus / TOC no longer marks the file dirty.

---

## Talking points for the demo

| Feature | One-liner |
| --- | --- |
| `@` mention | Link to any declared entity by name, keyboard-only. |
| `/` define/execute | Block menu + commands from the line start. |
| `caption::` declare | Turn any block into a navigable, searchable entity. |
| Cmd-click navigate | Jump straight to a declaration, badge flashes. |
| Broken-ref fix | Warning marker → "Search again" re-points the link. |
| 3 Reading Modes | Standard / Sepia / Paper, fully themed incl. popups. |

_See `Update History.md` / `CHANGELOG.md` [0.9.0] for the full line-by-line list._
