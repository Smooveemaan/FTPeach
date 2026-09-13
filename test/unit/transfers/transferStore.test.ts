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
  isConnectionDead,
  retainConnectionRequest,
  rememberConnectionLabels,
  rememberedConnectionLabel,
  updateTransferRow,
  getTransferSummarySnapshot,
  flushTransferUpdates,
  hasTransferCapacity,
  PENDING_TRANSFER_LIMIT,
} from '../../../src/features/transfers/transferStore.ts';
import type { TransferRow } from '../../../src/features/transfers/transferStore.ts';

test('connection metadata follows live rows and pending responses through 10k disconnects', () => {
  resetTransfersStoreForTests();
  for (let index = 0; index < 10_000; index++) {
    const id = `connection-${index}`;
    const release = retainConnectionRequest(id);
    rememberConnectionLabels(new Map([[id, 'Server']]));
    markConnectionDead(id);
    rememberConnectionLabels(new Map());
    assert.equal(isConnectionDead(id), true);
    assert.equal(rememberedConnectionLabel(id), 'Server');
    release();
    assert.equal(isConnectionDead(id), false);
    assert.equal(rememberedConnectionLabel(id), undefined);
  }
});

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
  setTransfersStore({ upload, copy });

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
  assert.equal(notifications, 0);
  unsubscribe();
});

test('row updates preserve old snapshots and do not publish unchanged values', () => {
  resetTransfersStoreForTests();
  const row: TransferRow = {
    id: 'hot',
    attemptId: 'attempt',
    name: 'hot',
    direction: 'down',
    protocol: 'sftp',
    connectionId: 'c',
    remoteFile: '/hot',
    localTarget: 'C:/hot',
    status: 'progress',
    bytes: 0,
    startedAt: 1,
  };
  setTransfersStore({ hot: row });
  const before = getTransfersSnapshot();
  const summary = getTransferSummarySnapshot();
  let calls = 0;
  const stop = subscribeTransfers(() => calls++);
  updateTransferRow('hot', (current) => ({ ...current, bytes: 10 }));
  assert.equal(before.hot?.bytes, 0);
  assert.equal(getTransfersSnapshot().hot?.bytes, 10);
  assert.equal(getTransferSummarySnapshot(), summary);
  updateTransferRow('hot', (current) => ({ ...current, bytes: 10 }));
  assert.equal(calls, 1);
  updateTransferRow('hot', (current) => ({ ...current, attemptId: 'retry', status: 'paused' }));
  assert.equal(transferForAttempt('attempt'), undefined);
  assert.equal(transferForAttempt('retry')?.status, 'paused');
  assert.equal(activeTransferForTarget('local:c:\\hot'), undefined);
  assert.equal(getTransferSummarySnapshot().activeTransfersCount, 0);
  assert.equal(getTransferSummarySnapshot().hasPausedTransfers, true);
  stop();
});

test('a progress burst publishes once and terminal updates flush immediately', () => {
  resetTransfersStoreForTests();
  const row: TransferRow = {
    id: 'a',
    name: 'a',
    direction: 'down',
    protocol: 'sftp',
    connectionId: 'c',
    remoteFile: '/a',
    localTarget: 'C:/a',
    status: 'progress',
    bytes: 0,
    startedAt: 1,
  };
  setTransfersStore({ a: row });
  let calls = 0;
  const stop = subscribeTransfers(() => calls++);
  for (let bytes = 1; bytes <= 100; bytes++)
    updateTransferRow('a', (current) => ({ ...current, bytes }), true);
  assert.equal(calls, 0);
  assert.equal(transferForAttempt('a')?.bytes, 100);
  updateTransferRow('a', (current) => ({ ...current, status: 'stopped' }));
  assert.equal(calls, 1);
  flushTransferUpdates();
  assert.equal(calls, 1);
  assert.equal(transferForAttempt('a')?.status, 'stopped');
  stop();
});

test('random lifecycle updates keep indexes and counters equal to a full scan', () => {
  resetTransfersStoreForTests();
  let seed = 7829;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const statuses = [
    'queued',
    'progress',
    'paused',
    'cancelling',
    'stopped',
    'error',
    'done',
  ] as const;
  for (let step = 0; step < 2000; step++) {
    const id = String(random() % 100);
    const status = statuses[random() % statuses.length]!;
    const previous = getTransfersSnapshot()[id];
    if (previous && random() % 4 === 0) {
      setTransfersStore((state) => {
        const next = { ...state };
        delete next[id];
        return next;
      });
    } else if (previous) {
      updateTransferRow(id, (row) => ({ ...row, status, attemptId: `${id}-${step}`, bytes: step }));
    } else {
      setTransfersStore((state) => ({
        ...state,
        [id]: {
          id,
          name: id,
          direction: 'down',
          protocol: 'sftp',
          connectionId: 'c',
          remoteFile: id,
          localTarget: `C:/${id}`,
          startedAt: step,
          status,
          bytes: 0,
        },
      }));
    }
    const rows = Object.values(getTransfersSnapshot());
    const active = rows.filter((row) => ['queued', 'progress', 'cancelling'].includes(row.status));
    const summary = getTransferSummarySnapshot();
    assert.equal(summary.activeTransfersCount, active.length);
    assert.equal(
      summary.hasPausedTransfers,
      rows.some((row) => row.status === 'paused'),
    );
    assert.equal(
      summary.hasCompletedTransfers,
      rows.some((row) => ['error', 'done', 'stopped'].includes(row.status)),
    );
    for (const row of rows) {
      assert.equal(transferForAttempt(row.attemptId || row.id), row);
      assert.equal(
        activeTransferForTarget(`local:c:\\${row.id}`),
        active.includes(row) ? row : undefined,
      );
    }
    if (previous?.attemptId && previous.attemptId !== getTransfersSnapshot()[id]?.attemptId)
      assert.equal(transferForAttempt(previous.attemptId), undefined);
  }
});

test('admission budget refuses new work without evicting queued or paused rows', () => {
  resetTransfersStoreForTests();
  const rows = Object.fromEntries(
    Array.from({ length: PENDING_TRANSFER_LIMIT }, (_, index) => {
      const id = String(index);
      const row: TransferRow = {
        id,
        name: id,
        direction: 'down',
        protocol: 'sftp',
        connectionId: 'c',
        remoteFile: id,
        localTarget: id,
        status: 'queued',
        bytes: 0,
        startedAt: index,
      };
      return [id, row];
    }),
  );
  setTransfersStore(rows);
  assert.equal(hasTransferCapacity(), false);
  assert.equal(Object.keys(getTransfersSnapshot()).length, PENDING_TRANSFER_LIMIT);
  updateTransferRow('0', (row) => ({ ...row, status: 'paused' }));
  assert.equal(hasTransferCapacity(), true);
  assert.equal(getTransfersSnapshot()['0']?.status, 'paused');
});

test('settling a colliding target does not hide another active owner', () => {
  resetTransfersStoreForTests();
  const row: TransferRow = {
    id: 'a',
    name: 'a',
    direction: 'down',
    protocol: 'sftp',
    connectionId: 'c',
    remoteFile: '/a',
    localTarget: 'C:/shared',
    status: 'progress',
    bytes: 0,
    startedAt: 1,
  };
  setTransfersStore({ a: row, b: { ...row, id: 'b' } });
  updateTransferRow('a', (row) => ({ ...row, status: 'error' }));
  assert.equal(activeTransferForTarget('local:c:\\shared')?.id, 'b');
});

test('retention caps failures apart from successes, including a row that just failed', () => {
  resetTransfersStoreForTests();
  const row = (id: string, status: TransferRow['status'], startedAt: number): TransferRow => ({
    id,
    direction: 'down',
    protocol: 'sftp',
    name: id,
    connectionId: 'session',
    remoteFile: id,
    localTarget: `C:\target\${id}`,
    status,
    bytes: 0,
    startedAt,
  });
  const rows: Record<string, TransferRow> = {};
  for (let i = 0; i < 1500; i++) {
    rows[`done-${i}`] = row(`done-${i}`, 'done', i);
    rows[`failed-${i}`] = row(`failed-${i}`, i % 2 ? 'error' : 'stopped', i);
  }
  rows.active = row('active', 'progress', 5000);
  setTransfersStore(rows);
  const snapshot = getTransfersSnapshot();
  assert.equal(Object.keys(snapshot).length, COMPLETED_RETENTION * 2 + 1);
  assert.equal(snapshot['failed-499'], undefined);
  assert.ok(snapshot['failed-500']);
  assert.ok(snapshot['done-500'], 'successes never displace failures, nor the reverse');

  updateTransferRow('active', (current) => ({ ...current, status: 'error' }));
  const after = getTransfersSnapshot();
  assert.equal(after.active?.status, 'error');
  assert.equal(after['failed-500'], undefined, 'the oldest failure makes room');
  assert.equal(Object.keys(after).length, COMPLETED_RETENTION * 2);
});
