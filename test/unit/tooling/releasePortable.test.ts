import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PORTABLE_TARGET,
  portableZipName,
  withPortablePlatform,
} from '../../../scripts/release/portable.ts';

const latest = {
  version: '0.4.0',
  notes: 'notes',
  platforms: {
    'windows-x86_64': {
      signature: 'installer-signature',
      url: 'https://github.com/Smooveemaan/ftpeach/releases/download/v0.4.0/FTPeach_0.4.0_x64-setup.exe',
    },
  },
};

test('the portable zip joins the feed beside the installer and leaves it alone', () => {
  const patched = withPortablePlatform(latest, portableZipName('0.4.0'), 'zip-signature\n');
  assert.deepEqual(patched.platforms?.[PORTABLE_TARGET], {
    signature: 'zip-signature',
    url: 'https://github.com/Smooveemaan/ftpeach/releases/download/v0.4.0/FTPeach_0.4.0_x64-portable.zip',
  });
  assert.deepEqual(patched.platforms?.['windows-x86_64'], latest.platforms['windows-x86_64']);
  assert.equal(patched.version, '0.4.0');
  assert.equal(patched.notes, 'notes');
});

test('a feed without the installer or a zip without a signature is refused', () => {
  assert.throws(() => withPortablePlatform({ platforms: {} }, 'x.zip', 'signature'));
  assert.throws(() => withPortablePlatform(latest, 'x.zip', ' \n'));
});

test('the script and the updater name the same feed entry', () => {
  const updater = readFileSync('src-tauri/src/runtime/updater.rs', 'utf8');
  assert.ok(updater.includes(`const PORTABLE_TARGET: &str = "${PORTABLE_TARGET}";`));
});
