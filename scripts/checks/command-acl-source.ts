import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export interface CommandAclSource {
  appCommands: string[];
  manifestCommands: string[];
  sensitiveCommands: string[];
  manifestSensitiveCommands: string[];
  defaultWindows: string[];
  confirmationWindows: string[];
  defaultPermissions: string[];
  confirmationPermissions: string[];
}

const libPath = new URL('../../src-tauri/src/lib.rs', import.meta.url);
const buildPath = new URL('../../src-tauri/build.rs', import.meta.url);
const pluginPath = new URL('../../src-tauri/src/runtime/sensitive_plugin.rs', import.meta.url);
const defaultCapabilityPath = new URL('../../src-tauri/capabilities/default.json', import.meta.url);
const confirmationCapabilityPath = new URL(
  '../../src-tauri/capabilities/security-confirmation.json',
  import.meta.url,
);

function captures(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

function registeredCommands(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Could not find ${marker}`);
  const end = source.indexOf('])', start);
  assert.notEqual(end, -1, `Could not find the end of ${marker}`);
  return captures(
    source.slice(start, end),
    /^\s*(?:crate::)?[a-z_]+(?:::[a-z_]+)*::([a-z_0-9]+),$/gm,
  );
}

function buildList(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}:`);
  assert.notEqual(start, -1, `build.rs must declare ${name}`);
  const end = source.indexOf('];', start);
  assert.notEqual(end, -1, `Could not find the end of ${name}`);
  return captures(source.slice(start, end), /"([a-z0-9_]+)"/g);
}

export const toPermission = (command: string) => `allow-${command.replaceAll('_', '-')}`;

// An app-command permission has no plugin/core prefix; plugin permissions do.
export const isAppPermission = (permission: string) => !permission.includes(':');

export async function loadCommandAcl(): Promise<CommandAclSource> {
  const [libSource, buildSource, pluginSource, defaultSource, confirmationSource] =
    await Promise.all([
      readFile(libPath, 'utf8'),
      readFile(buildPath, 'utf8'),
      readFile(pluginPath, 'utf8'),
      readFile(defaultCapabilityPath, 'utf8'),
      readFile(confirmationCapabilityPath, 'utf8'),
    ]);
  const defaultCapability = JSON.parse(defaultSource);
  const confirmationCapability = JSON.parse(confirmationSource);

  return {
    appCommands: registeredCommands(libSource, 'invoke_handler(tauri::generate_handler!['),
    manifestCommands: buildList(buildSource, 'APP_COMMANDS'),
    sensitiveCommands: registeredCommands(
      pluginSource,
      '.invoke_handler(tauri::generate_handler![',
    ),
    manifestSensitiveCommands: buildList(buildSource, 'SENSITIVE_COMMANDS'),
    defaultWindows: defaultCapability.windows,
    confirmationWindows: confirmationCapability.windows,
    defaultPermissions: defaultCapability.permissions,
    confirmationPermissions: confirmationCapability.permissions,
  };
}
