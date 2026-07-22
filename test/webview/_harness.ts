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
import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';
import type { InitConfig } from '../../src/shared/messages';

const DIST_WEBVIEW = path.join(__dirname, '..', '..', 'dist', 'webview');
const HARNESS_FILE = path.join(DIST_WEBVIEW, '_harness.html');

const DEFAULT_CONFIG: InitConfig = {
  breaks: false,
  linkify: true,
  wordWrap: true,
  fontSize: 14,
  lineHeight: 1.6,
  fontFamily: 'sans-serif',
  autoOpenToc: false,
  showLineNumbers: false,
  crossFileSearchScope: 'markdown',
  readability: { enabled: false, mode: 'standard', fontFamily: '', zen: false },
  trigger: { dateFormat: 'YYYY-MM-DD', executeCommands: [], mode: 'advanced' },
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
  let __state = {};
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

function ensureHarnessFile(readability: InitConfig['readability']): void {
  if (!fs.existsSync(path.join(DIST_WEBVIEW, 'main.js'))) {
    throw new Error('dist/webview/main.js not found — run `node esbuild.js` before webview tests.');
  }
  fs.writeFileSync(HARNESS_FILE, harnessHtml(readability), 'utf8');
}

/** Open the harness page and bootstrap it with the given markdown, like the host's 'init' message. */
export async function openEditor(page: Page, markdown: string, configOverrides: Partial<InitConfig> = {}): Promise<void> {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  ensureHarnessFile(config.readability);
  await page.goto('file://' + HARNESS_FILE);
  await page.evaluate(
    ({ text, cfg, docUri }) => window.postMessage({ type: 'init', text, docUri, config: cfg }, '*'),
    { text: markdown, cfg: config, docUri: DEFAULT_DOC_URI }
  );
  await page.locator('#content').waitFor();
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
