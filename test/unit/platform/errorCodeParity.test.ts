import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { COMMAND_ERROR_CODES, VAULT_LOCK_REASONS } from '../../../src/platform/ipcContracts.ts';

/** The variants of a camelCase `pub enum` in a backend file, as serde writes them. */
async function rustVariants(file: string, name: string): Promise<string[]> {
  const source = await readFile(new URL(`../../../src-tauri/src/${file}`, import.meta.url), 'utf8');
  const match = new RegExp(
    String.raw`#\[serde\(rename_all = "camelCase"\)\]\s*pub enum ${name} \{([^}]*)\}`,
  ).exec(source);
  assert.ok(match, `${file} no longer declares a camelCase \`pub enum ${name}\``);
  return match[1]!
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line !== '')
    .map((line) => {
      const variant = /^([A-Z][A-Za-z0-9]*),$/.exec(line);
      assert.ok(variant, `unexpected line in ${name}: ${line}`);
      return variant[1]![0]!.toLowerCase() + variant[1]!.slice(1);
    });
}

test('the renderer knows exactly the error codes the backend can send', async () => {
  assert.deepEqual(
    [...COMMAND_ERROR_CODES].sort(),
    (await rustVariants('ipc.rs', 'ErrorCode')).sort(),
  );
});

test('the renderer knows exactly the reasons the backend gives for a vault lock', async () => {
  assert.deepEqual(
    [...VAULT_LOCK_REASONS].sort(),
    (await rustVariants('security/auto_lock.rs', 'LockReason')).sort(),
  );
});
