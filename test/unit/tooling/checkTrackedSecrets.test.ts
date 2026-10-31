import assert from 'node:assert/strict';
import test from 'node:test';
import { secretViolations } from '../../../scripts/checks/check-tracked-secrets.ts';

const privateKey = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(32)}\n-----END PRIVATE KEY-----`;

test('secret scanning checks supplied paths and contents', () => {
  assert.deepEqual(secretViolations([{ path: '.env', content: 'safe' }]), [
    '.env (secret-like filename)',
  ]);
  assert.deepEqual(secretViolations([{ path: 'allowed.txt', content: privateKey }]), [
    'allowed.txt (private-key marker)',
  ]);
  assert.deepEqual(secretViolations([{ path: '.env.example', content: 'safe' }]), []);
});

test('scanner source and release trust files are not exempt from secret checks', () => {
  for (const path of [
    'scripts/checks/check-tracked-secrets.ts',
    'scripts/release/release-trust.ts',
  ]) {
    assert.deepEqual(secretViolations([{ path, content: privateKey }]), [
      `${path} (private-key marker)`,
    ]);
  }
});
