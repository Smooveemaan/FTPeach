import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sha256, verifyCandidate } from './candidate.ts';

export function requireAcceptance(stats: {
  expected: number;
  skipped: number;
  unexpected: number;
  flaky: number;
}) {
  assert.equal(stats.expected, 3, 'All three final-package scenarios must pass');
  for (const value of [stats.skipped, stats.unexpected, stats.flaky])
    assert.equal(value, 0, 'Final package acceptance cannot skip, fail or retry');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const candidate = await verifyCandidate('release-candidate');
  const report = JSON.parse(await readFile('test-results/release-acceptance-results.json', 'utf8'));
  requireAcceptance(report.stats);
  await mkdir('test-results/e2e', { recursive: true });
  await writeFile(
    'test-results/e2e/release-acceptance.json',
    JSON.stringify(
      {
        schema: 1,
        sha: candidate.readiness.sha,
        candidateHash: sha256(await readFile('release-candidate/candidate.json')),
        runId: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        stats: report.stats,
      },
      null,
      2,
    ),
  );
}
