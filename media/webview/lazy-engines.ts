/**
 * Lazy loader for the math and front-matter engine bundles
 * (dist/webview/math-engine.js, dist/webview/front-matter-engine.js), audit
 * L-9 (Performance Low-End — Audit.md). Same single-flight + retry-on-failure
 * contract as mermaid.ts's loadEngine, over the shared loadNoncedEngineScript.
 *
 * Also keeps the miss ledger: a shim that had to answer without its engine
 * calls noteEngineMiss, and a render reads takeEngineMisses to learn which
 * engines it waited on.
 *
 * Import-safe under Node (render.ts imports it in unit / roundtrip tests):
 * nothing here touches window or document at import time.
 */
import { loadNoncedEngineScript, type EngineConfig } from './engine-loader';

export type LazyEngine = 'math' | 'frontMatter';

const ENGINES: Record<LazyEngine, { globalKey: string; label: string }> = {
  math: { globalKey: 'OrcaMathEngine', label: 'Math' },
  frontMatter: { globalKey: 'OrcaFrontMatterEngine', label: 'Front-matter' },
};

const configs: Partial<Record<LazyEngine, EngineConfig>> = {};

// Single-flight per engine: every caller shares one Promise, so only one
// <script> is injected. Dropped on failure so the next call retries.
const loads: Partial<Record<LazyEngine, Promise<void>>> = {};

const failed = new Set<LazyEngine>();
const missed = new Set<LazyEngine>();
let missCount = 0;

/** Receives an engine's config from the host's 'init' message (see provider.ts, InitConfig). */
export function setLazyEngineConfig(engine: LazyEngine, config: EngineConfig): void {
  configs[engine] = config;
}

/** Loads the engine bundle once; rejects on a missing config or a failed load, and the next call retries. */
export function loadLazyEngine(engine: LazyEngine): Promise<void> {
  const pending = loads[engine];
  if (pending) {
    return pending;
  }
  const { globalKey, label } = ENGINES[engine];
  const load = loadNoncedEngineScript<unknown>(globalKey, configs[engine], {
    notConfigured: `${label} engine location was not provided by the host`,
    loadedButEmpty: `${label} engine loaded but exposed no API`,
    failed: `Failed to load the ${label} engine`,
  }).then(
    () => {
      failed.delete(engine);
    },
    (err: unknown) => {
      failed.add(engine);
      loads[engine] = undefined; // allow a retry on the next call
      throw err;
    }
  );
  loads[engine] = load;
  return load;
}

/** The global the engine bundle publishes; undefined before it loads and under Node. */
export function lazyEngineApi<T>(engine: LazyEngine): T | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return (window as unknown as Record<string, T | undefined>)[ENGINES[engine].globalKey];
}

/** True after a load rejected (a missing config included), until a later load resolves. */
export function lazyEngineFailed(engine: LazyEngine): boolean {
  return failed.has(engine);
}

/** Records a shim call answered without the engine (not loaded, or failed). */
export function noteEngineMiss(engine: LazyEngine): void {
  missed.add(engine);
  missCount++;
}

/** Misses across all engines since the webview started; never decreases. */
export function engineMissCount(): number {
  return missCount;
}

/** Engines missed since the last take; clears the set. */
export function takeEngineMisses(): LazyEngine[] {
  const engines = [...missed];
  missed.clear();
  return engines;
}
