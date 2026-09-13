import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cpus, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  ACTIVE_COUNTS,
  FIXTURE_VERSION,
  QUEUE_SIZES,
  directoryEntries,
  mixedQueue,
} from './baseline-fixtures.ts';
import {
  getTransfersSnapshot,
  resetTransfersStoreForTests,
  setTransfersStore,
  subscribeTransfers,
  transferForAttempt,
} from '../../src/features/transfers/transferStore.ts';
import { filterAndSortEntries } from '../../src/features/file-browser/components/fileListModel.ts';

const warmup = 5;
const runs = 40;
function measure(work: () => void) {
  for (let i = 0; i < warmup; i++) work();
  const samplesMs: number[] = [];
  const cpu = process.cpuUsage();
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    work();
    samplesMs.push(performance.now() - start);
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    samplesMs,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    cpuMicros: process.cpuUsage(cpu),
    memoryBytes: process.memoryUsage(),
  };
}
const results: unknown[] = [];
for (const count of QUEUE_SIZES) {
  for (const active of ACTIVE_COUNTS) {
    resetTransfersStoreForTests();
    setTransfersStore(mixedQueue(count, active));
    let notifications = 0;
    const unsubscribe = subscribeTransfers(() => {
      notifications++;
    });
    const measurement = measure(() => {
      // One synchronous burst, one ordinary progress update per active attempt.
      for (let index = 0; index < active; index++) {
        const row = transferForAttempt(String(index))!;
        setTransfersStore((current) => ({
          ...current,
          [row.id]: { ...row, bytes: row.bytes + 1 },
        }));
      }
    });
    unsubscribe();
    const snapshot = getTransfersSnapshot();
    for (let index = 0; index < active; index++)
      assert.equal(snapshot[String(index)]!.bytes, runs + warmup);
    const statuses: Record<string, number> = {};
    for (const row of Object.values(snapshot))
      statuses[row.status] = (statuses[row.status] ?? 0) + 1;
    results.push({
      scenario: 'mixed-queue-progress-burst',
      inputRows: count,
      active,
      retainedRows: Object.keys(snapshot).length,
      statuses,
      notifications,
      ...measurement,
    });
    console.log(
      `queue ${count}/${active}: p50=${measurement.p50Ms.toFixed(2)} p95=${measurement.p95Ms.toFixed(2)} ms`,
    );
  }
}
resetTransfersStoreForTests();
for (const count of QUEUE_SIZES) {
  const entries = directoryEntries(count);
  for (const filterText of ['', '7']) {
    const measurement = measure(() => {
      filterAndSortEntries(entries, {
        filterText,
        sortKey: 'name',
        sortDir: 'asc',
        t: (key) => key,
      });
    });
    results.push({ scenario: 'directory-filter-sort', count, filterText, ...measurement });
  }
}
const output = resolve(process.argv[2] ?? '.local/benchmarks/stage-0.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  JSON.stringify(
    {
      schemaVersion: 1,
      fixtureVersion: FIXTURE_VERSION,
      createdAt: new Date().toISOString(),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      warmup,
      runs,
      scope:
        'Node store and directory model only; no IPC, React, WebView2 or network timing. Memory is process-wide and not GC-normalized. p99 is descriptive, not a release gate.',
      results,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Baseline saved to ${output}`);
