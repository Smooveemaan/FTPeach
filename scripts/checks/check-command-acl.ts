// Tauri only enforces its access-control list on app commands once the build
// declares an application manifest for them. Nothing in the build fails when a
// new `#[tauri::command]` is registered but left out of that manifest or out of
// the capability files, and the quiet outcome is the worst one: the command
// becomes reachable from every window, including the isolated confirmation
// window. This check ties the three lists together so adding a command forces a
// deliberate decision about which window class may call it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const libPath = new URL('../../src-tauri/src/lib.rs', import.meta.url);
const buildPath = new URL('../../src-tauri/build.rs', import.meta.url);
const pluginPath = new URL('../../src-tauri/src/runtime/sensitive_plugin.rs', import.meta.url);
const defaultCapabilityPath = new URL('../../src-tauri/capabilities/default.json', import.meta.url);
const confirmationCapabilityPath = new URL(
  '../../src-tauri/capabilities/security-confirmation.json',
  import.meta.url,
);

const read = (path: URL) => readFile(path, 'utf8');
const [libSource, buildSource, pluginSource, defaultSource, confirmationSource] = await Promise.all(
  [
    read(libPath),
    read(buildPath),
    read(pluginPath),
    read(defaultCapabilityPath),
    read(confirmationCapabilityPath),
  ],
);

/** Every capture of `pattern` in `source`, dropping groups that did not match. */
function captures(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** Command names from a `generate_handler![...]` list, ignoring `#[cfg]` lines. */
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

/** String literals from a `const NAME: &[&str] = &[...]` array in build.rs. */
function buildList(name: string): string[] {
  const start = buildSource.indexOf(`const ${name}:`);
  assert.notEqual(start, -1, `build.rs must declare ${name}`);
  const end = buildSource.indexOf('];', start);
  assert.notEqual(end, -1, `Could not find the end of ${name}`);
  return captures(buildSource.slice(start, end), /"([a-z0-9_]+)"/g);
}

const toPermission = (command: string) => `allow-${command.replaceAll('_', '-')}`;

function reportSetDifference(actual: string[], expected: string[], subject: string): void {
  const missing = expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${subject}\n  missing: ${missing.join(', ') || '(none)'}\n  unexpected: ${extra.join(', ') || '(none)'}`,
  );
  assert.equal(new Set(actual).size, actual.length, `${subject}: the list repeats an entry`);
}

const appCommands = registeredCommands(libSource, 'invoke_handler(tauri::generate_handler![');
const manifestCommands = buildList('APP_COMMANDS');
reportSetDifference(
  manifestCommands,
  appCommands,
  'build.rs APP_COMMANDS must list exactly the commands registered in lib.rs, so every app command is ACL-checked',
);

const sensitiveCommands = registeredCommands(
  pluginSource,
  '.invoke_handler(tauri::generate_handler![',
);
const manifestSensitiveCommands = buildList('SENSITIVE_COMMANDS');
reportSetDifference(
  manifestSensitiveCommands,
  sensitiveCommands,
  'build.rs SENSITIVE_COMMANDS must list exactly the commands the sensitive plugin registers',
);

const overlap = appCommands.filter((command) => sensitiveCommands.includes(command));
assert.deepEqual(
  overlap,
  [],
  `A command must be registered once, either as an app command or behind the sensitive plugin: ${overlap.join(', ')}`,
);

const defaultCapability = JSON.parse(defaultSource);
const confirmationCapability = JSON.parse(confirmationSource);
assert.deepEqual(defaultCapability.windows, ['main'], 'The default capability must target main');
assert.deepEqual(
  confirmationCapability.windows,
  ['security-confirmation-*'],
  'The confirmation capability must target only confirmation windows',
);

const defaultPermissions = defaultCapability.permissions as string[];
const confirmationPermissions = confirmationCapability.permissions as string[];

// An app-command permission has no `plugin:`/`core:` prefix, which is exactly
// how Tauri tells the application's own ACL entries from a plugin's.
const isAppPermission = (permission: string) => !permission.includes(':');

reportSetDifference(
  defaultPermissions.filter(isAppPermission),
  appCommands.map(toPermission),
  'The main window must be granted exactly the registered app commands',
);

const leakedToConfirmation = confirmationPermissions.filter(isAppPermission);
assert.deepEqual(
  leakedToConfirmation,
  [],
  `The confirmation window must reach no app commands: ${leakedToConfirmation.join(', ')}`,
);

// The confirmation window exists to answer one prompt. Anything beyond that,
// including the sensitive commands the prompt is protecting, has to stay out.
const allowedConfirmationPermissions = [
  'core:window:allow-set-size',
  'sensitive:allow-sensitive-confirmation-prompt',
  'sensitive:allow-sensitive-confirmation-ready',
  'sensitive:allow-respond-sensitive-confirmation',
];
reportSetDifference(
  confirmationPermissions,
  allowedConfirmationPermissions,
  'The confirmation window must keep only its prompt/ready/respond and window permissions',
);

console.log(
  `Command ACL OK: ${appCommands.length} app commands and ${sensitiveCommands.length} sensitive commands are permissioned; the confirmation window reaches ${confirmationPermissions.length} of them`,
);
