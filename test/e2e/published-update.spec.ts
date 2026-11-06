import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { sha256, type Candidate } from '../../scripts/release/candidate.ts';
import {
  requirePublishedRunner,
  downloadPrevious,
  profileData,
  updateMode,
  verifyPending,
} from '../../scripts/release/published-update.ts';
import {
  closeOnceShown,
  dataDir,
  fileVersion,
  install,
  installedExe,
  installDir,
  keepEdit,
  localDir,
  recoveredEdits,
  registryValue,
  removeFTPeach,
  runningFrom,
  stopProgramsIn,
  UNINSTALL_KEY,
  updatesDir,
  writeProfile,
} from './install.ts';

const run = promisify(execFile);
const framework = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319';

// eslint-disable-next-line no-empty-pattern
test('previous published copy updates through Help using the unchanged public feed', async ({}, testInfo) => {
  requirePublishedRunner();
  const mode = updateMode(process.env.FTPEACH_UPDATE_MODE);
  const manifest = readFileSync('published-release/candidate.json');
  const candidate = JSON.parse(manifest.toString()) as Candidate;
  const toolsSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
  expect(toolsSha).toBe(process.env.FTPEACH_UPDATE_TOOLS_SHA);
  const version = candidate.readiness.version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'));
  expect(event.action).toBe('published');
  expect(event.release.tag_name).toBe(`v${version}`);
  const previous = await downloadPrevious(version, mode);
  let observedPrevious = '',
    observedNew = '',
    previousAbout = '',
    newAbout = '';
  const work = mkdtempSync(path.join(process.env.RUNNER_TEMP!, 'ftpeach-published-'));
  const portable = path.join(work, 'portable');
  const helper = path.join(work, 'uia.exe');
  let exe = installedExe;
  let data = dataDir;
  let local = localDir;
  let updates = updatesDir;
  let clean = false;
  try {
    // Refuse to erase a pre-existing profile even on a misconfigured hosted runner.
    for (const folder of [installDir, dataDir, localDir])
      expect(existsSync(folder), folder).toBe(false);
    clean = true;
    execFileSync(
      `${framework}/csc.exe`,
      [
        '/nologo',
        '/target:exe',
        '/platform:x64',
        `/out:${helper}`,
        `/r:${framework}/WPF/UIAutomationClient.dll`,
        `/r:${framework}/WPF/UIAutomationTypes.dll`,
        `/r:${framework}/WPF/WindowsBase.dll`,
        path.join(import.meta.dirname, 'published-update.cs'),
      ],
      { timeout: 60_000 },
    );
    const ui = async (pid: number, action: string, name: string, scope?: string) => {
      return (
        await run(helper, [String(pid), action, name, ...(scope ? [scope] : [])], {
          timeout: 50_000,
        })
      ).stdout.trim();
    };
    const packagePath = path.join(work, previous.name);
    writeFileSync(packagePath, previous.bytes);
    if (mode === 'installed') install(packagePath);
    else {
      mkdirSync(portable);
      execFileSync('tar.exe', ['-xf', packagePath, '-C', portable], { timeout: 60_000 });
      expect(existsSync(path.join(portable, 'FTPeach.portable'))).toBe(true);
      exe = path.join(portable, 'FTPeach.exe');
      data = path.join(portable, 'data');
      local = path.join(data, 'local');
      updates = path.join(local, 'updates');
    }
    observedPrevious = fileVersion(exe);
    expect(observedPrevious).toBe(previous.version);
    // The fixture's trusted-host entry needs a public key, but no server or connection.
    const key = path.join(work, 'fixture-host');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { timeout: 30_000 });
    process.env.FTPEACH_E2E_SFTP_HOST_KEY = `${key}.pub`;
    const { profile } = await import('./profiles.ts');
    const files = profile('system');
    delete files['tabs.json'];
    const settings = {
      ...JSON.parse(String(files['settings.json'])).data,
      language: 'en',
      theme: 'dark',
      autoCheckUpdates: false,
      closeToTray: false,
      autoReconnectTabs: false,
      saveSessionOnExit: false,
    };
    writeProfile(files, settings, data);
    keepEdit(local);
    const edits = recoveredEdits(path.join(local, 'recovered-edits'));
    const start = async () => {
      const child = spawn(exe, [], { stdio: 'ignore' });
      await once(child, 'spawn');
      assert.ok(child.pid);
      return child.pid;
    };
    const about = async (pid: number, expected: string) => {
      await ui(pid, 'invoke', 'Help');
      await ui(pid, 'invoke', 'About');
      const observed = await ui(pid, 'text', `v${expected}`, 'About');
      await ui(pid, 'invoke', 'Close', 'About');
      return observed.replace(/^FTPeach\s+/, '').replace(/^v/, '');
    };
    const password = () => {
      const sites = JSON.parse(readFileSync(path.join(data, 'sites.json'), 'utf8'));
      const site = sites.data.find((entry: { id: string }) => entry.id === 'system-sftp');
      assert.ok(site?.enc, 'Saved DPAPI password is missing');
      const actual = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:SEALED), [Text.Encoding]::ASCII.GetBytes('FTPeach/dpapi-entropy/v1'), 'CurrentUser'))",
        ],
        { encoding: 'utf8', timeout: 30_000, env: { ...process.env, SEALED: site.enc } },
      ).trim();
      const seeded = JSON.parse(String(files['sites.json'])).data.find(
        (entry: { id: string }) => entry.id === 'system-sftp',
      );
      expect(site.enc).toBe(seeded.enc);
      expect(actual).toBe(process.env.FTPEACH_E2E_SFTP_PASSWORD ?? 'FTPeach-test-2026!');
    };
    const old = await start();
    await ui(old, 'invoke', 'Later');
    previousAbout = await about(old, previous.version);
    await closeOnceShown(old);
    password();
    const readProfile = () =>
      profileData(
        Object.fromEntries(
          Object.keys(profileData(files)).map((name) => [
            name,
            readFileSync(path.join(data, name)),
          ]),
        ),
      );
    const before = readProfile();
    expect(before).toEqual(profileData(files));
    const updating = await start();
    await ui(updating, 'invoke', 'Later');
    await ui(updating, 'invoke', 'Help');
    await ui(updating, 'invoke', 'Check for Updates');
    // Automatic checks are disabled so this download must follow the explicit Help action.
    await ui(updating, 'invoke', 'Click to download');
    const pendingPath = path.join(updates, 'pending.json');
    await expect.poll(() => existsSync(pendingPath), { timeout: 180_000 }).toBe(true);
    const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
    const suffix = mode === 'portable' ? 'portable.zip' : 'setup.exe';
    const name = `FTPeach_${version}_x64-${suffix}`;
    // Validate the name before using it as a path.
    expect(pending.installer).toBe(`FTPeach-${version}-${suffix}`);
    const published = readFileSync(path.join('published-release', name));
    expect(sha256(published)).toBe(candidate.files[name]);
    verifyPending(
      pending,
      readFileSync(path.join(updates, pending.installer)),
      version,
      mode,
      candidate.files,
      readFileSync(path.join('published-release', `${name}.sig`), 'utf8'),
    );
    await ui(
      updating,
      'invoke',
      'Restart now to install. Otherwise the update installs the next time FTPeach starts.',
    );
    await expect
      .poll(() => existsSync(exe) && fileVersion(exe), { timeout: 180_000 })
      .toBe(version);
    await expect
      .poll(() => runningFrom(exe).filter((pid) => pid !== updating), { timeout: 60_000 })
      .toHaveLength(1);
    const updated = runningFrom(exe).filter((pid) => pid !== updating)[0]!;
    await ui(updated, 'invoke', 'Later');
    observedNew = fileVersion(exe);
    expect(observedNew).toBe(version);
    newAbout = await about(updated, version);
    await closeOnceShown(updated);
    expect(readProfile()).toEqual(before);
    expect(JSON.parse(readFileSync(path.join(data, 'settings.json'), 'utf8')).data).toMatchObject(
      settings,
    );
    expect(recoveredEdits(path.join(local, 'recovered-edits'))).toEqual(edits);
    password();
    expect(existsSync(updates)).toBe(false);
    if (mode === 'installed') expect(registryValue(UNINSTALL_KEY, 'DisplayVersion')).toBe(version);
    else {
      expect(existsSync(dataDir)).toBe(false);
      expect(existsSync(localDir)).toBe(false);
    }
  } finally {
    requirePublishedRunner();
    stopProgramsIn(portable);
    if (clean) await removeFTPeach();
    const base = path.resolve(process.env.RUNNER_TEMP!);
    assert.equal(path.dirname(work), base);
    assert.ok(path.basename(work).startsWith('ftpeach-published-'));
    rmSync(work, { recursive: true, force: true });
  }
  const result = {
    schema: 1,
    status: 'passed',
    mode,
    candidateHash: sha256(manifest),
    candidate,
    toolsSha,
    releaseId: String(event.release.id),
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    previous: {
      version: observedPrevious,
      aboutVersion: previousAbout,
      packageSha256: previous.sha256,
      url: previous.url,
    },
    updated: { version: observedNew, aboutVersion: newAbout },
    checks: [
      'public-feed-ui',
      'staged-package-hash-signature',
      'profile',
      'settings',
      'dpapi-password',
      'recovered-edits',
    ],
  };
  mkdirSync(testInfo.outputDir, { recursive: true });
  writeFileSync(testInfo.outputPath('result.json'), JSON.stringify(result, null, 2));
});
