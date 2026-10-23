// `cargo check` on Linux, as CI's rust-linux job and the server matrix build
// the crate, in Docker. The Tauri build script writes into the source tree, so
// the container checks a copy; target and registry stay in named volumes.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const channel = /channel\s*=\s*"([^"]+)"/.exec(
  readFileSync(new URL('../../rust-toolchain.toml', import.meta.url), 'utf8'),
)?.[1];
if (!channel) throw new Error('rust-toolchain.toml names no channel');

// The copy holds what a CI checkout would, plus files not yet committed: never
// .tools, private/ or other ignored local artifacts, which ran to gigabytes.
const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
});
if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
const files = [...new Set(listed.stdout.split('\0'))].filter(
  (file) => file && existsSync(join(root, file)),
);
const listDir = mkdtempSync(join(tmpdir(), 'ftpeach-linux-'));
const list = join(listDir, 'files');
writeFileSync(list, files.join('\0'));

const script = [
  'apt-get update -qq',
  'apt-get install -y -qq libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev >/dev/null',
  'mkdir /w',
  'tar -C /src --null -T /files -cf - | tar -C /w -xf -',
  'cargo check --locked --all-targets --manifest-path /w/src-tauri/Cargo.toml',
].join(' && ');

const result = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '-v',
    `${root}:/src:ro`,
    '-v',
    `${list}:/files:ro`,
    '-v',
    'ftpeach-linux-target:/target',
    '-v',
    'ftpeach-cargo-reg:/usr/local/cargo/registry',
    '-e',
    'CARGO_TARGET_DIR=/target',
    `rust:${channel}`,
    'bash',
    '-c',
    script,
  ],
  { stdio: 'inherit' },
);
rmSync(listDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
