import { defineConfig } from '@playwright/test';

/**
 * Separate config for the feature-guide screenshot generator, so it can never be
 * swept into `npm run test:webview`.
 *
 * `playwright.config.ts` sets `testDir: './test/webview'` with no `testMatch`, which
 * means every `*.spec.ts` under that directory runs — and the generator used to live
 * there, rewriting eight tracked PNGs on every suite run. Its own `testDir` here is
 * the whole fix: the default config cannot see it, and this one runs only when named.
 *
 * `testIgnore` in the shared config was the alternative and is worse: it excludes a
 * file even when you pass its path explicitly, so regenerating would stop working.
 */
export default defineConfig({
  testDir: './scripts/feature-shots',
  timeout: 30_000,
  reporter: 'list',
  use: {
    headless: true,
  },
});
