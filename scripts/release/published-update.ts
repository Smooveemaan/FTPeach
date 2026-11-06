import assert from 'node:assert/strict';
import { sha256 } from './candidate.ts';

export type UpdateMode = 'installed' | 'portable';

interface PublishedRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; digest: string | null; browser_download_url: string }[];
}

export function previousPackage(releases: PublishedRelease[], version: string, mode: UpdateMode) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const compare = (a: string, b: string) => {
    const x = a.split('.').map(Number),
      y = b.split('.').map(Number);
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
  };
  const previous = releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        /^v\d+\.\d+\.\d+$/.test(release.tag_name) &&
        compare(release.tag_name.slice(1), version) < 0,
    )
    .sort((a, b) => compare(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
  assert.ok(previous, 'No previous stable published release in the latest 50 releases');
  const old = previous.tag_name.slice(1);
  const name = `FTPeach_${old}_x64-${mode === 'portable' ? 'portable.zip' : 'setup.exe'}`;
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

export function requirePublishedRunner(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32', 'Published updates require Windows');
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
  assert.ok(value === 'installed' || value === 'portable', 'Expected installed or portable mode');
  return value;
}

export function verifyPending(
  pending: { version: string; attempted: boolean; installer: string; signature: string },
  bytes: Buffer,
  version: string,
  mode: UpdateMode,
  hashes: Record<string, string>,
  signature: string,
) {
  const suffix = mode === 'portable' ? 'portable.zip' : 'setup.exe';
  assert.equal(pending.version, version);
  assert.equal(pending.attempted, false);
  assert.equal(pending.installer, `FTPeach-${version}-${suffix}`);
  assert.equal(pending.signature.trim(), signature.trim());
  assert.equal(
    sha256(bytes),
    hashes[`FTPeach_${version}_x64-${suffix}`],
    'Downloaded update bytes changed',
  );
}
