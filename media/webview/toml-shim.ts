/**
 * Stands in for `smol-toml` inside main.js (esbuild webviewConfig alias), audit
 * L-9 (Performance Low-End — Audit.md): smol-toml itself lives in the lazily
 * loaded front-matter-engine.js. Once that engine is loaded every call forwards
 * to it. Before that, a call is recorded as a miss and answered with `{}`; the
 * render lifecycle discards a render that missed. After a failed load it throws
 * a plain Error, so front-matter.ts shows the TOML card in its invalid frame.
 *
 * Unit / roundtrip / host bundles do not alias `smol-toml`, so they keep the real one.
 */
import { lazyEngineApi, lazyEngineFailed, noteEngineMiss } from './lazy-engines';

interface TomlEngineApi {
  parse(toml: string, opts?: Record<string, unknown>): Record<string, unknown>;
}

export function parse(toml: string, opts?: Record<string, unknown>): Record<string, unknown> {
  const engine = lazyEngineApi<TomlEngineApi>('frontMatter');
  if (engine) {
    return engine.parse(toml, opts);
  }
  if (lazyEngineFailed('frontMatter')) {
    throw new Error('Front-matter engine not available');
  }
  noteEngineMiss('frontMatter');
  return {};
}
