import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256, type PublicRun } from '../../../scripts/release/candidate.ts';
import {
  evidenceName,
  parseCandidateId,
  findArtifact,
  requireJob,
  latestStageSuccess,
  resumePlan,
  validateEvidence,
  validateOrigin,
  type Evidence,
} from '../../../scripts/release/validate-candidate.ts';
import { signingEnvironmentVerdict } from '../../../scripts/release/release-trust.ts';

const id = '123:1';
const hash = sha256('immutable candidate manifest');
const run = {
  id: 456,
  run_attempt: 2,
  head_sha: 'b'.repeat(40),
  head_branch: 'master',
  path: '.github/workflows/release.yml',
  event: 'workflow_dispatch',
  head_repository: { full_name: 'owner/app' },
} as PublicRun;
const proof: Evidence = {
  schema: 1,
  candidateId: id,
  candidateHash: hash,
  stage: 'installer',
  runId: '456',
  attempt: '1',
  toolsSha: run.head_sha,
  workflow: run.path,
};

test('acceptance evidence binds to candidate ID and manifest hash and requires approval when missing', () => {
  assert.equal(evidenceName(id), 'candidate-123-1-acceptance');
  validateEvidence(proof, 'installer', id, hash, run);
  assert.deepEqual(resumePlan({}, true), {
    installer: true,
  });
  assert.throws(() => resumePlan({}, false), /requires installer-approved/);
  assert.deepEqual(resumePlan({ installer: proof }, false), {
    installer: false,
  });
});

test('substituted run, attempt, SHA, stage or candidate hash cannot authorize reuse', () => {
  validateOrigin(run, '456', 'owner/app');
  for (const patch of [
    { candidateId: '123:2' },
    { candidateHash: '0'.repeat(64) },
    { runId: '999' },
    { attempt: '3' },
    { attempt: '0' },
    { toolsSha: 'c'.repeat(40) },
    { workflow: '.github/workflows/installer.yml' },
    { stage: 'desktop' as unknown as Evidence['stage'] },
  ])
    assert.throws(() => validateEvidence({ ...proof, ...patch }, 'installer', id, hash, run));
  for (const patch of [
    { event: 'pull_request' },
    { head_branch: 'untrusted' },
    { path: '.github/workflows/installer.yml' },
    { head_repository: { full_name: 'attacker/fork' } },
  ])
    assert.throws(() => validateOrigin({ ...run, ...patch }, '456', 'owner/app'));
  for (const invalid of ['123', '123:0', '../123:1', '123:1:2', '0:1'])
    assert.throws(() => parseCandidateId(invalid));
});

test('automatic signing is permitted only for an exact master branch environment', () => {
  const settings = {
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    protection_rules: [],
  };
  const branches = [{ name: 'master', type: 'branch' }];
  assert.equal(signingEnvironmentVerdict(settings, branches).ok, true);
  for (const policies of [
    [],
    [{ name: '*', type: 'branch' }],
    [{ name: 'master', type: 'tag' }],
    [...branches, { name: 'v*', type: 'tag' }],
  ])
    assert.equal(signingEnvironmentVerdict(settings, policies).ok, false);
  assert.equal(
    signingEnvironmentVerdict(
      { ...settings, protection_rules: [{ type: 'required_reviewers' }] },
      branches,
    ).ok,
    false,
  );
  assert.equal(
    signingEnvironmentVerdict({ ...settings, deployment_branch_policy: null }, branches).ok,
    false,
  );
});

test('a newer failed attempt invalidates its own stage while skipped retries preserve success', () => {
  const jobs = [
    { id: 1, name: 'release / build-windows', conclusion: 'success' },
    { id: 2, name: 'release / acceptance / installer', conclusion: 'success' },
  ];
  for (const conclusion of ['failure', 'cancelled', 'timed_out', null]) {
    const retried = [...jobs, { id: 3, name: 'release / acceptance / installer', conclusion }];
    assert.equal(latestStageSuccess(retried, 'acceptance / installer'), false);
    assert.equal(latestStageSuccess(retried, 'build-windows'), true);
  }
  assert.equal(
    latestStageSuccess(
      [...jobs, { id: 3, name: 'release / acceptance / installer', conclusion: 'skipped' }],
      'acceptance / installer',
    ),
    true,
  );
});

test('expired evidence and missing, skipped or failed jobs cannot permit a transition', async (t) => {
  const token = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  t.after(() => {
    if (token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = token;
  });
  let body: object = { total_count: 1, artifacts: [{ id: 1, name: 'proof', expired: true }] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  assert.equal(await findArtifact('proof'), undefined);
  body = { jobs: [] };
  await assert.rejects(requireJob('123', '1', 'build-windows'), /Missing or ambiguous/);
  for (const conclusion of ['skipped', 'failure', 'cancelled', null]) {
    body = { jobs: [{ name: 'release / build-windows', conclusion }] };
    await assert.rejects(requireJob('123', '1', 'build-windows'), /did not succeed/);
  }
  body = { jobs: [{ name: 'release / build-windows', conclusion: 'success' }] };
  await requireJob('123', '1', 'build-windows');
});
