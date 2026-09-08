import assert from 'node:assert/strict';
import test from 'node:test';
import { backendFor, paneJoin } from '../../../src/features/file-browser/panes/paneBackend.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import { paneClient } from '../helpers/paneClient.ts';

test('backend routes every operation to the correct namespace and preserves deletion semantics', async () => {
  const { panes } = makeTab('tab');
  const h = paneClient(() => ({ ok: true, path: 'C:\\', entries: [] }));
  panes.b.connectionId = 'session';
  for (const pane of [panes.a, panes.b]) {
    const backend = backendFor(pane, h.client);
    await backend.list();
    await backend.mkdir('/new');
    await backend.createFile('/file');
    await backend.remove('/dir', true);
    await backend.remove('/file', false, true);
    await backend.rename('/old', '/new');
  }
  assert.deepEqual(
    h.calls.slice(0, 6).map((call) => call.command),
    ['fs_list', 'fs_mkdir', 'fs_create_file', 'fs_delete', 'fs_delete', 'fs_rename'],
  );
  assert.deepEqual(
    h.calls.slice(6).map((call) => call.command),
    [
      'session_list',
      'session_mkdir',
      'session_create_file',
      'session_delete',
      'session_delete',
      'session_rename',
    ],
  );
  assert.equal(h.calls[3]!.args!.permanent, false);
  assert.equal(h.calls[4]!.args!.permanent, true);
  assert.deepEqual(h.calls[6]!.args, { connectionId: 'session', remotePath: '/' });
  assert.deepEqual(h.calls[9]!.args, { connectionId: 'session', remotePath: '/dir', isDir: true });
  assert.deepEqual(h.calls[10]!.args, {
    connectionId: 'session',
    remotePath: '/file',
    isDir: false,
  });
  assert.deepEqual(h.calls[11]!.args, {
    connectionId: 'session',
    oldPath: '/old',
    newPath: '/new',
  });
});

test('remote backend requires a session and path joining follows pane kind', () => {
  const { panes } = makeTab('tab');
  assert.throws(() => backendFor(panes.b), /no active connection/);
  panes.a.path = 'C:\\root';
  panes.b.path = '/root';
  assert.equal(paneJoin(panes.a, 'child'), 'C:\\root\\child');
  assert.equal(paneJoin(panes.b, 'child'), '/root/child');
});
