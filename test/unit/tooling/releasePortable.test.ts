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
      url: 'https://api.github.com/repos/Smooveemaan/FTPeach/releases/assets/655797214',
    },
  },
};

const zipUrl = 'https://api.github.com/repos/Smooveemaan/FTPeach/releases/assets/655810593';

test('the portable zip joins the feed beside the installer and leaves it alone', () => {
  const patched = withPortablePlatform(latest, zipUrl, 'zip-signature\n');
  assert.deepEqual(patched.platforms?.[PORTABLE_TARGET], {
    signature: 'zip-signature',
    url: zipUrl,
  });
  assert.deepEqual(patched.platforms?.['windows-x86_64'], latest.platforms['windows-x86_64']);
  assert.equal(patched.version, '0.4.0');
  assert.equal(patched.notes, 'notes');
});

test('a zip address that is not an asset id or a zip without a signature is refused', () => {
  // The 0.4.0 and 0.5.0 feeds pointed here: the API takes only an id, so it was a 404.
  const byName = `https://api.github.com/repos/Smooveemaan/FTPeach/releases/assets/${portableZipName('0.5.0')}`;
  assert.throws(() => withPortablePlatform(latest, byName, 'signature'));
  assert.throws(() => withPortablePlatform(latest, '', 'signature'));
  assert.throws(() => withPortablePlatform(latest, zipUrl, ' \n'));
});

test('the script and the updater name the same feed entry', () => {
  const updater = readFileSync('src-tauri/src/runtime/updater.rs', 'utf8');
  assert.ok(updater.includes(`const PORTABLE_TARGET: &str = "${PORTABLE_TARGET}";`));
});
