import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, type Candidate } from './candidate.ts';
import {
  candidateAssetName,
  downloadPrevious,
  expectedRunnerPlatform,
  profileData,
  requirePublishedRunner,
  stagedInstallerName,
  updateMode,
  verifyPending,
  type UpdateMode,
} from './published-update.ts';
import {
  attachDmg,
  findInstalledBinary,
  isolatedEnv,
  parseDebMetadata,
} from './unix-acceptance.ts';

function treeHashes(root: string, base = root): string[] {
  if (!existsSync(root)) return [];
  const rows: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const rel = path.relative(base, full).replaceAll('\\', '/');
    if (entry.isDirectory()) rows.push(...treeHashes(full, base));
    else rows.push(`${rel} ${sha256(readFileSync(full))}`);
  }
  return rows.sort();
}

async function pollUntil(check: () => boolean, timeoutMs: number, description: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

async function stopProcessGroup(child: ChildProcess) {
  if (!child.pid) return;
  const signalGroup = (signal: 'SIGTERM' | 'SIGKILL') => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already exited.
      }
    }
  };
  signalGroup('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (child.exitCode === null && child.signalCode === null) {
    signalGroup('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function macosBundleVersion(appBundle: string): string {
  try {
    return execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', path.join(appBundle, 'Contents', 'Info.plist')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return '';
  }
}

function debInstalledVersion(packageName: string): string {
  try {
    return execFileSync('dpkg-query', ['-W', '-f=${Version}', packageName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function versionMatchesDeb(actual: string, expected: string): boolean {
  return actual === expected || actual.startsWith(`${expected}-`);
}

function seedProfile(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const settings = {
    language: 'en',
    theme: 'dark',
    showTransferQueue: false,
    notifyOnTransferComplete: false,
    autoCheckUpdates: true,
    closeToTray: false,
    autoReconnectTabs: false,
    saveSessionOnExit: false,
  };
  const files: Record<string, string> = {
    'sites.json': JSON.stringify({
      schemaVersion: 1,
      data: [
        {
          id: 'unix-sftp',
          kind: 'site',
          name: 'Saved SFTP',
          icon: 'server',
          color: '',
          protocol: 'sftp',
          host: 'example.invalid',
          port: 22,
          user: 'tester',
          maxConnections: 0,
          webdavUrl: '',
          secure: false,
          allowInvalidCert: false,
          allowCleartextAuth: false,
          remotePath: '/',
          parentId: null,
          useKeyAuth: false,
          keyPath: '',
          caCertPath: '',
          encoding: '',
        },
      ],
    }),
    'local-paths.json': JSON.stringify({
      schemaVersion: 1,
      data: [{ id: 'unix-local', name: 'Workspace', path: '/tmp' }],
    }),
    'known_hosts.json': JSON.stringify({
      schemaVersion: 1,
      data: { 'example.invalid:22': 'SHA256:published-update-test' },
    }),
    'settings.json': JSON.stringify({ schemaVersion: 1, data: settings }),
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dataDir, name), content);
  }
  const recoveredRoot = path.join(dataDir, 'recovered-edits');
  const editFolder = path.join(recoveredRoot, randomUUID());
  mkdirSync(path.join(editFolder, 'file'), { recursive: true });
  writeFileSync(
    path.join(editFolder, 'edit.json'),
    JSON.stringify({
      name: 'notes from 0.x.txt',
      remotePath: '/notes from 0.x.txt',
      savedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(path.join(editFolder, 'file', 'notes from 0.x.txt'), `kept ${randomUUID()}\n`);
  return { files, settings, recoveredRoot, edits: treeHashes(recoveredRoot) };
}

export async function runUnixPublishedUpdate(mode: UpdateMode) {
  assert.ok(
    mode === 'macos' || mode === 'appimage' || mode === 'deb',
    `Expected Unix update mode, got ${mode}`,
  );
  requirePublishedRunner(process.env, process.platform, expectedRunnerPlatform(mode));
  const manifest = readFileSync('published-release/candidate.json');
  const candidate = JSON.parse(manifest.toString()) as Candidate;
  const toolsSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
  assert.equal(toolsSha, process.env.FTPEACH_UPDATE_TOOLS_SHA);
  const version = candidate.readiness.version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'));
  assert.equal(event.action, 'published');
  assert.equal(event.release.tag_name, `v${version}`);

  const previous = await downloadPrevious(version, mode);
  const work = mkdtempSync(path.join(process.env.RUNNER_TEMP!, 'ftpeach-published-'));
  let running: ChildProcess | undefined;
  let observedPrevious = '';
  let observedNew = '';

  try {
    const env = await isolatedEnv(work, mode);
    const dataDir =
      mode === 'macos'
        ? path.join(env.HOME!, 'Library', 'Application Support', 'com.smooveemaan.ftpeach')
        : path.join(env.XDG_DATA_HOME!, 'com.smooveemaan.ftpeach');
    const updatesDir = path.join(dataDir, 'updates');
    const pendingPath = path.join(updatesDir, 'pending.json');
    const packagePath = path.join(work, previous.name);
    writeFileSync(packagePath, previous.bytes);

    let executable = '';
    let installedApp = '';
    let appImagePath = '';
    let debPackageName = '';

    if (mode === 'macos') {
      const mountPoint = path.join(work, 'mnt');
      mkdirSync(mountPoint, { recursive: true });
      attachDmg(packagePath, mountPoint);
      try {
        installedApp = path.join(work, 'Applications', 'FTPeach.app');
        mkdirSync(path.dirname(installedApp), { recursive: true });
        cpSync(path.join(mountPoint, 'FTPeach.app'), installedApp, {
          recursive: true,
          verbatimSymlinks: true,
        });
      } finally {
        execFileSync('hdiutil', ['detach', mountPoint, '-force'], { stdio: 'pipe' });
      }
      observedPrevious = macosBundleVersion(installedApp);
      assert.equal(observedPrevious, previous.version);
      const macosDir = path.join(installedApp, 'Contents', 'MacOS');
      const entries = readdirSync(macosDir);
      const bin = entries.find((entry) => entry === 'FTPeach' || entry === 'app') ?? entries[0];
      assert.ok(bin, `No executable found in ${macosDir}`);
      executable = path.join(macosDir, bin);
    } else if (mode === 'appimage') {
      appImagePath = path.join(work, 'FTPeach.AppImage');
      writeFileSync(appImagePath, previous.bytes);
      chmodSync(appImagePath, 0o755);
      assert.equal(sha256(readFileSync(appImagePath)), previous.sha256);
      observedPrevious = previous.version;
      env.APPIMAGE_EXTRACT_AND_RUN = '1';
      executable = appImagePath;
    } else {
      const debInfo = execFileSync('dpkg-deb', ['--info', packagePath], { encoding: 'utf8' });
      debPackageName = parseDebMetadata(debInfo, previous.version).packageName;
      execFileSync('sudo', ['apt-get', 'install', '-y', packagePath], { stdio: 'inherit' });
      const debContents = execFileSync('dpkg-deb', ['--contents', packagePath], {
        encoding: 'utf8',
      });
      executable = findInstalledBinary(debContents);
      observedPrevious = debInstalledVersion(debPackageName);
      assert.ok(
        versionMatchesDeb(observedPrevious, previous.version),
        `Installed deb version ${observedPrevious} does not match ${previous.version}`,
      );
    }

    const { files, settings, recoveredRoot, edits } = seedProfile(dataDir);
    const readProfile = () =>
      profileData(
        Object.fromEntries(
          Object.keys(profileData(files)).map((name) => [
            name,
            readFileSync(path.join(dataDir, name)),
          ]),
        ),
      );
    const before = readProfile();
    assert.deepEqual(before, profileData(files));

    const startApp = () => {
      let stderr = '';
      const child = spawn(executable, [], {
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      return { child, getStderr: () => stderr.trim() };
    };

    // Launch 1: automatic startup check downloads and stages the update from the public feed.
    const launch1 = startApp();
    running = launch1.child;
    await pollUntil(
      () => {
        if (launch1.child.exitCode !== null || launch1.child.signalCode !== null) {
          assert.fail(
            `Launch 1 exited before staging update (code=${String(launch1.child.exitCode)}, signal=${String(launch1.child.signalCode)}): ${launch1.getStderr()}`,
          );
        }
        return existsSync(pendingPath);
      },
      180_000,
      'staged pending.json from public feed',
    );
    const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
    const assetName = candidateAssetName(version, mode);
    assert.equal(pending.installer, stagedInstallerName(version, mode));
    const published = readFileSync(path.join('published-release', assetName));
    assert.equal(sha256(published), candidate.files[assetName]);
    verifyPending(
      pending,
      readFileSync(path.join(updatesDir, pending.installer)),
      version,
      mode,
      candidate.files,
      readFileSync(path.join('published-release', `${assetName}.sig`), 'utf8'),
    );
    await stopProcessGroup(launch1.child);
    running = undefined;

    // Launch 2: resume_at_startup fetches a fresh offer, installs the update, and restarts.
    const launch2 = startApp();
    running = launch2.child;
    const isInstalledUpdated = () => {
      if (mode === 'macos') return macosBundleVersion(installedApp) === version;
      if (mode === 'appimage') {
        try {
          return sha256(readFileSync(appImagePath)) === candidate.files[assetName];
        } catch {
          return false;
        }
      }
      return versionMatchesDeb(debInstalledVersion(debPackageName), version);
    };
    await pollUntil(
      () => isInstalledUpdated() && !existsSync(updatesDir),
      180_000,
      `updated ${mode} package (${version}) and cleaned staging directory`,
    );
    await stopProcessGroup(launch2.child);
    running = undefined;

    if (mode === 'macos') {
      execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', installedApp], {
        stdio: 'pipe',
      });
      observedNew = macosBundleVersion(installedApp);
      assert.equal(observedNew, version);
    } else if (mode === 'appimage') {
      assert.equal(sha256(readFileSync(appImagePath)), candidate.files[assetName]);
      observedNew = version;
    } else {
      observedNew = debInstalledVersion(debPackageName);
      assert.ok(
        versionMatchesDeb(observedNew, version),
        `Updated deb version ${observedNew} does not match ${version}`,
      );
    }

    assert.deepEqual(readProfile(), before);
    const savedSettings = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
      .data as Record<string, unknown>;
    for (const [key, value] of Object.entries(settings)) {
      assert.deepEqual(savedSettings[key], value, `Setting ${key} changed after update`);
    }
    assert.deepEqual(treeHashes(recoveredRoot), edits);
    assert.equal(existsSync(updatesDir), false);
  } finally {
    if (running) await stopProcessGroup(running);
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
      packageSha256: previous.sha256,
      url: previous.url,
    },
    updated: { version: observedNew },
    checks: [
      'public-feed-auto-update',
      'staged-package-hash-signature',
      'fresh-offer-install-and-restart',
      'profile',
      'settings',
      'recovered-edits',
      ...(mode === 'macos' ? ['codesign'] : []),
    ],
  };
  const outputDir = path.join('test-results', 'published-update', mode);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`Real public-feed ${mode} update passed (${observedPrevious} -> ${observedNew}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runUnixPublishedUpdate(updateMode(process.env.FTPEACH_UPDATE_MODE));
}
