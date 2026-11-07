import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Readiness {
  schema: number;
  repository: string;
  runId: string;
  attempt: string;
  sha: string;
  version: string;
  packages: string[];
}
export interface PublicRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  path: string;
  status: string;
  conclusion: string | null;
  head_commit: { message: string };
  head_repository: { full_name: string };
}
export const WINDOWS_PACKAGES = ['windows-x86_64-nsis', 'windows-x86_64-portable'];

export interface Candidate {
  schema: number;
  readiness: Readiness;
  build: { runId: string; attempt: string; workflowSha: string; tools: Record<string, string> };
  files: Record<string, string>;
}
export const sha256 = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

export function requireUnusedVersion(tag: unknown, release: unknown) {
  assert.equal(
    tag,
    null,
    'This version is already tagged; resume the accepted candidate instead of rebuilding',
  );
  assert.equal(release, null, 'This version already has a release or draft');
}

export async function githubApi(
  route: string,
  body?: unknown,
  allowMissing = false,
): Promise<unknown> {
  assert.ok(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN is required');
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${route}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (allowMissing && response.status === 404) return null;
    if (response.ok) return response.json();
    if (body !== undefined || attempt === 3 || ![502, 503, 504].includes(response.status)) {
      assert.fail(`GitHub API request failed: HTTP ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
}

export function candidateNames(version: string): string[] {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  return [
    `FTPeach_${version}_x64-setup.exe`,
    `FTPeach_${version}_x64-setup.exe.sig`,
    `FTPeach_${version}_x64-portable.zip`,
    `FTPeach_${version}_x64-portable.zip.sig`,
    'release-audit.zip',
    'release-notes.md',
  ];
}

export async function verifyCandidate(directory: string): Promise<Candidate> {
  const candidate = JSON.parse(
    await readFile(path.join(directory, 'candidate.json'), 'utf8'),
  ) as Candidate;
  assert.equal(candidate.schema, 1);
  assert.match(candidate.readiness.sha, /^[0-9a-f]{40}$/);
  assert.match(candidate.build.runId, /^[1-9][0-9]*$/);
  assert.match(candidate.build.attempt, /^[1-9][0-9]*$/);
  assert.match(candidate.build.workflowSha, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    Object.keys(candidate.files).sort(),
    candidateNames(candidate.readiness.version).sort(),
  );
  for (const [name, hash] of Object.entries(candidate.files)) {
    assert.equal(
      sha256(await readFile(path.join(directory, name))),
      hash,
      `Candidate file changed: ${name}`,
    );
  }
  return candidate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory =
    process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'release-candidate';
  if (process.argv.includes('--preflight')) {
    assert.equal(
      process.env.GITHUB_REF,
      'refs/heads/master',
      'Packaging can only be dispatched on master',
    );
    const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.match(
      version,
      /^0\.6\.\d+$/,
      'The multi-platform release matrix must be implemented before 0.7.0',
    );
    requireUnusedVersion(
      await githubApi(`git/ref/tags/v${version}`, undefined, true),
      await githubApi(`releases/tags/v${version}`, undefined, true),
    );
    await appendFile(process.env.GITHUB_OUTPUT!, `version=${version}\n`);
  } else if (process.argv.includes('--verify')) {
    await verifyCandidate(directory);
  } else {
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (process.env.GITHUB_SHA) {
      assert.equal(
        source,
        process.env.GITHUB_SHA,
        'The build checkout is not the checked candidate',
      );
    }
    const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.match(
      version,
      /^0\.6\.\d+$/,
      'The multi-platform release matrix must be implemented before 0.7.0',
    );
    const workflowSha = process.env.GITHUB_WORKFLOW_SHA ?? source;
    assert.match(workflowSha, /^[0-9a-f]{40}$/, 'The build workflow SHA is required');
    const readiness: Readiness = {
      schema: 1,
      repository: process.env.GITHUB_REPOSITORY!,
      runId: process.env.GITHUB_RUN_ID!,
      attempt: process.env.GITHUB_RUN_ATTEMPT!,
      sha: source,
      version,
      packages: WINDOWS_PACKAGES,
    };
    const files: Record<string, string> = {};
    for (const name of candidateNames(version))
      files[name] = sha256(await readFile(path.join(directory, name)));
    assert.deepEqual((await readdir(directory)).sort(), Object.keys(files).sort());
    const candidate: Candidate = {
      schema: 1,
      readiness,
      build: {
        runId: process.env.GITHUB_RUN_ID!,
        attempt: process.env.GITHUB_RUN_ATTEMPT!,
        workflowSha,
        tools: {
          node: process.version,
          rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
          cargo: execFileSync('cargo', ['--version'], { encoding: 'utf8' }).trim(),
        },
      },
      files,
    };
    const manifest = JSON.stringify(candidate, null, 2);
    await writeFile(path.join(directory, 'candidate.json'), manifest);
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY!,
      `## Final candidate\n\nCandidate ID: ${candidate.build.runId}:${candidate.build.attempt}.\nVersion ${version}, source ${source}.\nCandidate SHA-256: ${sha256(manifest)}.\nPackages and acceptance evidence are retained for 30 days; diagnostic logs for 14 days.\n`,
    );
  }
}
