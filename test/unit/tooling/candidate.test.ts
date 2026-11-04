import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
  const predicate = provenance(candidate, {
    GITHUB_WORKFLOW_REF: 'owner/app/.github/workflows/release.yml@refs/heads/master',
  });
  assert.equal(predicate.buildDefinition.resolvedDependencies[0]?.digest.gitCommit, 'a'.repeat(40));
  assert.equal(predicate.buildDefinition.resolvedDependencies[1]?.digest.gitCommit, 'b'.repeat(40));
  await writeFile(path.join(directory, candidateNames('0.6.1')[0]!), 'damaged');
  await assert.rejects(verifyCandidate(directory), /Candidate file changed/);
});
