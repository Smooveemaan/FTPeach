import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  candidateNames,
  githubApi,
  requireUnusedVersion,
  sha256,
  verifyCandidate,
  type Candidate,
  type Readiness,
} from '../../../scripts/release/candidate.ts';

test('candidate hashes bind every final file; damaged or missing packages are rejected', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
  const files = Object.fromEntries(candidateNames('0.6.1').map((name) => [name, sha256(name)]));
  for (const name of Object.keys(files)) await writeFile(path.join(directory, name), name);
  const candidate: Candidate = {
    schema: 1,
    readiness: { sha: 'a'.repeat(40), version: '0.6.1', repository: 'owner/app' } as Readiness,
    build: { runId: '123', attempt: '1', workflowSha: 'b'.repeat(40), tools: {} },
    files,
  };
  await writeFile(path.join(directory, 'candidate.json'), JSON.stringify(candidate));
  assert.deepEqual(await verifyCandidate(directory), candidate);
  await writeFile(path.join(directory, candidateNames('0.6.1')[0]!), 'damaged');
  await assert.rejects(verifyCandidate(directory), /Candidate file changed/);
});

test('a version already taken by a tag or draft cannot start another packaging build', () => {
  requireUnusedVersion(null, null);
  assert.throws(() => requireUnusedVersion({ object: { sha: 'a'.repeat(40) } }, null));
  assert.throws(() => requireUnusedVersion(null, { draft: true }));
});

test('temporary GitHub gateway failures retry GET but not POST', async (t) => {
  const previousToken = process.env.GITHUB_TOKEN;
  const previousRepo = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_TOKEN = 'token';
  process.env.GITHUB_REPOSITORY = 'owner/app';
  t.after(() => {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    if (previousRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepo;
  });
  let calls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string | URL | Request, init?: { body?: unknown }) => {
      calls++;
      const failed = calls === 1 || init?.body !== undefined;
      return new Response(failed ? null : '{}', { status: failed ? 502 : 200 });
    },
  );
  assert.deepEqual(await githubApi('actions/runs/123'), {});
  assert.equal(calls, 2);
  await assert.rejects(githubApi('actions/runs/123', {}), /HTTP 502/);
  assert.equal(calls, 3);
});

test('candidate records source and workflow commits and rejects source checkout mismatch', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'candidate-checkouts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  await mkdir(source, { recursive: true });
  const script = fileURLToPath(new URL('../../../scripts/release/candidate.ts', import.meta.url));
  await writeFile(path.join(source, 'package.json'), '{"version":"0.6.1","type":"module"}');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', 'package.json');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  const sourceSha = git('rev-parse', 'HEAD');
  const workflowSha = 'b'.repeat(40);
  await mkdir(path.join(source, 'release-candidate'));
  for (const name of candidateNames('0.6.1')) {
    await writeFile(path.join(source, 'release-candidate', name), name);
  }
  const run = (shaEnv: string) =>
    spawnSync(process.execPath, ['--experimental-strip-types', script], {
      cwd: source,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'owner/app',
        GITHUB_SHA: shaEnv,
        GITHUB_WORKFLOW_SHA: workflowSha,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md'),
      },
    });
  const success = run(sourceSha);
  assert.equal(success.status, 0, success.stderr);
  const candidate = await verifyCandidate(path.join(source, 'release-candidate'));
  assert.equal(candidate.readiness.sha, sourceSha);
  assert.equal(candidate.build.workflowSha, workflowSha);
  await rm(path.join(source, 'release-candidate/candidate.json'));
  const wrongSource = run(workflowSha);
  assert.notEqual(wrongSource.status, 0);
  assert.match(wrongSource.stderr, /build checkout is not the checked candidate/);
});
