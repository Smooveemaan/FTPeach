import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

export function parseDebMetadata(
  debInfo: string,
  expectedVersion: string,
): { packageName: string; version: string } {
  const pkgMatch = debInfo.match(/^\s*Package:\s*(\S+)/m);
  assert.ok(
    pkgMatch?.[1] && /^ft-?peach$/i.test(pkgMatch[1]),
    `Unexpected Debian package name: ${pkgMatch?.[1] ?? '(missing)'}`,
  );
  const verMatch = debInfo.match(/^\s*Version:\s*(\S+)/m);
  assert.ok(verMatch?.[1], 'Missing Version field in Debian package metadata');
  const version = verMatch[1];
  assert.ok(
    version === expectedVersion || version.startsWith(`${expectedVersion}-`),
    `Debian package version ${version} does not match expected ${expectedVersion}`,
  );
  return { packageName: pkgMatch[1], version };
}

export function findInstalledDesktopFile(debContents: string): string {
  const match = debContents.match(/(?:^|\s)(?:\.\/)?(usr\/share\/applications\/[^\s]+\.desktop)\b/);
  assert.ok(match?.[1], 'No .desktop entry found under /usr/share/applications in Debian package');
  return `/${match[1]}`;
}

export function findInstalledBinary(debContents: string): string {
  const match = debContents.match(/(?:^|\s)(?:\.\/)?(usr\/bin\/[^\s]+)\b/);
  assert.ok(match?.[1], 'No executable found under /usr/bin in Debian package');
  return `/${match[1]}`;
}

export function parseDesktopEntry(contents: string): { name: string; execArgs: string[] } {
  const sectionMatch = contents.match(/\[Desktop Entry\]([\s\S]*?)(?:\n\[|$)/);
  assert.ok(sectionMatch?.[1], 'Missing [Desktop Entry] section');
  const fields = new Map<string, string>();
  for (const rawLine of sectionMatch[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  assert.equal(
    fields.get('Type'),
    'Application',
    `Unexpected Desktop Entry Type: ${fields.get('Type') ?? '(missing)'}`,
  );
  const name = fields.get('Name');
  assert.ok(name && /ftpeach/i.test(name), `Unexpected Desktop Entry Name: ${name ?? '(missing)'}`);
  const execRaw = fields.get('Exec');
  assert.ok(execRaw, 'Missing Exec field in Desktop Entry');
  const tokens: string[] = [];
  for (const token of execRaw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
    const unquoted = token.replace(/^["']|["']$/g, '');
    if (/^%[fFuUdDnNickvm]$/.test(unquoted)) continue;
    tokens.push(unquoted);
  }
  assert.ok(tokens.length > 0, `Empty Exec command in Desktop Entry: ${execRaw}`);
  return { name, execArgs: tokens };
}

export function verifyLinuxUpdateMetadata(
  rawLatestJson: string,
  expectedVersion: string,
  signatures: { appImage?: string; deb?: string },
): void {
  const feed = JSON.parse(rawLatestJson) as {
    version?: unknown;
    platforms?: Record<string, { url?: unknown; signature?: unknown }>;
  };
  assert.equal(
    feed.version,
    expectedVersion,
    `Updater feed version ${String(feed.version)} does not match ${expectedVersion}`,
  );
  assert.ok(
    feed.platforms && typeof feed.platforms === 'object',
    'Updater feed is missing platforms',
  );
  if (signatures.appImage !== undefined) {
    const target = feed.platforms['linux-x86_64'];
    assert.ok(target, 'Updater feed is missing linux-x86_64 target');
    assert.equal(typeof target.url, 'string', 'linux-x86_64 url must be a string');
    assert.ok(
      String(target.url).endsWith(`FTPeach_${expectedVersion}_amd64.AppImage`),
      `Unexpected linux-x86_64 url: ${String(target.url)}`,
    );
    assert.equal(
      String(target.signature ?? '').trim(),
      signatures.appImage.trim(),
      'linux-x86_64 signature does not match candidate .AppImage.sig',
    );
  }
  if (signatures.deb !== undefined) {
    const target = feed.platforms['linux-x86_64-deb'];
    assert.ok(target, 'Updater feed is missing linux-x86_64-deb target');
    assert.equal(typeof target.url, 'string', 'linux-x86_64-deb url must be a string');
    assert.ok(
      String(target.url).endsWith(`FTPeach_${expectedVersion}_amd64.deb`),
      `Unexpected linux-x86_64-deb url: ${String(target.url)}`,
    );
    assert.equal(
      String(target.signature ?? '').trim(),
      signatures.deb.trim(),
      'linux-x86_64-deb signature does not match candidate .deb.sig',
    );
  }
}

function terminateTree(child: ReturnType<typeof spawn>, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to direct child signal if the process group already exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Ignore ESRCH when the process has already exited.
  }
}

export async function launchAndStayAlive(
  command: string,
  args: string[],
  env: typeof process.env,
  durationMs = 4_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      settled = true;
      terminateTree(child, 'SIGTERM');
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          terminateTree(child, 'SIGKILL');
        }
      }, 1_000);
      force.unref();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve();
    }, durationMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
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
  const appImageSig = await readFile(`${appImagePath}.sig`, 'utf8');
  const debSig = await readFile(`${debPath}.sig`, 'utf8');

  verifyUpdaterSignature(pubkey, await readFile(appImagePath), appImageSig);
  verifyUpdaterSignature(pubkey, await readFile(debPath), debSig);

  const latestPath = path.resolve(directory, 'latest.json');
  if (existsSync(latestPath)) {
    verifyLinuxUpdateMetadata(await readFile(latestPath, 'utf8'), version, {
      appImage: appImageSig,
      deb: debSig,
    });
  }

  const debInfo = execFileSync('dpkg-deb', ['--info', debPath], { encoding: 'utf8' });
  parseDebMetadata(debInfo, version);

  const workDir = await mkdtemp(path.join(tmpdir(), 'ftpeach-linux-acceptance-'));
  try {
    execFileSync('sudo', ['apt-get', 'install', '-y', debPath], { stdio: 'inherit' });
    const installedFiles = execFileSync('dpkg-deb', ['--contents', debPath], {
      encoding: 'utf8',
    });
    const debBinary = findInstalledBinary(installedFiles);
    const desktopFile = findInstalledDesktopFile(installedFiles);
    const desktop = parseDesktopEntry(await readFile(desktopFile, 'utf8'));
    const execCommand = path.isAbsolute(desktop.execArgs[0]!)
      ? desktop.execArgs[0]!
      : `/usr/bin/${desktop.execArgs[0]!}`;
    assert.equal(
      path.basename(execCommand),
      path.basename(debBinary),
      `Desktop entry Exec (${desktop.execArgs[0]}) does not match installed binary (${debBinary})`,
    );

    const debEnv = await isolatedEnv(workDir, 'deb');
    await launchAndStayAlive(
      'dbus-run-session',
      ['--', 'xvfb-run', '-a', execCommand, ...desktop.execArgs.slice(1)],
      debEnv,
    );

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
