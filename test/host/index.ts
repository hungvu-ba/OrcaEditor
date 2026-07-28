/**
 * US-23.17 AC1: the entry point `@vscode/test-electron`'s `runTests` loads
 * inside the real Extension Host. No test framework — each `*.test.ts` file
 * exports its own `run(): Promise<void>` (using `HostTestRunner` from
 * `_harness.ts`), and this just requires and runs every one of them, same
 * house style as `test/roundtrip/_lib.ts`'s custom runner.
 */
import * as fs from 'fs';
import * as path from 'path';

export async function run(): Promise<void> {
  const dir = __dirname;
  // `dist/` is never cleaned, so a bundle whose source was renamed or deleted — and
  // any throwaway diagnostic someone once built here — keeps running forever and
  // counts toward the pass total. Require a live `.ts` source, the same guard
  // `test/roundtrip-runner.js` carries for the same reason. This bit during US-23.18:
  // a deleted probe kept reporting PASS from a stale bundle.
  const sourceDir = path.resolve(dir, '../../../test/host');
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
  const files = all.filter((f) => fs.existsSync(path.join(sourceDir, `${path.basename(f, '.js')}.ts`)));
  const orphans = all.filter((f) => !files.includes(f));
  if (orphans.length > 0) {
    console.log(`[test:host] skipping ${orphans.length} stale bundle(s) with no source: ${orphans.join(', ')}`);
  }
  const failed: string[] = [];
  for (const file of files) {
    // eslint-disable-next-line security/detect-non-literal-require
    const mod = require(path.join(dir, file)) as { run?: () => Promise<void> };
    if (typeof mod.run !== 'function') {
      failed.push(`${file}: no exported run()`);
      continue;
    }
    try {
      await mod.run();
      console.log(`[test:host] PASS ${file}`);
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(`[test:host] FAIL ${file}\n${detail}`);
      failed.push(file);
    }
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length}/${files.length} host test file(s) failed: ${failed.join(', ')}`);
  }
}
