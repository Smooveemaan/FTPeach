import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    copyFileSync(process.execPath, path.join(directory, 'app.exe'));
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
    assert.match(report, /app\.exe: /);
    assert.equal(child.status, report.includes('**FAIL**') ? 1 : 0, child.stderr);
  },
);
