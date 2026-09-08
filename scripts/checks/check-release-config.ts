import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const configPath = new URL('../../src-tauri/tauri.conf.json', import.meta.url);
const capabilitiesPath = new URL('../../src-tauri/capabilities/default.json', import.meta.url);
const indexPath = new URL('../../index.html', import.meta.url);
const spikePublicKeyPath = new URL('../../test/fixtures/updater/spike.key.pub', import.meta.url);
const licensePath = new URL('../../LICENSE', import.meta.url);
const noticePath = new URL('../../NOTICE', import.meta.url);
const assetProvenancePath = new URL('../../docs/legal/ASSET_PROVENANCE.md', import.meta.url);
const thirdPartyNoticesPath = new URL('../../docs/legal/THIRD_PARTY_NOTICES.txt', import.meta.url);
const npmLicensesPath = new URL('../../docs/legal/NPM_THIRD_PARTY_LICENSES.txt', import.meta.url);
const rustLicensesPath = new URL('../../docs/legal/RUST_THIRD_PARTY_LICENSES.txt', import.meta.url);
const releaseWorkflowPath = new URL('../../.github/workflows/release.yml', import.meta.url);
const checksWorkflowPath = new URL('../../.github/workflows/checks.yml', import.meta.url);
const [
  configSource,
  capabilitiesSource,
  indexHtml,
  spikePublicKeySource,
  license,
  notice,
  assetProvenance,
  thirdPartyNotices,
  releaseWorkflow,
  checksWorkflow,
] = await Promise.all([
  readFile(configPath, 'utf8'),
  readFile(capabilitiesPath, 'utf8'),
  readFile(indexPath, 'utf8'),
  readFile(spikePublicKeyPath, 'utf8'),
  readFile(licensePath, 'utf8'),
  readFile(noticePath, 'utf8'),
  readFile(assetProvenancePath, 'utf8'),
  readFile(thirdPartyNoticesPath, 'utf8'),
  readFile(releaseWorkflowPath, 'utf8'),
  readFile(checksWorkflowPath, 'utf8'),
  readFile(npmLicensesPath, 'utf8'),
  readFile(rustLicensesPath, 'utf8'),
]);
const config = JSON.parse(configSource);
const capabilities = JSON.parse(capabilitiesSource);
const spikePublicKey = spikePublicKeySource.trim();
const endpoints = config?.plugins?.updater?.endpoints;
const updaterPublicKey = config?.plugins?.updater?.pubkey;

assert.equal(
  config?.bundle?.createUpdaterArtifacts,
  true,
  'Production builds must create signed Tauri updater artifacts',
);
assert.equal(config?.bundle?.license, 'Apache-2.0', 'Bundle license must match package metadata');
assert.equal(
  config?.bundle?.licenseFile,
  '../LICENSE',
  'The Apache-2.0 text must be included in bundles',
);
assert.ok(
  license.includes('Apache License') && license.includes('Version 2.0'),
  'LICENSE must contain the Apache-2.0 text',
);
assert.ok(notice.includes('THIRD_PARTY_NOTICES.txt'), 'NOTICE must point to third-party notices');
assert.ok(
  assetProvenance.includes('original works created by'),
  'Original FTPeach asset provenance must be documented',
);
for (const component of ['Lucide Icons', 'Phosphor Icons']) {
  assert.ok(thirdPartyNotices.includes(component), `Missing third-party notice for ${component}`);
}
const resources = config?.bundle?.resources;
assert.equal(typeof resources, 'object', 'Bundle legal resources must be configured');
for (const resource of [
  '../NOTICE',
  '../docs/legal/ASSET_PROVENANCE.md',
  '../docs/legal/THIRD_PARTY_NOTICES.txt',
  '../docs/legal/NPM_THIRD_PARTY_LICENSES.txt',
  '../docs/legal/RUST_THIRD_PARTY_LICENSES.txt',
]) {
  assert.ok(resource in resources, `Bundle must include ${resource}`);
}
assert.equal(typeof updaterPublicKey, 'string', 'Updater public key must be configured');
assert.ok(updaterPublicKey.trim().length > 0, 'Updater public key must not be empty');
assert.notEqual(
  updaterPublicKey.trim(),
  spikePublicKey,
  'Production updater must not use the throwaway spike signing key',
);

assert.ok(Array.isArray(endpoints) && endpoints.length > 0, 'Updater endpoints must not be empty');

for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  assert.equal(url.protocol, 'https:', `Production updater endpoint must use HTTPS: ${endpoint}`);
  assert.ok(
    !['localhost', '127.0.0.1', '::1'].includes(url.hostname),
    `Production updater endpoint must not point to a loopback host: ${endpoint}`,
  );
}

const permissions = capabilities?.permissions;
assert.ok(Array.isArray(permissions), 'Tauri capability permissions must be an array');
assert.ok(
  permissions.includes('core:webview:allow-set-webview-zoom'),
  'Interface scaling requires the WebView set-zoom permission',
);
assert.ok(!permissions.includes('core:default'), 'Do not grant the broad core:default permission');
assert.ok(
  permissions.every(
    (permission) => typeof permission !== 'string' || !permission.endsWith(':default'),
  ),
  'Do not grant broad plugin :default permissions to the renderer',
);

const csp = config?.app?.security?.csp;
assert.equal(typeof csp, 'string', 'Production CSP must be configured by Tauri');
assert.ok(csp.includes("script-src 'self'"), 'Production scripts must be restricted to self');
assert.ok(!csp.includes("'unsafe-eval'"), 'Production CSP must not allow unsafe-eval');
assert.ok(
  !/script-src[^;]*https?:/i.test(csp),
  'Production CSP must not allow external script sources',
);
assert.ok(
  !/http-equiv=["']Content-Security-Policy["']/i.test(indexHtml),
  'CSP must have one source of truth; remove the duplicate meta tag from index.html',
);

// release.yml publishes, checks.yml verifies, and a step deleted from either
// weakens the same release — so each entry names the file it has to appear in.
const requiredWorkflowEntries: [string, string, string][] = [
  [releaseWorkflow, 'release.yml', '  gates:'],
  [releaseWorkflow, 'release.yml', '    uses: ./.github/workflows/checks.yml'],
  // A tag must never settle for the path-filtered subset CI is allowed to skip.
  [releaseWorkflow, 'release.yml', '      force-all: true'],
  [releaseWorkflow, 'release.yml', '    needs: [gates, protocol-compatibility]'],
  [releaseWorkflow, 'release.yml', '    environment: release'],
  [releaseWorkflow, 'release.yml', 'run: npm run sbom:generate'],
  [releaseWorkflow, 'release.yml', 'Verify every generated updater signature'],
  [releaseWorkflow, 'release.yml', 'ftpeach-npm.cdx.json'],
  [releaseWorkflow, 'release.yml', 'ftpeach-cargo.cdx.json'],
  [checksWorkflow, 'checks.yml', '  rust-test:'],
  [checksWorkflow, 'checks.yml', '  packaged-smoke:'],
  [checksWorkflow, 'checks.yml', 'run: npm run check:release-config'],
  [checksWorkflow, 'checks.yml', 'run: npm run licenses:check'],
  [checksWorkflow, 'checks.yml', 'run: npm run check:tracked-secrets'],
  [checksWorkflow, 'checks.yml', 'run: npm audit --audit-level=high'],
  [checksWorkflow, 'checks.yml', 'run: npm run test:updater-fixtures'],
  [checksWorkflow, 'checks.yml', 'command: check advisories licenses'],
];

for (const [workflow, workflowName, requiredWorkflowEntry] of requiredWorkflowEntries) {
  assert.ok(
    workflow.includes(requiredWorkflowEntry),
    `${workflowName} must contain: ${requiredWorkflowEntry.trim()}`,
  );
}

assert.match(
  checksWorkflow,
  /uses: EmbarkStudios\/cargo-deny-action@[0-9a-f]{40} # v2/,
  'cargo-deny action must be pinned to a full commit SHA with its release tag documented',
);

console.log(
  `Release config OK: signed updater artifacts, ${endpoints.length} HTTPS updater endpoint(s), minimal capabilities and strict CSP`,
);
