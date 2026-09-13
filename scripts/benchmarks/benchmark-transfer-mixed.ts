import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  flushTransferUpdates,
  getTransferSummarySnapshot,
  resetTransfersStoreForTests,
  setTransfersStore,
  subscribeTransfers,
  updateTransferRow,
} from '../../src/features/transfers/transferStore.ts';
import type { TransferRow, TransferState } from '../../src/features/transfers/transferStore.ts';

const results = [];
for (const count of [1000, 10_000, 100_000]) {
  for (const active of [1, 8, 32]) {
    const rows: TransferState = Object.fromEntries(
      Array.from({ length: count }, (_, i) => {
        const id = `row-${i}`;
        const row: TransferRow = {
          id,
          attemptId: id,
          direction: 'down',
          protocol: 'sftp',
          connectionId: 'session',
          remoteFile: id,
          localTarget: `C:/${id}`,
          name: id,
          bytes: 0,
          total: 100_000,
          startedAt: i,
          status:
            i < active
              ? 'progress'
              : (['error', 'stopped', 'paused', 'queued'][i % 4] as TransferRow['status']),
        };
        return [id, row];
      }),
    );
    let old = { ...rows };
    resetTransfersStoreForTests();
    setTransfersStore(rows);
    let publications = 0;
    const stop = subscribeTransfers(() => {
      publications++;
      getTransferSummarySnapshot();
    });
    const samples = { previous: [] as number[], current: [] as number[] };
    for (let sample = 0; sample < 12; sample++) {
      let start = performance.now();
      for (let i = 0; i < active; i++) {
        const id = `row-${i}`;
        old = { ...old, [id]: { ...old[id]!, bytes: sample + 1 } };
        // Previous progress path: retention scan, two index rebuilds and summary scans.
        const values = Object.values(old);
        values.filter((row) => row.status === 'done');
        new Map(values.map((row) => [row.attemptId, row.id]));
        new Map(
          values
            .filter((row) => ['queued', 'progress', 'cancelling'].includes(row.status))
            .map((row) => [
              row.direction === 'down' && !row.dragOut ? row.localTarget : row.id,
              row.id,
            ]),
        );
        values.filter((row) => ['queued', 'progress', 'cancelling'].includes(row.status)).length;
      }
      if (sample >= 2) samples.previous.push(performance.now() - start);
      start = performance.now();
      for (let i = 0; i < active; i++)
        updateTransferRow(`row-${i}`, (row) => ({ ...row, bytes: sample + 1 }), true);
      flushTransferUpdates();
      if (sample >= 2) samples.current.push(performance.now() - start);
    }
    stop();
    const percentile = (values: number[], quantile: number) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1]!;
    const result = {
      count,
      active,
      publications,
      previousMedianMs: percentile(samples.previous, 0.5),
      currentMedianMs: percentile(samples.current, 0.5),
      currentP95Ms: percentile(samples.current, 0.95),
      memory: process.memoryUsage(),
      samples,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
mkdirSync('.local', { recursive: true });
writeFileSync(
  '.local/stage3-mixed-store.json',
  JSON.stringify(
    {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      node: process.version,
      platform: process.platform,
      measuredAt: new Date().toISOString(),
      note: 'Working tree; modeled previous store; current batch includes publication, excludes the 16ms scheduling delay. Memory is process-wide, including both fixtures.',
      results,
    },
    null,
    2,
  ),
);
