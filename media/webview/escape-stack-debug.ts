/**
 * Test-only bundle re-exporting escape-stack.ts as window.EscapeStackDebug, so
 * test/webview/escape-stack-priority.spec.ts can register fake handlers at
 * arbitrary priorities and dispatch a real Escape deterministically (the real
 * drag/popup/cross-file/Zen sources can't all be made simultaneously active from
 * a spec). Mirrors the list-ops-debug pattern; only built with --test, never
 * shipped in the production dist/webview bundle.
 */
export * from './escape-stack';
