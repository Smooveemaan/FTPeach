// The portable release: the built program and its bundled files in a zip that
// people unpack and that a portable copy updates itself from.
//
//   portable.ts build [releaseDir]   assemble the folder and zip it
//   portable.ts feed <latest.json>   add the signed zip to the update feed
//
// Signing happens between the two, with `tauri signer sign`, so the private
// key is only ever handled by the Tauri CLI.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** The feed entry a portable copy asks for (`runtime/updater.rs`). */
export const PORTABLE_TARGET = 'windows-x86_64-portable';
/** The entry of the installer, whose download address the zip sits beside. */
const INSTALLER_TARGET = 'windows-x86_64';

export function portableZipName(version: string): string {
  return `FTPeach_${version}_x64-portable.zip`;
}

interface Feed {
  platforms?: Record<string, { url: string; signature: string }>;
  [key: string]: unknown;
}

/**
 * `latest` with the portable zip added. Its address is the installer's with
 * the file name replaced, so both come from the same release.
 */
export function withPortablePlatform(latest: Feed, zipName: string, signature: string): Feed {
  const installer = latest.platforms?.[INSTALLER_TARGET]?.url;
  if (!installer) throw new Error(`latest.json has no ${INSTALLER_TARGET} entry`);
  if (!signature.trim()) throw new Error('The portable zip has no signature');
  return {
    ...latest,
    platforms: {
      ...latest.platforms,
      [PORTABLE_TARGET]: { signature: signature.trim(), url: new URL(zipName, installer).href },
    },
  };
}

function version(): string {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
    version: string;
  };
  return config.version;
}

function zipPath(releaseDir: string): string {
  return path.join(releaseDir, 'bundle', 'portable', portableZipName(version()));
}

/** What the installer puts in the program's folder, plus the marker and the license. */
function build(releaseDir: string): string {
  const zip = zipPath(releaseDir);
  const folder = path.join(path.dirname(zip), 'FTPeach');
  rmSync(path.dirname(zip), { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  // Cargo names the binary after the `app` package.
  cpSync(path.join(releaseDir, 'app.exe'), path.join(folder, 'FTPeach.exe'));
  writeFileSync(path.join(folder, 'FTPeach.portable'), '');
  cpSync('LICENSE', path.join(folder, 'LICENSE'));
  for (const resource of ['NOTICE', 'licenses', 'icons']) {
    cpSync(path.join(releaseDir, resource), path.join(folder, resource), { recursive: true });
  }
  // Windows' own bsdtar, by its full path: it writes zip names with forward
  // slashes, which Compress-Archive does not, and a `tar` found on PATH may be
  // GNU tar, which writes no zip at all.
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', folder, ...readdirSync(folder)], {
    stdio: 'inherit',
  });
  rmSync(folder, { recursive: true });
  return zip;
}

function feed(latestPath: string, releaseDir: string): void {
  const zip = zipPath(releaseDir);
  const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as Feed;
  const signature = readFileSync(`${zip}.sig`, 'utf8');
  const patched = withPortablePlatform(latest, path.basename(zip), signature);
  writeFileSync(latestPath, `${JSON.stringify(patched, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, argument] = process.argv.slice(2);
  const releaseDir = process.env.FTPEACH_RELEASE_DIR ?? 'src-tauri/target/release';
  if (command === 'build') {
    console.log(build(argument ?? releaseDir));
  } else if (command === 'feed' && argument) {
    feed(argument, releaseDir);
    console.log(`${argument}: added ${PORTABLE_TARGET}`);
  } else {
    console.error('Usage: portable.ts build [releaseDir] | portable.ts feed <latest.json>');
    process.exit(1);
  }
}
