import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../../../scripts/release/candidate.ts';
import {
  requirePublishedRunner,
  updateMode,
  verifyPending,
  previousPackage,
  downloadPrevious,
  profileData,
} from '../../../scripts/release/published-update.ts';

const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };
test('published update automation refuses local/self-hosted/non-Windows and modified transport', () => {
  requirePublishedRunner(hosted, 'win32');
  for (const env of [
    {},
    { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' },
    ...[
      'HTTPS_PROXY',
      'http_proxy',
      'ALL_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
      'FTPEACH_SMOKE_TEST',
    ].map((name) => ({ ...hosted, [name]: 'override' })),
  ]) {
    assert.throws(() => requirePublishedRunner(env, 'win32'));
  }
  assert.throws(() => requirePublishedRunner(hosted, 'linux'));
  assert.equal(updateMode('installed'), 'installed');
  assert.equal(updateMode('portable'), 'portable');
  assert.throws(() => updateMode(undefined));
  assert.throws(() => updateMode('../portable'));
});

for (const mode of ['installed', 'portable'] as const) {
  test(`${mode} staging rejects wrong version, attempted install, unsafe name, signature and bytes`, () => {
    const suffix = mode === 'installed' ? 'setup.exe' : 'portable.zip';
    const bytes = Buffer.from('mock package boundary, not a real updater');
    const pending = {
      version: '1.2.3',
      attempted: false,
      installer: `FTPeach-1.2.3-${suffix}`,
      signature: 'signed',
    };
    const hashes = { [`FTPeach_1.2.3_x64-${suffix}`]: sha256(bytes) };
    const verify = (value = pending, body = bytes) =>
      verifyPending(value, body, '1.2.3', mode, hashes, 'signed\n');
    verify();
    for (const patch of [
      { version: '1.2.4' },
      { attempted: true },
      { installer: '../setup.exe' },
      { signature: 'other' },
    ]) {
      assert.throws(() => verify({ ...pending, ...patch }));
    }
    assert.throws(() => verify(pending, Buffer.from('corrupted')));
    assert.throws(() => verifyPending(pending, bytes, '1.2.3', mode, {}, 'signed'));
  });
}

const oldBytes = Buffer.from('mock previous published package');
const release = (version = '0.6.0') => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: ['setup.exe', 'portable.zip'].map((suffix) => ({
    name: `FTPeach_${version}_x64-${suffix}`,
    digest: `sha256:${sha256(oldBytes)}`,
    browser_download_url: `https://github.com/Smooveemaan/FTPeach/releases/download/v${version}/FTPeach_${version}_x64-${suffix}`,
  })),
});

test('selects the newest older stable release across version lines; missing evidence fails without falling back', () => {
  const releases = [
    release('0.6.0'),
    release('0.6.9'),
    release('0.6.10'),
    release('0.6.11'),
    { ...release('0.6.12'), draft: true },
    { ...release('0.6.13'), prerelease: true },
  ];
  assert.equal(previousPackage(releases, '0.6.11', 'portable').version, '0.6.10');
  assert.equal(
    previousPackage([release('0.6.11'), release('0.7.0')], '0.7.1', 'portable').version,
    '0.7.0',
  );
  for (const broken of [
    { ...release(), assets: [] },
    { ...release(), assets: release().assets.map((asset) => ({ ...asset, digest: null })) },
    {
      ...release(),
      assets: release().assets.map((asset) => ({
        ...asset,
        browser_download_url: 'https://example.com/package',
      })),
    },
  ]) {
    assert.throws(() => previousPackage([broken], '0.8.0', 'portable'));
  }
  assert.throws(() => previousPackage([], '0.6.1', 'installed'));
  assert.throws(() =>
    previousPackage([release('0.6.0'), { ...release('0.6.1'), assets: [] }], '0.6.2', 'portable'),
  );
});

for (const mode of ['installed', 'portable'] as const) {
  test(`${mode} previous download requires authenticated metadata and matching bytes (mock network only)`, async () => {
    for (const fault of ['none', 'metadata-http', 'asset-http', 'corrupt']) {
      const request: typeof fetch = async (url, options) => {
        assert.ok(options?.signal);
        if (String(url).startsWith('https://api.github.com/')) {
          return Response.json([release()], { status: fault === 'metadata-http' ? 503 : 200 });
        }
        assert.equal(
          String(url),
          release().assets[mode === 'installed' ? 0 : 1]!.browser_download_url,
        );
        assert.equal(
          options?.headers,
          undefined,
          'Do not forward API authorization to asset redirects',
        );
        return new Response(fault === 'corrupt' ? 'bad bytes' : oldBytes, {
          status: fault === 'asset-http' ? 404 : 200,
        });
      };
      const result = downloadPrevious('0.6.1', mode, request);
      if (fault === 'none') assert.deepEqual((await result).bytes, oldBytes);
      else await assert.rejects(result);
    }
  });
}

test('profile comparison ignores serialization and runtime/backups while retaining all bookmark fields', () => {
  const files = {
    'sites.json': '{"schemaVersion":1,"data":[{"id":"saved","name":"Bookmark","enc":"sealed"}]}',
    'local-paths.json': '{"schemaVersion":1,"data":[]}',
    'known_hosts.json': '{"schemaVersion":1,"data":{"host":"fingerprint"}}',
  };
  const actual = {
    ...files,
    'tabs.json': 'runtime state',
    'sites.last-good.bak': 'backup',
    'sites.json':
      '{ "data": [ { "enc": "sealed", "name": "Bookmark", "id": "saved" } ], "schemaVersion": 1 }',
  };
  assert.deepEqual(profileData(actual), profileData(files));
  assert.notDeepEqual(
    profileData({ ...files, 'sites.json': files['sites.json'].replace('sealed', 'lost') }),
    profileData(files),
  );
  assert.throws(() => profileData({}));
});
