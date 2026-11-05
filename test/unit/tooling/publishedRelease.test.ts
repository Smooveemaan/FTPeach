import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../../../scripts/release/candidate.ts';
import { validatePublicFeed } from '../../../scripts/release/check-published.ts';

test('public feed must offer exactly the accepted installed and portable files and signatures', () => {
  const files = {
    'FTPeach_0.6.1_x64-setup.exe.sig': sha256('installed\n'),
    'FTPeach_0.6.1_x64-portable.zip.sig': sha256('portable\r\n'),
  };
  const candidate = { readiness: { version: '0.6.1' }, files };
  const assets = [
    { name: 'FTPeach_0.6.1_x64-setup.exe', url: 'https://api.github.com/installed' },
    { name: 'FTPeach_0.6.1_x64-portable.zip', url: 'https://api.github.com/portable' },
  ];
  const feed = {
    version: '0.6.1',
    platforms: {
      'windows-x86_64': { url: assets[0]!.url, signature: 'installed' },
      'windows-x86_64-portable': { url: assets[1]!.url, signature: 'portable' },
    },
  };
  validatePublicFeed(feed, candidate, assets);
  for (const bad of [
    { ...feed, version: '0.6.0' },
    {
      ...feed,
      platforms: {
        ...feed.platforms,
        'windows-x86_64': { url: 'https://attacker.example/setup', signature: 'installed' },
      },
    },
    {
      ...feed,
      platforms: {
        ...feed.platforms,
        'windows-x86_64-portable': { url: assets[1]!.url, signature: 'tampered' },
      },
    },
    { ...feed, platforms: { 'windows-x86_64': feed.platforms['windows-x86_64'] } },
  ])
    assert.throws(() => validatePublicFeed(bad, candidate, assets));
});
