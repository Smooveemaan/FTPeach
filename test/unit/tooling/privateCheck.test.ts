import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkTitle,
  assertCurrentSuccess,
  findOrDispatch,
  validatePrivateCheck,
  type Api,
  type CheckRun,
  type Receipt,
} from '../../../scripts/release/private-check.ts';

const parent = { repository: 'owner/app', runId: '123', sha: 'a'.repeat(40) };
const run: CheckRun = {
  id: 456,
  run_attempt: 2,
  workflow_id: 7,
  head_sha: 'b'.repeat(40),
  head_branch: 'main',
  event: 'workflow_dispatch',
  display_title: checkTitle(parent),
  status: 'completed',
  conclusion: 'success',
};
const receipt: Receipt = {
  schema: 1,
  repository: parent.repository,
  parentRunId: parent.runId,
  sha: parent.sha,
  testSha: run.head_sha,
  requiredJobs: ['suite', 'report'],
};
const jobs = [
  { id: 1, name: 'suite', conclusion: 'failure' },
  { id: 2, name: 'suite', conclusion: 'success' },
  { id: 3, name: 'report', conclusion: 'success' },
];

test('a successful later attempt preserves selected evidence; failures or in-progress retries block it', () => {
  assertCurrentSuccess({ ...run, run_attempt: 3 }, run);
  for (const patch of [
    { run_attempt: 1 },
    { head_sha: 'd'.repeat(40) },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
  ]) {
    assert.throws(() => assertCurrentSuccess({ ...run, ...patch }, run));
  }
});

test('a failed-job retry retains earlier successful results and binds exact identities', () => {
  assert.deepEqual(validatePrivateCheck(parent, run, 7, receipt, jobs), {
    runId: 456,
    attempt: 2,
    workflowId: 7,
    testSha: run.head_sha,
    requiredJobCount: 2,
  });
});
test('a green report cannot replace missing or failed mandatory jobs', () => {
  for (const conclusion of ['failure', 'skipped', 'cancelled', null]) {
    assert.throws(() =>
      validatePrivateCheck(parent, run, 7, receipt, [
        { id: 4, name: 'suite', conclusion },
        jobs[2]!,
      ]),
    );
  }
  assert.throws(() => validatePrivateCheck(parent, run, 7, receipt, [jobs[2]!]));
  assert.throws(() => validatePrivateCheck(parent, run, 7, { ...receipt, requiredJobs: [] }, jobs));
});
test('substituted parent, workflow, commit, tests or unsuccessful run is rejected', () => {
  for (const patch of [
    { workflow_id: 8 },
    { event: 'push' },
    { display_title: 'another parent' },
    { head_sha: 'c'.repeat(40) },
    { status: 'in_progress' },
    { conclusion: 'failure' },
  ]) {
    assert.throws(() => validatePrivateCheck(parent, { ...run, ...patch }, 7, receipt, jobs));
  }
  for (const patch of [
    { sha: 'c'.repeat(40) },
    { parentRunId: '999' },
    { repository: 'another/app' },
  ]) {
    assert.throws(() => validatePrivateCheck(parent, run, 7, { ...receipt, ...patch }, jobs));
  }
});
test('reconnecting after a public retry never dispatches the same private suite twice', async () => {
  const api: Api = async (_route, body) => {
    assert.equal(body, undefined);
    return { workflow_runs: [run] };
  };
  assert.equal((await findOrDispatch(api, parent, 'checks.yml', 'main')).id, run.id);
});
test('first dispatch pins private source and uses the exact returned child ID', async () => {
  const calls: string[] = [];
  const api: Api = async (route, body) => {
    calls.push(route);
    if (route.includes('/runs?')) return { workflow_runs: [] };
    if (route.startsWith('commits/')) return { sha: run.head_sha };
    if (route.endsWith('/dispatches')) {
      assert.deepEqual(body, {
        ref: 'main',
        inputs: { commit: parent.sha, 'public-repo': parent.repository, 'parent-run-id': '123' },
      });
      return { workflow_run_id: 456 };
    }
    assert.equal(route, 'actions/runs/456');
    return run;
  };
  assert.equal((await findOrDispatch(api, parent, 'checks.yml', 'main')).head_sha, run.head_sha);
  assert.equal(calls.length, 4);
});
test('ambiguous duplicate children and a ref moving during dispatch fail closed', async () => {
  await assert.rejects(
    findOrDispatch(async () => ({ workflow_runs: [run, run] }), parent, 'checks.yml', 'main'),
  );
  const api: Api = async (route) =>
    route.includes('/runs?')
      ? { workflow_runs: [] }
      : route.startsWith('commits/')
        ? { sha: 'c'.repeat(40) }
        : route.endsWith('/dispatches')
          ? { workflow_run_id: 456 }
          : run;
  await assert.rejects(findOrDispatch(api, parent, 'checks.yml', 'main'));
});
