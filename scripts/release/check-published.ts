import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateNames, githubApi, sha256, type Candidate, type PublicRun } from './candidate.ts';
import { validateTag, verifyAttestations } from './finalize.ts';
import { downloadArtifact, validateOrigin, type Artifact } from './validate-candidate.ts';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyUpdaterSignature(
  encodedPublicKey: string,
  content: Buffer,
  encodedSignature: string,
) {
  const pubLines = Buffer.from(encodedPublicKey.trim(), 'base64')
    .toString('utf8')
    .trim()
    .split(/\r?\n/);
  assert.equal(pubLines.length, 2, 'Invalid minisign public key format');
  assert.ok(pubLines[0]!.startsWith('untrusted comment: '), 'Missing public key untrusted comment');
  const pubBin = Buffer.from(pubLines[1]!, 'base64');
  assert.equal(pubBin.length, 42, 'Invalid minisign public key length');
  assert.equal(pubBin.subarray(0, 2).toString('ascii'), 'Ed', 'Unsupported public key algorithm');

  const sigLines = Buffer.from(encodedSignature.trim(), 'base64')
    .toString('utf8')
    .trim()
    .split(/\r?\n/);
  assert.equal(sigLines.length, 4, 'Invalid minisign signature format');
  assert.ok(sigLines[0]!.startsWith('untrusted comment: '), 'Missing signature untrusted comment');
  const sigBin = Buffer.from(sigLines[1]!, 'base64');
  assert.equal(sigBin.length, 74, 'Invalid minisign signature length');
  const alg = sigBin.subarray(0, 2).toString('ascii');
  assert.ok(alg === 'Ed' || alg === 'ED', `Unsupported minisign signature algorithm: ${alg}`);
  assert.ok(
    pubBin.subarray(2, 10).equals(sigBin.subarray(2, 10)),
    'Updater signature key ID does not match public key',
  );
  assert.ok(sigLines[2]!.startsWith('trusted comment: '), 'Missing signature trusted comment');
  const globalSig = Buffer.from(sigLines[3]!, 'base64');
  assert.equal(globalSig.length, 64, 'Invalid minisign global signature length');

  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, pubBin.subarray(10, 42)]),
    format: 'der',
    type: 'spki',
  });
  const payload = alg === 'ED' ? createHash('blake2b512').update(content).digest() : content;
  const signature = sigBin.subarray(10, 74);
  assert.ok(verify(null, payload, key, signature), 'Updater signature verification failed');
  const trustedComment = Buffer.from(sigLines[2]!.slice('trusted comment: '.length), 'utf8');
  assert.ok(
    verify(null, Buffer.concat([signature, trustedComment]), key, globalSig),
    'Updater trusted comment signature verification failed',
  );
}

export function validatePublicFeed(
  feed: { version: string; platforms: Record<string, { url: string; signature: string }> },
  candidate: { readiness: { version: string }; files: Record<string, string> },
  assets: { name: string; url: string }[],
) {
  assert.equal(feed.version, candidate.readiness.version);
  assert.deepEqual(Object.keys(feed.platforms).sort(), [
    'windows-x86_64',
    'windows-x86_64-portable',
  ]);
  for (const [platform, suffix] of [
    ['windows-x86_64', 'setup.exe'],
    ['windows-x86_64-portable', 'portable.zip'],
  ]) {
    const name = `FTPeach_${feed.version}_x64-${suffix}`;
    assert.equal(feed.platforms[platform!]!.url, assets.find((asset) => asset.name === name)?.url);
    const signature = feed.platforms[platform!]!.signature;
    assert.ok(signature.trim());
    assert.ok(
      [signature, `${signature}\n`, `${signature}\r\n`].some(
        (text) => sha256(text) === candidate.files[`${name}.sig`],
      ),
      'Public feed signature differs from accepted bytes',
    );
  }
}

async function resolvePublishedCandidate(tagName: string, directory: string): Promise<Candidate> {
  const reference = (await githubApi(`git/ref/tags/${tagName}`)) as {
    object: { type: string; sha: string };
  };
  assert.equal(reference.object.type, 'tag', 'Published release tag must be an annotated tag');
  const tag = (await githubApi(`git/tags/${reference.object.sha}`)) as Parameters<
    typeof validateTag
  >[0];
  const hashMatch = tag.message.match(/FTPeach candidate SHA256: ([0-9a-f]{64})\b/);
  assert.ok(hashMatch?.[1], 'Release tag is missing candidate SHA256');
  const expectedHash = hashMatch[1];

  const { artifacts } = (await githubApi('actions/artifacts?per_page=100')) as {
    artifacts: Artifact[];
  };
  const candidates = artifacts
    .filter((item) => !item.expired && /^release-candidate-[1-9][0-9]*$/.test(item.name))
    .sort((a, b) => b.id - a.id);

  for (const artifact of candidates) {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'published-candidate-'));
    downloadArtifact(artifact, tempDir);
    const manifest = await readFile(path.join(tempDir, 'candidate.json'));
    if (sha256(manifest) !== expectedHash) continue;
    const run = (await githubApi(`actions/runs/${artifact.workflow_run.id}`)) as PublicRun;
    validateOrigin(run, String(artifact.workflow_run.id), process.env.GITHUB_REPOSITORY!);
    const candidate = JSON.parse(manifest.toString()) as Candidate;
    validateTag(tag, candidate, expectedHash);
    await writeFile(path.join(directory, 'candidate.json'), manifest);
    return candidate;
  }
  assert.fail(`No retained release-candidate artifact matches tag ${tagName} (${expectedHash})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, 'utf8'));
  assert.equal(event.action, 'published');
  assert.equal(event.release.draft, false);
  const release = (await githubApi(`releases/${event.release.id}`)) as {
    tag_name: string;
    assets: { name: string; url: string; browser_download_url: string }[];
  };
  const directory = 'published-release';
  await mkdir(directory, { recursive: true });
  for (const asset of release.assets) {
    assert.match(asset.name, /^[a-zA-Z0-9_.-]+$/);
    const response = await fetch(asset.browser_download_url, {
      signal: AbortSignal.timeout(120_000),
    });
    assert.ok(response.ok, `Public asset ${asset.name}: HTTP ${response.status}`);
    await writeFile(`${directory}/${asset.name}`, Buffer.from(await response.arrayBuffer()));
  }
  const candidate = await resolvePublishedCandidate(release.tag_name, directory);
  assert.equal(candidate.schema, 1);
  assert.match(candidate.readiness.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    Object.keys(candidate.files).sort(),
    candidateNames(candidate.readiness.version).sort(),
  );
  assert.deepEqual(
    release.assets.map((asset) => asset.name).sort(),
    [
      `FTPeach_${candidate.readiness.version}_x64-setup.exe`,
      `FTPeach_${candidate.readiness.version}_x64-portable.zip`,
      'release-audit.zip',
      'latest.json',
    ].sort(),
  );
  assert.equal(
    candidate.readiness.repository.toLowerCase(),
    process.env.GITHUB_REPOSITORY!.toLowerCase(),
  );
  assert.equal(release.tag_name, `v${candidate.readiness.version}`);
  for (const [name, hash] of Object.entries(candidate.files).filter(
    ([name]) => !name.endsWith('.sig') && name !== 'release-notes.md',
  ))
    assert.equal(sha256(await readFile(`${directory}/${name}`)), hash, `Published ${name} changed`);
  const publicFeed = await fetch(
    `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/latest/download/latest.json`,
    { signal: AbortSignal.timeout(60_000) },
  );
  assert.ok(publicFeed.ok, `Public feed: HTTP ${publicFeed.status}`);
  const feed = (await publicFeed.json()) as Parameters<typeof validatePublicFeed>[0];
  assert.deepEqual(feed, JSON.parse(await readFile(`${directory}/latest.json`, 'utf8')));
  validatePublicFeed(feed, candidate, release.assets);
  verifyAttestations(
    directory,
    candidate,
    '.github/workflows/release.yml',
    execFileSync,
    candidate.build.workflowSha,
  );
  const config = (await githubApi(
    `contents/src-tauri/tauri.conf.json?ref=${candidate.readiness.sha}`,
  )) as { content: string };
  const key = JSON.parse(Buffer.from(config.content, 'base64').toString()).plugins.updater.pubkey;
  for (const [platform, suffix] of [
    ['windows-x86_64', 'setup.exe'],
    ['windows-x86_64-portable', 'portable.zip'],
  ]) {
    const file = `${directory}/FTPeach_${feed.version}_x64-${suffix}`;
    const signature = feed.platforms[platform!]!.signature;
    await writeFile(`${file}.sig`, signature);
    verifyUpdaterSignature(key, await readFile(file), signature);
  }
  const page = await fetch('https://ftpeach.com/', { signal: AbortSignal.timeout(60_000) });
  assert.ok(page.ok, `Public Pages: HTTP ${page.status}`);
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY!,
    `Published ${release.tag_name}: public packages, manifest, updater signatures, feed and Pages availability passed. Real installed/portable updates from this public feed still require the owner's verification.\n`,
  );
}
