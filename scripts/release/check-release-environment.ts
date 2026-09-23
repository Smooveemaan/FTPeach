// Runs before the job that holds the signing secrets. Naming the `release`
// environment in the workflow proves nothing about who must approve a run;
// the protection rules are repository settings, so read them from GitHub.
import { appendFile } from 'node:fs/promises';
import { environmentVerdict, type GithubEnvironment } from './release-trust.ts';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repository || !token) {
  throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
}

const response = await fetch(`https://api.github.com/repos/${repository}/environments/release`, {
  headers: {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'FTPeach-release-gate',
    'X-GitHub-Api-Version': '2022-11-28',
  },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  throw new Error(`Could not read the release environment: HTTP ${response.status}`);
}

const verdict = environmentVerdict((await response.json()) as GithubEnvironment);
const line = `${verdict.ok ? 'PASS' : 'FAIL'}: ${verdict.summary}`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Release environment\n\n${line}\n`);
}
if (!verdict.ok) {
  console.error(
    'Configure required reviewers and turn off administrator bypass; see docs/release-trust.md.',
  );
  process.exitCode = 1;
}
