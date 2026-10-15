import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  reporter: 'list',
  projects: [{ name: 'chromium' }],
  // The demo spec runs against the real static host (fetch() semantics differ
  // under file://), so boot demo/serve.mjs for the whole run.
  webServer: {
    command: 'node demo/serve.mjs',
    url: 'http://localhost:4173/',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
