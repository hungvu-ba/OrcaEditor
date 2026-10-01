/**
 * Test-only bundle exposing the US-19.27 area-fit cell measure adapter and pure
 * solver as window.TableAreaFitDebug, so webview specs (GATE A, the fit
 * integration) measure real cells in Chromium and feed them to the solver.
 * Only built with --test, never shipped in the production dist/webview bundle.
 */
export { measureTableLines } from './table-area-measure';
export { cellLineCount, solveAreaFit } from './table-area-fit';
