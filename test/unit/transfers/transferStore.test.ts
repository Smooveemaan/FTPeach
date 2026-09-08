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
} from '../../../src/features/transfers/transferStore.ts';
import type { TransferRow } from '../../../src/features/transfers/transferStore.ts';

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
