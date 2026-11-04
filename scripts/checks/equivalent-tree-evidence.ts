import { appendFile } from 'node:fs/promises';
import type { ChangeClassification, GateId } from './classify-changes.ts';

interface PullRequest {
  base: { sha: string };
  head: { sha: string };
  merge_commit_sha: string | null;
  merged_at: string | null;
  number: number;
}

interface WorkflowRun {
  conclusion: string | null;
  event: string;
  head_sha: string;
  id: number;
  path: string;
  status: string;
}

interface WorkflowJob {
  conclusion: string | null;
  name: string;
  status: string;
}

export interface EvidenceInput {
  before: string;
  classification: { requiredGates: { id: GateId }[] };
  currentTree: string;
  head: string;
  jobs: WorkflowJob[];
  pullRequest: PullRequest;
  pullRequestTree: string;
  run: WorkflowRun;
}

export interface EvidenceDecision {
  reuse: boolean;
  reason: string;
  pullRequest?: number;
  runId?: number;
}

const MATRIX_JOBS: Partial<Record<GateId, string[]>> = {
  'packaged-smoke': ['windows-latest', 'ubuntu-22.04', 'macos-15'],
  'rust-test-unix': ['ubuntu-22.04', 'macos-15'],
};

export function expectedCheckNames(gates: readonly GateId[]): string[] {
  return gates.flatMap((gate) =>
    (MATRIX_JOBS[gate] ?? [undefined]).map(
      (matrix) => `checks / ${gate}${matrix ? ` (${matrix})` : ''}`,
    ),
  );
}

export function evaluateEquivalentTree(input: EvidenceInput): EvidenceDecision {
  const { before, classification, currentTree, head, jobs, pullRequest, pullRequestTree, run } =
    input;
  const identity = { pullRequest: pullRequest.number, runId: run.id };
  if (!pullRequest.merged_at || pullRequest.merge_commit_sha !== head) {
    return { reuse: false, reason: 'the push is not this pull request merge commit', ...identity };
  }
  if (pullRequest.base.sha !== before) {
    return {
      reuse: false,
      reason: 'the pull request base differs from the push base',
      ...identity,
    };
  }
  if (currentTree !== pullRequestTree) {
    return { reuse: false, reason: 'the pull request and master trees differ', ...identity };
  }
  if (
    run.event !== 'pull_request' ||
    run.path !== '.github/workflows/ci.yml' ||
    run.head_sha !== pullRequest.head.sha ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  ) {
    return {
      reuse: false,
      reason: 'the pull request CI run is not a matching success',
      ...identity,
    };
  }
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const missing = expectedCheckNames(classification.requiredGates.map((gate) => gate.id)).filter(
    (name) => {
      const job = byName.get(name);
      return !job || job.status !== 'completed' || job.conclusion !== 'success';
    },
  );
  if (missing.length > 0) {
    return {
      reuse: false,
      reason: `required pull request checks are not successful: ${missing.join(', ')}`,
      ...identity,
    };
  }
  return {
    reuse: true,
    reason: 'matching base and tree with every required pull request check successful',
    ...identity,
  };
}

async function github<T>(repository: string, token: string, endpoint: string): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function findDecision(env: Record<string, string | undefined>): Promise<EvidenceDecision> {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const before = env.BASE_SHA;
  const head = env.HEAD_SHA;
  if (!repository || !token || !before || !head || !env.CLASSIFICATION) {
    throw new Error(
      'GITHUB_REPOSITORY, GITHUB_TOKEN, BASE_SHA, HEAD_SHA and CLASSIFICATION are required',
    );
  }
  const classification = JSON.parse(env.CLASSIFICATION) as ChangeClassification;
  const request = <T>(endpoint: string) => github<T>(repository, token, endpoint);
  const pullRequests = await request<PullRequest[]>('/pulls?state=closed&per_page=100');
  const pullRequest = pullRequests.find((item) => item.merge_commit_sha === head && item.merged_at);
  if (!pullRequest) return { reuse: false, reason: 'no merged pull request matches the push head' };
  const [currentCommit, pullRequestCommit, runs] = await Promise.all([
    request<{ commit: { tree: { sha: string } } }>(`/commits/${head}`),
    request<{ commit: { tree: { sha: string } } }>(`/commits/${pullRequest.head.sha}`),
    request<{ workflow_runs: WorkflowRun[] }>(
      `/actions/runs?event=pull_request&head_sha=${pullRequest.head.sha}&per_page=100`,
    ),
  ]);
  const run = runs.workflow_runs.find(
    (item) => item.path === '.github/workflows/ci.yml' && item.conclusion === 'success',
  );
  if (!run) return { reuse: false, reason: 'no successful pull request CI run matches the head' };
  const jobs = await request<{ jobs: WorkflowJob[] }>(`/actions/runs/${run.id}/jobs?per_page=100`);
  return evaluateEquivalentTree({
    before,
    classification,
    currentTree: currentCommit.commit.tree.sha,
    head,
    jobs: jobs.jobs,
    pullRequest,
    pullRequestTree: pullRequestCommit.commit.tree.sha,
    run,
  });
}

async function main() {
  let decision: EvidenceDecision;
  try {
    decision = await findDecision(process.env);
  } catch (error) {
    decision = {
      reuse: false,
      reason: `evidence lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const json = JSON.stringify(decision);
  console.log(json);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `reuse=${decision.reuse}\nevidence=${json}\n`);
  }
}

if (import.meta.filename === process.argv[1]) await main();
