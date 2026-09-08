import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { runRustBoundaryCheck } from '../../../scripts/checks/check-rust-boundaries.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ftpeach-rust-boundaries-'));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function writeSource(relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

/** The modules a fixture names, so a crate path resolves to something real. */
async function writeCrateSkeleton(): Promise<void> {
  await writeSource('ipc.rs', `pub enum OkResult {}\n`);
  await writeSource('commands/fs.rs', `pub fn ok() {}\n`);
  await writeSource('commands/session.rs', `pub const NO_SESSION: &str = "";\n`);
  await writeSource('commands/settings.rs', `pub fn apply_speed_limit() {}\n`);
}

test('a domain zone importing the wire types is allowed', async () => {
  await writeCrateSkeleton();
  await writeSource('local_fs/fs_delete.rs', `use crate::ipc::{OkResult, err, ok};\n`);

  const { errors } = runRustBoundaryCheck(root);
  assert.deepEqual(errors, []);
});

test('a domain zone importing crate::commands is rejected', async () => {
  await writeCrateSkeleton();
  await writeSource('local_fs/fs_delete.rs', `use crate::commands::fs::{OkResult, err, ok};\n`);

  const { errors } = runRustBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(
    errors[0] ?? '',
    /local_fs\/fs_delete\.rs \(local_fs\) reaches into crate::commands/,
  );
});

test('every zone below the command layer is covered', async () => {
  await writeCrateSkeleton();
  for (const zone of ['application', 'store', 'protocol', 'security', 'transfer', 'local_fs']) {
    await writeSource(`${zone}/reach.rs`, `use crate::commands::fs::ok;\n`);
  }

  const { errors } = runRustBoundaryCheck(root);
  assert.equal(errors.length, 6);
});

test('confirmation presentation belongs to runtime rather than security policy', async () => {
  await writeSource('security/confirmation.rs', 'use tauri::WebviewWindowBuilder;');
  await writeSource('runtime/confirmation.rs', 'use tauri::WebviewWindowBuilder;');
  const { errors } = runRustBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /security.*move it to runtime/);
});

test('an inline crate::commands path counts, not only a use statement', async () => {
  await writeCrateSkeleton();
  await writeSource(
    'store/settings.rs',
    `pub fn apply() { crate::commands::settings::apply_speed_limit(); }\n`,
  );

  const { errors } = runRustBoundaryCheck(root);
  assert.equal(errors.length, 1);
});

test('one command module naming a sibling is rejected', async () => {
  await writeCrateSkeleton();
  await writeSource('commands/transfer.rs', `use crate::commands::session::NO_SESSION;\n`);

  const { errors } = runRustBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /names a sibling command module, crate::commands::session/);
});

test('a child command module may name its own parent', async () => {
  await writeCrateSkeleton();
  await writeSource('commands/session/browse.rs', `use crate::commands::session::NO_SESSION;\n`);

  const { errors } = runRustBoundaryCheck(root);
  assert.deepEqual(errors, []);
});

test('an import cycle between two modules is reported', async () => {
  await writeSource('store/mod.rs', `use crate::security::vault::Vault;\n`);
  await writeSource('security/vault.rs', `use crate::store::Store;\n`);

  const { errors } = runRustBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /module import cycle:/);
});

test('a cycle routed through a third module is still found', async () => {
  await writeSource('a/mod.rs', `use crate::b::go;\n`);
  await writeSource('b/mod.rs', `use crate::c::go;\n`);
  await writeSource('c/mod.rs', `use crate::a::go;\n`);

  const { errors } = runRustBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /module import cycle:/);
});

test('a crate path that skips its zone is rejected', async () => {
  // What a glob re-export in lib.rs used to make possible: `crate::vault`
  // instead of `crate::security::vault`, a name that hides where it comes from.
  await writeSource('security/vault.rs', `pub struct Vault;\n`);
  await writeSource('store/mod.rs', `use crate::vault::Vault;\n`);

  const { errors } = runRustBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /names crate::vault, which is not a top-level module/);
});

test('a crate root file is not attributed to any zone', async () => {
  await writeSource('commands/log.rs', `pub struct LogState;`);
  await writeSource('lib.rs', `use crate::commands::log::LogState;\n`);

  const { errors } = runRustBoundaryCheck(root);
  assert.deepEqual(errors, []);
});
