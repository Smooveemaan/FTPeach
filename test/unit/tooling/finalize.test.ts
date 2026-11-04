import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assetNeedsUpload,
  MANUAL_CHECKS,
  tagMessage,
  validateManualAcceptance,
  validatePackagingRun,
  validateTag,
  verifiedSource,
  type ManualAcceptance,
} from '../../../scripts/release/finalize.ts';
import type { Candidate } from '../../../scripts/release/candidate.ts';
import type { PublicRun } from '../../../scripts/release/verify-readiness.ts';

const sha = 'a'.repeat(40);
const hash = 'b'.repeat(64);
const candidate = {
  readiness: { version: '0.6.1', sha, repository: 'owner/app' },
  build: { runId: '123', attempt: '1', workflowSha: 'c'.repeat(40) },
} as Candidate;
const manual: ManualAcceptance = {
  sha,
  candidateHash: hash,
  tester: 'owner',
  checkedAt: '2026-01-01T12:00:00Z',
  results: Object.fromEntries(
    MANUAL_CHECKS.map((name) => [
      name,
      { result: 'passed', evidence: 'Recorded test on a clean machine' },
    ]),
  ),
};

test('every manual result must name the exact source and accepted bytes', () => {
  validateManualAcceptance(manual, sha, hash);
  for (const patch of [
    { sha: 'd'.repeat(40) },
    { candidateHash: 'd'.repeat(64) },
    { tester: '' },
    { checkedAt: 'not a date' },
    { results: {} },
  ]) {
    assert.throws(() => validateManualAcceptance({ ...manual, ...patch }, sha, hash));
  }
  for (const name of MANUAL_CHECKS) {
    for (const result of ['skipped', 'failed', 'not verified']) {
      assert.throws(() =>
        validateManualAcceptance(
          { ...manual, results: { ...manual.results, [name]: { result, evidence: 'A note' } } },
          sha,
          hash,
        ),
      );
    }
    assert.throws(() =>
      validateManualAcceptance(
        { ...manual, results: { ...manual.results, [name]: { result: 'passed', evidence: '' } } },
        sha,
        hash,
      ),
    );
  }
});
test('only an annotated tag of these exact candidate bytes can be resumed', () => {
  const tag = {
    tag: 'v0.6.1',
    message: tagMessage('0.6.1', hash),
    object: { type: 'commit', sha },
  };
  validateTag(tag, candidate, hash);
  assert.throws(() => validateTag({ ...tag, tag: 'v0.6.0' }, candidate, hash));
  assert.throws(() =>
    validateTag({ ...tag, message: tagMessage('0.6.1', 'd'.repeat(64)) }, candidate, hash),
  );
  assert.throws(() =>
    validateTag({ ...tag, object: { type: 'commit', sha: 'd'.repeat(40) } }, candidate, hash),
  );
});
test('uploads resume only missing assets, and never overwrite mismatches or unproven hashes', () => {
  assert.equal(assetNeedsUpload(undefined, hash), true);
  assert.equal(
    assetNeedsUpload({ name: 'setup.exe', url: 'asset', digest: `sha256:${hash}` }, hash),
    false,
  );
  assert.throws(() =>
    assetNeedsUpload({ name: 'setup.exe', url: 'asset', digest: `sha256:${'d'.repeat(64)}` }, hash),
  );
  assert.throws(() => assetNeedsUpload({ name: 'setup.exe', url: 'asset' }, hash));
});
test('failed, canceled or substituted packaging runs cannot authorize a tag', () => {
  const run = {
    id: 123,
    run_attempt: 2,
    head_sha: candidate.build.workflowSha,
    head_branch: 'master',
    event: 'workflow_dispatch',
    path: '.github/workflows/release-next.yml',
    status: 'completed',
    conclusion: 'success',
    head_repository: { full_name: 'owner/app' },
  } as PublicRun;
  validatePackagingRun(run, candidate, run.path, '123');
  for (const patch of [
    { id: 999 },
    { event: 'push' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { head_branch: 'branch' },
    { head_sha: sha },
    { path: '.github/workflows/other.yml' },
    { run_attempt: 0 },
  ]) {
    assert.throws(() => validatePackagingRun({ ...run, ...patch }, candidate, run.path, '123'));
  }
});
test('the verified attestation must identify the actual checkout, independently of controller SHA', () => {
  const output = [
    {
      verificationResult: {
        statement: {
          predicate: {
            buildDefinition: {
              resolvedDependencies: [
                { uri: `git+https://github.com/owner/app@${sha}`, digest: { gitCommit: sha } },
              ],
            },
          },
        },
      },
    },
  ];
  assert.equal(verifiedSource(output, 'owner/app', sha), true);
  assert.equal(verifiedSource(output, 'owner/app', 'd'.repeat(40)), false);
  assert.equal(verifiedSource([], 'owner/app', sha), false);
});
