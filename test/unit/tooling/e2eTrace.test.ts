import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasRunningAppProcess, shouldTrace } from '../../e2e/app.ts';

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

test('hasRunningAppProcess detects app.exe and FTPeach.exe in CSV tasklist output without substring false positives', () => {
  assert.equal(hasRunningAppProcess('"System","4","Services","0","8 K"\r\n'), false);
  assert.equal(hasRunningAppProcess('"my-app.exe","100","Console","1","10 K"\r\n'), false);
  assert.equal(
    hasRunningAppProcess(
      '"System","4","Services","0","8 K"\r\n"app.exe","1234","Console","1","10 K"\r\n',
    ),
    true,
  );
  assert.equal(hasRunningAppProcess('"FTPeach.exe","5678","Console","1","50 K"\r\n'), true);
  assert.equal(hasRunningAppProcess('"ftpeach.exe","5678","Console","1","50 K"\r\n'), true);
});
