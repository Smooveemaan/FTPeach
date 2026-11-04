import assert from 'node:assert/strict';
import { test } from 'node:test';
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
