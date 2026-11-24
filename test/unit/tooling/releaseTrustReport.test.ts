import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test(
  'trust report reads Authenticode with the PowerShell 7 module environment',
  {
    skip: process.platform !== 'win32',
  },
  (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'release-trust-report-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const name of ['bundle/nsis', 'docs', 'src-tauri']) {
      mkdirSync(path.join(directory, name), { recursive: true });
    }
    copyFileSync(process.execPath, path.join(directory, 'FTPeach.exe'));
    copyFileSync(process.execPath, path.join(directory, 'bundle/nsis/test-setup.exe'));
    for (const name of [
      'docs/rust-advisories.md',
      'docs/release-trust.md',
      'src-tauri/deny.toml',
    ]) {
      copyFileSync(new URL(`../../../${name}`, import.meta.url), path.join(directory, name));
    }
    const modulePath = execFileSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', '$env:PSModulePath'],
      {
        encoding: 'utf8',
      },
    ).trim();
    const script = fileURLToPath(
      new URL('../../../scripts/release/release-trust-report.ts', import.meta.url),
    );
    const child = spawnSync(process.execPath, ['--experimental-strip-types', script, directory], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PSModulePath: modulePath,
        TAURI_SIGNING_PRIVATE_KEY: '',
        GITHUB_STEP_SUMMARY: '',
      },
    });
    const report = readFileSync(path.join(directory, 'release/release-trust-report.md'), 'utf8');
    assert.match(report, /test-setup\.exe: /);
    assert.match(report, /FTPeach\.exe: /);
    assert.equal(child.status, report.includes('**FAIL**') ? 1 : 0, child.stderr);
  },
);

test('trust report scans platform packages and aggregates fragments without Windows runner', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'release-trust-aggregate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['candidate', 'macos', 'meta', 'docs', 'src-tauri']) {
    mkdirSync(path.join(directory, name), { recursive: true });
  }
  for (const name of ['docs/rust-advisories.md', 'docs/release-trust.md', 'src-tauri/deny.toml']) {
    copyFileSync(new URL(`../../../${name}`, import.meta.url), path.join(directory, name));
  }
  const secret = 'A'.repeat(40);
  writeFileSync(path.join(directory, 'macos/FTPeach_0.7.0_universal.dmg'), 'clean-dmg');
  writeFileSync(path.join(directory, 'candidate/FTPeach_0.7.0_x64-setup.exe'), 'setup');
  writeFileSync(path.join(directory, 'candidate/FTPeach_0.7.0_x64-setup.exe.sig'), 'sig');
  writeFileSync(
    path.join(directory, 'meta/trust-windows.json'),
    JSON.stringify({
      extraDigests: [{ file: 'FTPeach.exe', sha256: 'a'.repeat(64) }],
      authenticode: [{ ok: true, summary: 'FTPeach.exe: not Authenticode-signed' }],
      scannedCount: 3,
      secretProvided: true,
      problems: [],
    }),
  );
  const script = fileURLToPath(
    new URL('../../../scripts/release/release-trust-report.ts', import.meta.url),
  );
  const scan = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      script,
      '--scan',
      path.join(directory, 'macos'),
      path.join(directory, 'meta/trust-macos.json'),
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: secret, GITHUB_STEP_SUMMARY: '' },
    },
  );
  assert.equal(scan.status, 0, scan.stderr);

  const aggregate = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      script,
      '--aggregate',
      path.join(directory, 'candidate'),
      path.join(directory, 'meta/trust-windows.json'),
      path.join(directory, 'meta/trust-macos.json'),
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: '', GITHUB_STEP_SUMMARY: '' },
    },
  );
  assert.equal(aggregate.status, 0, aggregate.stderr);
  const report = readFileSync(path.join(directory, 'release/release-trust-report.md'), 'utf8');
  assert.match(report, /FTPeach\.exe/);
  assert.match(report, /FTPeach_0\.7\.0_x64-setup\.exe/);
  assert.match(report, /Not found in 4 file\(s\)\n/);

  writeFileSync(path.join(directory, 'macos/leaked.dmg'), `prefix-${secret}-suffix`);
  const leaked = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      script,
      '--scan',
      path.join(directory, 'macos'),
      path.join(directory, 'meta/trust-leaked.json'),
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: secret, GITHUB_STEP_SUMMARY: '' },
    },
  );
  assert.equal(leaked.status, 1);
  assert.match(leaked.stderr, /contains the updater private key/);
});
