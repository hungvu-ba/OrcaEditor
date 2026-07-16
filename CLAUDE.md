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

## Mandatory Rule: Git Workflow

For any git operation (branch, commit, merge, PR, release, hotfix, worktree...), read and follow [Plan/GIT_WORKFLOW.md](Plan/GIT_WORKFLOW.md) — it defines branch structure, commit conventions, feature/release/hotfix lifecycle, and presentation style (explain for newcomers + a status sitemap after each commit).
