// Starts the real application for a desktop end-to-end test: the packaged
// smoke build (production frontend, `FTPEACH_SMOKE_TEST` unset, so it runs as
// the ordinary application), a throwaway profile, and Playwright attached to
// its WebView2 over the Chrome DevTools Protocol.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, test as base, type Browser, type Page } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '../..');
export const APP_PATH =
  process.env.FTPEACH_E2E_APP ?? path.join(root, '.tools', 'smoke-target', 'debug', 'app.exe');

export interface RunningApp {
  page: Page;
  /** A folder of this run's own, for local files the test prepares. */
  workDir: string;
  close: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => socket.end(() => resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out after ${seconds} s waiting for ${what}`);
}

function stop(child: ChildProcess) {
  if (child.pid && child.exitCode === null) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

export async function launchApp(): Promise<RunningApp> {
  if (!existsSync(APP_PATH)) {
    throw new Error(`${APP_PATH} is missing; run npm run build:packaged-smoke first`);
  }
  // The application is single-instance: a running copy would take the launch
  // over and the test would drive the wrong profile.
  const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq app.exe'], { encoding: 'utf8' });
  const ftpeach = spawnSync('tasklist', ['/FI', 'IMAGENAME eq FTPeach.exe'], { encoding: 'utf8' });
  if (running.stdout.includes('app.exe') || ftpeach.stdout.includes('FTPeach.exe')) {
    throw new Error('Close every running FTPeach first: the application is single-instance');
  }

  const base = mkdtempSync(path.join(tmpdir(), 'ftpeach-e2e-'));
  const profile = path.join(base, 'profile');
  const workDir = path.join(base, 'work');
  mkdirSync(path.join(profile, 'Roaming', 'FTPeach'), { recursive: true });
  mkdirSync(path.join(profile, 'Local'), { recursive: true });
  mkdirSync(workDir);
  // An explicit language, so the run reads the same on any Windows display
  // language; everything else starts from the defaults.
  writeFileSync(
    path.join(profile, 'Roaming', 'FTPeach', 'settings.json'),
    JSON.stringify({ schemaVersion: 1, data: { language: 'en' } }),
  );

  const cdpPort = await freePort();
  // The smoke build runs its self-test whenever this variable exists, even empty.
  const env = { ...process.env };
  delete env.FTPEACH_SMOKE_TEST;
  const child = spawn(APP_PATH, [], {
    cwd: workDir,
    stdio: 'ignore',
    env: {
      ...env,
      APPDATA: path.join(profile, 'Roaming'),
      LOCALAPPDATA: path.join(profile, 'Local'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    },
  });

  let browser: Browser | undefined;
  const close = async () => {
    await browser?.close().catch(() => {});
    stop(child);
    await waitFor('the app to close', async () => !(await portOpen(cdpPort)) || undefined, 30);
    // WebView2 lets go of its profile a moment after the process ends.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(base, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };
  try {
    await waitFor('the debugging port', async () => (await portOpen(cdpPort)) || undefined, 60);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await waitFor(
      'the main window',
      async () => browser!.contexts()[0]?.pages()[0],
      30,
    );
    await page.getByRole('button', { name: 'Manage Bookmarks', exact: true }).waitFor();
    return { page, workDir, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * The test API with `app`: the running application, with a trace of the run
 * attached and the process and profile gone afterwards, a timed-out test too.
 */
export const test = base.extend<{ app: RunningApp }>({
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, use, testInfo) => {
    const app = await launchApp();
    const tracing = app.page.context().tracing;
    await tracing.start({ screenshots: true, snapshots: true });
    try {
      await use(app);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('window', {
          body: await app.page.screenshot().catch(() => Buffer.alloc(0)),
          contentType: 'image/png',
        });
      }
      await tracing.stop({ path: testInfo.outputPath('trace.zip') }).catch(() => {});
      await app.close();
    }
  },
});
