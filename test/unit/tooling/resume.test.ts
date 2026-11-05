import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../../../scripts/release/candidate.ts';
import {
  parseCandidateId,
  findArtifact,
  requireJob,
  latestStageSuccess,
  workflowInputs,
  resumePlan,
  stageInputs,
  validateEvidence,
  validateOrigin,
  type Evidence,
} from '../../../scripts/release/validate-candidate.ts';
import { signingEnvironmentVerdict } from '../../../scripts/release/release-trust.ts';
import type { PublicRun } from '../../../scripts/release/verify-readiness.ts';
import { MANUAL_CHECKS } from '../../../scripts/release/finalize.ts';
import { validateManualRecord } from '../../../scripts/release/manual.ts';

const id = '123:1';
const hash = sha256('immutable candidate manifest');
const files = {
  'scripts/release/candidate.ts': 'a',
  'test/e2e/release-feed.ts': 'broken-helper',
  'src/app.ts': 'app',
  'package-lock.json': 'lock',
};
const fixed = { ...files, 'test/e2e/release-feed.ts': 'fixed-helper' };
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
  stage: 'attest',
  inputs: stageInputs('attest', files),
  runId: '456',
  attempt: '1',
  toolsSha: run.head_sha,
  workflow: run.path,
};

test('a fixed acceptance helper rechecks the same bytes without losing independent attestation', () => {
  assert.equal(stageInputs('attest', files), stageInputs('attest', fixed));
  assert.notEqual(stageInputs('installer', files), stageInputs('installer', fixed));
  validateEvidence(proof, 'attest', id, hash, stageInputs('attest', fixed), run);
  assert.deepEqual(resumePlan({ attest: proof }, true), { attest: false, installer: true });
  assert.throws(() => resumePlan({ attest: proof }, false), /requires installer-approved/);
  assert.deepEqual(
    resumePlan({ attest: proof, installer: { ...proof, stage: 'installer' } }, false),
    { attest: false, installer: false },
  );
});

test('unknown inputs invalidate acceptance as a group, while unrelated prose preserves it', () => {
  assert.notEqual(
    stageInputs('installer', files),
    stageInputs('installer', { ...files, 'unknown.config': 'changed' }),
  );
  assert.equal(
    stageInputs('installer', files),
    stageInputs('installer', { ...files, 'docs/guide.md': 'changed' }),
  );
  assert.notEqual(
    stageInputs('installer', files),
    stageInputs('installer', { ...files, 'package-lock.json': 'new dependency' }),
  );
  assert.equal(
    stageInputs('installer', files),
    stageInputs('installer', {
      ...files,
      'scripts/release/finalize.ts': 'fixed partial upload',
      'test/unit/tooling/finalize.test.ts': 'regression',
    }),
  );
});

test('substituted run, attempt, SHA, stage, inputs or candidate hash cannot authorize reuse', () => {
  validateOrigin(run, '456', 'owner/app');
  for (const patch of [
    { candidateId: '123:2' },
    { candidateHash: '0'.repeat(64) },
    { runId: '999' },
    { attempt: '3' },
    { attempt: '0' },
    { toolsSha: 'c'.repeat(40) },
    { workflow: '.github/workflows/installer.yml' },
    { stage: 'installer' as const },
    { inputs: 'bad' },
  ])
    assert.throws(() =>
      validateEvidence({ ...proof, ...patch }, 'attest', id, hash, proof.inputs, run),
    );
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

test('a newer failed attempt invalidates its own stage while independent success survives', () => {
  const jobs = [
    { id: 1, name: 'release / attest', conclusion: 'success' },
    { id: 2, name: 'release / acceptance / installer', conclusion: 'success' },
  ];
  for (const conclusion of ['failure', 'cancelled', 'timed_out', null]) {
    const retried = [...jobs, { id: 3, name: 'release / acceptance / installer', conclusion }];
    assert.equal(latestStageSuccess(retried, 'acceptance / installer'), false);
    assert.equal(latestStageSuccess(retried, 'attest'), true);
  }
  assert.equal(
    latestStageSuccess(
      [...jobs, { id: 3, name: 'release / attest', conclusion: 'skipped' }],
      'attest',
    ),
    true,
  );
});

test('fixing only the Installer workflow job preserves the attestation fingerprint', () => {
  const before =
    'on:\n  workflow_call:\njobs:\n  attest:\n    run: attest\n  acceptance:\n    run: broken\n  next:\n    run: later\n';
  const after = before.replace('run: broken', 'run: fixed');
  assert.equal(workflowInputs(before, 'attest'), workflowInputs(after, 'attest'));
  assert.notEqual(workflowInputs(before, 'installer'), workflowInputs(after, 'installer'));
  assert.equal(workflowInputs('unknown YAML shape', 'attest'), 'unknown YAML shape');
  assert.equal(
    stageInputs('attest', files),
    stageInputs('attest', { ...files, '.github/workflows/installer.yml': 'fixed' }),
  );
});

test('an uploaded manual record stays pending until its recording job succeeds', () => {
  const manual = {
    sha: 'a'.repeat(40),
    candidateHash: hash,
    tester: 'owner',
    checkedAt: '2026-01-01T00:00:00Z',
    results: Object.fromEntries(
      MANUAL_CHECKS.map((name) => [
        name,
        { result: 'passed', evidence: 'Checked on the candidate' },
      ]),
    ),
  };
  const record = { runId: '456', attempt: '1', candidateId: id, manual };
  assert.equal(validateManualRecord(record, id, manual.sha, hash, run, null), undefined);
  assert.deepEqual(validateManualRecord(record, id, manual.sha, hash, run, 'success'), manual);
  for (const conclusion of ['failure', 'cancelled', 'skipped'])
    assert.throws(() => validateManualRecord(record, id, manual.sha, hash, run, conclusion));
  assert.throws(() =>
    validateManualRecord({ ...record, candidateId: '123:2' }, id, manual.sha, hash, run, 'success'),
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
  await assert.rejects(requireJob('123', '1', 'attest'), /Missing or ambiguous/);
  for (const conclusion of ['skipped', 'failure', 'cancelled', null]) {
    body = { jobs: [{ name: 'release / attest', conclusion }] };
    await assert.rejects(requireJob('123', '1', 'attest'), /did not succeed/);
  }
  body = { jobs: [{ name: 'release / attest', conclusion: 'success' }] };
  await requireJob('123', '1', 'attest');
});
