import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DesktopReceipt } from './desktop-receipt.ts';
import { sha256, verifyCandidate, type Candidate } from './candidate.ts';
import { githubApi, verifyReadiness, type PublicRun } from './verify-readiness.ts';

export type Stage = 'attest' | 'installer' | 'desktop';
export interface Evidence {
  schema: number;
  candidateId: string;
  candidateHash: string;
  stage: Stage;
  inputs: string;
  runId: string;
  attempt: string;
  toolsSha: string;
  workflow: string;
  desktop?: DesktopReceipt;
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

export function stageInputs(stage: Stage, files: Record<string, string>): string {
  // Unknown changes invalidate the group; only explicitly unrelated trees are excluded.
  const relevant = Object.entries(files).filter(([name]) => {
    if (/^(docs|site|assets|src|public)\//.test(name) || /\.md$/.test(name)) return false;
    if (
      name === '.github/workflows/release-published.yml' ||
      name === 'scripts/release/published-update.ts' ||
      /^test\/e2e\/published-update\./.test(name)
    )
      return false;
    if (stage === 'installer' && /^scripts\/release\/desktop-(check|receipt)\.ts$/.test(name))
      return false;
    if (
      stage === 'desktop' &&
      (/^test\/e2e\//.test(name) ||
        name === '.github/workflows/installer.yml' ||
        /^scripts\/release\/(record-acceptance|test-installers)\.ts$/.test(name))
    )
      return false;
    if (
      /^scripts\/release\/(finalize|manual|check-published|check-release-environment|build-release-notes)\.ts$/.test(
        name,
      ) ||
      /^scripts\/(checks|site|coverage|benchmarks)\//.test(name) ||
      /^test\/(unit|component|visual)\//.test(name)
    )
      return false;
    if (stage === 'attest')
      return (
        name === '.github/workflows/release.yml' ||
        ['scripts/release/candidate.ts', 'scripts/release/validate-candidate.ts'].includes(name) ||
        /^(package(-lock)?\.json|rust-toolchain\.toml)$/.test(name)
      );
    return true;
  });
  return sha256(JSON.stringify(relevant.sort(([a], [b]) => a.localeCompare(b))));
}

export function workflowInputs(source: string, stage: Stage): string {
  source = source.replaceAll('\r\n', '\n');
  const start = source.indexOf('\njobs:\n');
  const jobs = [...source.matchAll(/^ {2}([\w-]+):\r?$/gm)].filter((match) => match.index > start);
  if (
    start < 0 ||
    !jobs.some(
      (match) =>
        match[1] ===
        (stage === 'attest' ? 'attest' : stage === 'desktop' ? 'desktop-acceptance' : 'acceptance'),
    )
  )
    return source;
  const selected = jobs.flatMap((match, index) => {
    if (
      match[1] !==
      (stage === 'attest' ? 'attest' : stage === 'desktop' ? 'desktop-acceptance' : 'acceptance')
    )
      return [];
    return [source.slice(match.index, jobs[index + 1]?.index ?? source.length)];
  });
  return source.slice(0, start) + selected.join('\n');
}

export function checkoutInputs(stage: Stage): string {
  const files = Object.fromEntries(
    execFileSync('git', ['ls-tree', '-r', 'HEAD'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => {
        const [meta, name] = line.split('\t');
        assert.ok(meta && name);
        return [name, meta.split(' ')[2]!];
      }),
  );
  if (files['.github/workflows/release.yml'])
    files['.github/workflows/release.yml'] = sha256(
      workflowInputs(
        execFileSync('git', ['show', 'HEAD:.github/workflows/release.yml'], { encoding: 'utf8' }),
        stage,
      ),
    );
  return stageInputs(stage, files);
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
      `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
    )) as { jobs: typeof jobs };
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
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

export function evidenceName(id: string, stage: Stage, inputs: string) {
  parseCandidateId(id);
  assert.match(inputs, /^[0-9a-f]{64}$/);
  return `candidate-${id.replace(':', '-')}-${stage}-${inputs}`;
}

export function validateEvidence(
  proof: Evidence,
  stage: Stage,
  id: string,
  hash: string,
  inputs: string,
  run: PublicRun,
) {
  assert.equal(proof.schema, 1);
  assert.equal(proof.stage, stage);
  assert.equal(proof.candidateId, id);
  assert.equal(proof.candidateHash, hash);
  assert.equal(proof.inputs, inputs);
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
  inputs: string,
): Promise<Evidence | undefined> {
  const artifact = await findArtifact(evidenceName(id, stage, inputs));
  if (!artifact) return undefined;
  const directory = await mkdtemp(path.join(tmpdir(), `release-${stage}-`));
  downloadArtifact(artifact, directory);
  const proof = JSON.parse(await readFile(`${directory}/evidence.json`, 'utf8')) as Evidence;
  const run = (await githubApi(`actions/runs/${artifact.workflow_run.id}`)) as PublicRun;
  validateOrigin(run, String(artifact.workflow_run.id), process.env.GITHUB_REPOSITORY!);
  validateEvidence(proof, stage, id, hash, inputs, run);
  if (stage === 'desktop') {
    assert.ok(proof.desktop, 'Desktop receipt missing');
    assert.equal(proof.desktop.candidateId, id);
    assert.equal(proof.desktop.candidateHash, hash);
    assert.equal(proof.desktop.publicToolsSha, proof.toolsSha);
    assert.equal(proof.desktop.parentRunId, proof.runId);
    const { verifyDesktopRun } = await import('./desktop-check.ts');
    if (!(await verifyDesktopRun(proof.desktop))) return undefined;
  }
  const name =
    stage === 'installer'
      ? 'acceptance / installer'
      : stage === 'desktop'
        ? 'desktop-acceptance'
        : 'attest';
  if ((await jobConclusion(proof.runId, proof.attempt, name)) !== 'success') return undefined;
  const currentJobs: { id: number; name: string; conclusion: string | null }[] = [];
  for (let page = 1; ; page++) {
    const result = (await githubApi(
      `actions/runs/${proof.runId}/jobs?filter=all&per_page=100&page=${page}`,
    )) as { jobs: typeof currentJobs };
    currentJobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
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
  await requireJob(runId, attempt, 'build-windows');
  await verifyReadiness(candidate.readiness.runId, candidate.readiness);
  const hash = sha256(await readFile(`${directory}/candidate.json`));
  const inputs = {
    attest: checkoutInputs('attest'),
    installer: checkoutInputs('installer'),
    desktop: checkoutInputs('desktop'),
  };
  const attest = await stageEvidence('attest', id, hash, inputs.attest);
  const installer = await stageEvidence('installer', id, hash, inputs.installer);
  const desktop = await stageEvidence('desktop', id, hash, inputs.desktop);
  if (desktop) assert.equal(desktop.desktop!.applicationSha, candidate.readiness.sha);
  return { candidate, hash, inputs, attest, installer, desktop, directory, run };
}

export function resumePlan(
  result: {
    attest?: Evidence | undefined;
    installer?: Evidence | undefined;
    desktop?: Evidence | undefined;
  },
  installerApproved: boolean,
) {
  const missing = {
    attest: !result.attest,
    installer: !result.installer,
    desktop: !result.desktop,
  };
  if (missing.installer)
    assert.equal(
      installerApproved,
      true,
      'Installer evidence is missing, expired or its inputs changed. Repeating installation requires installer-approved=true after owner permission.',
    );
  return missing;
}

export async function recordEvidence(
  stage: Stage,
  candidate: Candidate,
  hash: string,
  desktop?: DesktopReceipt,
) {
  const id = `${candidate.build.runId}:${candidate.build.attempt}`;
  const toolsSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(
    toolsSha,
    process.env.GITHUB_WORKFLOW_SHA,
    'Acceptance tools checkout differs from the trusted workflow',
  );
  const inputs = checkoutInputs(stage);
  const proof: Evidence = {
    ...(desktop ? { desktop } : {}),
    schema: 1,
    candidateId: id,
    candidateHash: hash,
    stage,
    inputs,
    runId: process.env.GITHUB_RUN_ID!,
    attempt: process.env.GITHUB_RUN_ATTEMPT!,
    toolsSha,
    workflow: process.env.GITHUB_WORKFLOW_REF!.split('@')[0]!.split('/').slice(2).join('/'),
  };
  await mkdir(`release-evidence/${stage}`, { recursive: true });
  await writeFile(`release-evidence/${stage}/evidence.json`, JSON.stringify(proof, null, 2));
  await appendFile(process.env.GITHUB_OUTPUT!, `evidence=${evidenceName(id, stage, inputs)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'record') {
    const stage = process.argv[3];
    assert.ok(stage === 'attest' || stage === 'installer');
    await recordEvidence(
      stage,
      await verifyCandidate('release-candidate'),
      sha256(await readFile('release-candidate/candidate.json')),
    );
  } else {
    assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
    const result = await validateCandidate(process.env.CANDIDATE_ID!);
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY!,
      `Candidate ${process.env.CANDIDATE_ID}, manifest ${result.hash}, state ${result.attest && result.installer ? 'accepted' : 'built'}.\nAttestation inputs: ${result.inputs.attest}; ${result.attest ? 'retained success' : 'no valid retained success'}.\nInstaller inputs: ${result.inputs.installer}; ${result.installer ? 'retained success' : 'no valid retained success; owner permission required before repeating installation'}.\n`,
    );
    const plan = resumePlan(result, process.env.INSTALLER_APPROVED === 'true');
    if (process.argv[2] === 'accepted')
      assert.ok(
        !plan.attest && !plan.installer && !plan.desktop,
        'Automatic acceptance is missing or stale',
      );
    await appendFile(
      process.env.GITHUB_OUTPUT!,
      `sha=${result.candidate.readiness.sha}\nversion=${result.candidate.readiness.version}\nattest=${plan.attest}\ninstaller=${plan.installer}\ndesktop=${plan.desktop}\nartifact=release-candidate-${result.candidate.build.attempt}\nbuild-run-id=${result.candidate.build.runId}\n`,
    );
  }
}
