import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  githubApi,
  isMultiPlatformVersion,
  sha256,
  verifyCandidate,
  type Candidate,
  type PublicRun,
} from './candidate.ts';

export type Stage = 'installer' | 'macos' | 'linux';
export interface Evidence {
  schema: number;
  candidateId: string;
  candidateHash: string;
  stage: Stage;
  runId: string;
  attempt: string;
  toolsSha: string;
  workflow: string;
}
export interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  workflow_run: { id: number; head_sha: string };
}
const workflows = [
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  '.github/workflows/release-next.yml',
];

export function parseCandidateId(id: string): { runId: string; attempt: string } {
  assert.match(id, /^[1-9][0-9]*:[1-9][0-9]*$/, 'Candidate ID must be RUN_ID:BUILD_ATTEMPT');
  const [runId, attempt] = id.split(':') as [string, string];
  return { runId, attempt };
}

export function validateOrigin(run: PublicRun, id: string, repository: string) {
  assert.equal(String(run.id), id);
  assert.equal(run.head_repository.full_name, repository);
  assert.equal(run.head_branch, 'master');
  assert.ok(workflows.includes(run.path), 'Untrusted release workflow');
  assert.ok(
    (run.event === 'push' && run.path === workflows[0]) ||
      (run.event === 'workflow_dispatch' && workflows.slice(1).includes(run.path)),
    'Untrusted release event',
  );
}

export async function jobConclusion(runId: string, attempt: string, name: string) {
  const jobs: { name: string; conclusion: string | null }[] = [];
  for (let page = 1; ; page++) {
    const result = (await githubApi(
      `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=50&page=${page}`,
    )) as { jobs: typeof jobs };
    jobs.push(...result.jobs);
    if (result.jobs.length < 50) break;
  }
  const matches = jobs.filter((job) => job.name === name || job.name.endsWith(` / ${name}`));
  assert.equal(matches.length, 1, `Missing or ambiguous ${name} job in ${runId}:${attempt}`);
  return matches[0]!.conclusion;
}

export async function requireJob(runId: string, attempt: string, name: string) {
  assert.equal(
    await jobConclusion(runId, attempt, name),
    'success',
    `${name} did not succeed in ${runId}:${attempt}`,
  );
}

export function downloadArtifact(artifact: Artifact, directory: string) {
  assert.equal(artifact.expired, false, 'Candidate evidence expired');
  execFileSync(
    'gh',
    [
      'run',
      'download',
      String(artifact.workflow_run.id),
      '--repo',
      process.env.GITHUB_REPOSITORY!,
      '--name',
      artifact.name,
      '--dir',
      directory,
    ],
    {
      env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
      stdio: 'pipe',
      timeout: 120_000,
    },
  );
}

export async function findArtifact(name: string): Promise<Artifact | undefined> {
  const result = (await githubApi(
    `actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
  )) as { artifacts: Artifact[]; total_count: number };
  assert.ok(result.total_count <= 100, 'Ambiguous retained evidence');
  return result.artifacts.filter((artifact) => !artifact.expired).sort((a, b) => b.id - a.id)[0];
}

export function evidenceName(id: string, stage: Stage = 'installer') {
  parseCandidateId(id);
  const slug = id.replace(':', '-');
  return stage === 'installer'
    ? `candidate-${slug}-acceptance`
    : `candidate-${slug}-acceptance-${stage}`;
}

export function stageJobName(stage: Stage): string {
  if (stage === 'installer') return 'acceptance / installer';
  return stage === 'macos' ? 'acceptance-macos' : 'acceptance-linux';
}

export function validateEvidence(
  proof: Evidence,
  stage: Stage,
  id: string,
  hash: string,
  run: PublicRun,
) {
  assert.equal(proof.schema, 1);
  assert.equal(proof.stage, stage);
  assert.equal(proof.candidateId, id);
  assert.equal(proof.candidateHash, hash);
  assert.match(proof.attempt, /^[1-9][0-9]*$/);
  assert.equal(proof.runId, String(run.id));
  assert.equal(proof.workflow, run.path);
  assert.equal(proof.toolsSha, run.head_sha);
  assert.ok(Number(proof.attempt) <= run.run_attempt);
}

export function latestStageSuccess(
  jobs: { id: number; name: string; conclusion: string | null }[],
  name: string,
): boolean {
  const latest = jobs
    .filter(
      (job) =>
        (job.name === name || job.name.endsWith(` / ${name}`)) && job.conclusion !== 'skipped',
    )
    .sort((a, b) => b.id - a.id)[0];
  return latest?.conclusion === 'success';
}

export async function stageEvidence(
  stage: Stage,
  id: string,
  hash: string,
): Promise<Evidence | undefined> {
  const artifact = await findArtifact(evidenceName(id, stage));
  if (!artifact) return undefined;
  const directory = await mkdtemp(path.join(tmpdir(), `release-${stage}-`));
  downloadArtifact(artifact, directory);
  const proof = JSON.parse(await readFile(`${directory}/evidence.json`, 'utf8')) as Evidence;
  const run = (await githubApi(`actions/runs/${artifact.workflow_run.id}`)) as PublicRun;
  validateOrigin(run, String(artifact.workflow_run.id), process.env.GITHUB_REPOSITORY!);
  validateEvidence(proof, stage, id, hash, run);
  const name = stageJobName(stage);
  if ((await jobConclusion(proof.runId, proof.attempt, name)) !== 'success') return undefined;
  const currentJobs: { id: number; name: string; conclusion: string | null }[] = [];
  for (let page = 1; ; page++) {
    const result = (await githubApi(
      `actions/runs/${proof.runId}/jobs?filter=all&per_page=50&page=${page}`,
    )) as { jobs: typeof currentJobs };
    currentJobs.push(...result.jobs);
    if (result.jobs.length < 50) break;
  }
  if (!latestStageSuccess(currentJobs, name)) return undefined;
  return proof;
}

export async function validateCandidate(id: string) {
  const { runId, attempt } = parseCandidateId(id);
  const run = (await githubApi(`actions/runs/${runId}`)) as PublicRun;
  validateOrigin(run, runId, process.env.GITHUB_REPOSITORY!);
  assert.ok(Number(attempt) <= run.run_attempt);
  const result = (await githubApi(`actions/runs/${runId}/artifacts?per_page=100`)) as {
    artifacts: Artifact[];
    total_count: number;
  };
  assert.ok(result.total_count <= 100);
  const artifact = result.artifacts.find((item) => item.name === `release-candidate-${attempt}`);
  assert.ok(
    artifact && !artifact.expired,
    'Candidate files missing or expired; never rebuild a tagged version',
  );
  assert.equal(artifact.workflow_run.id, Number(runId));
  const directory = await mkdtemp(path.join(tmpdir(), 'release-candidate-'));
  downloadArtifact(artifact, directory);
  const candidate = await verifyCandidate(directory);
  assert.equal(candidate.build.runId, runId);
  assert.equal(candidate.build.attempt, attempt);
  assert.equal(candidate.build.workflowSha, run.head_sha);
  const multiplatform = isMultiPlatformVersion(candidate.readiness.version);
  await requireJob(runId, attempt, 'build-windows');
  if (multiplatform) {
    await requireJob(runId, attempt, 'build-macos');
    await requireJob(runId, attempt, 'build-linux');
  }
  const hash = sha256(await readFile(`${directory}/candidate.json`));
  const installer = await stageEvidence('installer', id, hash);
  const macos = multiplatform ? await stageEvidence('macos', id, hash) : undefined;
  const linux = multiplatform ? await stageEvidence('linux', id, hash) : undefined;
  return { candidate, hash, multiplatform, installer, macos, linux, directory, run };
}

export function resumePlan(
  result: {
    installer?: Evidence | undefined;
    macos?: Evidence | undefined;
    linux?: Evidence | undefined;
    multiplatform?: boolean;
  },
  installerApproved: boolean,
) {
  const missing: { installer: boolean; macos?: boolean; linux?: boolean } = {
    installer: !result.installer,
    ...(result.multiplatform
      ? {
          macos: !result.macos,
          linux: !result.linux,
        }
      : {}),
  };
  if (missing.installer)
    assert.equal(
      installerApproved,
      true,
      'Installer evidence is missing or expired. Repeating installation requires installer-approved=true after owner permission.',
    );
  return missing;
}

export async function recordEvidence(stage: Stage, candidate: Candidate, hash: string) {
  const id = `${candidate.build.runId}:${candidate.build.attempt}`;
  const toolsSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(
    toolsSha,
    process.env.GITHUB_WORKFLOW_SHA,
    'Acceptance tools checkout differs from the trusted workflow',
  );
  const proof: Evidence = {
    schema: 1,
    candidateId: id,
    candidateHash: hash,
    stage,
    runId: process.env.GITHUB_RUN_ID!,
    attempt: process.env.GITHUB_RUN_ATTEMPT!,
    toolsSha,
    workflow: process.env.GITHUB_WORKFLOW_REF!.split('@')[0]!.split('/').slice(2).join('/'),
  };
  await mkdir(`release-evidence/${stage}`, { recursive: true });
  await writeFile(`release-evidence/${stage}/evidence.json`, JSON.stringify(proof, null, 2));
  await appendFile(process.env.GITHUB_OUTPUT!, `evidence=${evidenceName(id, stage)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'record') {
    const stage = process.argv[3] as Stage | undefined;
    assert.ok(stage === 'installer' || stage === 'macos' || stage === 'linux');
    await recordEvidence(
      stage,
      await verifyCandidate('release-candidate'),
      sha256(await readFile('release-candidate/candidate.json')),
    );
  } else {
    assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
    const result = await validateCandidate(process.env.CANDIDATE_ID!);
    const accepted =
      Boolean(result.installer) &&
      (!result.multiplatform || (Boolean(result.macos) && Boolean(result.linux)));
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY!,
      `Candidate ${process.env.CANDIDATE_ID}, manifest ${result.hash}, state ${accepted ? 'accepted' : 'built'}.\nInstaller acceptance: ${result.installer ? 'retained success' : 'no valid retained success; owner permission required before repeating installation'}.\n${
        result.multiplatform
          ? `macOS acceptance: ${result.macos ? 'retained success' : 'missing'}.\nLinux acceptance: ${result.linux ? 'retained success' : 'missing'}.\n`
          : ''
      }`,
    );
    const plan = resumePlan(result, process.env.INSTALLER_APPROVED === 'true');
    if (process.argv[2] === 'accepted') {
      assert.ok(
        !plan.installer && !plan.macos && !plan.linux,
        'Automatic acceptance is missing or stale',
      );
    }
    if (
      (process.argv[2] === 'prepare-installer' && plan.installer) ||
      (process.argv[2] === 'prepare-macos' && plan.macos) ||
      (process.argv[2] === 'prepare-linux' && plan.linux)
    ) {
      await cp(result.directory, 'release-candidate', { recursive: true });
    }
    await appendFile(
      process.env.GITHUB_OUTPUT!,
      `sha=${result.candidate.readiness.sha}\nversion=${result.candidate.readiness.version}\nmultiplatform=${result.multiplatform}\ninstaller=${plan.installer}\nmacos=${Boolean(plan.macos)}\nlinux=${Boolean(plan.linux)}\nartifact=release-candidate-${result.candidate.build.attempt}\nbuild-run-id=${result.candidate.build.runId}\n`,
    );
  }
}
