/**
 * Shared infra for webview interaction tests (test/webview/*.spec.ts). Playwright
 * drives the real dist/webview/main.js bundle in a real Chromium page — the same
 * engine VS Code's webview uses — so document.execCommand, the Selection API, and
 * real click/keyboard events actually run. test/roundtrip/ (domino) can't do this:
 * domino has no JS engine attached to elements and never dispatches events.
 *
 * Run `node esbuild.js` before these tests (see npm run test:webview) so
 * dist/webview/main.js and its CSS exist.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { expect, type Page } from '@playwright/test';
import type { InitConfig } from '../../src/shared/messages';

const DIST_WEBVIEW = path.join(__dirname, '..', '..', 'dist', 'webview');

const DEFAULT_CONFIG: InitConfig = {
  breaks: false,
  linkify: true,
  wordWrap: true,
  fontSize: 14,
  lineHeight: 1.6,
  fontFamily: 'sans-serif',
  autoOpenToc: false,
  showLineNumbers: false,
  caseInsensitiveFs: false,
  crossFileSearchScope: 'markdown',
  tableFitMode: false,
  readability: { enabled: false, mode: 'standard', fontFamily: '', zen: false },
  trigger: { dateFormat: 'YYYY-MM-DD', executeCommands: [], mode: 'advanced' },
  commentAuthorName: 'harness-user',
  docRelativePath: 'harness.md',
  commentHighlightOn: false,
  // US-2.8: the harness serves dist/webview over file://, so the engine bundle
  // sits right beside main.js; no nonce is enforced here (no CSP meta).
  plantumlEngineUri: 'plantuml-engine.js',
  scriptNonce: '',
};

/** Default docUri echoed back to the harness's fake acquireVsCodeApi (Req 20 US-20.3). */
export const DEFAULT_DOC_URI = 'file:///harness.md';

/**
 * Bug 0716 #1: cold-open baking. Mirrors provider.ts's getHtml() — the real
 * shell bakes Reading Mode/Zen classes and the toolbar's inline hidden-style
 * directly into the initial HTML (before any JS runs) so first paint is
 * already correct. The harness must reproduce this same baking, not just
 * apply state later via the 'init' message, or a cold-open test here would
 * exercise a different (already-JS-guarded) code path than the real bug.
 */
function bakedMarkup(readability: InitConfig['readability']): { bodyClasses: string; toolbarStyle: string } {
  // bug_General #1: reading styling gates on `enabled` only; Zen is independent.
  const stylingActive = readability.enabled;
  const bodyClasses = [
    ...(stylingActive ? ['reading-mode'] : []),
    ...(readability.zen ? ['reading-zen'] : []),
    ...(stylingActive && readability.mode !== 'standard' ? [`reading-mode-${readability.mode}`] : []),
  ].join(' ');
  const toolbarStyle = readability.zen
    ? 'position:fixed;top:0;left:0;right:0;margin:0;z-index:200;transform:translateY(-100%);pointer-events:none;'
    : '';
  return { bodyClasses, toolbarStyle };
}

function harnessHtml(readability: InitConfig['readability']): string {
  // Mirrors the real shell built by provider.ts's getHtmlForWebview (toolbar/
  // gutter/content divs, main.js loaded last) minus CSP/nonce, which don't apply
  // outside a real webview. acquireVsCodeApi is stubbed since VS Code normally
  // injects it — messages the webview posts are recorded on window.__posted so
  // tests can assert on them (e.g. the serialized markdown after an edit).
  const { bodyClasses, toolbarStyle } = bakedMarkup(readability);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="./katex/katex.min.css">
<link rel="stylesheet" href="./markdown.css">
<link rel="stylesheet" href="./editor.css">
<title>webview test harness</title>
<script>
  window.__posted = [];
  // Seeded by presetWebviewState() through addInitScript, which runs before this
  // stub — the only way a spec can reach code that reads persisted webview state
  // (rightDockTab, tocWidth, tocMaxLevel) on the very first boot.
  let __state = window.__presetState ?? {};
  window.acquireVsCodeApi = () => ({
    postMessage: (msg) => { window.__posted.push(msg); },
    getState: () => __state,
    setState: (s) => { __state = s; },
  });
</script>
</head>
<body class="${bodyClasses}">
  <div id="toolbar" role="toolbar" aria-label="Formatting toolbar"${toolbarStyle ? ` style="${toolbarStyle}"` : ''}></div>
  <div id="line-gutter" aria-hidden="true"></div>
  <div id="content" role="main" aria-label="Document content" contenteditable="true" spellcheck="false"></div>
  <script src="./main.js"></script>
  <!-- HLR 22 Phase 1: test-only bundle exposing list-ops.ts's pure functions +
       commitListOp/commitListOpDirect on window.ListOpsDebug, so
       list-ops-primitive.spec.ts can drive them directly without wiring into
       any real call site (Phase 2). -->
  <script src="./list-ops-debug.js"></script>
  <!-- Req 20 US-20.4: test-only bundle exposing escape-stack.ts's
       registerEscapeHandler/ESCAPE_PRIORITY on window.EscapeStackDebug, so
       escape-stack-priority.spec.ts can register fake handlers and dispatch a
       real Escape deterministically. -->
  <script src="./escape-stack-debug.js"></script>
  <!-- Req 20 US-20.1/20.2: test-only bundle exposing trigger-popup.ts's
       initTriggerPopup on window.TriggerPopupDebug, so trigger-popup-shell.spec.ts
       can drive the shell with a fake dataSource (no real @// trigger yet). -->
  <script src="./trigger-popup-debug.js"></script>
</body>
</html>`;
}

/** Per-process counter so two temp files from this process never collide. */
let tmpSeq = 0;

/**
 * Write the harness page and return its path.
 *
 * Content-addressed on purpose. This used to write one shared
 * `dist/webview/_harness.html` on every `openBlankHarness`, which made the
 * harness itself the flakiest thing in the suite: `fs.writeFileSync` truncates
 * before it writes, so with the suite's parallel workers one worker could be
 * inside `page.goto('file://.../_harness.html')` during another worker's
 * zero-length window. Chromium then loaded an EMPTY document — `readyState`
 * "complete", no stylesheets, no `#content`, the inline `acquireVsCodeApi` stub
 * never run — and the next `#content` wait could only sit there until the test
 * timeout killed it, which is why four unrelated specs all died at that one
 * line. Raising the timeout could never have helped: `#content` was never going
 * to appear on that page.
 *
 * Hashing the HTML fixes a second bug in the same code: the file's content
 * depends on `readability` (`bakedMarkup`), so a worker that wrote a Zen/Reading
 * variant could hand it to a worker expecting the plain shell. Distinct configs
 * are now distinct files, and identical configs produce byte-identical ones.
 *
 * `rename` rather than a plain write, because two workers can still land on the
 * same new path at once: rename(2) is atomic, so a concurrent reader sees either
 * no file or the whole file, never a partial one.
 */
function ensureHarnessFile(readability: InitConfig['readability']): string {
  if (!fs.existsSync(path.join(DIST_WEBVIEW, 'main.js'))) {
    throw new Error('dist/webview/main.js not found — run `node esbuild.js` before webview tests.');
  }
  const html = harnessHtml(readability);
  const hash = crypto.createHash('sha1').update(html).digest('hex').slice(0, 12);
  const file = path.join(DIST_WEBVIEW, `_harness-${hash}.html`);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
    fs.writeFileSync(tmp, html, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      // `existsSync` above is advisory, so two workers can both reach this. On
      // POSIX the loser's rename just replaces byte-identical content; on Windows
      // it fails with a sharing violation if another worker's Chromium already
      // holds the destination open. Losing the race is always fine here — the
      // name is a hash of the content — so the only thing to check is that
      // somebody won it.
      if (!fs.existsSync(file)) { throw err; }
    } finally {
      // A worker killed mid-run (Ctrl-C, --max-failures) would otherwise leave
      // its temp behind forever; nothing else prunes dist/webview.
      fs.rmSync(tmp, { force: true });
    }
  }
  return file;
}

/**
 * Seed the fake `vscode.getState()` record BEFORE the page boots. Must be called
 * before `openEditor`; anything the webview persists (`rightDockTab`, `tocWidth`,
 * `tocMaxLevel`) can be restored this way, which is the only route to the
 * "reopened with a remembered choice" branch — the stub's state is per-page.
 */
export async function presetWebviewState(page: Page, state: Record<string, unknown>): Promise<void> {
  await page.addInitScript((seed) => {
    (window as unknown as { __presetState: unknown }).__presetState = seed;
  }, state);
}

/** Read the fake `vscode.setState()` record — what the webview persisted so far. */
export async function readWebviewState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => (window as unknown as { acquireVsCodeApi: () => { getState(): Record<string, unknown> } }).acquireVsCodeApi().getState());
}

/**
 * Req 24 US-23.8 AC6: open the harness page WITHOUT posting 'init' — for a spec
 * that needs to control exactly when the first render happens (e.g. racing a
 * `commentThreadsSync` against it, the way the host's own best-effort immediate
 * sync can race the webview's first paint). Pair with `postInit` below once the
 * race has been set up.
 */
export async function openBlankHarness(page: Page, configOverrides: Partial<InitConfig> = {}): Promise<InitConfig> {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  // pathToFileURL, not `'file://' + path`: the concat is the raw path-as-text
  // construct CLAUDE.md's cross-platform rule forbids — it leaves a Windows
  // `C:\…` path and any `#`/`?` in the repo path to chance (a `#` would silently
  // truncate the URL at the fragment). This repo's own path already has a space.
  await page.goto(url.pathToFileURL(ensureHarnessFile(config.readability)).href);
  return config;
}

/**
 * Post the host's 'init' message and wait for the first render — the other
 * half of `openEditor`. `docUri` defaults to `DEFAULT_DOC_URI`; a spec racing
 * a pre-init `commentThreadsSync` (AC6, see `seedCommentThreads`'s own
 * `docUri` param) must pass the SAME `''` here too — `main.ts`'s 'init'
 * handler treats an actual docUri change as switching documents and prunes
 * every resolver thread via `syncAll([])` before rendering, which would
 * wipe the very thread the race is trying to observe.
 */
export async function postInit(
  page: Page,
  markdown: string,
  config: InitConfig,
  docUri: string = DEFAULT_DOC_URI
): Promise<void> {
  await page.evaluate(
    ({ text, cfg, docUri }) => {
      // Re-arm the gate below: a spec may post 'init' more than once, and a
      // marker left over from the previous one would satisfy the wait instantly.
      delete document.body.dataset.triggerMode;
      window.postMessage({ type: 'init', text, docUri, config: cfg }, '*');
    },
    { text: markdown, cfg: config, docUri }
  );
  // Gate on a stamp the 'init' handler itself writes (`applyTriggerMode` in
  // main.ts), so this really does wait for the message to be consumed. The old
  // `#content` wait could not: editor.css gives `#content` `min-height: 60vh`,
  // so it is already "visible" — measured 432px tall with zero children — on a
  // page where no init has run at all, and the wait returned in ~9ms having
  // asserted nothing.
  // `attached`, not the default `visible`: presence of the stamp is the whole
  // signal, and the default would additionally require `<body>` to have a
  // non-empty box — an unrelated condition to hang on.
  await page.locator('body[data-trigger-mode]').waitFor({ state: 'attached' });
}

/** Open the harness page and bootstrap it with the given markdown, like the host's 'init' message. */
export async function openEditor(page: Page, markdown: string, configOverrides: Partial<InitConfig> = {}): Promise<void> {
  const config = await openBlankHarness(page, configOverrides);
  await postInit(page, markdown, config);
}

/**
 * Type into the trigger popup's focused query <input> (T0.1 focused-input model).
 * Types per-keystroke via pressSequentially so the input's own `input` event
 * fires for each char (that event is what drives runQuery / filtering).
 */
export async function typePopupQuery(page: Page, text: string): Promise<void> {
  const input = page.locator('.trigger-popup-query-input');
  await input.click();
  await input.pressSequentially(text);
}

/** Read the current value of the trigger popup's query input (for assertions). */
export async function popupQueryValue(page: Page): Promise<string> {
  return page.locator('.trigger-popup-query-input').inputValue();
}

/** Clear recorded host messages — call right before the action under test so waitForEdit only sees fresh messages. */
export async function clearPosted(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __posted: unknown[] }).__posted.length = 0;
  });
}

/** Wait for the next 'edit' message posted to the host (scheduleSync debounces ~250ms) and return its markdown text. */
export async function waitForEdit(page: Page, timeoutMs = 2000): Promise<string> {
  const handle = await page.waitForFunction(
    () => (window as unknown as { __posted: Array<{ type: string; text: string }> }).__posted.filter((m) => m.type === 'edit').at(-1),
    undefined,
    { timeout: timeoutMs }
  );
  const msg = (await handle.jsonValue()) as { text: string };
  return msg.text;
}

/**
 * Req 23 US-23.9: one thread as the host would push it, with everything but the
 * interesting fields defaulted. Specs that only care about status/anchor state
 * should not have to restate the whole `CommentSyncThread` envelope.
 */
export interface SeedThread {
  threadId: string;
  status?: 'Open' | 'Resolved' | 'Closed';
  author?: string;
  timestamp?: string;
  body?: string;
  recordedText?: string;
  /** Defaults to a bare-caret anchor (0, 0) — override both to give the thread a real washable range. */
  offsetStart?: number;
  offsetEnd?: number;
  lastKnownLine?: number;
  /** US-23.11 AC2: the applied transition trail, oldest first. */
  statusChanges?: Array<{ toStatus: 'Open' | 'Resolved' | 'Closed'; author: string; timestamp: string }>;
}

/** What the host reports about the sidecar behind a snapshot (US-23.9 AC12/AC13). */
export interface SeedSidecar {
  foreign?: boolean;
  problem?: string;
  orphans?: Array<{ id: string; kind: 'reply' | 'status-change'; author: string; timestamp: string; detail: string }>;
  /** Req 24 US-23.15 AC3: how many sidecar lines the load discarded. */
  skipped?: number;
  /** Req 24 US-23.15 AC4: the sidecar holds git conflict markers. */
  conflicted?: boolean;
}

/**
 * Push a `commentThreadsSync` snapshot, exactly as `provider.syncCommentThreads`
 * does. This is the ONLY way to reach a Closed thread or a foreign sidecar from
 * a spec: neither can be produced by driving the webview's own UI.
 *
 * `docUri` defaults to `DEFAULT_DOC_URI` (the normal case, matching whatever
 * `openEditor`/`postInit` set as `currentDocUri`). Req 24 US-23.8 AC6: a spec
 * racing this against the first render (via `openBlankHarness`, before any
 * 'init') must pass `''` instead — before 'init', the webview's `currentDocUri`
 * is still its `''` default, and the sync handler drops anything that doesn't
 * match it.
 */
export async function seedCommentThreads(
  page: Page,
  threads: SeedThread[],
  sidecar?: SeedSidecar,
  docUri: string = DEFAULT_DOC_URI
): Promise<void> {
  await page.evaluate(
    ({ list, docUri, side }) =>
      window.postMessage(
        {
          type: 'commentThreadsSync',
          docUri,
          sidecar: side,
          threads: list.map((t) => ({
            threadId: t.threadId,
            status: t.status ?? 'Open',
            author: t.author ?? 'reviewer',
            timestamp: t.timestamp ?? '2026-07-20T09:00:00.000Z',
            body: t.body ?? 'Body.',
            recordedText: t.recordedText ?? '',
            offsetStart: t.offsetStart ?? 0,
            offsetEnd: t.offsetEnd ?? 0,
            lastKnownLine: t.lastKnownLine ?? 1,
            nearestHeading: '',
            replies: [],
            statusChanges: t.statusChanges ?? [],
          })),
        },
        '*'
      ),
    { list: threads, docUri, side: sidecar }
  );
}

/**
 * Answer away every anchor-lost confirmation currently queued, with "Later" —
 * the exit that decides nothing and writes nothing.
 *
 * Needed by any spec that floats a thread without being ABOUT the dialog: since
 * US-23.11 AC1 dropped the identity filter, whoever is at the keyboard is asked
 * about every floating thread, and the dialog's scrim swallows clicks meant for
 * the dock or the gutter underneath it.
 */
export async function dismissAnchorLost(page: Page): Promise<void> {
  const dialog = page.locator('.comment-anchor-lost');
  // Bounded: one pass per thread a spec could plausibly float, so a dialog that
  // refuses to close fails the spec instead of hanging the run. Each pass waits
  // out ANCHOR_REEVAL_DEBOUNCE_MS first — a thread does not float, and the next
  // queued question does not open, until a resolution pass has run, so polling
  // `isVisible()` straight away sees nothing and lets the dialog appear over
  // whatever the spec does next.
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    if (!(await dialog.isVisible())) {
      return;
    }
    await page.locator('.comment-anchor-lost-later').click();
  }
  await expect(dialog).toBeHidden();
}

/**
 * Open the right dock on the Comment tab and wait for the panel to finish
 * widening. Goes through the tab header rather than the `⚑` toolbar button: the
 * button is hidden while the file has no threads, which is exactly the state the
 * empty-state specs need to reach.
 */
export async function openCommentTab(page: Page): Promise<void> {
  // force: toolbar overflow math can transiently report #toc-toggle as offscreen.
  await page.locator('#toc-toggle').click({ force: true });
  // The dock animates its width open; measuring a row mid-transition would give
  // a box that has moved by the time the pointer gets there.
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '300px');
  await page.locator('.right-dock-tab', { hasText: 'Comment' }).click();
  await expect(page.locator('#comment-tabpanel')).toBeVisible();
}

/**
 * US-10.8: the TOC's heading-depth control lives in the dock's `⋯` overflow menu,
 * so every spec that drives the depth filter goes through the same three steps
 * (open the menu, click the row for `level`, wait for the menu to close). Shared
 * here rather than copied per spec — the rows carry no `data-level`, so the level
 * is positional and the mapping belongs in one place.
 */
export const DEPTH_MENU_LABELS = { 1: 'H1', 2: 'H1–H2', 3: 'H1–H2–H3' } as const;

/** Open the dock's `⋯` menu and assert it is the TOC tab's "Outline depth" section. */
export async function openDepthMenu(page: Page): Promise<void> {
  await page.locator('.right-dock-menu-btn').click();
  await expect(page.locator('.right-dock-menu-title')).toHaveText('Outline depth');
  await expect(page.locator('.right-dock-menu-item')).toHaveCount(3);
}

/** Set the TOC heading-depth filter to `level` via the `⋯` menu. */
export async function setDepth(page: Page, level: 1 | 2 | 3): Promise<void> {
  await openDepthMenu(page);
  await page.locator('.right-dock-menu-item').nth(level - 1).click();
  await expect(page.locator('.right-dock-menu')).toBeHidden();
}

/** Assert exactly one depth row is checked, and it is `level`. Leaves the menu closed. */
export async function expectActiveDepth(page: Page, level: 1 | 2 | 3): Promise<void> {
  await openDepthMenu(page);
  const checked = page.locator('.right-dock-menu-item[aria-checked="true"]');
  await expect(checked).toHaveCount(1);
  // Suffix match: the label shares its button with the ✓ check column.
  await expect(checked).toHaveText(new RegExp(`${DEPTH_MENU_LABELS[level]}$`));
  await page.locator('.right-dock-menu-btn').click();
  await expect(page.locator('.right-dock-menu')).toBeHidden();
}
