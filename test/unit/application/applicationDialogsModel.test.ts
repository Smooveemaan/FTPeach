import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPaneMode,
  serializeRecentLogLines,
} from '../../../src/app/applicationDialogsModel.ts';
import { makePane } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { LogEntry } from '../../../src/shared/types.ts';

const logEntry = (index: number): LogEntry => ({
  line: `line-${index}`,
  kind: 'info',
  ts: index,
  connectionId: 'remote',
});

test('diagnostics contain only the latest 200 log entries', () => {
  const lines = Array.from({ length: 205 }, (_, index) => logEntry(index));
  const serialized = JSON.parse(serializeRecentLogLines(lines)) as LogEntry[];

  assert.equal(serialized.length, 200);
  assert.equal(serialized[0]?.line, 'line-5');
  assert.equal(serialized.at(-1)?.line, 'line-204');
});

test('chmod reports command failures without refreshing the pane', async () => {
  const left = makePane('a', 'remote');
  left.connectionId = 'connection-a';
  left.path = '/documents';
  const errors: unknown[] = [];
  const refreshes: unknown[] = [];

  await applyPaneMode(
    { id: 'a', entry: { name: 'report.txt', isDirectory: false }, mode: '644' },
    '600',
    {
      panes: { a: left, b: makePane('b', 'local') },
      refreshPane: async (...args: unknown[]) => {
        refreshes.push(args);
      },
      services: {
        exportDiagnostics: async () => ({ ok: true }),
        chmod: async () => ({ ok: false, error: 'permission denied' }),
        paneJoin: (pane, name) => `${pane.path}/${name}`,
        reportError: (error) => errors.push(error),
      },
    },
  );

  assert.equal(errors.length, 1);
  assert.deepEqual(refreshes, []);
});

test('chmod refreshes the affected pane after a successful command', async () => {
  const left = makePane('a', 'remote');
  left.connectionId = 'connection-a';
  left.path = '/documents';
  const calls: unknown[][] = [];

  await applyPaneMode(
    { id: 'a', entry: { name: 'report.txt', isDirectory: false }, mode: '644' },
    '600',
    {
      panes: { a: left, b: makePane('b', 'local') },
      refreshPane: async (...args: unknown[]) => {
        calls.push(['refresh', ...args]);
      },
      services: {
        exportDiagnostics: async () => ({ ok: true }),
        chmod: async (...args) => {
          calls.push(['chmod', ...args]);
          return { ok: true };
        },
        paneJoin: (pane, name) => `${pane.path}/${name}`,
        reportError: () => undefined,
      },
    },
  );

  assert.deepEqual(calls, [
    ['chmod', 'connection-a', '/documents/report.txt', '600'],
    ['refresh', 'a', '/documents'],
  ]);
});
