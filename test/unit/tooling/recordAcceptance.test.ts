import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireAcceptance } from '../../../scripts/release/record-acceptance.ts';

test('package acceptance requires every scenario with no skips or retries', () => {
  const stats = { expected: 5, skipped: 0, unexpected: 0, flaky: 0 };
  requireAcceptance(stats);
  for (const patch of [
    { expected: 0 },
    { expected: 2 },
    { skipped: 1 },
    { unexpected: 1 },
    { flaky: 1 },
  ]) {
    assert.throws(() => requireAcceptance({ ...stats, ...patch }));
  }
});
