import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { filterAndSortEntries } from '../../src/features/file-browser/components/fileListModel.ts';

const entries = Array.from({ length: 100_000 }, (_, i) => ({
  name: `file-${100_000 - i}.txt`,
  isDirectory: i % 10 === 0,
  size: i,
}));
const t = (key: string) => key;
const ordered = filterAndSortEntries(entries, { t });
const samples = { previous: [] as number[], cached: [] as number[] };
for (let run = 0; run < 35; run++) {
  const filterText = ['file', 'file-1', 'file-', 'file-9', ''][run % 5]!;
  let start = performance.now();
  const previous = filterAndSortEntries(entries, { filterText, t });
  if (run >= 5) samples.previous.push(performance.now() - start);
  start = performance.now();
  const cached = filterText
    ? ordered.filter((row) => row.name.toLowerCase().includes(filterText))
    : ordered;
  if (run >= 5) samples.cached.push(performance.now() - start);
  if (previous.length !== cached.length || previous.some((row, index) => row !== cached[index]))
    throw new Error('Filter changed the order');
}
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[14], p95: sorted[28] };
};
const result = {
  count: entries.length,
  previous: summarize(samples.previous),
  cached: summarize(samples.cached),
  samples,
};
console.log(JSON.stringify(result));
writeFileSync('.local/stage3-file-filter.json', JSON.stringify(result, null, 2));
