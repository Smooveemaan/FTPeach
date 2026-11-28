import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function runReleaseNotes(version: string, changelog: string, sha = 'a'.repeat(40)) {
  const directory = mkdtempSync(path.join(tmpdir(), 'release-notes-test-'));
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version }));
  writeFileSync(path.join(directory, 'CHANGELOG.md'), changelog);
  const script = fileURLToPath(
    new URL('../../../scripts/release/build-release-notes.ts', import.meta.url),
  );
  const child = spawnSync(process.execPath, ['--experimental-strip-types', script], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'owner/app',
      GITHUB_REF_NAME: 'master',
      RELEASE_SOURCE_SHA: sha,
      GITHUB_OUTPUT: path.join(directory, 'output.txt'),
    },
  });
  assert.equal(child.status, 0, child.stderr);
  return readFileSync(path.join(directory, 'release/release-notes.md'), 'utf8');
}

test('manual packaging release notes link to the pinned source, not the advancing master ref', () => {
  const sha = 'a'.repeat(40);
  const notes = runReleaseNotes(
    '0.6.1',
    '## [0.6.1]\n\nFixed a problem.\n\n## [0.6.0]\nOld notes.',
    sha,
  );
  assert.match(notes, new RegExp(`owner/app/${sha}/assets/images`));
  assert.match(notes, new RegExp(`owner/app/${sha}/assets/images/platforms/windows-dark\\.png`));
  assert.ok(notes.includes('FTPeach_0.6.1_x64-setup.exe'));
  assert.ok(!notes.includes('FTPeach_0.6.1_universal.dmg'));
  assert.ok(!notes.includes('/master/'));
  assert.ok(!notes.includes('Old notes'));
});

test('multi-platform release notes include Windows, macOS and Linux download links and platform icons', () => {
  const sha = 'b'.repeat(40);
  const notes = runReleaseNotes('0.7.1', '## [0.7.1]\n\nAdded something.\n', sha);
  for (const platform of ['windows', 'macos', 'linux']) {
    assert.ok(notes.includes(`owner/app/${sha}/assets/images/platforms/${platform}-dark.png`));
    assert.ok(notes.includes(`owner/app/${sha}/assets/images/platforms/${platform}-light.png`));
  }
  for (const asset of [
    'FTPeach_0.7.1_x64-setup.exe',
    'FTPeach_0.7.1_x64-portable.zip',
    'FTPeach_0.7.1_universal.dmg',
    'FTPeach_0.7.1_amd64.deb',
    'FTPeach_0.7.1_amd64.AppImage',
  ]) {
    assert.ok(notes.includes(`https://github.com/owner/app/releases/download/v0.7.1/${asset}`));
  }
  assert.ok(notes.includes('Fedora'));
  assert.ok(!notes.includes('Recommended'));
  assert.ok(!notes.includes('universal.app.tar.gz'));
});
