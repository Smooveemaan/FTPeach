import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseCheck } from './check-mode.ts';
import { runPrivateCheck, type CheckJob, type PrivateEvidence } from './private-check.ts';

export interface Readiness {
  schema: number;
  repository: string;
  runId: string;
  attempt: string;
  sha: string;
  version: string;
  packages: string[];
  privateCheck: PrivateEvidence;
}
export interface PublicRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  path: string;
  status: string;
  conclusion: string | null;
  head_commit: { message: string };
  head_repository: { full_name: string };
}
export const WINDOWS_PACKAGES = ['windows-x86_64-nsis', 'windows-x86_64-portable'];
const SOURCE_JOBS = ['mode', 'private-check', 'release-ready', 'checks / full-result'];

export function validateSourceJobs(jobs: CheckJob[]) {
  const latest = new Map<string, CheckJob>();
  for (const job of jobs) {
    if (!SOURCE_JOBS.includes(job.name) && !job.name.startsWith('checks / ')) continue;
    if (job.id > (latest.get(job.name)?.id ?? 0)) latest.set(job.name, job);
  }
  for (const name of SOURCE_JOBS)
    assert.ok(latest.has(name), `Mandatory source check ${name} is missing`);
  for (const job of latest.values())
    assert.equal(job.conclusion, 'success', `Source check ${job.name} is not successful`);
}

export function requireUnusedVersion(tag: unknown, release: unknown) {
  assert.equal(
    tag,
    null,
    'This version is already tagged; resume the accepted candidate instead of rebuilding',
  );
  assert.equal(release, null, 'This version already has a release or draft');
}

export function validateReadiness(
  repository: string,
  id: string,
  run: PublicRun,
  proof: Readiness,
) {
  assert.match(id, /^[1-9][0-9]*$/);
  assert.equal(String(run.id), id);
  assert.equal(run.head_repository.full_name.toLowerCase(), repository.toLowerCase());
  assert.equal(run.path, '.github/workflows/ci.yml');
  assert.equal(run.head_branch, 'master');
  assert.equal(
    releaseCheck(run.event, 'refs/heads/master', run.head_commit.message),
    true,
    'An ordinary CI run is not release readiness',
  );
  assert.match(run.head_sha, /^[0-9a-f]{40}$/);
  assert.equal(proof.schema, 1);
  assert.equal(proof.repository, repository);
  assert.equal(proof.runId, id);
  assert.equal(proof.attempt, String(run.run_attempt));
  assert.equal(proof.sha, run.head_sha);
  assert.ok(proof.privateCheck, 'The exact closed-check evidence is required');
  assert.match(proof.version, /^\d+\.\d+\.\d+$/);
  assert.match(
    proof.version,
    /^0\.6\.\d+$/,
    'The multi-platform release matrix must be implemented before 0.7.0',
  );
  assert.deepEqual(
    proof.packages,
    WINDOWS_PACKAGES,
    'The packaging matrix does not match the checked matrix',
  );
  return proof;
}

export async function githubApi(
  route: string,
  body?: unknown,
  allowMissing = false,
): Promise<unknown> {
  assert.ok(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN is required');
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${route}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (allowMissing && response.status === 404) return null;
  assert.ok(response.ok, `GitHub API request failed: HTTP ${response.status}`);
  return response.json();
}

export async function verifyReadiness(id: string, expected?: Readiness): Promise<Readiness> {
  assert.match(id, /^[1-9][0-9]*$/);
  const currentAtStart = (await githubApi(`actions/runs/${id}`)) as PublicRun;
  if (expected) assert.match(expected.attempt, /^[1-9][0-9]*$/);
  const run = expected
    ? ((await githubApi(`actions/runs/${id}/attempts/${expected.attempt}`)) as PublicRun)
    : currentAtStart;
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  async function jobsFor(route: string): Promise<CheckJob[]> {
    const jobs: CheckJob[] = [];
    for (let page = 1; ; page++) {
      const response = (await githubApi(
        `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      )) as {
        jobs: CheckJob[];
      };
      jobs.push(...response.jobs);
      if (response.jobs.length < 100) return jobs;
    }
  }
  async function validateCurrent(current: PublicRun) {
    assert.equal(current.id, run.id);
    assert.equal(current.head_sha, run.head_sha);
    assert.ok(current.run_attempt >= run.run_attempt);
    validateSourceJobs(await jobsFor(`actions/runs/${id}/jobs?filter=all`));
  }
  // A failed-job retry retains successful source jobs from earlier attempts.
  const selectedJobs: CheckJob[] = [];
  for (let attempt = run.run_attempt; attempt >= 1; attempt--) {
    selectedJobs.push(...(await jobsFor(`actions/runs/${id}/attempts/${attempt}/jobs`)));
    if (SOURCE_JOBS.every((name) => selectedJobs.some((job) => job.name === name))) break;
  }
  validateSourceJobs(selectedJobs);
  await validateCurrent(currentAtStart);
  const directory = await mkdtemp(path.join(tmpdir(), 'release-readiness-'));
  execFileSync(
    'gh',
    [
      'run',
      'download',
      id,
      '--repo',
      process.env.GITHUB_REPOSITORY!,
      '--name',
      `release-readiness-${run.run_attempt}`,
      '--dir',
      directory,
    ],
    {
      env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
      stdio: 'pipe',
      timeout: 60_000,
    },
  );
  const proof = validateReadiness(
    process.env.GITHUB_REPOSITORY!,
    id,
    run,
    JSON.parse(await readFile(path.join(directory, 'release-readiness.json'), 'utf8')) as Readiness,
  );
  if (expected) assert.deepEqual(proof, expected);
  await runPrivateCheck({
    parent: { repository: proof.repository, runId: proof.runId, sha: proof.sha },
    expected: proof.privateCheck,
  });
  const current = (await githubApi(`actions/runs/${id}`)) as PublicRun;
  assert.equal(
    current.run_attempt,
    currentAtStart.run_attempt,
    'Source workflow was retried during readiness validation',
  );
  await validateCurrent(current);
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(
    process.env.GITHUB_REF,
    'refs/heads/master',
    'Packaging can only be dispatched on master',
  );
  const proof = await verifyReadiness(process.env.CHECK_RUN_ID!);
  if (!process.env.CANDIDATE_RUN_ID) {
    requireUnusedVersion(
      await githubApi(`git/ref/tags/v${proof.version}`, undefined, true),
      await githubApi(`releases/tags/v${proof.version}`, undefined, true),
    );
  }
  await writeFile('release-readiness.json', JSON.stringify(proof, null, 2));
  await appendFile(process.env.GITHUB_OUTPUT!, `sha=${proof.sha}\nversion=${proof.version}\n`);
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY!,
    `Candidate v${proof.version}, source ${proof.sha}, verified CI run ${proof.runId}, attempt ${proof.attempt}.\n`,
  );
}
