import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldTrace } from '../../e2e/app.ts';

test('e2e tracing skips first CI attempt when retries exist and records retries, local runs and overrides', () => {
  assert.equal(shouldTrace(0, 1, { CI: 'true' }), false);
  assert.equal(shouldTrace(1, 1, { CI: 'true' }), true);
  assert.equal(shouldTrace(0, 0, { CI: 'true' }), true);
  assert.equal(shouldTrace(0, 0, {}), true);
  assert.equal(shouldTrace(0, 1, {}), true);
  assert.equal(shouldTrace(0, 1, { CI: 'true', FTPEACH_E2E_TRACE: '1' }), true);
  assert.equal(shouldTrace(1, 1, { CI: 'true', FTPEACH_E2E_TRACE: '0' }), false);
  assert.equal(shouldTrace(0, 0, { FTPEACH_E2E_TRACE: '0' }), false);
});
