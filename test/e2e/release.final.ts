import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { sha256, verifyCandidate } from '../../scripts/release/candidate.ts';
import { serveProductionFeed, PRODUCTION_FEED } from './release-feed.ts';
import {
  changeSettings,
  closeOnceShown,
  dataDir,
  fileVersion,
  install,
  installedExe,
  installDir,
  localDir,
  keepEdit,
  previousRelease,
  recoveredEdits,
  registryValue,
  removeFTPeach,
  requireThrowawayMachine,
  runningFrom,
  storedData,
  stopProgramsIn,
  UNINSTALL_KEY,
  uninstallDeletingData,
  uninstallSilently,
  updatesDir,
} from './install.ts';

const directory = path.resolve('release-candidate');
const portable = path.resolve('.tools/release-acceptance/portable');
async function launchAndClose(exe: string) {
  const env = { ...process.env };
  delete env.FTPEACH_SMOKE_TEST;
  const child = spawn(exe, [], { env, stdio: 'ignore' });
  expect(child.pid).toBeTruthy();
  await closeOnceShown(child.pid!);
}
test.beforeEach(async () => {
  requireThrowawayMachine();
  stopProgramsIn(portable);
  rmSync(portable, { recursive: true, force: true });
  await removeFTPeach();
  await verifyCandidate(directory);
});
test.afterEach(() => {
  requireThrowawayMachine();
  stopProgramsIn(installDir);
  stopProgramsIn(portable);
});

test('final NSIS installs, starts, keeps the profile on uninstall and deletes it only when asked', async () => {
  const {
    readiness: { version },
  } = await verifyCandidate(directory);
  const setup = path.join(directory, `FTPeach_${version}_x64-setup.exe`);
  install(setup);
  expect(fileVersion(installedExe)).toBe(version);
  expect(registryValue(UNINSTALL_KEY, 'DisplayVersion')).toBe(version);
  changeSettings({ language: 'en', autoCheckUpdates: false, closeToTray: false });
  await launchAndClose(installedExe);
  keepEdit();
  const edits = recoveredEdits();
  await uninstallSilently();
  expect(existsSync(installedExe)).toBe(false);
  expect(recoveredEdits()).toEqual(edits);
  install(setup);
  expect(recoveredEdits()).toEqual(edits);
  await uninstallDeletingData();
  expect(existsSync(dataDir)).toBe(false);
});

test('final NSIS upgrades the previous published release and preserves settings and kept edits', async () => {
  const {
    readiness: { version },
  } = await verifyCandidate(directory);
  const previous = await previousRelease(version);
  install(previous.setup);
  changeSettings({ language: 'en', theme: 'dark', autoCheckUpdates: false, closeToTray: false });
  keepEdit();
  const edits = recoveredEdits();
  install(path.join(directory, `FTPeach_${version}_x64-setup.exe`));
  expect(fileVersion(installedExe)).toBe(version);
  expect(recoveredEdits()).toEqual(edits);
  expect(JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).data.theme).toBe(
    'dark',
  );
  // The recovery dialog is closed with its owning main window, without DevTools.
  await launchAndClose(installedExe);
  expect(recoveredEdits()).toEqual(edits);
});

test('final portable ZIP starts, carries its licenses and keeps data outside the Windows profile', async () => {
  const {
    readiness: { version },
  } = await verifyCandidate(directory);
  mkdirSync(portable, { recursive: true });
  execFileSync(path.join(process.env.SystemRoot!, 'System32/tar.exe'), [
    '-xf',
    path.join(directory, `FTPeach_${version}_x64-portable.zip`),
    '-C',
    portable,
  ]);
  for (const name of [
    'LICENSE',
    'NOTICE',
    'licenses/NPM_THIRD_PARTY_LICENSES.txt',
    'licenses/RUST_THIRD_PARTY_LICENSES.txt',
    'FTPeach.portable',
  ]) {
    expect(existsSync(path.join(portable, name)), name).toBe(true);
  }
  const data = path.join(portable, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(
    path.join(data, 'settings.json'),
    JSON.stringify({
      schemaVersion: 1,
      data: { language: 'en', autoCheckUpdates: false, closeToTray: false },
    }),
  );
  const exe = path.join(portable, 'FTPeach.exe');
  expect(fileVersion(exe)).toBe(version);
  await launchAndClose(exe);
  expect(existsSync(path.join(data, 'tabs.json'))).toBe(true);
  expect(existsSync(dataDir)).toBe(false);
});

for (const mode of ['installed', 'portable'] as const) {
  test(`the previous production ${mode} copy downloads and installs the signed candidate, preserving its profile`, async () => {
    requireThrowawayMachine();
    const candidate = await verifyCandidate(directory);
    const version = candidate.readiness.version;
    const previous = await previousRelease(version);
    let exe = installedExe;
    let data = dataDir;
    let updates = updatesDir;
    let editsDir: string | undefined;
    if (mode === 'installed') {
      install(previous.setup);
    } else {
      const name = `FTPeach_${previous.version}_x64-portable.zip`;
      const download = await fetch(
        `https://github.com/Smooveemaan/ftpeach/releases/download/v${previous.version}/${name}`,
        { signal: AbortSignal.timeout(120_000) },
      );
      expect(download.ok, `Download previous production portable: HTTP ${download.status}`).toBe(
        true,
      );
      const zip = path.join(path.dirname(previous.setup), name);
      writeFileSync(zip, Buffer.from(await download.arrayBuffer()));
      mkdirSync(portable, { recursive: true });
      execFileSync(path.join(process.env.SystemRoot!, 'System32/tar.exe'), [
        '-xf',
        zip,
        '-C',
        portable,
      ]);
      exe = path.join(portable, 'FTPeach.exe');
      data = path.join(portable, 'data');
      updates = path.join(data, 'local', 'updates');
      editsDir = path.join(data, 'local', 'recovered-edits');
    }
    expect(fileVersion(exe)).toBe(previous.version);
    changeSettings(
      { language: 'en', theme: 'dark', autoCheckUpdates: true, closeToTray: false },
      data,
    );
    if (mode === 'portable') keepEdit(path.join(data, 'local'));
    else keepEdit();
    const edits = recoveredEdits(editsDir);
    const feed = await serveProductionFeed(directory);
    const packageName = `FTPeach_${version}_x64-${mode === 'portable' ? 'portable.zip' : 'setup.exe'}`;
    const env: typeof process.env = { ...process.env, ...feed.env };
    delete env.FTPEACH_SMOKE_TEST;
    try {
      const old = spawn(exe, [], { env, stdio: 'ignore' });
      expect(old.pid).toBeTruthy();
      const pendingPath = path.join(updates, 'pending.json');
      await expect.poll(() => existsSync(pendingPath), { timeout: 180_000 }).toBe(true);
      const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
      expect(pending.version).toBe(version);
      expect(pending.attempted).toBe(false);
      expect(pending.installer).toBe(
        `FTPeach-${version}-${mode === 'portable' ? 'portable.zip' : 'setup.exe'}`,
      );
      expect(pending.signature.trim()).toBe(
        readFileSync(path.join(directory, `${packageName}.sig`), 'utf8').trim(),
      );
      expect(sha256(readFileSync(path.join(updates, pending.installer)))).toBe(
        candidate.files[packageName],
      );
      expect(feed.requests).toContain(PRODUCTION_FEED);
      expect(feed.requests).toContain(`/${packageName}`);
      await closeOnceShown(old.pid!);
      const stored = storedData(data);
      // Staging at startup installs the verified bytes even with future checks disabled.
      changeSettings({ autoCheckUpdates: false }, data);
      const staging = spawn(exe, [], { env, stdio: 'ignore' });
      expect(staging.pid).toBeTruthy();
      await expect
        .poll(() => existsSync(exe) && fileVersion(exe), { timeout: 180_000 })
        .toBe(version);
      await expect.poll(() => runningFrom(exe), { timeout: 60_000 }).toHaveLength(1);
      await closeOnceShown(runningFrom(exe)[0]!);
      if (mode === 'installed')
        expect(registryValue(UNINSTALL_KEY, 'DisplayVersion')).toBe(version);
      expect(storedData(data)).toEqual(stored);
      expect(recoveredEdits(editsDir)).toEqual(edits);
      expect(JSON.parse(readFileSync(path.join(data, 'settings.json'), 'utf8')).data.theme).toBe(
        'dark',
      );
      expect(existsSync(updates)).toBe(false);
      if (mode === 'portable') {
        expect(existsSync(dataDir)).toBe(false);
        expect(existsSync(localDir)).toBe(false);
      }
    } finally {
      stopProgramsIn(mode === 'portable' ? portable : installDir);
      await feed.close();
    }
  });
}
