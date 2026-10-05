// `cargo check` on Linux, as CI's rust-linux job and the server matrix build
// the crate, in Docker. The Tauri build script writes into the source tree, so
// the container checks a copy; target and registry stay in named volumes.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const channel = /channel\s*=\s*"([^"]+)"/.exec(
  readFileSync(new URL('../../rust-toolchain.toml', import.meta.url), 'utf8'),
)?.[1];
if (!channel) throw new Error('rust-toolchain.toml names no channel');

const script = [
  'apt-get update -qq',
  'apt-get install -y -qq libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev >/dev/null',
  'mkdir /w',
  'tar -C /src -cf - --exclude=./src-tauri/target --exclude=./node_modules --exclude=./.git . | tar -C /w -xf -',
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
process.exit(result.status ?? 1);
