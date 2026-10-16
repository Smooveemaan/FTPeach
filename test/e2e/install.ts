// What the installer tests (install.vm.ts) work with: the test installers of
// scripts/release/test-installers.ts, where Tauri's NSIS installer puts
// FTPeach for the current user (with src-tauri/installer/hooks.nsh), what the
// registry says about it, the update feed the test builds read, and updates
// made up to fail. Installing touches the real profile and registry of the
// account running the tests, so they run only on a throwaway machine.
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, type Page } from '@playwright/test';
import { startProgram, type StartedProgram } from './app.ts';
import { call } from './ipc.ts';
import { menu, sha256, tree } from './panes.ts';
import { closeWindow, nativeWindows } from './windows.ts';

const root = path.resolve(import.meta.dirname, '../..');
const built = path.join(root, '.tools', 'installer-test');
const framework = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319';

/** What scripts/release/test-installers.ts built. */
export interface TestBuild {
  version: string;
  /** The next patch version, the update the feed offers. */
  next: string;
  feedPort: number;
  key: string;
  keyPassword: string;
}

export function testBuild(): TestBuild {
  const file = path.join(built, 'build.json');
  if (!existsSync(file)) throw new Error(`${file} is missing; run npm run build:test-installers`);
  return JSON.parse(readFileSync(file, 'utf8')) as TestBuild;
}

export const setupOf = (version: string) =>
  path.join(built, version, `FTPeach_${version}_x64-setup.exe`);
export const portableOf = (version: string) =>
  path.join(built, version, `FTPeach_${version}_x64-portable.zip`);

/**
 * Installing changes the account that runs the tests: its profile, its
 * registry, its Start menu. Only a CI runner or a machine said to be
 * throwaway (FTPEACH_DISPOSABLE_VM=1) is one where that harms nothing.
 */
export function requireThrowawayMachine() {
  if (process.env.GITHUB_ACTIONS !== 'true' && process.env.FTPEACH_DISPOSABLE_VM !== '1') {
    throw new Error(
      'The installer tests install and uninstall FTPeach for this Windows account and delete its FTPeach data. Run them on a throwaway machine with FTPEACH_DISPOSABLE_VM=1, or in CI (installer.yml).',
    );
  }
}

const env = process.env as Record<string, string> & { LOCALAPPDATA: string; APPDATA: string };
export const installDir = path.join(env.LOCALAPPDATA, 'FTPeach');
// The installer keeps the program's Cargo name; only the portable zip renames it.
export const installedExe = path.join(installDir, 'app.exe');
const uninstaller = path.join(installDir, 'uninstall.exe');
/** Settings, bookmarks, the vault (docs/storage.md). */
export const dataDir = path.join(env.APPDATA, 'FTPeach');
/** Recovered edits, the downloaded update, the WebView2 profile. */
export const localDir = path.join(env.LOCALAPPDATA, 'com.smooveemaan.ftpeach');
export const updatesDir = path.join(localDir, 'updates');
export const recoveredDir = path.join(localDir, 'recovered-edits');
export const UNINSTALL_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FTPeach';
/** The notification identity FTPeach registers at start (runtime/notification.rs). */
export const IDENTITY_KEY = 'HKCU\\Software\\Classes\\AppUserModelId\\com.smooveemaan.ftpeach';

const powershell = (command: string, variables: Record<string, string> = {}) =>
  execFileSync('powershell', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    env: { ...process.env, ...variables },
  }).trim();

export const startMenuShortcut = path.join(
  env.APPDATA,
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'FTPeach.lnk',
);
export const desktopShortcut = path.join(
  powershell("[Environment]::GetFolderPath('Desktop')"),
  'FTPeach.lnk',
);

export function registryValue(key: string, name: string): string | undefined {
  const result = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s{4}REG_\w+\s{4}(.*)$/.exec(line);
    if (match?.[1] === name) return match[2];
  }
  return undefined;
}

export const registryKeyExists = (key: string) =>
  spawnSync('reg', ['query', key], { stdio: 'ignore' }).status === 0;

/** The product version Windows reads from a program's version resource. */
export const fileVersion = (file: string) =>
  powershell('(Get-Item -LiteralPath $env:FILE).VersionInfo.ProductVersion', { FILE: file });

export const shortcutTarget = (shortcut: string) =>
  powershell('(New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK).TargetPath', {
    LINK: shortcut,
  });

/** Runs an installer silently, as people do with `/S` and as nothing else answers it. */
export function install(setup: string) {
  const result = spawnSync(setup, ['/S'], { timeout: 300_000 });
  if (result.status !== 0) {
    throw new Error(`${setup} /S ended with ${result.status ?? result.error}`);
  }
}

/** Processes of the copy an NSIS uninstaller runs from %TEMP%. */
const uninstallerRunning = () =>
  powershell(
    "@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*\\~nsu*.tmp\\*' }).Count",
  ) !== '0';

/**
 * The uninstaller copies itself to %TEMP%, starts the copy and ends, so it is
 * done once its file is gone and the copy has ended.
 */
async function uninstallerDone() {
  await expect
    .poll(() => existsSync(uninstaller) || uninstallerRunning(), { timeout: 180_000 })
    .toBe(false);
}

/** `uninstall.exe /S`: no confirmation page, so nothing asks to delete the data. */
export async function uninstallSilently() {
  spawnSync(uninstaller, ['/S']);
  await uninstallerDone();
}

/** uninstall.cs, built with the C# compiler every Windows has. */
function uninstallHelper(): string {
  const exe = path.join(mkdtempSync(path.join(tmpdir(), 'ftpeach-uninstall-')), 'uninstall.exe');
  execFileSync(`${framework}/csc.exe`, [
    '/nologo',
    '/target:exe',
    '/platform:x64',
    `/out:${exe}`,
    `/r:${framework}/WPF/UIAutomationClient.dll`,
    `/r:${framework}/WPF/UIAutomationTypes.dll`,
    `/r:${framework}/WPF/WindowsBase.dll`,
    path.join(import.meta.dirname, 'uninstall.cs'),
  ]);
  return exe;
}

/** The uninstaller as people see it, with "Delete the application data" ticked. */
export async function uninstallDeletingData() {
  const helper = uninstallHelper();
  spawn(uninstaller, [], { detached: true, stdio: 'ignore' }).unref();
  const { stdout } = await promisify(execFile)(
    helper,
    ['FTPeach Uninstall', 'Delete the application data'],
    { timeout: 240_000 },
  );
  expect((JSON.parse(stdout) as { ticked: boolean }).ticked).toBe(true);
  await uninstallerDone();
}

/** Removes a folder that WebView2 may still be letting go of. */
async function remove(folder: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(folder, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** Back to a machine that never had FTPeach, whatever the last test left. */
export async function removeFTPeach() {
  stopProgramsIn(installDir);
  // An uninstaller window a failed test left open would hold the next one up.
  powershell(
    "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*\\~nsu*.tmp\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
  );
  if (existsSync(uninstaller)) await uninstallSilently();
  for (const folder of [installDir, dataDir, localDir]) await remove(folder);
  for (const key of [UNINSTALL_KEY, IDENTITY_KEY]) {
    spawnSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
  }
  for (const shortcut of [startMenuShortcut, desktopShortcut]) rmSync(shortcut, { force: true });
}

/**
 * Puts profile files in the data folder, %APPDATA%\FTPeach unless a portable
 * copy's is given, then the settings `patch` over theirs.
 */
export function writeProfile(
  files: Record<string, string | Buffer>,
  patch: Record<string, unknown>,
  folder = dataDir,
) {
  mkdirSync(folder, { recursive: true });
  for (const [name, data] of Object.entries(files)) writeFileSync(path.join(folder, name), data);
  changeSettings(patch, folder);
}

/** Changes settings.json while FTPeach is not running. */
export function changeSettings(patch: Record<string, unknown>, folder = dataDir) {
  const file = path.join(folder, 'settings.json');
  const settings = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion: number; data: object })
    : { schemaVersion: 1, data: {} };
  writeFileSync(file, JSON.stringify({ ...settings, data: { ...settings.data, ...patch } }));
}

/** The settings an installed run starts with: English, no notifications, the updater as asked. */
export const runSettings = (autoCheckUpdates: boolean) => ({
  language: 'en',
  notifyOnTransferComplete: false,
  autoCheckUpdates,
});

export const RECOVERED_EDIT = 'notes from 0.x.txt';

/**
 * An edit an earlier session kept because it never reached the server, as
 * edit_recovery.rs keeps it: a folder with edit.json and the file. A
 * portable copy keeps its local data in `data\local`.
 */
export function keepEdit(local = localDir) {
  const folder = path.join(local, 'recovered-edits', randomUUID());
  mkdirSync(path.join(folder, 'file'), { recursive: true });
  writeFileSync(
    path.join(folder, 'edit.json'),
    JSON.stringify({
      name: RECOVERED_EDIT,
      remotePath: `/${RECOVERED_EDIT}`,
      savedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(path.join(folder, 'file', RECOVERED_EDIT), `kept ${randomUUID()}\n`);
}

/** The recovered edits, compared byte for byte; a portable copy keeps them in `data\local`. */
export const recoveredEdits = (folder = recoveredDir) => (existsSync(folder) ? tree(folder) : []);

/** The settings and the session as their files hold them; compare with toMatchObject. */
export const savedProfile = (folder = dataDir) => {
  const read = (name: string) =>
    (JSON.parse(readFileSync(path.join(folder, `${name}.json`), 'utf8')) as { data: object }).data;
  return { settings: read('settings'), tabs: read('tabs') };
};

/**
 * The store files FTPeach keeps until something changes them, byte for byte:
 * the files of the data folder itself. Left out is what every run writes:
 * settings and the session with their last-good backups, and the folders
 * (logs and, in a portable copy, the WebView2 profile and the local data).
 */
export const storedData = (folder = dataDir) =>
  (existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : [])
    .filter((entry) => entry.isFile() && !/^(tabs|settings)\./.test(entry.name))
    .map((entry) => `${entry.name} ${sha256(readFileSync(path.join(folder, entry.name)))}`)
    .sort();

/** Asks FTPeach which version it is. */
export async function runningVersion(page: Page) {
  const answer = await call(page, 'app_version');
  if (!answer.ok) throw new Error(`app_version: ${String(answer.error)}`);
  return answer.value;
}

export const recoveredOffer = (page: Page) =>
  page.getByRole('dialog').filter({ hasText: 'Edits that were not uploaded' });

/** The status bar's button that installs a downloaded update. */
export const installButton = (page: Page) =>
  page.getByRole('button', {
    name: 'Restart now to install. Otherwise the update installs the next time FTPeach starts.',
    exact: true,
  });

/** The status bar's button offering an update not downloaded yet. */
export const downloadButton = (page: Page) =>
  page.getByRole('button', { name: 'Click to download', exact: true });

export async function quit(app: StartedProgram) {
  await menu(app.page, 'File', 'Quit');
  await app.exited();
}

/** The process ids of programs running from `exe`. */
export const runningFrom = (exe: string) =>
  powershell(
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:EXE } | ForEach-Object { $_.ProcessId }',
    { EXE: exe },
  )
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);

/**
 * Ends every program running from under `folder`, with its WebView2
 * processes: by path, as other programs may share the name app.exe.
 */
export function stopProgramsIn(folder: string) {
  const pids = powershell(
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:FOLDER + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }',
    { FOLDER: folder },
  )
    .split(/\s+/)
    .filter(Boolean);
  for (const pid of pids) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
}

/**
 * Waits for the main window of process `pid` to be shown, then closes it as
 * Alt+F4 would and waits for the process to end: a program started without
 * the test build's DevTools port, by the installer or from a release.
 */
export async function closeOnceShown(pid: number) {
  const shown = () => nativeWindows(pid).find((window) => !window.owned && window.visible);
  await expect.poll(() => Boolean(shown()), { timeout: 60_000 }).toBe(true);
  closeWindow(pid, shown()!.handle);
  await expect.poll(() => alive(pid), { timeout: 60_000 }).toBe(false);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts the installed FTPeach and returns once its window is up. */
export const startInstalled = () => startProgram(installedExe);

// ---- The update feed ----

export interface Feed {
  /** The paths the application asked for, in order. */
  requests: string[];
  close: () => Promise<void>;
}

/**
 * Serves the update feed the test builds read: `latest.json` offering
 * `version`, the installer and the portable zip given, with the signatures
 * beside them unless `signatures` names others.
 */
export async function serveFeed(
  version: string,
  files: { installer?: string; portable?: string },
  signatures: { installer?: string; portable?: string } = {},
): Promise<Feed> {
  const { feedPort } = testBuild();
  const base = `http://127.0.0.1:${feedPort}`;
  const served = new Map<string, string>();
  const platforms: Record<string, { url: string; signature: string }> = {};
  for (const [kind, target] of [
    ['installer', 'windows-x86_64'],
    ['portable', 'windows-x86_64-portable'],
  ] as const) {
    const file = files[kind];
    if (!file) continue;
    const name = `${randomUUID()}-${path.basename(file)}`;
    served.set(`/${name}`, file);
    platforms[target] = {
      url: `${base}/${name}`,
      signature: signatures[kind] ?? readFileSync(`${file}.sig`, 'utf8').trim(),
    };
  }
  const latest = JSON.stringify({
    version,
    notes: 'Installer tests',
    pub_date: new Date().toISOString(),
    platforms,
  });
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    const file = served.get(url);
    if (url === '/latest.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(latest);
    } else if (file) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(readFileSync(file));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(feedPort, '127.0.0.1', resolve);
  });
  return {
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The path of an update the application asked the feed for, if it did. */
export const fetched = (feed: Feed, file: string) =>
  feed.requests.some((request) => request.endsWith(path.basename(file)));

// ---- Updates made up to fail ----

/** Signs `file` with the test key, as the release signs its artifacts; returns the signature. */
export function sign(file: string): string {
  const { key, keyPassword } = testBuild();
  execFileSync(
    process.execPath,
    ['node_modules/@tauri-apps/cli/tauri.js', 'signer', 'sign', file],
    {
      cwd: root,
      stdio: 'pipe',
      env: {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY: readFileSync(key, 'utf8'),
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: keyPassword,
      },
    },
  );
  return readFileSync(`${file}.sig`, 'utf8').trim();
}

/** A copy of `file` with one byte changed, in a folder of its own. */
export function damaged(file: string): string {
  const copy = path.join(mkdtempSync(path.join(tmpdir(), 'ftpeach-damaged-')), path.basename(file));
  copyFileSync(file, copy);
  flipByte(copy);
  return copy;
}

/** Changes one byte in the middle of `file`. */
export function flipByte(file: string) {
  const bytes = readFileSync(file);
  const middle = Math.floor(bytes.length / 2);
  bytes[middle] = bytes[middle]! ^ 0xff;
  writeFileSync(file, bytes);
}

/**
 * The fixed version information Windows keeps in a program, saying
 * `version`: what FTPeach reads an installer's version from
 * (`embedded_version` in runtime/update_staging.rs), as NSIS writes it:
 * with the structure version left at 0.
 */
function versionInfo(version: string): Buffer {
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  const info = Buffer.alloc(52);
  info.writeUInt32LE(0xfeef04bd, 0);
  for (const at of [8, 16]) {
    info.writeUInt32LE(((major << 16) | minor) >>> 0, at);
    info.writeUInt32LE((patch << 16) >>> 0, at + 4);
  }
  return info;
}

/**
 * The version FTPeach 0.3.0 to 0.4.0 read from an installer before running
 * it as an update: only from a version structure of 1.0, which NSIS does not
 * write (src-tauri/installer/version-info.ps1 adds one).
 */
export function versionOlderReleasesRead(installer: Buffer): string | undefined {
  const at = installer.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe, 0, 0, 1, 0]));
  if (at < 0) return undefined;
  const [high, low] = [installer.readUInt32LE(at + 16), installer.readUInt32LE(at + 20)];
  return `${high >>> 16}.${high & 0xffff}.${low >>> 16}`;
}

/**
 * An "installer" for `version`, signed with the test key, that Windows cannot
 * start: text, with the version information FTPeach checks.
 */
export function notAProgram(version: string): string {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), 'ftpeach-not-a-program-')),
    `FTPeach_${version}_x64-setup.exe`,
  );
  writeFileSync(file, Buffer.concat([Buffer.from('Not a program.\r\n'), versionInfo(version)]));
  sign(file);
  return file;
}

/**
 * An installer for `version`, signed with the test key, that fails: it adds
 * a line with its arguments to `runs` and ends with 1, installing nothing.
 */
export function failingInstaller(version: string, runs: string): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'ftpeach-failing-'));
  const source = path.join(folder, 'installer.cs');
  const file = path.join(folder, `FTPeach_${version}_x64-setup.exe`);
  const assembly = `${version}.0`;
  writeFileSync(
    source,
    [
      'using System.IO;',
      'using System.Reflection;',
      `[assembly: AssemblyVersion("${assembly}")]`,
      `[assembly: AssemblyFileVersion("${assembly}")]`,
      `[assembly: AssemblyInformationalVersion("${version}")]`,
      'static class Installer {',
      '  static int Main(string[] args) {',
      `    File.AppendAllText(@"${runs.replaceAll('"', '""')}", string.Join(" ", args) + "\\r\\n");`,
      '    return 1;',
      '  }',
      '}',
    ].join('\n'),
  );
  execFileSync(`${framework}/csc.exe`, ['/nologo', '/target:winexe', `/out:${file}`, source]);
  sign(file);
  return file;
}

// ---- The release before this one ----

interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

const parts = (version: string) => version.split('.').map(Number);
const older = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  const index = x.findIndex((part, at) => part !== y[at]);
  return index >= 0 && x[index]! < y[index]!;
};

/**
 * The installer of the newest published release older than `version`, from
 * GitHub, kept in .tools/installer-test/previous.
 */
export async function previousRelease(
  version: string,
): Promise<{ version: string; setup: string }> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(
    'https://api.github.com/repos/Smooveemaan/ftpeach/releases?per_page=50',
    { headers },
  );
  if (!response.ok) throw new Error(`GitHub releases: ${response.status}`);
  const releases = ((await response.json()) as Release[]).filter(
    (release) => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name),
  );
  const previous = releases
    .map((release) => ({ release, version: release.tag_name.slice(1) }))
    .filter((each) => older(each.version, version))
    .sort((a, b) => (older(a.version, b.version) ? 1 : -1))[0];
  if (!previous) throw new Error(`No published release is older than ${version}`);
  const name = `FTPeach_${previous.version}_x64-setup.exe`;
  const asset = previous.release.assets.find((each) => each.name === name);
  if (!asset) throw new Error(`${previous.release.tag_name} has no ${name}`);
  const setup = path.join(built, 'previous', name);
  if (!existsSync(setup)) {
    const download = await fetch(asset.browser_download_url);
    if (!download.ok) throw new Error(`${asset.browser_download_url}: ${download.status}`);
    mkdirSync(path.dirname(setup), { recursive: true });
    writeFileSync(setup, Buffer.from(await download.arrayBuffer()));
  }
  return { version: previous.version, setup };
}
