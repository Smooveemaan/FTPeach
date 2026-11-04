import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateReadiness,
  WINDOWS_PACKAGES,
  type PublicRun,
  type Readiness,
} from '../../../scripts/release/verify-readiness.ts';

const run: PublicRun = {
  id: 123,
  run_attempt: 2,
  head_sha: 'a'.repeat(40),
  head_branch: 'master',
  event: 'push',
  path: '.github/workflows/ci.yml',
  status: 'completed',
  conclusion: 'success',
  head_commit: { message: 'Prepare\nRelease-Check: true' },
  head_repository: { full_name: 'owner/app' },
};
const proof: Readiness = {
  schema: 1,
  repository: 'owner/app',
  runId: '123',
  attempt: '2',
  sha: run.head_sha,
  version: '0.6.1',
  packages: WINDOWS_PACKAGES,
  privateCheck: {
    runId: 456,
    attempt: 1,
    workflowId: 7,
    testSha: 'b'.repeat(40),
    requiredJobCount: 13,
  },
};
test('packaging uses the checked source even after master advances', () => {
  assert.equal(validateReadiness('owner/app', '123', run, proof).sha, 'a'.repeat(40));
});
test('ordinary, partial, failed, superseded or untrusted public evidence is rejected', () => {
  for (const patch of [
    { id: 999 },
    { run_attempt: 3 },
    { head_sha: 'c'.repeat(40) },
    { head_branch: 'branch' },
    { event: 'workflow_dispatch' },
    { path: '.github/workflows/other.yml' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { head_commit: { message: 'ordinary' } },
    { head_repository: { full_name: 'fork/app' } },
  ]) {
    assert.throws(() => validateReadiness('owner/app', '123', { ...run, ...patch }, proof));
  }
  for (const patch of [
    { sha: 'c'.repeat(40) },
    { attempt: '1' },
    { runId: '999' },
    { packages: [] },
    { version: 'bad' },
  ]) {
    assert.throws(() => validateReadiness('owner/app', '123', run, { ...proof, ...patch }));
  }
});
