import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { verifyCandidate } from './candidate.ts';
import { verifyUpdaterSignature } from './check-published.ts';

export function parseUniversalArchs(lipoOutput: string): string[] {
  const archs = lipoOutput.trim().split(/\s+/).filter(Boolean);
  assert.ok(
    archs.includes('x86_64') && archs.includes('arm64'),
    `Expected universal binary with x86_64 and arm64, got: ${lipoOutput.trim()}`,
  );
  return archs;
}

export async function launchAndStayAlive(
  command: string,
  args: string[],
  env: typeof process.env,
  durationMs = 4_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1_000).unref();
      resolve();
    }, durationMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Process ${command} ${args.join(' ')} exited early (code=${String(code)}, signal=${String(signal)}): ${stderr.trim()}`,
        ),
      );
    });
  });
}

async function isolatedEnv(baseDir: string, label: string): Promise<typeof process.env> {
  const home = path.join(baseDir, label, 'home');
  const config = path.join(home, '.config');
  const data = path.join(home, '.local', 'share');
  const cache = path.join(home, '.cache');
  await mkdir(config, { recursive: true });
  await mkdir(data, { recursive: true });
  await mkdir(cache, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
  };
}

async function resolveMacosExecutable(appBundle: string): Promise<string> {
  const macosDir = path.join(appBundle, 'Contents', 'MacOS');
  const entries = await readdir(macosDir);
  assert.ok(entries.length > 0, `No executable found inside ${macosDir}`);
  const preferred = entries.find((entry) => entry === 'FTPeach' || entry === 'app') ?? entries[0]!;
  return path.join(macosDir, preferred);
}

export async function verifyMacosCandidate(directory: string) {
  const candidate = await verifyCandidate(directory);
  const { version } = candidate.readiness;
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')) as {
    plugins: { updater: { pubkey: string } };
  };
  const pubkey = config.plugins.updater.pubkey;

  const tarName = `FTPeach_${version}_universal.app.tar.gz`;
  const tarPath = path.join(directory, tarName);
  const tarSig = await readFile(path.join(directory, `${tarName}.sig`), 'utf8');
  verifyUpdaterSignature(pubkey, await readFile(tarPath), tarSig);

  const workDir = await mkdtemp(path.join(tmpdir(), 'ftpeach-macos-acceptance-'));
  try {
    const extractDir = path.join(workDir, 'updater-extract');
    await mkdir(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', tarPath, '-C', extractDir], { stdio: 'pipe' });
    const extractedApp = path.join(extractDir, 'FTPeach.app');
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', extractedApp], {
      stdio: 'pipe',
    });

    const dmgPath = path.join(directory, `FTPeach_${version}_universal.dmg`);
    execFileSync('xcrun', ['stapler', 'validate', dmgPath], { stdio: 'pipe' });

    const mountPoint = path.join(workDir, 'mnt');
    await mkdir(mountPoint, { recursive: true });
    execFileSync(
      'hdiutil',
      ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountPoint],
      { stdio: 'pipe' },
    );
    try {
      const mountedApp = path.join(mountPoint, 'FTPeach.app');
      execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', mountedApp], {
        stdio: 'pipe',
      });
      execFileSync(
        'spctl',
        ['-a', '-t', 'open', '--context', 'context:primary-signature', '-v', mountedApp],
        { stdio: 'pipe' },
      );
      execFileSync('xcrun', ['stapler', 'validate', mountedApp], { stdio: 'pipe' });

      const installedApp = path.join(workDir, 'Applications', 'FTPeach.app');
      await mkdir(path.dirname(installedApp), { recursive: true });
      await cp(mountedApp, installedApp, { recursive: true, verbatimSymlinks: true });

      const executable = await resolveMacosExecutable(installedApp);
      const lipoOut = execFileSync('lipo', ['-archs', executable], { encoding: 'utf8' });
      parseUniversalArchs(lipoOut);

      for (const slice of ['arm64', 'x86_64']) {
        const env = await isolatedEnv(workDir, `run-${slice}`);
        await launchAndStayAlive('arch', [`-${slice}`, executable], env);
      }
    } finally {
      execFileSync('hdiutil', ['detach', mountPoint, '-force'], { stdio: 'pipe' });
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function verifyLinuxCandidate(directory: string) {
  const candidate = await verifyCandidate(directory);
  const { version } = candidate.readiness;
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')) as {
    plugins: { updater: { pubkey: string } };
  };
  const pubkey = config.plugins.updater.pubkey;

  const appImageName = `FTPeach_${version}_amd64.AppImage`;
  const debName = `FTPeach_${version}_amd64.deb`;
  const appImagePath = path.resolve(directory, appImageName);
  const debPath = path.resolve(directory, debName);

  verifyUpdaterSignature(
    pubkey,
    await readFile(appImagePath),
    await readFile(`${appImagePath}.sig`, 'utf8'),
  );
  verifyUpdaterSignature(pubkey, await readFile(debPath), await readFile(`${debPath}.sig`, 'utf8'));

  const debInfo = execFileSync('dpkg-deb', ['--info', debPath], { encoding: 'utf8' });
  assert.match(debInfo, /Package:\s+ftpeach/i, 'Unexpected Debian package name');

  const workDir = await mkdtemp(path.join(tmpdir(), 'ftpeach-linux-acceptance-'));
  try {
    execFileSync('sudo', ['apt-get', 'install', '-y', debPath], { stdio: 'inherit' });
    const installedFiles = execFileSync('dpkg-deb', ['--contents', debPath], {
      encoding: 'utf8',
    });
    const binMatch = installedFiles.match(/\.\/usr\/bin\/(\S+)/);
    assert.ok(binMatch?.[1], 'No executable found under /usr/bin in Debian package');
    const debBinary = `/usr/bin/${binMatch[1]}`;

    const debEnv = await isolatedEnv(workDir, 'deb');
    await launchAndStayAlive('dbus-run-session', ['--', 'xvfb-run', '-a', debBinary], debEnv);

    await chmod(appImagePath, 0o755);
    const appImageEnv = await isolatedEnv(workDir, 'appimage');
    await launchAndStayAlive(
      'dbus-run-session',
      ['--', 'xvfb-run', '-a', appImagePath, '--appimage-extract-and-run'],
      appImageEnv,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory =
    process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'release-candidate';
  if (process.argv.includes('--macos')) {
    await verifyMacosCandidate(directory);
  } else if (process.argv.includes('--linux')) {
    await verifyLinuxCandidate(directory);
  } else {
    console.error('Usage: unix-acceptance.ts [directory] <--macos|--linux>');
    process.exit(1);
  }
}
