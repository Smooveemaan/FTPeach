// Read actual repository protections before granting signing or deploy access.
import { appendFile } from 'node:fs/promises';
import {
  environmentVerdict,
  signingEnvironmentVerdict,
  type GithubEnvironment,
} from './release-trust.ts';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const environment = process.argv[2] ?? 'release';
if (!['release', 'release-tag'].includes(environment))
  throw new Error('Unknown release environment');
if (!repository || !token) {
  throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
}

const response = await fetch(
  `https://api.github.com/repos/${repository}/environments/${environment}`,
  {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'FTPeach-release-gate',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  },
);
if (!response.ok) {
  throw new Error(`Could not read the release environment: HTTP ${response.status}`);
}

const settings = (await response.json()) as GithubEnvironment;
let verdict;
if (environment === 'release') {
  const branches = await fetch(
    `https://api.github.com/repos/${repository}/environments/release/deployment-branch-policies`,
    {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!branches.ok)
    throw new Error(`Could not read signing branch policies: HTTP ${branches.status}`);
  const policies = (await branches.json()) as {
    total_count: number;
    branch_policies: { name: string; type: string }[];
  };
  if (policies.total_count !== policies.branch_policies.length)
    throw new Error('Incomplete signing branch policies');
  verdict = signingEnvironmentVerdict(settings, policies.branch_policies);
} else verdict = environmentVerdict(settings);
const line = `${verdict.ok ? 'PASS' : 'FAIL'} (${environment}): ${verdict.summary}`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Release environment\n\n${line}\n`);
}
if (!verdict.ok) {
  console.error(
    'Configure signing branch restrictions and deploy reviewers without administrator bypass; see docs/release-trust.md.',
  );
  process.exitCode = 1;
}
