import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  DESKTOP_SCENARIOS,
  collectDesktopFragments,
  validateDesktopReceipt,
  type DesktopReceipt,
} from '../../../scripts/release/desktop-receipt.ts';
import {
  findOrDispatchDesktop,
  validateDesktopJobs,
  verifyDesktopRun,
} from '../../../scripts/release/desktop-check.ts';
import { MANUAL_CHECKS } from '../../../scripts/release/finalize.ts';
import {
  resumePlan,
  workflowInputs,
  type Evidence,
} from '../../../scripts/release/validate-candidate.ts';

const run = {
  id: 456,
  run_attempt: 2,
  head_sha: 'a'.repeat(40),
  head_branch: 'master',
  path: '.github/workflows/candidate-acceptance.yml',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  display_title: `Desktop 321 123:1 ${'b'.repeat(40)} ${'a'.repeat(40)}`,
};
const receipt: DesktopReceipt = {
  schema: 1,
  candidateId: '123:1',
  candidateHash: 'c'.repeat(64),
  applicationSha: 'd'.repeat(40),
  parentRunId: '321',
  publicToolsSha: 'b'.repeat(40),
  toolsSha: run.head_sha,
  runId: '456',
  attempt: '2',
  results: DESKTOP_SCENARIOS.map((scenario) => ({
    scenario,
    status: 'passed',
    exitCode: 0,
    disposable: true,
    webView2: '156.0.4314.58',
  })),
};
const jobs = [...DESKTOP_SCENARIOS.map((scenario) => `desktop (${scenario})`), 'receipt'].map(
  (name, index) => ({ id: index + 1, name, conclusion: 'success' }),
);

test('desktop acceptance requires all three real scenarios bound to the exact candidate and tool runs', () => {
  validateDesktopReceipt(receipt, receipt, run);
  for (const patch of [
    { candidateId: '123:2' },
    { candidateHash: 'e'.repeat(64) },
    { applicationSha: 'e'.repeat(40) },
    { parentRunId: '999' },
    { publicToolsSha: 'e'.repeat(40) },
    { toolsSha: 'e'.repeat(40) },
    { runId: '999' },
    { attempt: '1' },
    { results: receipt.results.slice(1) },
    { results: [...receipt.results, receipt.results[0]!] },
    ...['failed', 'not-run', 'manual-required'].map((status) => ({
      results: receipt.results.map((result) => ({ ...result, status })),
    })),
    ...[{ exitCode: 1 }, { disposable: false }, { webView2: 'unknown' }].map((patch) => ({
      results: receipt.results.map((result) => ({ ...result, ...patch })),
    })),
  ])
    assert.throws(() => validateDesktopReceipt({ ...receipt, ...patch }, receipt, run));
  validateDesktopJobs(jobs);
  for (const conclusion of [null, 'failure', 'cancelled', 'skipped'])
    assert.throws(() => validateDesktopJobs([...jobs, { ...jobs[0]!, id: 99, conclusion }]));
});

test('retained desktop evidence needs a trusted successful run, live receipt and unchanged relevant tools', async (t) => {
  const previous = {
    token: process.env.PRIVATE_CHECK_TOKEN,
    config: process.env.PRIVATE_CHECK_CONFIG,
  };
  process.env.PRIVATE_CHECK_TOKEN = 'test';
  process.env.PRIVATE_CHECK_CONFIG = JSON.stringify({ repository: 'owner/tests', ref: 'master' });
  t.after(() => {
    for (const [key, value] of [
      ['PRIVATE_CHECK_TOKEN', previous.token],
      ['PRIVATE_CHECK_CONFIG', previous.config],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  });
  let observedRun = { ...run };
  let expired = false;
  let files: { filename: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    if (input.includes('/compare/')) return Response.json({ status: 'ahead', files });
    if (input.includes('/artifacts?'))
      return Response.json({ total_count: 1, artifacts: [{ name: 'desktop-receipt-2', expired }] });
    if (input.includes('/jobs?')) return Response.json({ jobs });
    return Response.json(observedRun);
  });
  assert.equal(await verifyDesktopRun(receipt), true);
  files = [{ filename: 'docs/acceptance.md' }];
  assert.equal(await verifyDesktopRun(receipt), true);
  files = [{ filename: 'scripts/acceptance/orchestrator.ts' }];
  assert.equal(await verifyDesktopRun(receipt), false);
  files = [];
  expired = true;
  assert.equal(await verifyDesktopRun(receipt), false);
  expired = false;
  for (const patch of [{ conclusion: 'failure' }, { status: 'in_progress' }, { run_attempt: 3 }]) {
    observedRun = { ...run, ...patch };
    assert.equal(await verifyDesktopRun(receipt), false);
  }
  for (const patch of [
    { head_branch: 'untrusted' },
    { event: 'push' },
    { path: '.github/workflows/other.yml' },
  ]) {
    observedRun = { ...run, ...patch };
    await assert.rejects(verifyDesktopRun(receipt));
  }
});

test('Hello and session lock do not block release; automatic desktop acceptance still does', async () => {
  assert.deepEqual(
    [...MANUAL_CHECKS],
    [
      'production-updater-installed',
      'production-updater-portable',
      'native-desktop',
      'filesystem-stand',
    ],
  );
  const proof = {} as Evidence;
  assert.deepEqual(resumePlan({ attest: proof, installer: proof }, false), {
    attest: false,
    installer: false,
    desktop: true,
  });
  assert.deepEqual(resumePlan({ attest: proof, installer: proof, desktop: proof }, false), {
    attest: false,
    installer: false,
    desktop: false,
  });
  const workflow = await readFile(
    new URL('../../../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    workflow,
    /needs: \[candidate, build-windows, attest, acceptance, desktop-acceptance\]/,
  );
  assert.doesNotMatch(workflow, /hello-assisted|windows-hello|vault-lock/);
  const changed = workflow.replace(
    'scripts/release/desktop-check.ts',
    'scripts/release/fixed-desktop.ts',
  );
  assert.notEqual(workflowInputs(workflow, 'desktop'), workflowInputs(changed, 'desktop'));
  assert.equal(workflowInputs(workflow, 'installer'), workflowInputs(changed, 'installer'));
  assert.equal(workflowInputs(workflow, 'attest'), workflowInputs(changed, 'attest'));
});

test('partial desktop retries retain independent successful scenarios without accepting duplicate or foreign fragments', () => {
  const fragments = receipt.results.map((result) => ({
    ...receipt,
    attempt: '1',
    results: [result],
  }));
  const retry = { ...receipt, results: [receipt.results[0]!] };
  assert.deepEqual(
    collectDesktopFragments([...fragments, retry], receipt).results,
    receipt.results,
  );
  for (const invalid of [
    fragments.slice(1),
    [...fragments, fragments[0]!],
    [...fragments, { ...retry, candidateHash: 'e'.repeat(64) }],
    [...fragments, { ...retry, attempt: '3' }],
    [...fragments, { ...retry, results: [{ ...retry.results[0]!, status: 'failed' }] }],
  ])
    assert.throws(() => collectDesktopFragments(invalid, receipt));
});

test('desktop reconnect reuses an active run, but changed private tools get a distinct new run', async () => {
  let dispatched = 0;
  let changed = false;
  const nextSha = 'f'.repeat(40);
  const active = { ...run, status: 'in_progress', conclusion: null };
  const api = async (route: string, body?: unknown) => {
    if (route.startsWith('commits/')) return { sha: nextSha };
    if (route.includes('/runs?')) return { workflow_runs: [active] };
    if (route.startsWith('compare/'))
      return {
        status: 'ahead',
        files: [{ filename: changed ? 'scripts/acceptance/run-vm.ps1' : 'docs/notes.md' }],
      };
    if (route.endsWith('/dispatches')) {
      dispatched++;
      assert.equal(
        (body as { inputs: Record<string, string> }).inputs['candidate-id'],
        receipt.candidateId,
      );
      return { workflow_run_id: 789 };
    }
    if (route === 'actions/runs/789') return { ...active, id: 789, head_sha: nextSha };
    throw new Error(`Unexpected API route ${route}`);
  };
  assert.equal((await findOrDispatchDesktop(api, receipt, 'master', 'owner/app')).id, run.id);
  assert.equal(dispatched, 0);
  changed = true;
  assert.equal((await findOrDispatchDesktop(api, receipt, 'master', 'owner/app')).id, 789);
  assert.equal(dispatched, 1);
});
