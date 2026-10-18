// The installer as people get it, on a throwaway Windows machine: a clean
// install, uninstalling with and without the data, upgrading the release
// before this one with a profile in place, and the updater installing what
// the feed offers, for the installed and the portable copy, including updates
// that are damaged or fail. The installers are this checkout's release build
// with a test key and a local feed (scripts/release/test-installers.ts); the
// previous release is the published one. Each test starts from a machine
// without FTPeach, so any one can run alone. Checked from outside: the
// registry, the files on disk, the version Windows reads from the program,
// and the window of the program that runs.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { attach, inventory, startProgram, tempFolder } from './app.ts';
import {
  changeSettings,
  closeOnceShown,
  damaged,
  dataDir,
  desktopShortcut,
  downloadButton,
  failingInstaller,
  fetched,
  fileVersion,
  flipByte,
  IDENTITY_KEY,
  install,
  installButton,
  installDir,
  installedExe,
  keepEdit,
  localDir,
  notAProgram,
  portableOf,
  previousRelease,
  quit,
  RECOVERED_EDIT,
  recoveredEdits,
  recoveredOffer,
  registryKeyExists,
  registryValue,
  removeFTPeach,
  requireThrowawayMachine,
  runningFrom,
  runningVersion,
  runSettings,
  savedProfile,
  serveFeed,
  setupOf,
  shortcutTarget,
  startInstalled,
  startMenuShortcut,
  stopProgramsIn,
  storedData,
  testBuild,
  UNINSTALL_KEY,
  uninstallDeletingData,
  uninstallSilently,
  versionOlderReleasesRead,
  updatesDir,
  writeProfile,
} from './install.ts';
import { connectBookmark, menu, sha256, tree } from './panes.ts';
import { profile } from './profiles.ts';

test.beforeEach(async () => {
  requireThrowawayMachine();
  await removeFTPeach();
});

// The next test starts by removing them, and CI keeps only the test results.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  // What the program and its data looked like: each folder's files with size and hash.
  const files = [installDir, dataDir, localDir]
    .filter((folder) => existsSync(folder))
    .map((folder) => `== ${folder}\n${inventory(folder)}`)
    .join('\n\n');
  await testInfo.attach('files.txt', { body: files, contentType: 'text/plain' });
  const logs = path.join(dataDir, 'logs');
  if (!existsSync(logs)) return;
  for (const name of readdirSync(logs)) {
    await testInfo.attach(name, { path: path.join(logs, name) });
  }
});

const tabs = (page: Page) => page.getByRole('tablist').getByRole('tab');
const sameFile = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The `system` profile fixture as FTPeach shows it: the edit kept from an
 * earlier session offered back, the dark theme, the saved session of two
 * tabs, and the SFTP bookmark connecting with the password Windows protects
 * and the server key it trusts, without asking about either.
 */
async function expectSystemProfile(page: Page) {
  const offer = recoveredOffer(page);
  await expect(offer).toContainText(RECOVERED_EDIT);
  await offer.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(1)).toHaveText('Saved session');
  await connectBookmark(page, 'Saved SFTP');
  expect(page.context().pages()).toEqual([page]);
}

/** The installation, as the registry, the disk and the shortcuts have it, is `version`. */
function expectInstalled(version: string) {
  expect(registryValue(UNINSTALL_KEY, 'DisplayVersion')).toBe(version);
  expect(registryValue(UNINSTALL_KEY, 'UninstallString')).toBe(
    `"${path.join(installDir, 'uninstall.exe')}"`,
  );
  expect(fileVersion(installedExe)).toBe(version);
  for (const shortcut of [startMenuShortcut, desktopShortcut]) {
    expect(sameFile(shortcutTarget(shortcut), installedExe), shortcut).toBe(true);
  }
}

test('a clean install puts FTPeach in place, and it starts from its shortcut', async () => {
  const { version } = testBuild();
  install(setupOf(version));
  expectInstalled(version);

  const app = await startProgram(shortcutTarget(startMenuShortcut));
  expect(await runningVersion(app.page)).toBe(version);
  await expect(tabs(app.page)).toHaveCount(1);
  await quit(app);
  expect(registryKeyExists(IDENTITY_KEY)).toBe(true);
});

test('the installer says its version to the updater of every release since 0.3.0', () => {
  const { version } = testBuild();
  // Read by 0.3.0 to 0.4.0, which installed no update without it.
  expect(versionOlderReleasesRead(readFileSync(setupOf(version)))).toBe(version);
});

test('an uninstall keeps the data, and installing again picks it up', async () => {
  const { version } = testBuild();
  install(setupOf(version));
  writeProfile(profile('system'), runSettings(false));
  keepEdit();
  // A started FTPeach registers its notification identity.
  const first = await startInstalled();
  await expectSystemProfile(first.page);
  await quit(first);
  // A download waiting for the next launch belongs to the installation.
  mkdirSync(updatesDir, { recursive: true });
  writeFileSync(path.join(updatesDir, 'pending.json'), '{}');
  const data = storedData();
  const edits = recoveredEdits();

  await uninstallSilently();
  expect(registryKeyExists(UNINSTALL_KEY)).toBe(false);
  expect(existsSync(installedExe)).toBe(false);
  expect(existsSync(startMenuShortcut)).toBe(false);
  expect(existsSync(desktopShortcut)).toBe(false);
  expect(registryKeyExists(IDENTITY_KEY)).toBe(false);
  expect(existsSync(updatesDir)).toBe(false);
  expect(storedData()).toEqual(data);
  expect(recoveredEdits()).toEqual(edits);

  install(setupOf(version));
  expectInstalled(version);
  const again = await startInstalled();
  await expectSystemProfile(again.page);
  await quit(again);
});

test('an uninstall asked to delete the data removes it', async () => {
  const { version } = testBuild();
  install(setupOf(version));
  writeProfile(profile('system'), runSettings(false));
  keepEdit();
  const app = await startInstalled();
  await expectSystemProfile(app.page);
  await quit(app);
  expect(existsSync(path.join(dataDir, 'sites.json'))).toBe(true);

  await uninstallDeletingData();
  expect(registryKeyExists(UNINSTALL_KEY)).toBe(false);
  expect(existsSync(installedExe)).toBe(false);
  expect(existsSync(dataDir)).toBe(false);
  expect(existsSync(localDir)).toBe(false);
});

test('an upgrade over the previous release keeps settings, passwords, bookmarks, the session and kept edits', async () => {
  const { version } = testBuild();
  const previous = await previousRelease(version);
  install(previous.setup);
  expect(registryValue(UNINSTALL_KEY, 'DisplayVersion')).toBe(previous.version);
  writeProfile(profile('system'), runSettings(false));
  // The previous release runs on the profile first, and writes it as it does.
  const old = spawn(installedExe, [], { detached: true, stdio: 'ignore' });
  await closeOnceShown(old.pid!);
  keepEdit();
  const data = storedData();
  const edits = recoveredEdits();

  install(setupOf(version));
  expectInstalled(version);
  expect(storedData()).toEqual(data);
  expect(recoveredEdits()).toEqual(edits);
  const app = await startInstalled();
  expect(await runningVersion(app.page)).toBe(version);
  await expectSystemProfile(app.page);
  await quit(app);
});

test('the installed copy installs the update the feed offers and keeps its data', async () => {
  const { version, next } = testBuild();
  install(setupOf(version));
  writeProfile(profile('system'), runSettings(true));
  keepEdit();
  const feed = await serveFeed(next, { installer: setupOf(next) });
  try {
    const app = await startInstalled();
    expect(await runningVersion(app.page)).toBe(version);
    // Connected, as people are when they install.
    await expectSystemProfile(app.page);
    await expect(installButton(app.page)).toBeVisible({ timeout: 120_000 });
    const data = storedData();
    const edits = recoveredEdits();

    await installButton(app.page).click();
    await app.exited();
    // The installer puts the new version in place and starts it.
    await expect
      .poll(() => registryValue(UNINSTALL_KEY, 'DisplayVersion'), { timeout: 180_000 })
      .toBe(next);
    await expect.poll(() => runningFrom(installedExe), { timeout: 60_000 }).toHaveLength(1);
    await closeOnceShown(runningFrom(installedExe)[0]!);
    expectInstalled(next);
    expect(storedData()).toEqual(data);
    expect(recoveredEdits()).toEqual(edits);

    changeSettings({ autoCheckUpdates: false });
    const updated = await startInstalled();
    expect(await runningVersion(updated.page)).toBe(next);
    // The updated FTPeach clears the download away.
    expect(existsSync(updatesDir)).toBe(false);
    await expectSystemProfile(updated.page);
    await quit(updated);
  } finally {
    await feed.close();
  }
});

test('an update that does not match its signature is not taken', async () => {
  const { version, next } = testBuild();
  install(setupOf(version));
  writeProfile({}, runSettings(true));
  const tampered = damaged(setupOf(next));
  const feed = await serveFeed(
    next,
    { installer: tampered },
    { installer: readFileSync(`${setupOf(next)}.sig`, 'utf8') },
  );
  try {
    const app = await startInstalled();
    // Downloaded, refused, and offered again as not downloaded.
    await expect(downloadButton(app.page)).toBeVisible({ timeout: 120_000 });
    expect(fetched(feed, tampered)).toBe(true);
    expect(existsSync(updatesDir)).toBe(false);
    await quit(app);
  } finally {
    await feed.close();
  }
  expectInstalled(version);
});

test('a downloaded update changed on disk is thrown away at the next start', async () => {
  const { version, next } = testBuild();
  install(setupOf(version));
  writeProfile({}, runSettings(true));
  const feed = await serveFeed(next, { installer: setupOf(next) });
  try {
    const app = await startInstalled();
    await expect(installButton(app.page)).toBeVisible({ timeout: 120_000 });
    await quit(app);
  } finally {
    await feed.close();
  }
  flipByte(path.join(updatesDir, `FTPeach-${next}-setup.exe`));

  changeSettings({ autoCheckUpdates: false });
  // It starts, rather than handing over to an installer.
  const app = await startInstalled();
  expect(await runningVersion(app.page)).toBe(version);
  expect(existsSync(updatesDir)).toBe(false);
  await quit(app);
  expectInstalled(version);
});

test('an installer Windows cannot start is tried once, and FTPeach opens', async () => {
  const { version, next } = testBuild();
  install(setupOf(version));
  writeProfile({}, runSettings(true));
  const broken = notAProgram(next);
  const feed = await serveFeed(next, { installer: broken });
  try {
    const app = await startInstalled();
    await expect(installButton(app.page)).toBeVisible({ timeout: 120_000 });
    await quit(app);
  } finally {
    await feed.close();
  }

  changeSettings({ autoCheckUpdates: false });
  // The start installs the download, fails to, and opens the window anyway.
  const tried = await startInstalled();
  expect(await runningVersion(tried.page)).toBe(version);
  await quit(tried);
  const manifest = JSON.parse(readFileSync(path.join(updatesDir, 'pending.json'), 'utf8'));
  expect(manifest).toMatchObject({ version: next, attempted: true });

  const again = await startInstalled();
  expect(await runningVersion(again.page)).toBe(version);
  expect(existsSync(updatesDir)).toBe(false);
  await quit(again);
  expectInstalled(version);
});

test('an installer that fails is not run again unless asked, and FTPeach opens every time', async () => {
  const { version, next } = testBuild();
  install(setupOf(version));
  writeProfile({}, runSettings(true));
  const runs = path.join(tempFolder('ftpeach-runs-'), 'runs.txt');
  const ran = () => (existsSync(runs) ? readFileSync(runs, 'utf8').trim().split(/\r?\n/) : []);
  // The feed keeps offering it, and updates stay automatic.
  const feed = await serveFeed(next, { installer: failingInstaller(next, runs) });
  try {
    const app = await startInstalled();
    await expect(installButton(app.page)).toBeVisible({ timeout: 120_000 });
    await installButton(app.page).click();
    await app.exited();
    await expect.poll(ran, { timeout: 60_000 }).toEqual(['/S /UPDATE /R']);
    expectInstalled(version);

    // Each start opens the window: the version is offered, not downloaded
    // and installed on its own.
    for (let start = 0; start < 2; start++) {
      const again = await startInstalled();
      expect(await runningVersion(again.page)).toBe(version);
      await expect(downloadButton(again.page)).toBeVisible({ timeout: 60_000 });
      expect(existsSync(path.join(updatesDir, 'pending.json'))).toBe(false);
      await quit(again);
    }
    expect(ran()).toHaveLength(1);

    // Asked to, it tries again.
    const asked = await startInstalled();
    await downloadButton(asked.page).click({ timeout: 60_000 });
    await installButton(asked.page).click({ timeout: 120_000 });
    await asked.exited();
    await expect.poll(ran, { timeout: 60_000 }).toHaveLength(2);
  } finally {
    await feed.close();
  }
  expectInstalled(version);
});

test('a portable copy replaces its program with the update and leaves its data alone', async () => {
  const { version, next } = testBuild();
  const folder = tempFolder('ftpeach-portable-');
  // Windows' own bsdtar, as the release packs the zip with it.
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-x', '-f', portableOf(version), '-C', folder]);
  const exe = path.join(folder, 'FTPeach.exe');
  const data = path.join(folder, 'data');
  writeProfile(profile('system'), runSettings(true), data);
  keepEdit(path.join(data, 'local'));
  // What the user had before any FTPeach ran: the run and the update leave
  // the edit byte for byte and keep the settings and the session (each start
  // may add fields to them).
  const editsDir = path.join(data, 'local', 'recovered-edits');
  const edits = recoveredEdits(editsDir);
  const profileBefore = savedProfile(data);
  const feed = await serveFeed(next, { portable: portableOf(next) });
  try {
    const app = await startProgram(exe);
    expect(await runningVersion(app.page)).toBe(version);
    await expectSystemProfile(app.page);
    await expect(installButton(app.page)).toBeVisible({ timeout: 120_000 });
    const stored = storedData(data);
    const program = programFiles(folder);

    await installButton(app.page).click();
    await app.exited();
    // The new program starts in place of the old one, with its variables.
    const page = await attach(app.cdpPort);
    expect(await runningVersion(page)).toBe(next);
    expect(fileVersion(exe)).toBe(next);
    expect(storedData(data)).toEqual(stored);
    expect(recoveredEdits(editsDir)).toEqual(edits);
    expect(savedProfile(data)).toMatchObject(profileBefore);
    // The program's files are the update's. The old program, renamed aside,
    // goes as soon as it has exited: at once, or at the next start.
    const names = (entries: string[]) => entries.map((entry) => entry.split(' ')[0]).sort();
    const updated = programFiles(folder).filter((entry) => !entry.startsWith('FTPeach.exe.old '));
    expect(names(updated)).toEqual(names(program));
    expect(updated).not.toContain(program.find((entry) => entry.startsWith('FTPeach.exe ')));
    await page.getByRole('dialog').getByRole('button', { name: 'Later', exact: true }).click();
    await menu(page, 'File', 'Quit');
    await expect.poll(() => runningFrom(exe), { timeout: 60_000 }).toEqual([]);

    changeSettings({ autoCheckUpdates: false }, data);
    const again = await startProgram(exe);
    expect(await runningVersion(again.page)).toBe(next);
    expect(existsSync(`${exe}.old`)).toBe(false);
    await expectSystemProfile(again.page);
    await quit(again);
  } finally {
    await feed.close();
    stopProgramsIn(folder);
    rmSync(folder, { recursive: true, force: true });
  }
});

/** A portable copy's own files, as `tree` has them, without its data folder, which a running copy holds open. */
function programFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.name !== 'data')
    .flatMap((entry) => {
      const full = path.join(folder, entry.name);
      return entry.isDirectory()
        ? [`${entry.name}/`, ...tree(full).map((inner) => `${entry.name}/${inner}`)]
        : [`${entry.name} ${sha256(readFileSync(full))}`];
    })
    .sort();
}
