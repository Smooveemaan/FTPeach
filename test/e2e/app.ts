// Starts the real application for a desktop end-to-end test: the packaged
// smoke build (production frontend, `FTPEACH_SMOKE_TEST` unset, so it runs as
// the ordinary application), a throwaway profile, and Playwright attached to
// its WebView2 over the Chrome DevTools Protocol.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, test as base, type Browser, type Page } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '../..');
export const APP_PATH =
  process.env.FTPEACH_E2E_APP ?? path.join(root, '.tools', 'smoke-target', 'debug', 'app.exe');

const HELD_BACK = 'desktop tests: held back';
/** Held-back lines a test read through `heldBack`. */
const expectedHeld = new Set<string>();

export interface RunningApp {
  /** The main window of the current run; `relaunch` replaces it. */
  page: Page;
  /** A folder of this run's own, for local files the test prepares. */
  workDir: string;
  /** The profile's `%APPDATA%\FTPeach`, where settings.json and tabs.json live; a portable copy's `data`. */
  dataDir: string;
  /** The profile's local application data: Open with copies, recovered edits; a portable copy's `data\local`. */
  localDir: string;
  /** The throwaway profile in place of the Windows one, with `Roaming` and `Local` in it; the next start uses the one set here. */
  profileDir: string;
  /** The program the next start runs: a test that moves a portable copy points it at the new place. */
  exe: string;
  /** Where a save dialog saves: the test build answers it with this folder. */
  savedDir: string;
  /** How the test build answers the next Choose folder dialogs and key or certificate pickers: that path, or `null` to cancel. */
  pick: (_picked: string | null) => void;
  /** The next window the application opens besides the main one, such as a security confirmation. */
  otherWindow: () => Promise<Page>;
  /** Whether the application process is still alive. */
  running: () => boolean;
  /** The application's process id. */
  pid: () => number;
  /** The application's own log so far. */
  log: () => string;
  /**
   * What the test build held back from opening outside FTPeach so far (a
   * program, Explorer); the ones read here are expected and no longer fail the test.
   */
  heldBack: () => string[];
  /** Ends the process at once, as a crash or Task Manager would. */
  kill: () => Promise<void>;
  /** Quits through File > Quit and waits for the process to exit. */
  quit: () => Promise<void>;
  /**
   * Starts the application again on the same profile and work folder, once
   * the last run has exited (a quit through the window, or `kill`).
   */
  relaunch: () => Promise<void>;
  /** Stops the application, removes its profile and returns its log. */
  close: () => Promise<string>;
  /**
   * Lets go of the DevTools connection until `reattach`. While attached,
   * Playwright keeps DevTools' network log on, and that keeps a few kilobytes
   * of every request in the renderer, every IPC call included.
   */
  detach: () => Promise<void>;
  /** Attaches again after `detach`; `page` is the main window anew. */
  reattach: () => Promise<void>;
}

export function freePort(): Promise<number> {
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

/** The tail of each of the application's own log files in the profile, or beside a portable copy. */
function appLogs(base: string, tail: number): string {
  return (readdirSync(base, { recursive: true }) as string[])
    .filter((file) => /ftpeach[^\\/]*\.log$/i.test(file))
    .map((file) => `--- ${file}\n${readFileSync(path.join(base, file), 'utf8').slice(-tail)}`)
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
 * Starts the application on a prepared profile, or with `null` on the
 * profile of the account running the test, as an installed copy runs. `run`
 * is filled in as soon as the process exists, so a failed start can still be
 * stopped.
 */
async function start(
  exe: string,
  profile: string | null,
  workDir: string,
  savedDir: string,
  pickFile: string,
  realDialogs: boolean,
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
  const portable = existsSync(path.join(path.dirname(exe), 'FTPeach.portable'));
  // The smoke build runs its self-test whenever this variable exists, even empty.
  const env = { ...process.env };
  delete env.FTPEACH_SMOKE_TEST;
  const child = spawn(exe, [], {
    cwd: workDir,
    stdio: 'ignore',
    env: {
      ...env,
      ...(profile && {
        APPDATA: path.join(profile, 'Roaming'),
        LOCALAPPDATA: path.join(profile, 'Local'),
      }),
      // Tauri finds its WebView2 profile through the Windows known-folder API,
      // not LOCALAPPDATA: without this the run shares the real user's profile.
      // A portable copy names its own, which this variable would override.
      ...(profile &&
        !portable && { WEBVIEW2_USER_DATA_FOLDER: path.join(profile, 'Local', 'webview2') }),
      // The test build listens for DevTools on this port (runtime/startup.rs);
      // WebView2 ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS on some runners.
      FTPEACH_E2E_CDP_PORT: String(cdpPort),
      // No one can answer a native save dialog in a run; the test build saves here.
      // Nor a Choose folder dialog or a file picker: the test build picks what
      // this file names. The native tests answer the real dialogs instead.
      ...(realDialogs ? {} : { FTPEACH_E2E_SAVE_DIR: savedDir, FTPEACH_E2E_PICK_FILE: pickFile }),
    },
  });
  Object.assign(run, { child, cdpPort });
  try {
    await waitFor('the debugging port', async () => (await portOpen(cdpPort)) || undefined, 60);
  } catch (error) {
    const logs = profile
      ? path.dirname(profile)
      : portable
        ? path.dirname(exe)
        : path.join(process.env.APPDATA!, 'FTPeach');
    throw new Error(`${(error as Error).message}\n${diagnose(child, logs)}`);
  }
  run.browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  return mainWindow(run.browser, startLanguage(exe, profile));
}

/**
 * The language a start shows, from the settings it reads: a portable copy's
 * beside the program, else the profile's (the account's own for `null`).
 */
function startLanguage(exe: string, profile: string | null): string {
  const portable = existsSync(path.join(path.dirname(exe), 'FTPeach.portable'));
  const dataDir = portable
    ? path.join(path.dirname(exe), 'data')
    : path.join(profile ? path.join(profile, 'Roaming') : process.env.APPDATA!, 'FTPeach');
  try {
    return (
      JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).data.language ?? 'en'
    );
  } catch {
    return 'en';
  }
}

/**
 * The main window once its page has loaded: the remote pane's buttons are
 * there, and `lang` names the language, set only once its text has loaded.
 * Whatever the language, the English names of the first frame never count.
 */
async function mainWindow(browser: Browser, language = 'en'): Promise<Page> {
  const page = await waitFor('the main window', async () => browser.contexts()[0]?.pages()[0], 30);
  await page
    .locator(`html[lang="${language}"] .pane[data-side=b] button[aria-label]`)
    .first()
    .waitFor();
  return page;
}

/** A program started outside `launchApp`, on the profile of the account running the test. */
export interface StartedProgram {
  page: Page;
  cdpPort: number;
  pid: () => number;
  running: () => boolean;
  /** Waits for the process to end by itself. */
  exited: () => Promise<void>;
  /** Ends the process at once, if it still runs. */
  kill: () => Promise<void>;
}

/**
 * Starts `exe`, an installed FTPeach or a portable copy built for the tests,
 * on the profile of the account running the test, as people run it. The
 * installer tests (install.vm.ts) do this on a throwaway machine only.
 */
export async function startProgram(exe: string): Promise<StartedProgram> {
  const workDir = mkdtempSync(path.join(tmpdir(), 'ftpeach-program-'));
  const run: Partial<Run> = {};
  const exited = async () => {
    await waitFor('the program to exit', async () => run.child!.exitCode !== null || undefined, 60);
  };
  try {
    const page = await start(exe, null, workDir, workDir, path.join(workDir, 'pick'), false, run);
    return {
      page,
      cdpPort: run.cdpPort!,
      pid: () => run.child!.pid!,
      running: () => run.child!.exitCode === null,
      exited,
      kill: async () => {
        await run.browser?.close().catch(() => {});
        stop(run.child!);
        await exited();
      },
    };
  } catch (error) {
    if (run.child) stop(run.child);
    throw error;
  }
}

/**
 * The main window of whatever FTPeach listens on `cdpPort` now: the program a
 * portable update starts in place of the old one inherits its variables, the
 * debugging port too.
 */
export async function attach(cdpPort: number): Promise<Page> {
  await waitFor('the debugging port', async () => (await portOpen(cdpPort)) || undefined, 60);
  return mainWindow(await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`));
}

/**
 * Launches the application on a throwaway profile holding `settings` and the
 * `store` files (name to data, or to the raw text or bytes of a file that is
 * not a plain store). `onStart` runs on the main window of every run. A `portable`
 * copy is the program copied into a folder of its own beside the
 * `FTPeach.portable` marker, with the store files in `data` there. With
 * `realDialogs` it shows the real file dialogs, which the native tests answer.
 * `onPhaseEnd` runs on the main window just before a test ends a run itself
 * (`quit`, `kill`), while the window can still give up its trace.
 */
export async function launchApp(
  settings: Record<string, unknown> = {},
  store: Record<string, unknown> = {},
  onStart: (_page: Page) => Promise<void> = async () => {},
  portable = false,
  realDialogs = false,
  onPhaseEnd: (_page: Page) => Promise<void> = async () => {},
): Promise<RunningApp> {
  if (!existsSync(APP_PATH)) {
    throw new Error(`${APP_PATH} is missing; run npm run build:packaged-smoke first`);
  }
  const base = mkdtempSync(path.join(tmpdir(), 'ftpeach-e2e-'));
  const profile = path.join(base, 'profile');
  const workDir = path.join(base, 'work');
  const savedDir = path.join(base, 'saved');
  const pickFile = path.join(base, 'pick.txt');
  const program = path.join(base, 'program');
  const exe = portable ? path.join(program, 'FTPeach.exe') : APP_PATH;
  if (portable) {
    mkdirSync(program);
    copyFileSync(APP_PATH, exe);
    writeFileSync(path.join(program, 'FTPeach.portable'), '');
  }
  const dataDir = portable ? path.join(program, 'data') : path.join(profile, 'Roaming', 'FTPeach');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(profile, 'Roaming'), { recursive: true });
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
      typeof data === 'string' || Buffer.isBuffer(data)
        ? data
        : JSON.stringify({ schemaVersion: 1, data }),
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
    const logs = appLogs(base, 200_000);
    // WebView2 lets go of its profile a moment after the process ends.
    let failure: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(base, { recursive: true, force: true });
        return logs;
      } catch (error) {
        failure = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    // A profile left behind is a leak into the next run, never a pass.
    throw new Error(`Could not remove the test profile ${base}; its logs are still there`, {
      cause: failure,
    });
  };
  const app: RunningApp = {
    page: undefined as unknown as Page,
    workDir,
    dataDir,
    localDir: portable
      ? path.join(dataDir, 'local')
      : path.join(profile, 'Local', 'com.smooveemaan.ftpeach'),
    profileDir: profile,
    exe,
    savedDir,
    pick: (picked) => writeFileSync(pickFile, picked ?? ''),
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
    log: () => appLogs(base, 200_000),
    heldBack: () =>
      app
        .log()
        .split('\n')
        .filter((line) => line.includes(HELD_BACK))
        .map((line) => {
          expectedHeld.add(line);
          return line.replace(/.*held back opening (.*) outside FTPeach.*/, '$1');
        }),
    kill: async () => {
      await onPhaseEnd(app.page).catch(() => {});
      await end(true);
    },
    quit: async () => {
      await onPhaseEnd(app.page).catch(() => {});
      const { page } = app;
      await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
      await page.getByRole('menuitem', { name: /^Quit( |$)/ }).click();
      await waitFor('the app to exit', async () => run.child?.exitCode !== null || undefined, 30);
    },
    relaunch: async () => {
      await end(false);
      run = {};
      app.page = await start(
        app.exe,
        app.profileDir,
        workDir,
        savedDir,
        pickFile,
        realDialogs,
        run,
      );
      await onStart(app.page);
    },
    close,
    detach: async () => {
      await run.browser?.close();
      delete run.browser;
    },
    reattach: async () => {
      run.browser = await chromium.connectOverCDP(`http://127.0.0.1:${run.cdpPort}`);
      app.page = await mainWindow(run.browser);
    },
  };
  try {
    app.page = await start(exe, profile, workDir, savedDir, pickFile, realDialogs, run);
    await onStart(app.page);
    return app;
  } catch (error) {
    // The start failing is the news; a profile it leaves is secondary.
    await close().catch(() => {});
    throw error;
  }
}

/**
 * Every file and folder under a run's folder (work, saved, profile, a portable
 * program) with its size, and the SHA-256 of files up to a megabyte outside
 * WebView2's own data.
 */
export function inventory(root: string): string {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) return `${relative}\\`;
      try {
        const size = statSync(full).size;
        const hash =
          size <= 1 << 20 && !relative.includes('EBWebView')
            ? createHash('sha256').update(readFileSync(full)).digest('hex')
            : '';
        return `${relative} ${size} ${hash}`.trimEnd();
      } catch (error) {
        return `${relative} unreadable: ${(error as Error).message}`;
      }
    })
    .sort()
    .join('\n');
}

/**
 * The test API with `app`: the running application, with a trace of the last
 * run attached and the process and profile gone afterwards, a timed-out test
 * too. `test.use({ appSettings, appStore, appPortable, appRealDialogs })`
 * starts it with those settings and store files in its profile, as a portable
 * copy, or with the real file dialogs (see `launchApp`).
 */
export const test = base.extend<{
  appSettings: Record<string, unknown>;
  appStore: Record<string, unknown>;
  appPortable: boolean;
  appRealDialogs: boolean;
  app: RunningApp;
}>({
  appSettings: [{}, { option: true }],
  appStore: [{}, { option: true }],
  appPortable: [false, { option: true }],
  appRealDialogs: [false, { option: true }],
  app: async ({ appSettings, appStore, appPortable, appRealDialogs }, use, testInfo) => {
    // Each run records a trace. One the test ends itself (quit, kill) is
    // saved as trace-phase-N.zip first; a run that exits any other way takes
    // its trace along. The last run's is trace.zip.
    let phase = 0;
    const app = await launchApp(
      appSettings,
      appStore,
      (page) => page.context().tracing.start({ screenshots: true, snapshots: true }),
      appPortable,
      appRealDialogs,
      (page) =>
        page.context().tracing.stop({ path: testInfo.outputPath(`trace-phase-${++phase}.zip`) }),
    );
    let held: string[] = [];
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
      // What the run left on disk, before close removes it.
      if (failed) {
        writeFileSync(testInfo.outputPath('files.txt'), inventory(path.dirname(app.profileDir)));
        await testInfo.attach('files.txt', { path: testInfo.outputPath('files.txt') });
      }
      const logs = await app.close();
      // A file, so the CI artifact of test results carries it too.
      if (failed) {
        writeFileSync(testInfo.outputPath('app.log'), logs);
        await testInfo.attach('app.log', { path: testInfo.outputPath('app.log') });
      }
      held = logs.split('\n').filter((line) => line.includes(HELD_BACK) && !expectedHeld.has(line));
    }
    // The test build holds back a program, Explorer or Windows' Open with
    // chooser that would come up on the screen; a test that set one off, say
    // by a double click it did not mean, fails.
    if (held.length > 0) {
      throw new Error(`The test opened something outside FTPeach:\n${held.join('\n')}`);
    }
  },
});
