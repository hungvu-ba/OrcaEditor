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
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'));
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
