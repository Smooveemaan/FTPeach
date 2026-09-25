import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

/** `npm run i18n:audit`: the layout audit in every language (test/visual/i18n-layout.audit.ts). */
export default defineConfig({
  ...base,
  testMatch: '**/*.audit.ts',
  outputDir: './test-results/i18n-audit/playwright',
  retries: 0,
  reporter: 'dot',
  globalSetup: './test/visual/i18nAuditSummary.ts',
  use: { ...base.use, trace: 'off' },
});
