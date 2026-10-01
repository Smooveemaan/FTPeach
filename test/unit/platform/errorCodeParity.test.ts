import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  COMMAND_ERROR_CODES,
  MAX_SITE_CONNECTIONS,
  MAX_TRANSFER_CONCURRENCY,
  VAULT_LOCK_REASONS,
} from '../../../src/platform/ipcContracts.ts';

function rustSource(file: string): Promise<string> {
  return readFile(new URL(`../../../src-tauri/src/${file}`, import.meta.url), 'utf8');
}

/** The variants of a camelCase `pub enum` in a backend file, as serde writes them. */
async function rustVariants(file: string, name: string): Promise<string[]> {
  const source = await rustSource(file);
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

test('the renderer allows exactly the concurrency the backend settings schema accepts', async () => {
  const bound = /\("concurrency", 0, (\d+)\)/.exec(await rustSource('store/settings_schema.rs'));
  assert.ok(bound, 'store/settings_schema.rs no longer bounds `concurrency` from 0');
  assert.equal(Number(bound[1]), MAX_TRANSFER_CONCURRENCY);
  assert.equal(MAX_TRANSFER_CONCURRENCY, 128);
});

test('the bookmark editor allows exactly the connection limit the backend accepts', async () => {
  const bound = /MAX_SITE_CONNECTIONS: u16 = (\d+);/.exec(await rustSource('protocol/config.rs'));
  assert.ok(bound, 'protocol/config.rs no longer names MAX_SITE_CONNECTIONS');
  assert.equal(Number(bound[1]), MAX_SITE_CONNECTIONS);
});
