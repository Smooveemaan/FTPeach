import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseCheck } from '../../../scripts/release/check-mode.ts';

test('only an exact line in the master push HEAD requests release verification', () => {
  assert.equal(
    releaseCheck('push', 'refs/heads/master', 'Prepare release\n\nRelease-Check: true'),
    true,
  );
  assert.equal(
    releaseCheck('push', 'refs/heads/master', 'Prepare\r\nRelease-Check: true\r\n'),
    true,
  );
  for (const message of [
    '',
    'Release-Check: false',
    ' Release-Check: true',
    'Release-Check: true ',
    'prefix Release-Check: true',
    'Release-Check: TRUE',
  ]) {
    assert.equal(releaseCheck('push', 'refs/heads/master', message), false, message);
  }
  for (const event of ['pull_request', 'workflow_dispatch']) {
    assert.equal(releaseCheck(event, 'refs/heads/master', 'Release-Check: true'), false);
  }
  for (const ref of ['refs/tags/v0.6.1', 'refs/heads/release']) {
    assert.equal(releaseCheck('push', ref, 'Release-Check: true'), false);
  }
});

test('the CLI reads only push HEAD; intermediate markers and PRs never enable the release mode', () => {
  const script = fileURLToPath(new URL('../../../scripts/release/check-mode.ts', import.meta.url));
  for (const [eventName, message, expected] of [
    ['push', 'Release-Check: true', 'release=true\nfull=true\n'],
    ['push', 'ordinary HEAD', 'release=false\nfull=false\n'],
    ['pull_request', 'Release-Check: true', 'release=false\nfull=false\n'],
    ['workflow_dispatch', 'ordinary HEAD', 'release=false\nfull=true\n'],
  ]) {
    const directory = mkdtempSync(path.join(tmpdir(), 'check-mode-test-'));
    const input = path.join(directory, 'event.json');
    const output = path.join(directory, 'output.txt');
    writeFileSync(
      input,
      JSON.stringify({
        head_commit: { message },
        commits: [{ message: 'Release-Check: true' }, { message }],
      }),
    );
    const child = spawnSync(process.execPath, ['--experimental-strip-types', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: input,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_REF: 'refs/heads/master',
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(output, 'utf8'), expected);
  }
});
