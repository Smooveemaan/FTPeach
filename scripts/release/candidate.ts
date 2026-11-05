import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Readiness } from './verify-readiness.ts';

export interface Candidate {
  schema: number;
  readiness: Readiness;
  build: { runId: string; attempt: string; workflowSha: string; tools: Record<string, string> };
  files: Record<string, string>;
}
export const sha256 = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

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
  const directory = process.argv[2] ?? 'release-candidate';
  if (process.argv.includes('--verify')) {
    await verifyCandidate(directory);
  } else {
    const readiness = JSON.parse(await readFile('release-readiness.json', 'utf8')) as Readiness;
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(source, readiness.sha, 'The build checkout is not the checked candidate');
    const version = (JSON.parse(await readFile('package.json', 'utf8')) as { version: string })
      .version;
    assert.equal(version, readiness.version);
    assert.match(
      process.env.GITHUB_WORKFLOW_SHA ?? '',
      /^[0-9a-f]{40}$/,
      'The build workflow SHA is required',
    );
    const toolsSource = execFileSync('git', ['-C', import.meta.dirname, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(
      toolsSource,
      process.env.GITHUB_WORKFLOW_SHA,
      'Release verification tools must come from the pinned build workflow commit',
    );
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
        workflowSha: process.env.GITHUB_WORKFLOW_SHA!,
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
