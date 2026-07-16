import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/webview',
  timeout: 10_000,
  reporter: 'list',
  use: {
    headless: true,
  },
});
