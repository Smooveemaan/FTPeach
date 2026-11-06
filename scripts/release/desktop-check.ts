import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DESKTOP_SCENARIOS,
  validateDesktopReceipt,
  type DesktopReceipt,
} from './desktop-receipt.ts';
import type { CheckRun, CheckJob, Api } from './private-check.ts';

function connection() {
  const config = JSON.parse(process.env.PRIVATE_CHECK_CONFIG ?? '{}') as {
    repository: string;
    ref: string;
  };
  assert.match(config.repository ?? '', /^[\w.-]+\/[\w.-]+$/);
  assert.ok(config.ref);
  assert.ok(process.env.PRIVATE_CHECK_TOKEN);
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
    assert.ok(response.ok, `Desktop acceptance API failed (HTTP ${response.status})`);
    return response.json();
  };
  return { config, api };
}

export function validateDesktopJobs(jobs: CheckJob[]) {
  const latest = new Map<string, CheckJob>();
  for (const job of jobs) if (job.id > (latest.get(job.name)?.id ?? 0)) latest.set(job.name, job);
  for (const name of [...DESKTOP_SCENARIOS.map((scenario) => `desktop (${scenario})`), 'receipt'])
    assert.equal(
      latest.get(name)?.conclusion,
      'success',
      `Desktop acceptance job did not pass: ${name}`,
    );
}

export async function verifyDesktopRun(receipt: DesktopReceipt): Promise<boolean> {
  const { config, api } = connection();
  const run = (await api(`actions/runs/${receipt.runId}`)) as CheckRun & { path: string };
  assert.equal(run.path, '.github/workflows/candidate-acceptance.yml');
  assert.equal(run.head_branch, config.ref);
  assert.equal(run.event, 'workflow_dispatch');
  if (
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.run_attempt !== Number(receipt.attempt)
  )
    return false;
  validateDesktopReceipt(receipt, receipt, run);
  assert.equal(
    run.display_title,
    `Desktop ${receipt.parentRunId} ${receipt.candidateId} ${receipt.publicToolsSha} ${receipt.toolsSha}`,
  );
  const jobs: CheckJob[] = [];
  for (let page = 1; ; page++) {
    const response = (await api(
      `actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`,
    )) as { jobs: CheckJob[] };
    jobs.push(...response.jobs);
    if (response.jobs.length < 100) break;
  }
  validateDesktopJobs(jobs);
  const artifacts = (await api(`actions/runs/${run.id}/artifacts?per_page=100`)) as {
    total_count: number;
    artifacts: { name: string; expired: boolean }[];
  };
  assert.ok(artifacts.total_count <= 100);
  if (
    !artifacts.artifacts.some(
      (artifact) => artifact.name === `desktop-receipt-${run.run_attempt}` && !artifact.expired,
    )
  )
    return false;
  return desktopToolsUnchanged(api, run.head_sha, config.ref);
}

export async function desktopToolsUnchanged(api: Api, from: string, to: string): Promise<boolean> {
  const comparison = (await api(`compare/${from}...${encodeURIComponent(to)}`)) as {
    status: string;
    files: { filename: string }[];
  };
  assert.ok(
    ['ahead', 'identical'].includes(comparison.status),
    'Desktop tools are not on the trusted history',
  );
  assert.ok(comparison.files.length < 300, 'Desktop tools comparison is incomplete');
  return !comparison.files.some(
    ({ filename }) => !/^(docs\/|workspace-local\/|test\/)|\.md$/.test(filename),
  );
}

export async function findOrDispatchDesktop(
  api: Api,
  expected: Pick<
    DesktopReceipt,
    'candidateId' | 'candidateHash' | 'applicationSha' | 'parentRunId' | 'publicToolsSha'
  >,
  ref: string,
  repository: string,
): Promise<CheckRun> {
  const workflow = 'candidate-acceptance.yml';
  const title = `Desktop ${expected.parentRunId} ${expected.candidateId} ${expected.publicToolsSha}`;
  const commit = (await api(`commits/${encodeURIComponent(ref)}`)) as { sha: string };
  assert.match(commit.sha, /^[0-9a-f]{40}$/);
  const matches: CheckRun[] = [];
  for (let page = 1; ; page++) {
    const response = (await api(
      `actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100&page=${page}`,
    )) as { workflow_runs: CheckRun[] };
    for (const found of response.workflow_runs) {
      if (found.display_title !== `${title} ${found.head_sha}`) continue;
      if (
        found.head_sha === commit.sha ||
        (await desktopToolsUnchanged(api, found.head_sha, commit.sha))
      )
        matches.push(found);
    }
    if (response.workflow_runs.length < 100) break;
    assert.ok(page < 10);
  }
  assert.ok(matches.length <= 1, 'Ambiguous desktop acceptance run');
  let run = matches[0];
  if (!run) {
    const dispatched = (await api(`actions/workflows/${workflow}/dispatches`, {
      ref,
      inputs: {
        'parent-run-id': expected.parentRunId,
        'candidate-id': expected.candidateId,
        'candidate-hash': expected.candidateHash,
        'application-sha': expected.applicationSha,
        'public-tools-sha': expected.publicToolsSha,
        'public-repo': repository,
      },
    })) as { workflow_run_id: number };
    assert.ok(
      Number.isSafeInteger(dispatched.workflow_run_id),
      'No exact desktop run ID; reconnect instead of dispatching blindly',
    );
    run = (await api(`actions/runs/${dispatched.workflow_run_id}`)) as CheckRun;
    assert.equal(run.head_sha, commit.sha);
  }
  return run;
}

export async function runDesktopCheck(
  expected: Pick<
    DesktopReceipt,
    'candidateId' | 'candidateHash' | 'applicationSha' | 'parentRunId' | 'publicToolsSha'
  >,
): Promise<DesktopReceipt> {
  const { config, api } = connection();
  let run = await findOrDispatchDesktop(api, expected, config.ref, process.env.GITHUB_REPOSITORY!);
  const deadline = Date.now() + 90 * 60_000;
  while (run.status !== 'completed') {
    assert.ok(
      Date.now() < deadline,
      'Desktop acceptance timed out; rerun the waiting job to reconnect',
    );
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    run = (await api(`actions/runs/${run.id}`)) as CheckRun;
  }
  assert.equal(
    run.conclusion,
    'success',
    'Desktop acceptance failed; inspect diagnostics and rerun affected jobs',
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'release-desktop-'));
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
        `desktop-receipt-${run.run_attempt}`,
        '--dir',
        directory,
      ],
      {
        env: { ...process.env, GH_TOKEN: process.env.PRIVATE_CHECK_TOKEN },
        stdio: 'pipe',
        timeout: 120_000,
      },
    );
  } catch {
    throw new Error('The desktop receipt is missing, expired or unreadable');
  }
  const receipt = JSON.parse(
    await readFile(path.join(directory, 'receipt.json'), 'utf8'),
  ) as DesktopReceipt;
  validateDesktopReceipt(receipt, expected, run);
  assert.equal(
    await verifyDesktopRun(receipt),
    true,
    'Desktop acceptance tools changed; a new acceptance run is required',
  );
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { validateCandidate, recordEvidence } = await import('./validate-candidate.ts');
    const result = await validateCandidate(process.env.CANDIDATE_ID!);
    assert.ok(result.installer, 'Installer acceptance must pass first');
    const receipt = await runDesktopCheck({
      candidateId: process.env.CANDIDATE_ID!,
      candidateHash: result.hash,
      applicationSha: result.candidate.readiness.sha,
      parentRunId: process.env.GITHUB_RUN_ID!,
      publicToolsSha: process.env.GITHUB_WORKFLOW_SHA!,
    });
    await writeFile('desktop-receipt.json', JSON.stringify(receipt));
    await recordEvidence('desktop', result.candidate, result.hash, receipt);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Desktop acceptance failed');
    process.exitCode = 1;
  }
}
