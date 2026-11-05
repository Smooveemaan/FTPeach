import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { finalizeCandidate, validateManualAcceptance, type ManualAcceptance } from './finalize.ts';
import {
  downloadArtifact,
  findArtifact,
  jobConclusion,
  parseCandidateId,
  validateCandidate,
  validateOrigin,
} from './validate-candidate.ts';
import { githubApi, type PublicRun } from './verify-readiness.ts';

interface ManualRecord {
  runId: string;
  attempt: string;
  candidateId: string;
  manual: ManualAcceptance;
}

export function validateManualRecord(
  record: ManualRecord,
  id: string,
  sha: string,
  hash: string,
  run: PublicRun,
  conclusion: string | null,
): ManualAcceptance | undefined {
  assert.equal(record.candidateId, id);
  assert.equal(record.runId, String(run.id));
  assert.match(record.attempt, /^[1-9][0-9]*$/);
  assert.ok(Number(record.attempt) <= run.run_attempt);
  validateManualAcceptance(record.manual, sha, hash);
  if (conclusion === null) return undefined;
  assert.equal(conclusion, 'success', 'The manual acceptance recording job failed');
  return record.manual;
}

export async function manualAcceptance(
  id: string,
  sha: string,
  hash: string,
): Promise<ManualAcceptance | undefined> {
  parseCandidateId(id);
  const artifact = await findArtifact(`candidate-${id.replace(':', '-')}-manual`);
  if (!artifact) return undefined;
  const directory = await mkdtemp(path.join(tmpdir(), 'release-manual-'));
  downloadArtifact(artifact, directory);
  const record = JSON.parse(
    await readFile(path.join(directory, 'manual.json'), 'utf8'),
  ) as ManualRecord;
  const run = (await githubApi(`actions/runs/${artifact.workflow_run.id}`)) as PublicRun;
  validateOrigin(run, String(artifact.workflow_run.id), process.env.GITHUB_REPOSITORY!);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(record.runId, String(run.id));
  assert.match(record.attempt, /^[1-9][0-9]*$/);
  const conclusion = await jobConclusion(record.runId, record.attempt, 'manual');
  return validateManualRecord(record, id, sha, hash, run, conclusion);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
  const id = process.env.CANDIDATE_ID!;
  const validated = await validateCandidate(id);
  const { candidate, hash, attest, installer } = validated;
  assert.ok(attest && installer, 'Complete automatic acceptance before recording manual results');
  if (process.argv[2] === 'record') {
    const manual = JSON.parse(process.env.MANUAL_ACCEPTANCE ?? '{}') as ManualAcceptance;
    validateManualAcceptance(manual, candidate.readiness.sha, hash);
    assert.equal(
      await findArtifact(`candidate-${id.replace(':', '-')}-manual`),
      undefined,
      'Manual acceptance already exists; never replace retained evidence',
    );
    await mkdir('release-manual', { recursive: true });
    await writeFile(
      'release-manual/manual.json',
      JSON.stringify(
        {
          candidateId: id,
          runId: process.env.GITHUB_RUN_ID,
          attempt: process.env.GITHUB_RUN_ATTEMPT,
          manual,
        },
        null,
        2,
      ),
    );
    await appendFile(
      process.env.GITHUB_OUTPUT!,
      `artifact=candidate-${id.replace(':', '-')}-manual\n`,
    );
  } else {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY!,
      `Automatic acceptance passed for ${id}, SHA ${candidate.readiness.sha}, manifest ${hash}. Record all manual checks with Release / record-manual for this candidate. No deploy approval is requested until that record passes validation.\n`,
    );
    const deadline = Date.now() + 5 * 60 * 60 * 1000;
    let manual = await manualAcceptance(id, candidate.readiness.sha, hash);
    while (!manual && process.argv[2] === 'wait' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      manual = await manualAcceptance(id, candidate.readiness.sha, hash);
    }
    assert.ok(
      manual,
      'Manual acceptance is missing; record it, then dispatch deploy with this candidate ID',
    );
    await writeFile('manual-acceptance.json', JSON.stringify(manual, null, 2));
    if (process.argv[3] === 'finalize' || process.argv[3] === 'publish')
      await finalizeCandidate(
        process.argv[2] === 'wait' ? undefined : validated,
        process.argv[3] === 'publish',
      );
  }
}
