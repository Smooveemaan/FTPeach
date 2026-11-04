import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('manual packaging release notes link to the pinned source, not the advancing master ref', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'release-notes-test-'));
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '0.6.1' }));
  writeFileSync(
    path.join(directory, 'CHANGELOG.md'),
    '## [0.6.1]\n\nFixed a problem.\n\n## [0.6.0]\nOld notes.',
  );
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
      RELEASE_SOURCE_SHA: 'a'.repeat(40),
      GITHUB_OUTPUT: path.join(directory, 'output.txt'),
    },
  });
  assert.equal(child.status, 0, child.stderr);
  const notes = readFileSync(path.join(directory, 'release/release-notes.md'), 'utf8');
  assert.match(notes, new RegExp(`owner/app/${'a'.repeat(40)}/assets/images`));
  assert.ok(!notes.includes('/master/'));
  assert.ok(!notes.includes('Old notes'));
});
