import { defineConfig } from '@playwright/test';
import visualConfig from '../../playwright.config.ts';

const config = { ...visualConfig };
// Website tests serve their own files through Playwright routes.
delete config.webServer;

export default defineConfig({
  ...config,
  testDir: import.meta.dirname,
  testMatch: /website-.*\.spec\.ts$/,
  outputDir: '../../test-results/site',
  projects: visualConfig.projects!.map((project) => ({ ...project, testIgnore: [] })),
});
