import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'published-update.spec.ts',
  outputDir: '../../test-results/published-update',
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 60_000 },
  use: { screenshot: 'off', trace: 'off', video: 'off' },
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
});
