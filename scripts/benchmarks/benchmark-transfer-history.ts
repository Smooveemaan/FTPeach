import { performance } from 'node:perf_hooks';
import {
  getTransfersSnapshot,
  resetTransfersStoreForTests,
  setTransfersStore,
  transferForAttempt,
} from '../../src/features/transfers/transferStore.ts';
import type { TransferRow, TransferState } from '../../src/features/transfers/transferStore.ts';

function row(id: string, status: TransferRow['status']): TransferRow {
  return {
    id,
    attemptId: id,
    direction: 'down',
    protocol: 'sftp',
    connectionId: 'session',
    remoteFile: id,
    localTarget: `C:\\target\\${id}`,
    name: id,
    bytes: 0,
    status,
    startedAt: Number(id) || 0,
  };
}
function measure(work: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    work();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[15]!;
}
console.log(
  'Completed rows | Previous update median ms | Retained/indexed median ms | Retained rows',
);
for (const count of [10_000, 100_000]) {
  let before: TransferState = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [String(i), row(String(i), 'done')]),
  );
  before.active = row('active', 'progress');
  const oldTime = measure(() => {
    const active = Object.values(before).find((item) => item.attemptId === 'active')!;
    before = { ...before, [active.id]: { ...active, bytes: active.bytes + 1 } };
  });
  resetTransfersStoreForTests();
  setTransfersStore(before);
  const newTime = measure(() => {
    const active = transferForAttempt('active')!;
    setTransfersStore((current) => ({
      ...current,
      [active.id]: { ...active, bytes: active.bytes + 1 },
    }));
  });
  console.log(
    `${count} | ${oldTime.toFixed(3)} | ${newTime.toFixed(3)} | ${Object.keys(getTransfersSnapshot()).length}`,
  );
}
