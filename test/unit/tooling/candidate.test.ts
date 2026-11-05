import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  candidateNames,
  provenance,
  sha256,
  verifyCandidate,
  type Candidate,
} from '../../../scripts/release/candidate.ts';
import type { Readiness } from '../../../scripts/release/verify-readiness.ts';

const provenanceEnv = {
  GITHUB_WORKFLOW_REF: 'owner/app/.github/workflows/release-next.yml@refs/heads/master',
  GITHUB_REPOSITORY_ID: '123',
  GITHUB_REPOSITORY_OWNER_ID: '456',
  RUNNER_ENVIRONMENT: 'github-hosted',
};

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
  const predicate = provenance(candidate, provenanceEnv);
  assert.deepEqual(predicate.buildDefinition.internalParameters.github, {
    event_name: 'workflow_dispatch',
    repository_id: '123',
    repository_owner_id: '456',
    runner_environment: 'github-hosted',
  });
  for (const name of Object.keys(provenanceEnv)) {
    assert.throws(
      () => provenance(candidate, { ...provenanceEnv, [name]: '' }),
      new RegExp(`Provenance requires ${name}`),
    );
  }
  assert.throws(() => provenance(candidate, { ...provenanceEnv, RUNNER_ENVIRONMENT: 'unknown' }));
  assert.equal(predicate.buildDefinition.resolvedDependencies[0]?.digest.gitCommit, 'a'.repeat(40));
  assert.equal(predicate.buildDefinition.resolvedDependencies[1]?.digest.gitCommit, 'b'.repeat(40));
  await writeFile(path.join(directory, candidateNames('0.6.1')[0]!), 'damaged');
  await assert.rejects(verifyCandidate(directory), /Candidate file changed/);
});

test('candidate records separate source and tool commits and rejects either checkout mismatch', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'candidate-checkouts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const tools = path.join(source, '.release-tools');
  await mkdir(path.join(tools, 'scripts/release'), { recursive: true });
  const script = path.join(tools, 'scripts/release/candidate.ts');
  await copyFile(new URL('../../../scripts/release/candidate.ts', import.meta.url), script);
  await writeFile(path.join(source, 'package.json'), '{"version":"0.6.1","type":"module"}');
  const commit = (cwd: string, file: string) => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('add', file);
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
    return git('rev-parse', 'HEAD');
  };
  const sourceSha = commit(source, 'package.json');
  const toolsSha = commit(tools, 'scripts/release/candidate.ts');
  const readiness = { sha: sourceSha, version: '0.6.1', repository: 'owner/app' };
  await writeFile(path.join(source, 'release-readiness.json'), JSON.stringify(readiness));
  await mkdir(path.join(source, 'release'));
  await mkdir(path.join(source, 'release-candidate'));
  for (const name of candidateNames('0.6.1')) {
    await writeFile(path.join(source, 'release-candidate', name), name);
  }
  const run = (workflowSha: string) =>
    spawnSync(process.execPath, ['--experimental-strip-types', script], {
      cwd: source,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...provenanceEnv,
        GITHUB_WORKFLOW_SHA: workflowSha,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md'),
      },
    });
  const success = run(toolsSha);
  assert.equal(success.status, 0, success.stderr);
  const candidate = await verifyCandidate(path.join(source, 'release-candidate'));
  assert.equal(candidate.readiness.sha, sourceSha);
  assert.equal(candidate.build.workflowSha, toolsSha);
  await rm(path.join(source, 'release-candidate/candidate.json'));
  const wrongTools = run(sourceSha);
  assert.notEqual(wrongTools.status, 0);
  assert.match(wrongTools.stderr, /tools must come from the pinned build workflow commit/);
  await writeFile(
    path.join(source, 'release-readiness.json'),
    JSON.stringify({ ...readiness, sha: toolsSha }),
  );
  const wrongSource = run(toolsSha);
  assert.notEqual(wrongSource.status, 0);
  assert.match(wrongSource.stderr, /build checkout is not the checked candidate/);
  const predicate = JSON.parse(
    await readFile(path.join(source, 'release/provenance.json'), 'utf8'),
  );
  assert.equal(
    predicate.buildDefinition.internalParameters.github.runner_environment,
    'github-hosted',
  );
  assert.deepEqual(
    predicate.buildDefinition.resolvedDependencies.map(
      (entry: { digest: { gitCommit: string } }) => entry.digest.gitCommit,
    ),
    [sourceSha, toolsSha],
  );
});
