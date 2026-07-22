/**
 * Test-only bundle re-exporting trigger-popup.ts as window.TriggerPopupDebug, so
 * test/webview/trigger-popup-shell.spec.ts can construct a controller with a fake
 * dataSource and drive open/updateQuery/close directly — there is no real @//
 * trigger caller yet (that ships with US-20.1/20.2). Mirrors the list-ops-debug
 * pattern; only built with --test, never shipped in the production dist/webview
 * bundle.
 */
export * from './trigger-popup';
