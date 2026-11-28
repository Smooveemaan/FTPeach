import assert from 'node:assert/strict';
import { sha256 } from './candidate.ts';

export type UpdateMode = 'installed' | 'portable' | 'macos' | 'appimage' | 'deb';

export interface PublishedRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; digest: string | null; browser_download_url: string }[];
}

export interface PublicUpdateFeed {
  version: string;
  platforms: Record<string, { url: string; signature: string }>;
}

const MODES: readonly UpdateMode[] = ['installed', 'portable', 'macos', 'appimage', 'deb'];

export function previousAssetName(version: string, mode: UpdateMode): string {
  switch (mode) {
    case 'installed':
      return `FTPeach_${version}_x64-setup.exe`;
    case 'portable':
      return `FTPeach_${version}_x64-portable.zip`;
    case 'macos':
      return `FTPeach_${version}_universal.dmg`;
    case 'appimage':
      return `FTPeach_${version}_amd64.AppImage`;
    case 'deb':
      return `FTPeach_${version}_amd64.deb`;
  }
}

export function candidateAssetName(version: string, mode: UpdateMode): string {
  return mode === 'macos'
    ? `FTPeach_${version}_universal.app.tar.gz`
    : previousAssetName(version, mode);
}

export function stagedInstallerName(version: string, mode: UpdateMode): string {
  switch (mode) {
    case 'installed':
      return `FTPeach-${version}-setup.exe`;
    case 'portable':
      return `FTPeach-${version}-portable.zip`;
    case 'macos':
      return `FTPeach-${version}.app.tar.gz`;
    case 'appimage':
      return `FTPeach-${version}.AppImage`;
    case 'deb':
      return `FTPeach-${version}.deb`;
  }
}

export function feedPlatforms(mode: UpdateMode): readonly string[] {
  switch (mode) {
    case 'installed':
      return ['windows-x86_64'];
    case 'portable':
      return ['windows-x86_64-portable'];
    case 'macos':
      return ['darwin-aarch64', 'darwin-x86_64'];
    case 'appimage':
      return ['linux-x86_64'];
    case 'deb':
      return ['linux-x86_64-deb'];
  }
}

export function feedSignature(
  feed: PublicUpdateFeed,
  version: string,
  mode: UpdateMode,
  hashes: Record<string, string>,
): string {
  assert.equal(feed.version, version);
  const sigName = `${candidateAssetName(version, mode)}.sig`;
  const expectedHash = hashes[sigName];
  assert.ok(expectedHash, `Missing candidate signature hash for ${sigName}`);
  let signature: string | undefined;
  for (const platform of feedPlatforms(mode)) {
    const entry = feed.platforms[platform];
    assert.ok(entry, `Missing public feed entry for ${platform}`);
    assert.ok(entry.signature.trim(), `Missing public feed signature for ${platform}`);
    assert.ok(
      [entry.signature, `${entry.signature}\n`, `${entry.signature}\r\n`].some(
        (text) => sha256(text) === expectedHash,
      ),
      `Public feed signature for ${platform} differs from accepted candidate`,
    );
    if (signature === undefined) signature = entry.signature;
    else assert.equal(entry.signature.trim(), signature.trim());
  }
  assert.ok(signature);
  return signature;
}

export function expectedRunnerPlatform(mode: UpdateMode): 'win32' | 'darwin' | 'linux' {
  if (mode === 'macos') return 'darwin';
  if (mode === 'appimage' || mode === 'deb') return 'linux';
  return 'win32';
}

export function previousStableRelease(
  releases: PublishedRelease[],
  version: string,
): PublishedRelease | undefined {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const compare = (a: string, b: string) => {
    const x = a.split('.').map(Number),
      y = b.split('.').map(Number);
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
  };
  return releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        /^v\d+\.\d+\.\d+$/.test(release.tag_name) &&
        compare(release.tag_name.slice(1), version) < 0,
    )
    .sort((a, b) => compare(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
}

export function previousPackage(releases: PublishedRelease[], version: string, mode: UpdateMode) {
  const previous = previousStableRelease(releases, version);
  assert.ok(previous, 'No previous stable published release in the latest 50 releases');
  const old = previous.tag_name.slice(1);
  const name = previousAssetName(old, mode);
  const asset = previous.assets.find((entry) => entry.name === name);
  assert.ok(asset, `Previous release ${old} has no ${name}; do not substitute another release`);
  assert.match(
    asset.digest ?? '',
    /^sha256:[0-9a-f]{64}$/,
    `Previous ${name} has no authenticated GitHub SHA-256 digest`,
  );
  assert.equal(
    asset.browser_download_url,
    `https://github.com/Smooveemaan/FTPeach/releases/download/v${old}/${name}`,
  );
  return { version: old, name, url: asset.browser_download_url, sha256: asset.digest!.slice(7) };
}

export async function downloadPrevious(version: string, mode: UpdateMode, request = fetch) {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await request(
    'https://api.github.com/repos/Smooveemaan/FTPeach/releases?per_page=50',
    {
      headers,
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.ok(response.ok, `Previous releases: HTTP ${response.status}`);
  const previous = previousPackage((await response.json()) as PublishedRelease[], version, mode);
  const download = await request(previous.url, { signal: AbortSignal.timeout(120_000) });
  assert.ok(download.ok, `Previous package: HTTP ${download.status}`);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(sha256(bytes), previous.sha256, 'Previous published package digest mismatch');
  return { ...previous, bytes };
}

export function profileData(files: Record<string, string | Buffer>) {
  return Object.fromEntries(
    ['sites.json', 'local-paths.json', 'known_hosts.json'].map((name) => {
      assert.ok(files[name], `Missing preserved profile file: ${name}`);
      return [name, JSON.parse(String(files[name])).data as unknown];
    }),
  );
}

export function requirePublishedRunner(
  env = process.env,
  platform: string = process.platform,
  expectedPlatform: 'win32' | 'darwin' | 'linux' = 'win32',
) {
  assert.equal(platform, expectedPlatform, `Published updates require ${expectedPlatform}`);
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(
    env.RUNNER_ENVIRONMENT,
    'github-hosted',
    'Only disposable hosted runners are allowed',
  );
  for (const [name, value] of Object.entries(env)) {
    assert.ok(
      !value ||
        !/^(https?_proxy|all_proxy|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir|webview2_additional_browser_arguments|ftpeach_smoke_test)$/i.test(
          name,
        ),
      `Unexpected updater environment override: ${name}`,
    );
  }
}

export function updateMode(value: string | undefined): UpdateMode {
  assert.ok(
    value && (MODES as readonly string[]).includes(value),
    `Expected update mode (${MODES.join(', ')})`,
  );
  return value as UpdateMode;
}

export function verifyPending(
  pending: { version: string; attempted: boolean; installer: string; signature: string },
  bytes: Buffer,
  version: string,
  mode: UpdateMode,
  hashes: Record<string, string>,
  signature: string,
) {
  assert.equal(pending.version, version);
  assert.equal(pending.attempted, false);
  assert.equal(pending.installer, stagedInstallerName(version, mode));
  assert.equal(pending.signature.trim(), signature.trim());
  assert.equal(
    sha256(bytes),
    hashes[candidateAssetName(version, mode)],
    'Downloaded update bytes changed',
  );
}
