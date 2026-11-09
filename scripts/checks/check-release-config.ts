import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const configPath = new URL('../../src-tauri/tauri.conf.json', import.meta.url);
const macosConfigPath = new URL('../../src-tauri/tauri.macos.conf.json', import.meta.url);
const linuxConfigPath = new URL('../../src-tauri/tauri.linux.conf.json', import.meta.url);
const infoPlistPath = new URL('../../src-tauri/Info.plist', import.meta.url);
const entitlementsPath = new URL('../../src-tauri/Entitlements.plist', import.meta.url);
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
const installerHooksPath = new URL('../../src-tauri/installer/hooks.nsh', import.meta.url);
const toolchainPath = new URL('../../rust-toolchain.toml', import.meta.url);
const [
  configSource,
  macosConfigSource,
  linuxConfigSource,
  infoPlist,
  entitlementsPlist,
  capabilitiesSource,
  indexHtml,
  spikePublicKeySource,
  license,
  notice,
  assetProvenance,
  thirdPartyNotices,
  releaseWorkflow,
  checksWorkflow,
  installerHooks,
  toolchain,
] = await Promise.all([
  readFile(configPath, 'utf8'),
  readFile(macosConfigPath, 'utf8'),
  readFile(linuxConfigPath, 'utf8'),
  readFile(infoPlistPath, 'utf8'),
  readFile(entitlementsPath, 'utf8'),
  readFile(capabilitiesPath, 'utf8'),
  readFile(indexPath, 'utf8'),
  readFile(spikePublicKeyPath, 'utf8'),
  readFile(licensePath, 'utf8'),
  readFile(noticePath, 'utf8'),
  readFile(assetProvenancePath, 'utf8'),
  readFile(thirdPartyNoticesPath, 'utf8'),
  readFile(releaseWorkflowPath, 'utf8'),
  readFile(checksWorkflowPath, 'utf8'),
  readFile(installerHooksPath, 'utf8'),
  readFile(toolchainPath, 'utf8'),
  readFile(npmLicensesPath, 'utf8'),
  readFile(rustLicensesPath, 'utf8'),
]);
const config = JSON.parse(configSource);
const macosConfig = JSON.parse(macosConfigSource);
const linuxConfig = JSON.parse(linuxConfigSource);
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
// The stock Tauri uninstaller shows a "delete the application data" checkbox,
// but its own cleanup only clears $APPDATA and $LOCALAPPDATA under the bundle
// id. FTPeach stores everything under %APPDATA%\FTPeach, so without the hook
// that checkbox is a no-op and an uninstall strands settings, sites and vault.
assert.equal(
  config?.bundle?.windows?.nsis?.installerHooks,
  'installer/hooks.nsh',
  'The uninstaller must run the FTPeach NSIS hooks so the delete-app-data checkbox works',
);
assert.ok(
  installerHooks.includes('!macro NSIS_HOOK_POSTUNINSTALL'),
  'The NSIS hooks must define the post-uninstall hook',
);
assert.ok(
  installerHooks.includes(String.raw`RMDir /r "$APPDATA\FTPeach"`),
  'The post-uninstall hook must remove the FTPeach data directory when deletion is chosen',
);
assert.ok(
  installerHooks.includes('$DeleteAppDataCheckboxState = 1') &&
    installerHooks.includes('$UpdateMode <> 1'),
  'The post-uninstall hook must keep user data unless the box is ticked on a real uninstall',
);
// The updater leaves a downloaded installer for the next launch; an uninstall
// that forgets it strands the installer after the app is gone.
assert.match(
  installerHooks,
  /RMDir \/r "\$LOCALAPPDATA\\\$(\{BUNDLEID\}|com\.smooveemaan\.ftpeach)\\updates"/,
  'A real uninstall must remove the staged update the next launch would have installed',
);
// FTPeach 0.3.0 to 0.4.0 refuse an installer without a version structure of
// 1.0, which NSIS does not write; without this their users never update.
assert.ok(
  installerHooks.includes('!finalize') && installerHooks.includes('version-info.ps1'),
  'The installer must get the version information FTPeach 0.3.0 to 0.4.0 read (version-info.ps1)',
);

// The base config ships the NSIS installer; macOS and Linux release builds pass
// dedicated overlay configs so local Windows builds never produce untested MSI bundles.
assert.deepEqual(config?.bundle?.targets, ['nsis'], 'Base bundle target must remain NSIS only');
assert.deepEqual(
  macosConfig?.bundle?.targets,
  ['app', 'dmg'],
  'macOS release overlay must bundle app and dmg',
);
assert.equal(
  macosConfig?.bundle?.macOS?.minimumSystemVersion,
  '13.3',
  'macOS minimumSystemVersion must be 13.3',
);
assert.equal(
  macosConfig?.bundle?.macOS?.entitlements,
  'Entitlements.plist',
  'macOS overlay must reference Entitlements.plist',
);
const baseWindow = config?.app?.windows?.[0];
const macWindow = macosConfig?.app?.windows?.[0];
assert.ok(
  Array.isArray(macosConfig?.app?.windows) && macosConfig.app.windows.length === 1,
  'macOS overlay config must define the windows array in its entirety',
);
const baseProps = { ...baseWindow };
delete baseProps.decorations;
const macProps = { ...macWindow };
assert.equal(macProps.decorations, true, 'macOS window decorations must be true');
assert.equal(macProps.titleBarStyle, 'Overlay', 'macOS window titleBarStyle must be Overlay');
assert.equal(macProps.hiddenTitle, true, 'macOS window hiddenTitle must be true');
delete macProps.decorations;
delete macProps.titleBarStyle;
delete macProps.hiddenTitle;
assert.deepEqual(
  macProps,
  baseProps,
  'macOS window definition must replicate all base window properties because Merge Patch replaces arrays',
);
assert.deepEqual(
  linuxConfig?.bundle?.targets,
  ['deb', 'appimage'],
  'Linux release overlay must bundle deb and appimage',
);
assert.deepEqual(linuxConfig?.bundle?.linux?.deb?.depends, [
  'libwebkit2gtk-4.1-0',
  'libayatana-appindicator3-1',
]);
assert.ok(
  infoPlist.includes('NSAppleEventsUsageDescription') &&
    infoPlist.includes('NSLocalNetworkUsageDescription'),
  'Info.plist must declare AppleEvents and LocalNetwork usage descriptions',
);
assert.ok(
  entitlementsPlist.includes('com.apple.security.automation.apple-events'),
  'Entitlements.plist must declare com.apple.security.automation.apple-events',
);
assert.ok(
  toolchain.includes('aarch64-apple-darwin') && toolchain.includes('x86_64-apple-darwin'),
  'rust-toolchain.toml must declare universal macOS targets (aarch64-apple-darwin and x86_64-apple-darwin)',
);

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
  permissions.includes('allow-app-set-interface-scale'),
  'Interface scaling requires the bounded app scale command',
);
assert.ok(
  !permissions.includes('core:webview:allow-set-webview-zoom'),
  'Direct WebView zoom bypasses native DPI compensation',
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

// Keep signing, immutable packages, acceptance and deploy in the same guarded chain.
const ciWorkflow = await readFile(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);
assert.ok(ciWorkflow.includes('needs: [mode, checks, private-check]'));
assert.ok(ciWorkflow.includes("if: needs.mode.outputs.release == 'true'"));
assert.ok(ciWorkflow.includes('uses: ./.github/workflows/release.yml'));
assert.doesNotMatch(
  releaseWorkflow,
  /\n {2}push:|skip-private-suites|--clobber|\.release-tools|record-manual|manual-acceptance/,
);
assert.match(
  releaseWorkflow,
  / {2}tag-and-draft:\r?\n {4}needs: \[build-windows, acceptance, acceptance-macos, acceptance-linux\]\r?\n {4}if: always\(\) && github\.ref == 'refs\/heads\/master' && !contains\(needs\.\*\.result, 'failure'\) && !contains\(needs\.\*\.result, 'cancelled'\) && \(github\.event_name == 'push' \|\| inputs\.operation == 'deploy'\)/,
  'Saved-candidate deploy must run after automatic acceptance across all target platforms or skipped build jobs on deploy without failures',
);
const requiredWorkflowEntries: [string, string, string][] = [
  [releaseWorkflow, 'release.yml', '  workflow_call:'],
  [releaseWorkflow, 'release.yml', '  build-macos:'],
  [releaseWorkflow, 'release.yml', '  build-linux:'],
  [releaseWorkflow, 'release.yml', '  build-windows:'],
  [releaseWorkflow, 'release.yml', '  acceptance-macos:'],
  [releaseWorkflow, 'release.yml', '  acceptance-linux:'],
  [releaseWorkflow, 'release.yml', '    environment: release'],
  [releaseWorkflow, 'release.yml', '    environment: release-tag'],
  [releaseWorkflow, 'release.yml', 'npm run tauri -- build --bundles nsis'],
  [
    releaseWorkflow,
    'release.yml',
    'npm run tauri -- build --target universal-apple-darwin --config src-tauri/tauri.macos.conf.json --bundles app,dmg',
  ],
  [
    releaseWorkflow,
    'release.yml',
    'npm run tauri -- build --config src-tauri/tauri.linux.conf.json --bundles deb,appimage',
  ],
  [releaseWorkflow, 'release.yml', 'scripts/release/msix.ts build'],
  [releaseWorkflow, 'release.yml', 'scripts/release/unix-acceptance.ts release-candidate --macos'],
  [releaseWorkflow, 'release.yml', 'scripts/release/unix-acceptance.ts release-candidate --linux'],
  [releaseWorkflow, 'release.yml', 'run: npm run sbom:generate'],
  [releaseWorkflow, 'release.yml', 'Verify every updater signature'],
  [releaseWorkflow, 'release.yml', 'uses: ./.github/workflows/installer.yml'],
  [
    releaseWorkflow,
    'release.yml',
    'needs: [build-windows, acceptance, acceptance-macos, acceptance-linux]',
  ],
  [
    releaseWorkflow,
    'release.yml',
    'candidate-artifact: ${{ needs.build-windows.outputs.artifact }}',
  ],
  [
    releaseWorkflow,
    'release.yml',
    'candidate-id: ${{ needs.build-windows.outputs.candidate-id || inputs.candidate-id }}',
  ],
  [releaseWorkflow, 'release.yml', 'scripts/release/check-release-environment.ts release'],
  [releaseWorkflow, 'release.yml', 'scripts/release/check-release-environment.ts release-tag'],
  [releaseWorkflow, 'release.yml', 'RELEASE_TAG_KEY: ${{ secrets.RELEASE_TAG_KEY }}'],
  [releaseWorkflow, 'release.yml', 'StrictHostKeyChecking=yes'],
  [releaseWorkflow, 'release.yml', 'scripts/release/release-trust-report.ts'],
  [releaseWorkflow, 'release.yml', 'uses: actions/attest-build-provenance@'],
  [releaseWorkflow, 'release.yml', 'scripts/release/portable.ts build'],
  [
    releaseWorkflow,
    'release.yml',
    'npm run tauri -- signer sign src-tauri/target/release/bundle/portable/*-portable.zip',
  ],
  [releaseWorkflow, 'release.yml', 'ftpeach-npm.cdx.json'],
  [releaseWorkflow, 'release.yml', 'ftpeach-cargo.cdx.json'],
  [releaseWorkflow, 'release.yml', 'APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}'],
  [releaseWorkflow, 'release.yml', 'APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}'],
  [releaseWorkflow, 'release.yml', 'xcrun stapler validate'],
  [checksWorkflow, 'checks.yml', '  rust-test:'],
  [checksWorkflow, 'checks.yml', '  packaged-smoke:'],
  [checksWorkflow, 'checks.yml', 'run: npm run check:release-config'],
  // Without this step a new app command can ship with no ACL decision at all.
  [checksWorkflow, 'checks.yml', 'run: npm run check:command-acl'],
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

const buildWindowsSection = releaseWorkflow.slice(releaseWorkflow.indexOf('  build-windows:'));
assert.ok(
  buildWindowsSection.indexOf('signer sign') <
    buildWindowsSection.indexOf('Verify every updater signature'),
);
assert.ok(
  buildWindowsSection.indexOf('Check release controller') <
    buildWindowsSection.indexOf('npm run tauri -- build --bundles nsis'),
);
assert.ok(
  buildWindowsSection.indexOf('Verify every updater signature') <
    buildWindowsSection.indexOf('uses: actions/attest-build-provenance@') &&
    buildWindowsSection.indexOf('uses: actions/attest-build-provenance@') <
      buildWindowsSection.indexOf('  acceptance:'),
);

assert.match(
  checksWorkflow,
  /uses: EmbarkStudios\/cargo-deny-action@[0-9a-f]{40} # v2/,
  'cargo-deny action must be pinned to a full commit SHA with its release tag documented',
);

console.log(
  `Release config OK: signed updater artifacts, ${endpoints.length} HTTPS updater endpoint(s), minimal capabilities, strict CSP and an opt-in app-data uninstall`,
);
