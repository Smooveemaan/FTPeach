import { defineConfig } from '@playwright/test';

const isCI = Boolean(process.env.CI);
const baseURL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './test/visual',
  outputDir: './test-results/visual',
  fullyParallel: true,
  forbidOnly: isCI,
  // A retry tells a flaky failure from a steady one in the report, but a
  // test that passed only on a retry still fails the run.
  retries: isCI ? 2 : 0,
  failOnFlakyTests: isCI,
  reporter: isCI ? 'github' : 'list',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.001,
    },
  },
  use: {
    baseURL,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'UTC',
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:renderer -- --port 4173 --strictPort',
    url: `${baseURL}/test/visual/visual.html`,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
  ],
});
