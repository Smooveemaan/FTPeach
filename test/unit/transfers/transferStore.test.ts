import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getTransfersSnapshot,
  resetTransfersStoreForTests,
  setTransfersStore,
  subscribeTransfers,
  COMPLETED_RETENTION,
  transferForAttempt,
  activeTransferForTarget,
  canPauseTransfer,
  canRetryTransfer,
  markConnectionDead,
} from '../../../src/features/transfers/transferStore.ts';
import type { TransferRow } from '../../../src/features/transfers/transferStore.ts';

test('a folder walk pauses only where the file it cuts short can carry on', () => {
  const walk = (
    target: 'local' | 'remote',
    targetProtocol?: 'sftp' | 'webdav',
    moving = false,
  ): TransferRow => ({
    id: 'walk',
    name: 'Folder',
    direction: 'recursive',
    status: 'progress',
    bytes: 0,
    startedAt: 0,
    targetProtocol,
    intent: {
      id: 'walk',
      source: { kind: 'remote', path: '/Folder', connectionId: 'a' },
      target:
        target === 'local'
          ? { kind: 'local', path: 'C:\\Folder' }
          : { kind: 'remote', path: '/Moved', connectionId: 'a' },
      moving,
      overwrite: false,
    },
  });
  assert.equal(canPauseTransfer(walk('local')), true, 'a download keeps its partial file');
  assert.equal(canPauseTransfer(walk('remote', 'sftp')), true);
  assert.equal(canPauseTransfer(walk('remote', 'webdav')), false, 'WebDAV restarts the file');
  assert.equal(canPauseTransfer(walk('remote')), false, 'an unknown target promises nothing');
  assert.equal(canPauseTransfer(walk('remote', 'sftp', true)), false, 'a move is one rename');
});

test('retention limits completed history while preserving active and retryable rows and indexes', () => {
  const row = (id: string, status: TransferRow['status']): TransferRow => ({
    id,
    attemptId: `attempt-${id}`,
    direction: 'down',
    protocol: 'sftp',
    name: id,
    connectionId: 'session',
    remoteFile: id,
    localTarget: `C:\\target\\${id}`,
    status,
    bytes: 0,
    startedAt: Number(id) || 0,
  });
  const rows = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, i) => [String(i), row(String(i), 'done')]),
  );
  rows.active = row('active', 'progress');
  rows.failed = row('failed', 'error');
  setTransfersStore(rows);
  assert.equal(Object.keys(getTransfersSnapshot()).length, COMPLETED_RETENTION + 2);
  assert.equal(transferForAttempt('attempt-active')?.id, 'active');
  assert.equal(activeTransferForTarget('local:c:\\target\\active')?.id, 'active');
  assert.equal(getTransfersSnapshot().failed?.status, 'error');
  assert.equal(transferForAttempt('attempt-0'), undefined);
  setTransfersStore((current) => ({
    ...current,
    active: { ...current.active!, attemptId: 'new-attempt', status: 'done' },
  }));
  assert.equal(transferForAttempt('attempt-active'), undefined);
  assert.equal(activeTransferForTarget('local:c:\\target\\active'), undefined);
  resetTransfersStoreForTests();
});

test('a connection marked dead can never be retried into again, on either side of a copy', () => {
  resetTransfersStoreForTests();
  const upload: TransferRow = {
    id: 'up',
    direction: 'up',
    protocol: 'sftp',
    name: 'up',
    connectionId: 'gone',
    localFile: 'C:\\local\\up',
    remoteTarget: '/up',
    status: 'stopped',
    bytes: 0,
    startedAt: 0,
  };
  const copy: TransferRow = {
    id: 'copy',
    direction: 'copy',
    protocol: 'sftp',
    name: 'copy',
    sourceConnectionId: 'alive',
    targetConnectionId: 'gone',
    sourcePath: '/src',
    remoteTarget: '/dst',
    status: 'stopped',
    bytes: 0,
    startedAt: 0,
  };
  assert.equal(canRetryTransfer(upload), true);
  assert.equal(canRetryTransfer(copy), true);

  let notifications = 0;
  const unsubscribe = subscribeTransfers(() => {
    notifications += 1;
  });
  markConnectionDead('gone');

  assert.equal(canRetryTransfer(upload), false);
  // Dead on either end is enough to sink it, even though 'alive' never was.
  assert.equal(canRetryTransfer(copy), false);
  // Rows already sitting at error/stopped are untouched by the teardown, so the
  // set growing is the only thing that can tell them to grey out their Retry.
  assert.equal(notifications, 1);
  markConnectionDead('gone');
  assert.equal(notifications, 1, 'remarking a known-dead connection redraws nothing');
  unsubscribe();
  resetTransfersStoreForTests();
});

test('transfer store does not notify subscribers for identity updates', () => {
  resetTransfersStoreForTests();
  let notifications = 0;
  const unsubscribe = subscribeTransfers(() => {
    notifications += 1;
  });

  setTransfersStore((current) => current);
  assert.equal(notifications, 0);

  setTransfersStore({ ...getTransfersSnapshot() });
  assert.equal(notifications, 1);
  unsubscribe();
});
