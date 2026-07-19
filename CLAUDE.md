# CLAUDE.md

## Mandatory Rule: Requirement Structure (HLR = master list)

Whenever a task creates or updates a requirement (HLR entry, detail file, status tag), read and follow [Plan/REQUIREMENT_STRUCTURE.md](Plan/REQUIREMENT_STRUCTURE.md) — it defines the HLR ⇄ detail-file linking, naming, and status-tag rules.

## Mandatory Rule: Roundtrip Test for `.md`-changing Features

Whenever a task alters raw `.md` content (toolbar formatting, input rules, table editing, inserting links/images/math/mermaid, image paste, list/task list, anything going through turndown/serialize...), read and follow [Plan/ROUNDTRIP_TEST.md](Plan/ROUNDTRIP_TEST.md) — it defines where roundtrip tests live, the DOM-outcome test pattern, and when to revisit existing coverage.

## Mandatory Rule: Webview Interaction Test

Whenever a task touches real interactive webview behavior that can't be verified by a hand-built DOM snapshot (click handlers, keyboard shortcuts, `execCommand`, Selection API, drag/drop, popovers) — including writing the bug-reproduction test required by [Working Principles #4](#4-work-toward-the-goal-not-a-fixed-sequence-of-steps) when the bug is this kind — read and follow [Plan/WEBVIEW_TEST.md](Plan/WEBVIEW_TEST.md) — it defines the Playwright harness, where tests live, and how to pick this track vs. `test/unit.ts` vs. `test/roundtrip/`.

## Mandatory Rule: Output Language vs. Conversation Language

Every **project output** — code, **all code comments** (inline, block, JSDoc/TSDoc, TODO/FIXME, test comments...), variable/function names, UI-facing strings (webview, toolbar, error/empty-state messages...), commit messages, and documentation (`Update History.md`, requirements, other docs) — is **always written in English**, no exceptions, including short or throwaway comments.

Only the **AI's chat/conversation replies** to the user are in Vietnamese. Don't translate code/docs back into Vietnamese "for readability".

## Mandatory Rule: Be Concise (chat replies + user stories)

- **Chat replies**: state the answer or what you did. No preamble, no filler, no restating the request.
- **User stories (US)**: one clear who/what/why + tight acceptance criteria. Cut anything a reader can infer.

## Mandatory Rule: Working Principles

### 1. Think before coding
- If a request is unclear, ask.
- If it can be interpreted multiple ways, present the options.
- Don't guess and code based on assumptions.

### 2. Simplicity above all
- Write only as much code as the task needs.
- Don't add features beyond what was asked.
- Don't add abstractions.
- Don't over-engineer "in case it's needed later".

### 3. Change like surgery
- Only touch the part that was actually requested.
- Don't refactor opportunistically while you're in there.
- Don't reformat.
- Don't edit comments unrelated to the change.
- Every changed line must have a reason.

### 4. Work toward the goal, not a fixed sequence of steps
- Instead of: "Fix this bug."
- Say: "Write a test that reproduces the bug, then fix the code until the test passes."
- With a clear success criterion, the AI can judge when to stop on its own.

### 5. Update History
- Every bug fix or feature must get one line (max 30 words) appended to \[Update History.md\](Update History.md) at the repo root (`Markdown Preview VS Code/`).
- Table format: `Date | Update Content`.
  -   **Date**: `YYYY-MM-DD`.
  -   **Update Content**: max 30 words, states whether it's a fix or feature.
- Append only — never edit existing rows.

## Mandatory Rule: Reuse Shared Modules

Before adding a new helper function, check whether one of these already covers it — extend it instead of duplicating the logic locally:

- Caret/selection placement & restore → `media/webview/dom-utils.ts`
- Search/highlight overlay math (ticks, viewport band) → `media/webview/match-utils.ts`
- List-structure transforms (indent/outdent/retag/unwrap) → `media/webview/list-ops.ts`
- Extension-host ⇄ webview message payload shapes → `src/shared/messages.ts`
- Block/line-number mapping → `media/webview/block-map.ts`
- Shared DOM class names/selectors → `media/webview/constants.ts`

Also run `npm run check:duplication` (jscpd) and `npm run check:deadcode` (ts-prune) before merge — see [Plan/GIT_WORKFLOW.md](Plan/GIT_WORKFLOW.md).

## Mandatory Rule: Known Traps

**Correctness trap (not performance):**

- **Domino has no `ParentNode.append`.** `media/webview/dom-postprocess.ts`, `dom-serialize-prep.ts`, `sibling-move.ts`, and `turndown.ts` also run under Node via `@mixmark-io/domino` for round-trip tests. Domino does not implement `element.append(a, b, c)` — always use chained `element.appendChild(a); element.appendChild(b);` in these files. `.append()` looks like a harmless shortening but breaks at runtime under domino, so don't "clean it up."

**Performance trap:**

- **Throttle layout-forcing reads in hot handlers.** Any `getBoundingClientRect`/`offsetHeight`/`offsetWidth`/`scrollWidth` read inside a `mousemove`/`scroll`/`pointermove`/drag handler must be rAF-coalesced or throttled — follow the existing pattern in `match-utils.ts`/`search.ts` (`SELECT_OVERVIEW_THROTTLE_MS`) or `toc.ts`'s `onScroll`, not the uncoalesced version.

## Mandatory Rule: Git Workflow

For any git operation (branch, commit, merge, PR, release, hotfix, worktree...), read and follow [Plan/GIT_WORKFLOW.md](Plan/GIT_WORKFLOW.md) — it defines branch structure, commit conventions, feature/release/hotfix lifecycle, and presentation style (explain for newcomers + a status sitemap after each commit).
