import { performance } from 'node:perf_hooks';

import {
  fileIconName,
  fileTypeLabel,
  filterAndSortEntries,
} from '../../src/features/file-browser/components/fileListModel.ts';
import type { FileEntry, Translate } from '../../src/shared/types.ts';
import { createSiteSearchIndex, searchSites } from '../../src/features/sites/siteSearchModel.ts';
import { mergeLogBatch } from '../../src/features/logs/logBuffer.ts';
import { sortManagedEntries } from '../../src/features/sites/siteManagerModel.ts';
import { formatBytes } from '../../src/shared/format.ts';

const SIZES = [10_000, 50_000, 100_000];
const EXTENSIONS = ['txt', 'zip', 'tsx', 'png', 'mp4', 'csv', 'bin'];
const RUNS = 5;
const t: Translate = (key: string, values?: Record<string, unknown>) =>
  key.endsWith('WithExt') && values?.ext !== undefined ? String(values.ext) : key;

console.log('Large-directory benchmark (median of 5 warm runs)');
console.log('entries\tname sort\tfiltered sort\ttype metadata');

for (const size of SIZES) {
  const entries = createEntries(size);

  // Warm JIT and Intl.Collator before collecting comparable samples.
  runScenarios(entries);
  const samples = Array.from({ length: RUNS }, () => runScenarios(entries));
  const nameSort = median(samples.map((sample) => sample.nameSort));
  const filteredSort = median(samples.map((sample) => sample.filteredSort));
  const typeMetadata = median(samples.map((sample) => sample.typeMetadata));

  console.log(
    `${size}\t${formatMs(nameSort)}\t${formatMs(filteredSort)}\t${formatMs(typeMetadata)}`,
  );
}

function createEntries(size: number): FileEntry[] {
  return Array.from({ length: size }, (_, index) => ({
    name: `entry-${String(size - index).padStart(6, '0')}.${EXTENSIONS[index % EXTENSIONS.length]}`,
    isDirectory: index % 23 === 0,
    size: index * 7919,
    modifiedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  }));
}

console.log('\nSite search and bounded log batches (median of 5 warm runs)');
console.log('entries\tsearch index\tsearch query\tlog append');
for (const size of SIZES) {
  const entries = Array.from({ length: size }, (_, index) => ({
    id: String(index),
    name: `Site ${index}`,
    host: `server-${index}.example.test`,
    user: 'user',
  }));
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const index = createSiteSearchIndex(entries, entriesById);
  const batch = entries.map((entry, seq) => ({ seq, message: entry.host }));
  const run = () => ({
    index: measure(() => {
      createSiteSearchIndex(entries, entriesById);
    }),
    query: measure(() => {
      searchSites(index, 'server-7');
    }),
    log: measure(() => {
      mergeLogBatch([], batch, -1);
    }),
  });
  run();
  const samples = Array.from({ length: RUNS }, run);
  console.log(
    `${size}\t${formatMs(median(samples.map((sample) => sample.index)))}\t${formatMs(median(samples.map((sample) => sample.query)))}\t${formatMs(median(samples.map((sample) => sample.log)))}`,
  );
}

console.log('\nGrouped site sorting and size formatting (median of 5 warm runs)');
console.log('entries\tsite sort\tformat bytes');
for (const size of SIZES) {
  const folders = Array.from({ length: 100 }, (_, index) => ({
    id: `folder-${index}`,
    kind: 'folder' as const,
    name: `Folder ${index}`,
  }));
  const entries = [
    ...folders,
    ...Array.from({ length: size }, (_, index) => ({
      id: String(index),
      name: `Site ${size - index}`,
      parentId: `folder-${index % 100}`,
    })),
  ];
  const run = () => ({
    sort: measure(() => {
      sortManagedEntries(entries, 'name');
    }),
    format: measure(() => {
      for (let index = 0; index < size; index++) formatBytes(index * 7919);
    }),
  });
  run();
  const samples = Array.from({ length: RUNS }, run);
  console.log(
    `${size}\t${formatMs(median(samples.map((sample) => sample.sort)))}\t${formatMs(median(samples.map((sample) => sample.format)))}`,
  );
}

function runScenarios(entries: readonly FileEntry[]): BenchmarkSample {
  const nameSort = measure(() =>
    filterAndSortEntries(entries, { sortKey: 'name', sortDir: 'asc', t }),
  );
  const filteredSort = measure(() =>
    filterAndSortEntries(entries, {
      filterText: '7',
      sortKey: 'modifiedAt',
      sortDir: 'desc',
      t,
    }),
  );
  const typeMetadata = measure(() => {
    for (const entry of entries) {
      fileIconName(entry);
      fileTypeLabel(entry, t);
    }
  });

  return { nameSort, filteredSort, typeMetadata };
}

function measure(operation: () => void): number {
  const start = performance.now();
  operation();
  return performance.now() - start;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) throw new Error('median() needs at least one sample');
  return middle;
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

interface BenchmarkSample {
  nameSort: number;
  filteredSort: number;
  typeMetadata: number;
}
