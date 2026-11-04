import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { verifyCandidate } from '../../scripts/release/candidate.ts';
import {
  changeSettings,
  closeOnceShown,
  dataDir,
  fileVersion,
  install,
  installedExe,
  installDir,
  keepEdit,
  previousRelease,
  recoveredEdits,
  registryValue,
  removeFTPeach,
  requireThrowawayMachine,
  stopProgramsIn,
  UNINSTALL_KEY,
  uninstallDeletingData,
  uninstallSilently,
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
  await removeFTPeach();
  await verifyCandidate(directory);
});
test.afterEach(() => {
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
