// The portable release: the built program and its bundled files in a zip that
// people unpack and that a portable copy updates itself from.
//
//   portable.ts build [releaseDir]   assemble the folder and zip it
//   portable.ts feed <latest.json> <zipUrl>   add the signed zip to the update feed
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
export function portableZipName(version: string): string {
  return `FTPeach_${version}_x64-portable.zip`;
}

interface Feed {
  platforms?: Record<string, { url: string; signature: string }>;
  [key: string]: unknown;
}

/**
 * `latest` with the portable zip added. `url` is the zip's own asset address:
 * the installer's is an API address by asset id, so a file name cannot be
 * swapped into it (0.4.0 and 0.5.0 shipped such a 404).
 */
export function withPortablePlatform(latest: Feed, url: string, signature: string): Feed {
  if (!/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/.test(url)) {
    throw new Error(`Not a release asset address: ${url}`);
  }
  if (!signature.trim()) throw new Error('The portable zip has no signature');
  return {
    ...latest,
    platforms: {
      ...latest.platforms,
      [PORTABLE_TARGET]: { signature: signature.trim(), url },
    },
  };
}

function version(): string {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
    version: string;
  };
  return config.version;
}

function zipPath(releaseDir: string, of = version()): string {
  return path.join(releaseDir, 'bundle', 'portable', portableZipName(of));
}

/**
 * What the installer puts in the program's folder, plus the marker and the
 * license. `of` names the version the program was built as, when a build
 * overrode the one in tauri.conf.json (scripts/release/test-installers.ts).
 */
export function build(releaseDir: string, of = version()): string {
  const zip = zipPath(releaseDir, of);
  const folder = path.join(path.dirname(zip), 'FTPeach');
  rmSync(path.dirname(zip), { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  // Cargo names the binary after the `app` package.
  cpSync(path.join(releaseDir, 'app.exe'), path.join(folder, 'FTPeach.exe'));
  writeFileSync(path.join(folder, 'FTPeach.portable'), '');
  // Where the key and certificate pickers open: files there move with the copy.
  for (const empty of ['keys', 'certificates']) mkdirSync(path.join(folder, empty));
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

function feed(latestPath: string, url: string, releaseDir: string): void {
  const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as Feed;
  const signature = readFileSync(`${zipPath(releaseDir)}.sig`, 'utf8');
  const patched = withPortablePlatform(latest, url, signature);
  writeFileSync(latestPath, `${JSON.stringify(patched, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, argument, url] = process.argv.slice(2);
  const releaseDir = process.env.FTPEACH_RELEASE_DIR ?? 'src-tauri/target/release';
  if (command === 'build') {
    console.log(build(argument ?? releaseDir));
  } else if (command === 'feed' && argument && url) {
    feed(argument, url, releaseDir);
    console.log(`${argument}: added ${PORTABLE_TARGET}`);
  } else {
    console.error(
      'Usage: portable.ts build [releaseDir] | portable.ts feed <latest.json> <zipUrl>',
    );
    process.exit(1);
  }
}
