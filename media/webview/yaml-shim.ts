/**
 * Stands in for `js-yaml` inside main.js (esbuild webviewConfig alias), audit
 * L-9 (Performance Low-End — Audit.md): js-yaml itself lives in the lazily
 * loaded front-matter-engine.js. Once that engine is loaded every call forwards
 * to it. Before that, a call is recorded as a miss and answered with
 * `undefined` (an empty block's value); the render lifecycle discards a render
 * that missed. After a failed load it throws a plain Error, so
 * front-matter.ts's parse-error path keeps the card with its raw rows.
 *
 * Unit / roundtrip / host bundles do not alias `js-yaml`, so they keep the real one.
 */
import { lazyEngineApi, lazyEngineFailed, noteEngineMiss } from './lazy-engines';

interface YamlEngineApi {
  load(str: string, opts?: Record<string, unknown>): unknown;
}

export function load(str: string, opts?: Record<string, unknown>): unknown {
  const engine = lazyEngineApi<YamlEngineApi>('frontMatter');
  if (engine) {
    return engine.load(str, opts);
  }
  if (lazyEngineFailed('frontMatter')) {
    throw new Error('Front-matter engine not available');
  }
  noteEngineMiss('frontMatter');
  return undefined;
}
