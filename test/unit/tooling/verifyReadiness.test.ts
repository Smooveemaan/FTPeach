import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateReadiness,
  validateSourceJobs,
  requireUnusedVersion,
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
test('a version already taken by a tag or draft cannot start another packaging build', () => {
  requireUnusedVersion(null, null);
  assert.throws(() => requireUnusedVersion({ object: { sha: 'a'.repeat(40) } }, null));
  assert.throws(() => requireUnusedVersion(null, { draft: true }));
});
test('packaging uses the checked source even after master advances', () => {
  assert.equal(validateReadiness('owner/app', '123', run, proof).sha, 'a'.repeat(40));
});
test('source readiness remains valid while packaging is running or has failed', () => {
  for (const patch of [
    { status: 'in_progress', conclusion: null },
    { status: 'completed', conclusion: 'failure' },
    { status: 'completed', conclusion: 'cancelled' },
  ]) {
    assert.equal(validateReadiness('owner/app', '123', { ...run, ...patch }, proof), proof);
  }
});

test('ordinary, superseded or untrusted public evidence is rejected', () => {
  for (const patch of [
    { id: 999 },
    { run_attempt: 3 },
    { head_sha: 'c'.repeat(40) },
    { head_branch: 'branch' },
    { event: 'workflow_dispatch' },
    { path: '.github/workflows/other.yml' },
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
    { privateCheck: undefined },
  ]) {
    assert.throws(() =>
      validateReadiness('owner/app', '123', run, { ...proof, ...patch } as Readiness),
    );
  }
});

const sourceJobs = [
  'mode',
  'private-check',
  'release-ready',
  'checks / full-result',
  'checks / rust-test-unix (ubuntu-22.04)',
  'checks / rust-test-unix (macos-15)',
].map((name, index) => ({ id: index + 1, name, conclusion: 'success' }));

test('successful retained source jobs survive failures in independent packaging stages', () => {
  validateSourceJobs([
    ...sourceJobs,
    { id: 10, name: 'build-windows', conclusion: 'failure' },
    { id: 11, name: 'tag-and-draft', conclusion: null },
  ]);
  validateSourceJobs([{ id: 0, name: 'private-check', conclusion: 'failure' }, ...sourceJobs]);
});

test('missing, skipped, failed and still-running source checks block readiness', () => {
  for (const job of sourceJobs) {
    for (const conclusion of ['failure', 'skipped', 'cancelled', null]) {
      assert.throws(() =>
        validateSourceJobs([...sourceJobs, { id: 100, name: job.name, conclusion }]),
      );
    }
  }
  for (const name of ['mode', 'private-check', 'release-ready', 'checks / full-result']) {
    assert.throws(() => validateSourceJobs(sourceJobs.filter((job) => job.name !== name)));
  }
});
