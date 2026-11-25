import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractFrontendIpcFromSource,
  extractRustEventsFromSource,
  verifyIpcSurface,
} from '../../../scripts/checks/ipc-surface.ts';

test('extractFrontendIpcFromSource finds direct, wrapped, ternary, sensitive, and event calls', () => {
  const sample = `
    const selection = (command: string) => invoke(command);
    export async function demo(flag: boolean) {
      await invoke('app_version');
      await rawInvoke('plugin:sensitive|authorize_sensitive');
      await rawInvoke('plugin:log|log', { message: 'ignored' });
      await voidOutcome(invoke, flag ? 'fs_execute_path' : 'fs_open_document');
      await selection('dialog_select_local_dir');
      onEvent('updater:status');
      await listen('app:flush-state', () => {});
    }
  `;
  const surface = extractFrontendIpcFromSource('src/platform/api/sample.ts', sample);
  assert.deepEqual([...surface.invokedCommands].sort(), [
    'app_version',
    'authorize_sensitive',
    'dialog_select_local_dir',
    'fs_execute_path',
    'fs_open_document',
  ]);
  assert.deepEqual([...surface.explicitSensitiveCommands], ['authorize_sensitive']);
  assert.deepEqual([...surface.listenedEvents].sort(), ['app:flush-state', 'updater:status']);
});

test('extractRustEventsFromSource resolves literals and constants while ignoring tests and non-Emitter files', () => {
  const rust = `
    use tauri::Emitter;
    const ACTION_EVENT: &str = "tray:action";
    pub fn fire(app: &AppHandle) {
      let _ = app.emit("updater:status", ());
      let _ = app.emit_to("main", ACTION_EVENT, "quit");
    }
    #[cfg(test)]
    mod tests {
      fn t(app: &AppHandle) { let _ = app.emit("test:only", ()); }
    }
  `;
  assert.deepEqual([...extractRustEventsFromSource(rust)].sort(), [
    'tray:action',
    'updater:status',
  ]);

  const loggerOnly = `
    pub fn run(&self) {
      self.logger.emit("LIST /", LogKind::Command);
    }
  `;
  assert.deepEqual([...extractRustEventsFromSource(loggerOnly)], []);
});

test('verifyIpcSurface flags unknown invokes, missing sensitive routes, and event drift', () => {
  const base = {
    appCommands: ['app_version'],
    sensitiveCommands: ['authorize_sensitive', 'fs_delete'],
    frontend: {
      invokedCommands: new Set(['app_version', 'authorize_sensitive', 'fs_delete']),
      explicitSensitiveCommands: new Set(['authorize_sensitive']),
      sensitiveRoutedCommands: new Set(['fs_delete']),
      listenedEvents: new Set(['updater:status']),
    },
    rustEvents: new Set(['updater:status']),
  };
  verifyIpcSurface(base);

  assert.throws(
    () =>
      verifyIpcSurface({
        ...base,
        frontend: {
          ...base.frontend,
          invokedCommands: new Set([...base.frontend.invokedCommands, 'typo_cmd']),
        },
      }),
    /typo_cmd/,
  );

  assert.throws(
    () =>
      verifyIpcSurface({
        ...base,
        frontend: { ...base.frontend, sensitiveRoutedCommands: new Set() },
      }),
    /fs_delete/,
  );

  assert.throws(
    () =>
      verifyIpcSurface({
        ...base,
        rustEvents: new Set(['updater:status', 'orphan:event']),
      }),
    /orphan:event/,
  );
});
