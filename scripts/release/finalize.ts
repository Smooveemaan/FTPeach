import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  githubApi,
  isMultiPlatformVersion,
  releaseAssetNames,
  sha256,
  updaterFeedTargets,
  type Candidate,
  type PublicRun,
} from './candidate.ts';
import { PORTABLE_TARGET, withPortablePlatform } from './portable.ts';
import { validateCandidate } from './validate-candidate.ts';

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

export function tagMessage(version: string, hash: string): string {
  return `Release ${version}\n\nFTPeach candidate SHA256: ${hash}\n`;
}

export function createVersionTag(
  candidate: Candidate,
  hash: string,
  run: typeof execFileSync = execFileSync,
) {
  const { version, sha, repository } = candidate.readiness;
  const tag = `v${version}`;
  const options = { stdio: 'pipe' as const, timeout: 120_000 };
  run(
    'git',
    ['fetch', '--no-tags', '--depth=1', `https://github.com/${repository}.git`, sha],
    options,
  );
  run(
    'git',
    [
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      '-c',
      'tag.gpgSign=false',
      'tag',
      '--annotate',
      '--message',
      tagMessage(version, hash),
      tag,
      sha,
    ],
    options,
  );
  run(
    'git',
    [
      'push',
      '--no-follow-tags',
      `git@github.com:${repository}.git`,
      `refs/tags/${tag}:refs/tags/${tag}`,
    ],
    options,
  );
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
    ...Object.keys(candidate.files).filter((name) =>
      /(-setup\.exe|-portable\.zip|\.dmg|\.app\.tar\.gz|\.AppImage|\.deb)$/.test(name),
    ),
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

export async function buildReleaseFeed(
  directory: string,
  version: string,
  notes: string,
  createdAt: string,
  assets: Asset[],
) {
  const platforms: Record<string, { url: string; signature: string }> = {};
  let portableEntry: { url: string; signature: string } | undefined;
  for (const [target, fileName] of updaterFeedTargets(version)) {
    const asset = assets.find((item) => item.name === fileName);
    assert.ok(asset, `Missing uploaded asset for updater target ${target}: ${fileName}`);
    const signature = await readFile(path.join(directory, `${fileName}.sig`), 'utf8');
    if (target === PORTABLE_TARGET) {
      portableEntry = { url: asset.url, signature };
    } else {
      assert.ok(signature.trim(), `Missing updater signature for ${fileName}`);
      platforms[target] = { url: asset.url, signature: signature.trim() };
    }
  }
  assert.ok(portableEntry, 'Missing portable updater target');
  return withPortablePlatform(
    {
      version,
      notes,
      pub_date: createdAt,
      platforms,
    },
    portableEntry.url,
    portableEntry.signature,
  );
}

async function readDestination(candidate: Candidate, hash: string, notes: string) {
  const tag = `v${candidate.readiness.version}`;
  const draft = (await githubApi(`releases/tags/${tag}`, undefined, true)) as Draft | null;
  if (draft) {
    assert.equal(draft.draft, true, 'A published release cannot be resumed or changed');
    assert.equal(draft.tag_name, tag);
    assert.equal(
      draft.body.trimEnd(),
      notes.trimEnd(),
      'Existing draft belongs to a different candidate',
    );
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
  return { draft, reference };
}

type AcceptedCandidate = Awaited<ReturnType<typeof validateCandidate>>;

async function prepare(accepted?: AcceptedCandidate) {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
  accepted ??= await validateCandidate(process.env.CANDIDATE_ID!);
  const { candidate, hash, directory, installer, macos, linux, run } = accepted;
  assert.ok(installer, 'Automatic candidate acceptance is incomplete or stale');
  if (isMultiPlatformVersion(candidate.readiness.version)) {
    assert.ok(macos && linux, 'Multi-platform candidate acceptance is incomplete or stale');
  }
  verifyAttestations(
    directory,
    candidate,
    '.github/workflows/release.yml',
    execFileSync,
    candidate.build.workflowSha,
  );
  const notes = await readFile(path.join(directory, 'release-notes.md'), 'utf8');
  await readDestination(candidate, hash, notes);
  return {
    candidate,
    directory,
    hash,
    createdAt: (run as PublicRun & { created_at: string }).created_at,
  };
}

export async function publish(accepted: Awaited<ReturnType<typeof prepare>>) {
  const { candidate, directory, hash, createdAt } = accepted;
  const { version, repository } = candidate.readiness;
  const tag = `v${version}`;
  const rawNotes = await readFile(path.join(directory, 'release-notes.md'), 'utf8');
  const notes = rawNotes.trimEnd();
  const destination = await readDestination(candidate, hash, notes);
  let draft = destination.draft;
  if (!destination.reference) {
    createVersionTag(candidate, hash);
    assert.ok(
      (await readDestination(candidate, hash, notes)).reference,
      'The version tag was not created',
    );
  }
  if (!draft) {
    // An explicit target_commitish requires workflow-write permission even with an existing tag.
    draft = (await githubApi('releases', {
      tag_name: tag,
      name: `FTPeach ${tag}`,
      draft: true,
      prerelease: false,
      body: notes,
    })) as Draft;
  }
  assert.equal(draft.draft, true, 'A published release cannot be resumed or changed');
  assert.equal(draft.tag_name, tag);
  assert.equal(draft.body.trimEnd(), notes, 'Existing draft belongs to a different candidate');
  const packages = releaseAssetNames(version);
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
  const feed = await buildReleaseFeed(directory, version, rawNotes, createdAt, assets);
  await writeFile(path.join(directory, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);
  await upload('latest.json');
  const finalAssets = (await githubApi(`releases/${draft.id}/assets?per_page=100`)) as Asset[];
  for (const name of allowed) {
    const expected = sha256(await readFile(path.join(directory, name)));
    const uploaded = finalAssets.find((asset) => asset.name === name);
    assert.ok(uploaded, `Missing uploaded draft asset: ${name}`);
    assert.equal(
      uploaded.digest,
      `sha256:${expected}`,
      `Uploaded draft asset digest differs: ${name}`,
    );
  }
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY!,
    `Draft ${tag} is complete: identical accepted packages and feed verified via SHA-256 digests. The owner publishes it, then verifies the public feed.\n`,
  );
}

export async function finalizeCandidate(validated?: AcceptedCandidate) {
  assert.equal(
    process.env.GITHUB_JOB,
    'tag-and-draft',
    'Only the separately approved tag job may mutate the release',
  );
  const accepted = await prepare(validated);
  await publish(accepted);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await finalizeCandidate();
}
