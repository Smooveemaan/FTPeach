import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sha256 } from '../../../scripts/release/candidate.ts';
import {
  validatePublicFeed,
  verifyUpdaterSignature,
} from '../../../scripts/release/check-published.ts';

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

test('node:crypto minisign verifier accepts valid updater signatures and rejects tampered payloads or comments', () => {
  const pubKey = readFileSync('test/fixtures/updater/spike.key.pub', 'utf8');
  const signature = readFileSync('test/fixtures/updater/dummy-update.bin.sig', 'utf8');
  const payload = readFileSync('test/fixtures/updater/dummy-update.bin');
  verifyUpdaterSignature(pubKey, payload, signature);
  assert.throws(
    () => verifyUpdaterSignature(pubKey, Buffer.concat([payload, Buffer.from('x')]), signature),
    /Updater signature verification failed/,
  );
  const tamperedComment = Buffer.from(
    Buffer.from(signature.trim(), 'base64')
      .toString('utf8')
      .replace('file:dummy-update.bin', 'file:evil.bin'),
    'utf8',
  ).toString('base64');
  assert.throws(
    () => verifyUpdaterSignature(pubKey, payload, tamperedComment),
    /Updater trusted comment signature verification failed/,
  );
});
