import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CheckRun {
  id: number;
  run_attempt: number;
  workflow_id: number;
  head_sha: string;
  head_branch: string;
  event: string;
  display_title: string;
  status: string;
  conclusion: string | null;
}
export interface CheckJob {
  id: number;
  name: string;
  conclusion: string | null;
}
export interface Receipt {
  schema: number;
  repository: string;
  parentRunId: string;
  sha: string;
  testSha: string;
  requiredJobs: string[];
}
export interface ParentCheck {
  repository: string;
  runId: string;
  sha: string;
}
export type Api = (_route: string, _body?: unknown) => Promise<unknown>;

export function checkTitle(parent: ParentCheck): string {
  return `Release check ${parent.repository}/${parent.runId} ${parent.sha}`;
}

export function validatePrivateCheck(
  parent: ParentCheck,
  run: CheckRun,
  workflowId: number,
  receipt: Receipt,
  jobs: CheckJob[],
) {
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.workflow_id, workflowId);
  assert.equal(run.display_title, checkTitle(parent));
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.repository, parent.repository);
  assert.equal(receipt.parentRunId, parent.runId);
  assert.equal(receipt.sha, parent.sha);
  assert.equal(receipt.testSha, run.head_sha);
  assert.match(receipt.testSha, /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(receipt.requiredJobs) && receipt.requiredJobs.length > 0);
  assert.equal(new Set(receipt.requiredJobs).size, receipt.requiredJobs.length);
  const latest = new Map<string, CheckJob>();
  for (const job of jobs) {
    if (job.id > (latest.get(job.name)?.id ?? 0)) latest.set(job.name, job);
  }
  for (const name of receipt.requiredJobs) {
    assert.equal(
      latest.get(name)?.conclusion,
      'success',
      'A mandatory closed check is missing or unsuccessful',
    );
  }
  return {
    runId: run.id,
    attempt: run.run_attempt,
    workflowId,
    testSha: run.head_sha,
    requiredJobCount: receipt.requiredJobs.length,
  };
}

export async function findOrDispatch(
  api: Api,
  parent: ParentCheck,
  workflow: string,
  ref: string,
): Promise<CheckRun> {
  const matches: CheckRun[] = [];
  for (let page = 1; ; page++) {
    const response = (await api(
      `actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100&page=${page}`,
    )) as { workflow_runs: CheckRun[] };
    matches.push(
      ...response.workflow_runs.filter((run) => run.display_title === checkTitle(parent)),
    );
    if (response.workflow_runs.length < 100) break;
    assert.ok(page < 10, 'Too many closed runs to establish an unambiguous parent link');
  }
  assert.ok(matches.length <= 1, 'Multiple closed runs claim the same parent');
  if (matches[0]) return matches[0];
  const commit = (await api(`commits/${encodeURIComponent(ref)}`)) as { sha: string };
  assert.match(commit.sha, /^[0-9a-f]{40}$/);
  const dispatched = (await api(`actions/workflows/${workflow}/dispatches`, {
    ref,
    inputs: { commit: parent.sha, 'public-repo': parent.repository, 'parent-run-id': parent.runId },
  })) as { workflow_run_id: number };
  assert.ok(
    Number.isSafeInteger(dispatched.workflow_run_id),
    'Dispatch did not return an exact run ID; do not dispatch again blindly',
  );
  const run = (await api(`actions/runs/${dispatched.workflow_run_id}`)) as CheckRun;
  assert.equal(run.head_sha, commit.sha, 'Closed workflow changed during dispatch');
  return run;
}

export async function runPrivateCheck() {
  assert.ok(process.env.PRIVATE_CHECK_TOKEN, 'PRIVATE_CHECK_TOKEN is required');
  const config = JSON.parse(process.env.PRIVATE_CHECK_CONFIG ?? '{}') as {
    repository: string;
    workflow: string;
    ref: string;
  };
  assert.match(config.repository ?? '', /^[\w.-]+\/[\w.-]+$/);
  assert.match(config.workflow ?? '', /^[\w.-]+\.ya?ml$/);
  assert.ok(config.ref);
  const parent = {
    repository: process.env.GITHUB_REPOSITORY!,
    runId: process.env.GITHUB_RUN_ID!,
    sha: process.env.GITHUB_SHA!,
  };
  assert.match(parent.sha, /^[0-9a-f]{40}$/);
  assert.match(parent.runId, /^[1-9][0-9]*$/);
  const api: Api = async (route, body) => {
    const response = await fetch(`https://api.github.com/repos/${config.repository}/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PRIVATE_CHECK_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `Closed check API failed (HTTP ${response.status})`);
    return response.json();
  };
  const workflow = (await api(`actions/workflows/${config.workflow}`)) as { id: number };
  let run = await findOrDispatch(api, parent, config.workflow, config.ref);
  assert.equal(run.head_branch, config.ref, 'Closed check did not run on the trusted ref');
  const deadline = Date.now() + 5 * 60 * 60 * 1000;
  while (run.status !== 'completed') {
    assert.ok(Date.now() < deadline, 'Closed check timed out; rerun this waiting job to reconnect');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    run = (await api(`actions/runs/${run.id}`)) as CheckRun;
  }
  assert.equal(
    run.conclusion,
    'success',
    'Closed check failed; rerun only its failed jobs, then this waiting job',
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'release-check-'));
  try {
    execFileSync(
      'gh',
      [
        'run',
        'download',
        String(run.id),
        '--repo',
        config.repository,
        '--name',
        `release-check-${run.run_attempt}`,
        '--dir',
        directory,
      ],
      {
        env: { ...process.env, GH_TOKEN: process.env.PRIVATE_CHECK_TOKEN },
        stdio: 'pipe',
        timeout: 60_000,
      },
    );
  } catch {
    throw new Error('The exact closed-check receipt is missing, expired or unreadable');
  }
  const receipt = JSON.parse(
    await readFile(path.join(directory, 'release-check.json'), 'utf8'),
  ) as Receipt;
  const jobs: CheckJob[] = [];
  for (let page = 1; ; page++) {
    const response = (await api(
      `actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`,
    )) as { jobs: CheckJob[] };
    jobs.push(...response.jobs);
    if (response.jobs.length < 100) break;
  }
  const current = (await api(`actions/runs/${run.id}`)) as CheckRun;
  assert.equal(
    current.run_attempt,
    run.run_attempt,
    'Closed check was retried during verification',
  );
  assert.equal(current.status, 'completed');
  assert.equal(current.conclusion, 'success');
  const evidence = validatePrivateCheck(parent, run, workflow.id, receipt, jobs);
  await writeFile('private-check.json', JSON.stringify(evidence, null, 2));
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY!,
    `Closed checks passed: run ${run.id}, attempt ${run.run_attempt}, tests ${run.head_sha}.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Private API errors and child logs must not reach the public log.
  try {
    await runPrivateCheck();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Closed check failed');
    process.exitCode = 1;
  }
}
