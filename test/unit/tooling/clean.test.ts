import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clean, cleanTargets } from '../../../scripts/clean.ts';

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ftpeach-clean-'));
  for (const dir of ['src-tauri/target/debug', 'dist', 'coverage/rust', '.local', 'node_modules']) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  return root;
}

test('clean removes output and keeps .local and node_modules', () => {
  const root = workspace();
  try {
    clean(cleanTargets(root, undefined), { artifactsOnly: false, dryRun: false });
    assert.equal(existsSync(path.join(root, 'src-tauri/target')), false);
    assert.equal(existsSync(path.join(root, 'dist')), false);
    assert.equal(existsSync(path.join(root, 'coverage')), false);
    assert.equal(existsSync(path.join(root, '.local')), true);
    assert.equal(existsSync(path.join(root, 'node_modules')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--artifacts-only keeps the Cargo caches and --dry-run removes nothing', () => {
  const root = workspace();
  try {
    clean(cleanTargets(root, undefined), { artifactsOnly: false, dryRun: true });
    assert.equal(existsSync(path.join(root, 'dist')), true);
    clean(cleanTargets(root, undefined), { artifactsOnly: true, dryRun: false });
    assert.equal(existsSync(path.join(root, 'src-tauri/target/debug')), true);
    assert.equal(existsSync(path.join(root, 'dist')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean refuses a target that is a link', () => {
  const root = workspace();
  const outside = mkdtempSync(path.join(tmpdir(), 'ftpeach-clean-outside-'));
  try {
    rmSync(path.join(root, 'dist'), { recursive: true });
    symlinkSync(outside, path.join(root, 'dist'), 'junction');
    assert.throws(
      () => clean(cleanTargets(root, undefined), { artifactsOnly: true, dryRun: false }),
      /symbolic link or junction/,
    );
    assert.equal(existsSync(outside), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
