import { defineConfig } from '@playwright/test';

// The installer tests drive the real installer and the installed application
// (install.ts, app.ts). They install FTPeach for the account running them, so
// they run only on a throwaway machine (`npm run test:e2e:vm`), one at a time,
// and a failure is never retried into a pass.
export default defineConfig({
  testDir: '.',
  outputDir: '../../test-results/e2e',
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // An install, a download and the installer's own run fit in no less.
  projects: [{ name: 'vm', testMatch: '*.vm.ts', timeout: 600_000 }],
});
