import { defineConfig } from '@playwright/test';

// The desktop end-to-end suite drives the real application (test/e2e/app.ts).
// It is single-instance and shares one server, so tests run one at a time,
// and a failure is never retried into a pass.
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  outputDir: '../../test-results/e2e',
  workers: 1,
  retries: 0,
  timeout: 180_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
});
