// Starts the real application for a desktop end-to-end test: the packaged
// smoke build (production frontend, `FTPEACH_SMOKE_TEST` unset, so it runs as
// the ordinary application), a throwaway profile, and Playwright attached to
// its WebView2 over the Chrome DevTools Protocol.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, test as base, type Browser, type Page } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '../..');
export const APP_PATH =
  process.env.FTPEACH_E2E_APP ?? path.join(root, '.tools', 'smoke-target', 'debug', 'app.exe');

export interface RunningApp {
  /** The main window of the current run; `relaunch` replaces it. */
  page: Page;
  /** A folder of this run's own, for local files the test prepares. */
  workDir: string;
  /** The profile's `%APPDATA%\FTPeach`, where settings.json and tabs.json live. */
  dataDir: string;
  /** The profile's local application data: Open with copies, recovered edits. */
  localDir: string;
  /** Where a save dialog saves: the test build answers it with this folder. */
  savedDir: string;
  /** How the test build answers the next Choose folder dialogs: that folder, or `null` to cancel. */
  pickFolder: (_folder: string | null) => void;
  /** The next window the application opens besides the main one, such as a security confirmation. */
  otherWindow: () => Promise<Page>;
  /** Whether the application process is still alive. */
  running: () => boolean;
  /** The application's process id. */
  pid: () => number;
  /** The application's own log so far. */
  log: () => string;
  /** Ends the process at once, as a crash or Task Manager would. */
  kill: () => Promise<void>;
  /**
   * Starts the application again on the same profile and work folder, once
   * the last run has exited (a quit through the window, or `kill`).
   */
  relaunch: () => Promise<void>;
  /** Stops the application, removes its profile and returns its log. */
  close: () => Promise<string>;
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

/**
 * What a launch that never opened its debugging port left to go on: whether
 * the process is alive, what WebView2 was started with, and the app's log.
 */
function diagnose(child: ChildProcess, profile: string): string {
  const webviews = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "name=\'msedgewebview2.exe\'" | ForEach-Object { $_.CommandLine }',
    ],
    { encoding: 'utf8' },
  ).stdout;
  return [
    `app process: ${child.exitCode === null ? 'running' : `exited with ${child.exitCode}`}`,
    `WebView2 processes:\n${webviews.trim() || '(none)'}`,
    appLogs(profile, 4000),
  ].join('\n');
}

/** The tail of each of the application's own log files in the profile. */
function appLogs(profile: string, tail: number): string {
  return (readdirSync(profile, { recursive: true }) as string[])
    .filter((file) => /ftpeach[^\\/]*\.log$/i.test(file))
    .map((file) => `--- ${file}\n${readFileSync(path.join(profile, file), 'utf8').slice(-tail)}`)
    .join('\n');
}

function stop(child: ChildProcess) {
  if (child.pid && child.exitCode === null) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

/** One process of the application, attached over DevTools. */
interface Run {
  child: ChildProcess;
  cdpPort: number;
  browser?: Browser;
}

/**
 * Starts the application on a prepared profile. `run` is filled in as soon as
 * the process exists, so a failed start can still be stopped.
 */
async function start(
  profile: string,
  workDir: string,
  savedDir: string,
  pickFile: string,
  run: Partial<Run>,
): Promise<Page> {
  // The application is single-instance: a running copy would take the launch
  // over and the test would drive the wrong profile.
  const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq app.exe'], { encoding: 'utf8' });
  const ftpeach = spawnSync('tasklist', ['/FI', 'IMAGENAME eq FTPeach.exe'], { encoding: 'utf8' });
  if (running.stdout.includes('app.exe') || ftpeach.stdout.includes('FTPeach.exe')) {
    throw new Error('Close every running FTPeach first: the application is single-instance');
  }
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
      // Tauri finds its WebView2 profile through the Windows known-folder API,
      // not LOCALAPPDATA: without this the run shares the real user's profile.
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, 'Local', 'webview2'),
      // The test build listens for DevTools on this port (runtime/startup.rs);
      // WebView2 ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS on some runners.
      FTPEACH_E2E_CDP_PORT: String(cdpPort),
      // No one can answer a native save dialog in a run; the test build saves here.
      FTPEACH_E2E_SAVE_DIR: savedDir,
      // Nor a Choose folder dialog: the test build picks the folder this file names.
      FTPEACH_E2E_PICK_FILE: pickFile,
    },
  });
  Object.assign(run, { child, cdpPort });
  try {
    await waitFor('the debugging port', async () => (await portOpen(cdpPort)) || undefined, 60);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${diagnose(child, profile)}`);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  run.browser = browser;
  const page = await waitFor('the main window', async () => browser.contexts()[0]?.pages()[0], 30);
  await page.getByRole('button', { name: 'Manage Bookmarks', exact: true }).waitFor();
  return page;
}

/**
 * Launches the application on a throwaway profile holding `settings` and the
 * `store` files (name to data, or to the raw text of a file that is not a
 * plain store). `onStart` runs on the main window of every run.
 */
export async function launchApp(
  settings: Record<string, unknown> = {},
  store: Record<string, unknown> = {},
  onStart: (_page: Page) => Promise<void> = async () => {},
): Promise<RunningApp> {
  if (!existsSync(APP_PATH)) {
    throw new Error(`${APP_PATH} is missing; run npm run build:packaged-smoke first`);
  }
  const base = mkdtempSync(path.join(tmpdir(), 'ftpeach-e2e-'));
  const profile = path.join(base, 'profile');
  const workDir = path.join(base, 'work');
  const savedDir = path.join(base, 'saved');
  const pickFile = path.join(base, 'pick.txt');
  const dataDir = path.join(profile, 'Roaming', 'FTPeach');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(profile, 'Local'), { recursive: true });
  mkdirSync(workDir);
  mkdirSync(savedDir);
  // An explicit language, so the run reads the same on any Windows display
  // language; everything else starts from the defaults unless the test says.
  // The window sits off screen and unfocused, where a finished transfer would
  // pop a Windows notification, so those are off.
  // Other store files, such as sites.json, are what a user saved earlier.
  const files = {
    'settings.json': { language: 'en', notifyOnTransferComplete: false, ...settings },
    ...store,
  };
  for (const [name, data] of Object.entries(files)) {
    writeFileSync(
      path.join(dataDir, name),
      typeof data === 'string' ? data : JSON.stringify({ schemaVersion: 1, data }),
    );
  }

  let run: Partial<Run> = {};
  /** Waits for the process and its debugging port to be gone, killing it if `force`. */
  const end = async (force: boolean) => {
    const { child, cdpPort, browser } = run;
    await browser?.close().catch(() => {});
    if (child && force) stop(child);
    if (child) {
      await waitFor('the app to exit', async () => child.exitCode !== null || undefined, 30);
    }
    if (cdpPort) {
      await waitFor('the app to close', async () => !(await portOpen(cdpPort)) || undefined, 30);
    }
  };
  const close = async () => {
    await end(true);
    const logs = appLogs(profile, 200_000);
    // WebView2 lets go of its profile a moment after the process ends.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(base, { recursive: true, force: true });
        return logs;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    return logs;
  };
  const app: RunningApp = {
    page: undefined as unknown as Page,
    workDir,
    dataDir,
    localDir: path.join(profile, 'Local', 'com.smooveemaan.ftpeach'),
    savedDir,
    pickFolder: (folder) => writeFileSync(pickFile, folder ?? ''),
    otherWindow: () =>
      waitFor(
        'another window',
        async () =>
          run
            .browser!.contexts()
            .flatMap((context) => context.pages())
            .find((other) => other !== app.page),
        30,
      ),
    running: () => run.child?.exitCode === null,
    pid: () => run.child!.pid!,
    log: () => appLogs(profile, 200_000),
    kill: () => end(true),
    relaunch: async () => {
      await end(false);
      run = {};
      app.page = await start(profile, workDir, savedDir, pickFile, run);
      await onStart(app.page);
    },
    close,
  };
  try {
    app.page = await start(profile, workDir, savedDir, pickFile, run);
    await onStart(app.page);
    return app;
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * The test API with `app`: the running application, with a trace of the last
 * run attached and the process and profile gone afterwards, a timed-out test
 * too. `test.use({ appSettings, appStore })` starts it with those settings and
 * store files (see `launchApp`) in its profile.
 */
export const test = base.extend<{
  appSettings: Record<string, unknown>;
  appStore: Record<string, unknown>;
  app: RunningApp;
}>({
  appSettings: [{}, { option: true }],
  appStore: [{}, { option: true }],
  app: async ({ appSettings, appStore }, use, testInfo) => {
    // A run that exits takes its trace along; each relaunch starts a new one.
    const app = await launchApp(appSettings, appStore, (page) =>
      page.context().tracing.start({ screenshots: true, snapshots: true }),
    );
    try {
      await use(app);
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (failed) {
        await testInfo.attach('window', {
          body: await app.page.screenshot().catch(() => Buffer.alloc(0)),
          contentType: 'image/png',
        });
      }
      await app.page
        ?.context()
        .tracing.stop({ path: testInfo.outputPath('trace.zip') })
        .catch(() => {});
      const logs = await app.close();
      // A file, so the CI artifact of test results carries it too.
      if (failed) {
        writeFileSync(testInfo.outputPath('app.log'), logs);
        await testInfo.attach('app.log', { path: testInfo.outputPath('app.log') });
      }
    }
  },
});
