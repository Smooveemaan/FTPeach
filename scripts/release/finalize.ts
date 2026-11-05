import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, type Candidate } from './candidate.ts';
import { withPortablePlatform } from './portable.ts';
import { validateCandidate } from './validate-candidate.ts';
import { githubApi, type PublicRun } from './verify-readiness.ts';

export const MANUAL_CHECKS = [
  'production-updater-installed',
  'production-updater-portable',
  'native-desktop',
  'filesystem-stand',
  'windows-hello',
  'windows-hello-second-account',
  'vault-lock',
  'tray-notification',
] as const;
export interface ManualAcceptance {
  sha: string;
  candidateHash: string;
  tester: string;
  checkedAt: string;
  results: Record<string, { result: string; evidence: string }>;
}
interface Asset {
  name: string;
  url: string;
  digest?: string;
}
interface Draft {
  id: number;
  tag_name: string;
  draft: boolean;
  body: string;
  assets: Asset[];
}

export function validateManualAcceptance(manual: ManualAcceptance, sha: string, hash: string) {
  assert.equal(manual.sha, sha);
  assert.equal(manual.candidateHash, hash);
  assert.ok(manual.tester?.trim(), 'Name the person who performed acceptance');
  assert.ok(
    Number.isFinite(Date.parse(manual.checkedAt)) &&
      Date.parse(manual.checkedAt) <= Date.now() + 300_000,
    'Acceptance needs a valid check date',
  );
  for (const name of MANUAL_CHECKS) {
    assert.equal(manual.results?.[name]?.result, 'passed', `Manual check ${name} has not passed`);
    assert.ok(manual.results[name]!.evidence?.trim(), `Manual check ${name} needs evidence`);
  }
}

export function tagMessage(version: string, hash: string): string {
  return `Release ${version}\n\nFTPeach candidate SHA256: ${hash}\n`;
}
export function validateTag(
  tag: { tag: string; message: string; object: { type: string; sha: string } },
  candidate: Candidate,
  hash: string,
) {
  assert.equal(tag.tag, `v${candidate.readiness.version}`);
  assert.equal(tag.object.type, 'commit');
  assert.equal(tag.object.sha, candidate.readiness.sha);
  assert.equal(
    tag.message.trimEnd(),
    tagMessage(candidate.readiness.version, hash).trimEnd(),
    'The version tag belongs to different candidate bytes',
  );
}
export function assetNeedsUpload(asset: Asset | undefined, hash: string): boolean {
  if (!asset) return true;
  assert.equal(
    asset.digest,
    `sha256:${hash}`,
    `Existing draft asset differs or lacks a SHA-256: ${asset.name}`,
  );
  return false;
}

export function verifyAttestations(
  directory: string,
  candidate: Candidate,
  workflowPath: string,
  run: typeof execFileSync = execFileSync,
  toolsSha = candidate.build.workflowSha,
) {
  // The attested manifest binds the checked app SHA to every final file hash.
  for (const name of [
    'candidate.json',
    ...Object.keys(candidate.files).filter((name) => /(-setup\.exe|-portable\.zip)$/.test(name)),
  ]) {
    run(
      'gh',
      [
        'attestation',
        'verify',
        path.join(directory, name),
        '--repo',
        candidate.readiness.repository,
        '--signer-workflow',
        `${candidate.readiness.repository}/${workflowPath}`,
        '--signer-digest',
        toolsSha,
        '--format',
        'json',
      ],
      {
        env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      },
    );
  }
}

async function readDestination(candidate: Candidate, hash: string) {
  const tag = `v${candidate.readiness.version}`;
  const marker = `<!-- ftpeach-candidate:${hash} -->`;
  const draft = (await githubApi(`releases/tags/${tag}`, undefined, true)) as Draft | null;
  if (draft) {
    assert.equal(draft.draft, true, 'A published release cannot be resumed or changed');
    assert.equal(draft.tag_name, tag);
    assert.ok(draft.body.includes(marker), 'Existing draft belongs to a different candidate');
  }
  const reference = (await githubApi(`git/ref/tags/${tag}`, undefined, true)) as {
    object: { type: string; sha: string };
  } | null;
  if (reference) {
    assert.equal(reference.object.type, 'tag', 'A lightweight version tag cannot be reused');
    validateTag(
      (await githubApi(`git/tags/${reference.object.sha}`)) as Parameters<typeof validateTag>[0],
      candidate,
      hash,
    );
  }
  return { draft, reference, marker };
}

async function prepare() {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
  const accepted = await validateCandidate(process.env.CANDIDATE_ID!);
  const { candidate, hash, directory, attest, installer, run } = accepted;
  assert.ok(attest && installer, 'Automatic candidate acceptance is incomplete or stale');
  const manual = JSON.parse(
    process.env.MANUAL_ACCEPTANCE ?? (await readFile('manual-acceptance.json', 'utf8')),
  ) as ManualAcceptance;
  validateManualAcceptance(manual, candidate.readiness.sha, hash);
  verifyAttestations(
    directory,
    candidate,
    '.github/workflows/release.yml',
    execFileSync,
    attest.toolsSha,
  );
  await writeFile(
    path.join(directory, 'release-verification.json'),
    JSON.stringify(
      { candidate, candidateHash: hash, automatic: { attest, installer }, manual },
      null,
      2,
    ),
  );
  await readDestination(candidate, hash);
  return {
    candidate,
    directory,
    hash,
    manual,
    createdAt: (run as PublicRun & { created_at: string }).created_at,
  };
}

async function publish(accepted: Awaited<ReturnType<typeof prepare>>) {
  const { candidate, directory, hash, manual, createdAt } = accepted;
  const { sha, version, repository } = candidate.readiness;
  const tag = `v${version}`;
  const destination = await readDestination(candidate, hash);
  let draft = destination.draft;
  const marker = destination.marker;
  if (!destination.reference) {
    const object = (await githubApi('git/tags', {
      tag,
      message: tagMessage(version, hash),
      object: sha,
      type: 'commit',
    })) as { sha: string };
    await githubApi('git/refs', { ref: `refs/tags/${tag}`, sha: object.sha });
  }
  if (!draft) {
    const notes = await readFile(path.join(directory, 'release-notes.md'), 'utf8');
    const manualLines = MANUAL_CHECKS.map(
      (name) =>
        `- ${name}: passed (${manual.tester}, ${manual.checkedAt}); ${manual.results[name]!.evidence}`,
    );
    draft = (await githubApi('releases', {
      tag_name: tag,
      target_commitish: sha,
      name: `FTPeach ${tag}`,
      draft: true,
      prerelease: false,
      body: `${notes}\n\n${marker}\n\nSource: ${sha}. Full checks: https://github.com/${repository}/actions/runs/${candidate.readiness.runId}. Packages: https://github.com/${repository}/actions/runs/${candidate.build.runId}.\n\n${manualLines.join('\n')}\n\nPublic-feed update verification remains required after publication.`,
    })) as Draft;
  }
  assert.equal(draft.draft, true, 'A published release cannot be resumed or changed');
  assert.equal(draft.tag_name, tag);
  assert.ok(draft.body.includes(marker), 'Existing draft belongs to a different candidate');
  const packages = [
    `FTPeach_${version}_x64-setup.exe`,
    `FTPeach_${version}_x64-portable.zip`,
    'release-audit.zip',
    'candidate.json',
    'release-verification.json',
  ];
  const allowed = [...packages, 'latest.json'];
  assert.ok(
    draft.assets.every((asset) => allowed.includes(asset.name)),
    'The draft has unexpected assets',
  );
  async function upload(name: string) {
    const assets = (await githubApi(`releases/${draft!.id}/assets?per_page=100`)) as Asset[];
    const local = path.join(directory, name);
    const digest = sha256(await readFile(local));
    if (
      assetNeedsUpload(
        assets.find((asset) => asset.name === name),
        digest,
      )
    ) {
      execFileSync('gh', ['release', 'upload', tag, local, '--repo', repository], {
        env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
        stdio: 'pipe',
        timeout: 120_000,
      });
    }
  }
  for (const name of packages) await upload(name);
  const assets = (await githubApi(`releases/${draft.id}/assets?per_page=100`)) as Asset[];
  const installer = assets.find((asset) => asset.name === packages[0]);
  const portable = assets.find((asset) => asset.name === packages[1]);
  assert.ok(installer && portable);
  const feed = withPortablePlatform(
    {
      version,
      notes: await readFile(path.join(directory, 'release-notes.md'), 'utf8'),
      pub_date: createdAt,
      platforms: {
        'windows-x86_64': {
          url: installer.url,
          signature: (await readFile(path.join(directory, `${packages[0]}.sig`), 'utf8')).trim(),
        },
      },
    },
    portable.url,
    await readFile(path.join(directory, `${packages[1]}.sig`), 'utf8'),
  );
  await writeFile(path.join(directory, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);
  await upload('latest.json');
  const downloaded = await mkdtemp(path.join(tmpdir(), 'draft-download-'));
  execFileSync('gh', ['release', 'download', tag, '--repo', repository, '--dir', downloaded], {
    env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
    stdio: 'pipe',
    timeout: 120_000,
  });
  for (const name of allowed)
    assert.equal(
      sha256(await readFile(path.join(downloaded, name))),
      sha256(await readFile(path.join(directory, name))),
      `Downloaded draft asset differs: ${name}`,
    );
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY!,
    `Draft ${tag} is complete: identical accepted packages and feed verified after download. The owner publishes it, then verifies the public feed.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const accepted = await prepare();
  if (process.argv[2] === 'publish') {
    assert.equal(
      process.env.GITHUB_JOB,
      'tag-and-draft',
      'Only the separately approved tag job may mutate the release',
    );
    await publish(accepted);
  } else {
    await appendFile(process.env.GITHUB_OUTPUT!, `sha=${accepted.candidate.readiness.sha}\n`);
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY!,
      `## Approval to create the final tag\n\nv${accepted.candidate.readiness.version}, source ${accepted.candidate.readiness.sha}, candidate SHA-256 ${accepted.hash}.\n\nAutomatic acceptance and all ${MANUAL_CHECKS.length} manual checks passed. Approve release-tag only to create this tag and upload these exact files to a draft.\n`,
    );
  }
}
