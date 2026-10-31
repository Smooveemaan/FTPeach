// Tauri only enforces its access-control list on app commands once the build
// declares an application manifest for them. Nothing in the build fails when a
// new `#[tauri::command]` is registered but left out of that manifest or out of
// the capability files, and the quiet outcome is the worst one: the command
// becomes reachable from every window, including the isolated confirmation
// window. This check ties the three lists together so adding a command forces a
// deliberate decision about which window class may call it.
import assert from 'node:assert/strict';
import { isAppPermission, loadCommandAcl, toPermission } from './command-acl-source.ts';

const {
  appCommands,
  manifestCommands,
  sensitiveCommands,
  manifestSensitiveCommands,
  defaultWindows,
  confirmationWindows,
  defaultPermissions,
  confirmationPermissions,
} = await loadCommandAcl();

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

reportSetDifference(
  manifestCommands,
  appCommands,
  'build.rs APP_COMMANDS must list exactly the commands registered in lib.rs, so every app command is ACL-checked',
);

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

assert.deepEqual(defaultWindows, ['main'], 'The default capability must target main');
assert.deepEqual(
  confirmationWindows,
  ['security-confirmation-*'],
  'The confirmation capability must target only confirmation windows',
);

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
