import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseCheck } from './check-mode.ts';
import { runPrivateCheck, type PrivateEvidence } from './private-check.ts';

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
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.match(run.head_sha, /^[0-9a-f]{40}$/);
  assert.equal(proof.schema, 1);
  assert.equal(proof.repository, repository);
  assert.equal(proof.runId, id);
  assert.equal(proof.attempt, String(run.run_attempt));
  assert.equal(proof.sha, run.head_sha);
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

export async function githubApi(route: string, body?: unknown): Promise<unknown> {
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
  assert.ok(response.ok, `GitHub API request failed: HTTP ${response.status}`);
  return response.json();
}

export async function verifyReadiness(id: string): Promise<Readiness> {
  assert.match(id, /^[1-9][0-9]*$/);
  const run = (await githubApi(`actions/runs/${id}`)) as PublicRun;
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
  await runPrivateCheck({
    parent: { repository: proof.repository, runId: proof.runId, sha: proof.sha },
    expected: proof.privateCheck,
  });
  const current = (await githubApi(`actions/runs/${id}`)) as PublicRun;
  validateReadiness(proof.repository, id, current, proof);
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(
    process.env.GITHUB_REF,
    'refs/heads/master',
    'Packaging can only be dispatched on master',
  );
  const proof = await verifyReadiness(process.env.CHECK_RUN_ID!);
  await writeFile('release-readiness.json', JSON.stringify(proof, null, 2));
  await appendFile(process.env.GITHUB_OUTPUT!, `sha=${proof.sha}\nversion=${proof.version}\n`);
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY!,
    `Candidate v${proof.version}, source ${proof.sha}, verified CI run ${proof.runId}, attempt ${proof.attempt}.\n`,
  );
}
