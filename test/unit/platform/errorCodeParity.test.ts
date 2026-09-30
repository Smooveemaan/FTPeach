import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { COMMAND_ERROR_CODES } from '../../../src/platform/ipcContracts.ts';

/** The variants of `ipc::ErrorCode`, as serde writes them. */
async function rustErrorCodes(): Promise<string[]> {
  const source = await readFile(new URL('../../../src-tauri/src/ipc.rs', import.meta.url), 'utf8');
  const match = /#\[serde\(rename_all = "camelCase"\)\]\s*pub enum ErrorCode \{([^}]*)\}/.exec(
    source,
  );
  assert.ok(match, 'ipc.rs no longer declares a camelCase `pub enum ErrorCode`');
  return match[1]!
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line !== '')
    .map((line) => {
      const variant = /^([A-Z][A-Za-z0-9]*),$/.exec(line);
      assert.ok(variant, `unexpected line in ErrorCode: ${line}`);
      return variant[1]![0]!.toLowerCase() + variant[1]!.slice(1);
    });
}

test('the renderer knows exactly the error codes the backend can send', async () => {
  assert.deepEqual([...COMMAND_ERROR_CODES].sort(), (await rustErrorCodes()).sort());
});
