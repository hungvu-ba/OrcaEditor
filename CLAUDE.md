# CLAUDE.md

## Mandatory Rule: Requirement Structure (HLR = master list)

Whenever a task creates or updates a requirement (HLR entry, detail file, status tag), read and follow [Plan/REQUIREMENT\_STRUCTURE.md](Plan/REQUIREMENT_STRUCTURE.md) — it defines the HLR ⇄ detail-file linking, naming, and status-tag rules.

## Mandatory Rule: Roundtrip Test for `.md`\-changing Features

Whenever a task alters raw `.md` content (toolbar formatting, input rules, table editing, inserting links/images/math/mermaid, image paste, list/task list, anything going through turndown/serialize...), read and follow [Plan/ROUNDTRIP\_TEST.md](Plan/ROUNDTRIP_TEST.md) — it defines where roundtrip tests live, the DOM-outcome test pattern, and when to revisit existing coverage.

## Mandatory Rule: Webview Interaction Test

Whenever a task touches real interactive webview behavior that can't be verified by a hand-built DOM snapshot (click handlers, keyboard shortcuts, `execCommand`, Selection API, drag/drop, popovers) — including writing the bug-reproduction test required by [Working Principles #4](#4-work-toward-the-goal-not-a-fixed-sequence-of-steps) when the bug is this kind — read and follow [Plan/WEBVIEW\_TEST.md](Plan/WEBVIEW_TEST.md) — it defines the Playwright harness, where tests live, and how to pick this track vs. `test/unit.ts` vs. `test/roundtrip/`.

## Mandatory Rule: Review Tier & Review Log

-   Every change gets one review tier, defined in `.claude/skills/review-commit/tiers.md`: **tier 1** = automated checks + Known Traps check, no reviewer; **tier 2** = one in-session review, no sub-agent; **tier 3** = three-reviewer sub-agent panel.
-   A tier 2/3 review never runs in the session that wrote the code: the code session commits once tests are green, records the hashes in the spec's `code_commits`, and hands off `/bmad-quick-dev-solo <spec_file>` to a fresh session, which reviews `git show <hashes>` — never the working tree.
-   Independent review of any committed work: `/review-commit <hash...> | <a>..<b> | --spec <spec_file>` in a fresh session — it picks the tier, fixes pure defects in its own commit, holds behavior changes for the user. `bmad-quick-dev-solo` step-04 uses the same skill.
-   Every review run (`/review-commit`, quick-dev step-04 / one-shot, `/code-review`, `/review-changes`) ends with `python3 scripts/review_log.py add ...` → `Plan/Skill Analysis/review-log.jsonl`. Pending items decided → `outcome <id> ...`; a bug found later that the review should have caught → `miss`; weekly read → `report --since <date>`.
-   Context usage per task: `python3 scripts/context_audit.py report --since <date>` (a SessionStart hook runs `sweep`). A session keys to its task by the quick-dev spec slug or the first prompt line `T<phase>.<n> Code:` / `Review:`.

## Mandatory Rule: Commit When Code Is Done

-   Every finished coding task ends with a commit — once its tests are green, and always before a review in another session, a handoff, or the end of the session. Never leave finished code uncommitted.
-   Stage by name only this task's files — never `git add -A`/`git add .` (parallel threads share the working tree). Message per [Plan/GIT\_WORKFLOW.md](Plan/GIT_WORKFLOW.md) §3.
-   Review fixes go in their own commit. Never amend, rebase or reset a commit that a spec, a review, or another session already references by hash; undo with `git revert`.
-   Push/PR stay manual.

## Mandatory Rule: Output Language vs. Conversation Language

Every **project output** — code, **all code comments** (inline, block, JSDoc/TSDoc, TODO/FIXME, test comments...), variable/function names, UI-facing strings (webview, toolbar, error/empty-state messages...), commit messages, and documentation (`Update History.md`, requirements, other docs) — is **always written in English**, no exceptions, including short or throwaway comments.

Only the **AI's chat/conversation replies** to the user are in Vietnamese. Don't translate code/docs back into Vietnamese "for readability".

## Mandatory Rule: Be Concise (chat replies + user stories)

-   **Chat replies**: state the answer or what you did. No preamble, no filler, no restating the request.
-   **User stories (US)**: one clear who/what/why + tight acceptance criteria. Cut anything a reader can infer.

## Mandatory Rule: Working Principles

### 1\. Think before coding

-   If a request is unclear, ask.
-   If it can be interpreted multiple ways, present the options.
-   Don't guess and code based on assumptions.
-   Maintain a todo list.

### 2\. Simplicity above all

-   Write only as much code as the task needs.
-   Don't add features beyond what was asked.
-   Don't add abstractions.
-   Don't over-engineer "in case it's needed later".

### 3\. Change like surgery

-   Only touch the part that was actually requested.
-   Don't refactor opportunistically while you're in there.
-   Don't reformat.
-   Don't edit comments unrelated to the change.
-   Every changed line must have a reason.

### 4\. Work toward the goal, not a fixed sequence of steps

-   Instead of: "Fix this bug."
-   Say: "Write a test that reproduces the bug, then fix the code until the test passes."
-   With a clear success criterion, the AI can judge when to stop on its own.

### 5\. Update History

-   Every bug fix or feature must get one line (max 30 words) appended to \[Update History.md\](Update History.md) at the repo root (`Markdown Preview VS Code/`).
-   Table format: `Date | Update Content`.
    -   **Date**: `YYYY-MM-DD`.
    -   **Update Content**: max 30 words, states whether it's a fix or feature.
-   Append only — never edit existing rows.

## Mandatory Rule: Reuse Shared Modules

Before adding a new helper function, check whether one of these already covers it — extend it instead of duplicating the logic locally:

-   Caret/selection placement & restore → `media/webview/dom-utils.ts`
-   Search/highlight overlay math (ticks, viewport band) → `media/webview/match-utils.ts`
-   List-structure transforms (indent/outdent/retag/unwrap) → `media/webview/list-ops.ts`
-   Extension-host ⇄ webview message payload shapes → `src/shared/messages.ts`
-   Block/line-number mapping → `media/webview/block-map.ts`
-   Shared DOM class names/selectors → `media/webview/constants.ts`

Also run `npm run check:duplication` (jscpd) and `npm run check:deadcode` (ts-prune) before merge — see [Plan/GIT\_WORKFLOW.md](Plan/GIT_WORKFLOW.md).

## Mandatory Rule: Find Code / Docs

Before grep or opening a long file:

-   `python3 scripts/codemap.py sym <Name>` → def `file:start-end` + callers + tests + doc mentions (whole repo, not just `src`/`media/webview`). Then read that range only.
-   `python3 scripts/codemap.py doc "<heading part>"` → one section of a Plan doc (e.g. `"US-23.10"`, `"Roundtrip Test"`). Never read those files whole.
-   Name unknown → `grep -n <word> .map/*/code.md` or read `.map/docs.md`. Maps rebuilt at session start (hook) + `python3 scripts/codemap.py build --all` if stale.
-   `sym`/`doc` parse live and always search the whole repo, so they're never stale — only `.map/*/code.md` (per-area overview) can go stale between rebuilds.

## Mandatory Rule: Known Traps

**Correctness trap (not performance):**

-   **Domino has no `ParentNode.append`.** `media/webview/dom-postprocess.ts`, `dom-serialize-prep.ts`, `sibling-move.ts`, and `turndown.ts` also run under Node via `@mixmark-io/domino` for round-trip tests. Domino does not implement `element.append(a, b, c)` — always use chained `element.appendChild(a); element.appendChild(b);` in these files. `.append()` looks like a harmless shortening but breaks at runtime under domino, so don't "clean it up."

**Performance trap:**

-   **Throttle layout-forcing reads in hot handlers.** Any `getBoundingClientRect`/`offsetHeight`/`offsetWidth`/`scrollWidth` read inside a `mousemove`/`scroll`/`pointermove`/drag handler must be rAF-coalesced or throttled — follow the existing pattern in `match-utils.ts`/`search.ts` (`SELECT_OVERVIEW_THROTTLE_MS`) or `toc.ts`'s `onScroll`, not the uncoalesced version.

**Cross-platform trap (macOS vs Windows):**

-   **Never compare paths/filenames/text with a raw `===`/`startsWith`/`includes`.** Windows vs macOS differ in path separator, filesystem case-sensitivity, filename Unicode form (NFC/NFD), and line ending (CRLF/LF) — a raw comparison usually coincides on macOS and silently breaks on Windows. Route file/entity-name comparisons through a shared normalizer (decode → NFC → normalize separator → optional case-fold) and reconcile text to `document.eol` before diffing/writing. Keyboard-shortcut handlers must test both `metaKey` and `ctrlKey`; shortcut labels shown in UI must not hardcode `⌘`. See [Plan/Cross-Environment Defects — Audit.md](Plan/Cross-Environment%20Defects%20%E2%80%94%20Audit.md) for the full defect family and fix patterns.

**Test-infra trap:**

-   **A bare `npx playwright test <spec>` runs against a stale bundle.** The Playwright harness loads the built `dist/webview/main.js`, never the TypeScript sources. `npm run test:webview` rebuilds first (`node esbuild.js --test && playwright test`); a targeted run does not. Edit `media/webview/*.ts`, then run a single spec without rebuilding, and the result — pass *or* fail — describes the previous build. Always write `node esbuild.js --test && npx playwright test test/webview/<name>.spec.ts`.
-   **`flaky` is not `passed`.** The webview suite has real timing flake, so gate runs use `npm run test:webview -- --retries=2`. A retried test is reported as `flaky`, not `failed`, and the suite still exits 0 — record every `N flaky` line as debt instead of letting it pass silently. See [Plan/WEBVIEW\_TEST.md](Plan/WEBVIEW_TEST.md) § Running the suite.
