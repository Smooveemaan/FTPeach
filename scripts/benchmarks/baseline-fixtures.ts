import type { TransferRow, TransferState } from '../../src/features/transfers/transferStore.ts';
import type { FileEntry } from '../../src/shared/types.ts';

export const FIXTURE_VERSION = 1;
export const QUEUE_SIZES = [1_000, 10_000, 100_000];
export const ACTIVE_COUNTS = [1, 8, 32];

// Fixed IDs, timestamps and status distribution keep revisions comparable.
export function mixedQueue(count: number, active: number): TransferState {
  const statuses = ['queued', 'paused', 'error', 'stopped', 'done'] as const;
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const id = String(index);
      const status = index < active ? 'progress' : statuses[(index - active) % statuses.length]!;
      const row: TransferRow = {
        id,
        attemptId: id,
        direction: 'down',
        protocol: 'sftp',
        connectionId: 'fixture-session',
        remoteFile: `/fixture/${id}`,
        localTarget: `C:\\fixture\\${id}`,
        name: `file-${id}`,
        bytes: status === 'done' ? 1048576 : 0,
        total: 1048576,
        status,
        startedAt: 1700000000000 + index,
      };
      return [id, row];
    }),
  );
}

export function directoryEntries(count: number): FileEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `entry-${String(count - index).padStart(6, '0')}.${['txt', 'zip', 'png'][index % 3]}`,
    isDirectory: index % 23 === 0,
    size: index * 7919,
    modifiedAt: new Date(1700000000000 + index * 1000).toISOString(),
  }));
}
