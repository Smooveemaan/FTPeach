// The installers the installer tests (test/e2e/install.vm.ts) install: the
// application as released, built twice from this checkout, as its own version
// and as the next patch, so the first has an update to find. Both trust a key
// made for this build instead of the release key and read their update feed
// from 127.0.0.1, where the tests serve it. They carry the `smoke-test`
// feature, so the tests can drive them over DevTools; without its variables
// they run as the released program, updater included.
//
// Run through `npm run build:test-installers` (scripts/cargo.ts),
// which builds into .tools/installer-target. Writes .tools/installer-test:
// build.json, the key, and per version the installer and the portable zip,
// each with its signature.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { build as buildPortable } from './portable.ts';

/** Where the tests serve the update feed; built into both versions. */
const FEED_PORT = 47_919;
const KEY_PASSWORD = 'ftpeach installer tests';

const out = path.resolve('.tools', 'installer-test');
const releaseDir = path.join(process.env.CARGO_TARGET_DIR ?? 'src-tauri/target', 'release');
const tauri = (...args: string[]) =>
  execFileSync(process.execPath, [process.env.npm_execpath!, 'run', 'tauri', '--', ...args], {
    stdio: 'inherit',
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: KEY_PASSWORD,
    },
  });

function nextPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  if ([major, minor, patch].some((part) => !Number.isInteger(part))) {
    throw new Error(`${version} is not a plain major.minor.patch version`);
  }
  return `${major}.${minor}.${patch! + 1}`;
}

function buildVersion(version: string, pubkey: string, key: string) {
  const config = path.join(out, `tauri.${version}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      version,
      plugins: {
        updater: {
          pubkey,
          endpoints: [`http://127.0.0.1:${FEED_PORT}/latest.json`],
          dangerousInsecureTransportProtocol: true,
        },
      },
    }),
  );
  process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(key, 'utf8');
  tauri('build', '--features', 'smoke-test', '--bundles', 'nsis', '--config', config);
  const folder = path.join(out, version);
  mkdirSync(folder, { recursive: true });
  const setup = `FTPeach_${version}_x64-setup.exe`;
  for (const file of [setup, `${setup}.sig`]) {
    copyFileSync(path.join(releaseDir, 'bundle', 'nsis', file), path.join(folder, file));
  }
  // Right after its own build: the next one replaces app.exe.
  const zip = buildPortable(releaseDir, version);
  // With the key and its password from the variables, as release.yml signs it.
  tauri('signer', 'sign', zip);
  for (const file of [zip, `${zip}.sig`]) {
    copyFileSync(file, path.join(folder, path.basename(file)));
  }
}

const version = (
  JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as { version: string }
).version;
const next = nextPatch(version);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const key = path.join(out, 'test.key');
tauri('signer', 'generate', '--ci', '--password', KEY_PASSWORD, '--write-keys', key);
const pubkey = readFileSync(`${key}.pub`, 'utf8').trim();
for (const each of [version, next]) buildVersion(each, pubkey, key);
// What the tests read (test/e2e/install.ts): the key signs what they make up.
const result = { version, next, feedPort: FEED_PORT, key, keyPassword: KEY_PASSWORD };
writeFileSync(path.join(out, 'build.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`Test installers for ${version} and ${next} in ${out}`);
