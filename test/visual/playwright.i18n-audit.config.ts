import { defineConfig } from '@playwright/test';
import base from '../../playwright.config.ts';

const isCI = Boolean(process.env.CI);

/** `npm run i18n:audit`: the layout audit in every language (i18n-layout.audit.ts). */
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: '**/*.audit.ts',
  outputDir: '../../test-results/i18n-audit/playwright',
  reporter: 'dot',
  projects: base.projects!.filter((project) => project.name === 'chromium-desktop'),
  globalSetup: './i18nAuditSummary.ts',
  use: {
    ...base.use,
    trace: isCI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
