// What a window has to download and parse before its first render, measured
// from the Vite manifest rather than from the entry chunk alone. The entry is
// a few KiB; `main.tsx` then awaits react-dom, the window's UI and, in Tauri,
// the IPC adapter before it renders anything. A budget on the entry by itself
// would pass while that startup graph doubled.
//
// Each window's graph is its entry plus the dynamic imports `main.tsx` awaits,
// followed through their static imports, with shared chunks and stylesheets
// counted once. Everything else is deferred and reported apart from it.
// Budgets are the committed baseline plus ALLOWED_GROWTH; an intended increase
// updates `bundle-baseline.json` in the same change, visibly.
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distDir = path.join(projectRoot, 'dist');
const manifestPath = path.join(distDir, '.vite', 'manifest.json');
const baselinePath = path.join(projectRoot, 'scripts', 'checks', 'bundle-baseline.json');
const reportPath = path.join(distDir, 'bundle-report.json');

const CHUNK_LIMIT_BYTES = 950 * 1024;
const ALLOWED_GROWTH = 0.1;

/** The dynamic imports `src/main.tsx` awaits before each window renders. */
export const STARTUP_IMPORTS: Record<string, readonly string[]> = {
  main: ['node_modules/react-dom/client.js', 'src/App.tsx', 'src/platform/tauriApi.ts'],
  securityConfirmation: [
    'node_modules/react-dom/client.js',
    'src/platform/SecurityConfirmation.tsx',
  ],
};

export interface ManifestEntry {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}
export type ViteManifest = Record<string, ManifestEntry>;

export interface Size {
  raw: number;
  gzip: number;
}

/** Every file reached from `keys` through static imports, stylesheets included. */
export function staticClosure(manifest: ViteManifest, keys: readonly string[]): Set<string> {
  const files = new Set<string>();
  const seen = new Set<string>();
  const queue = [...keys];
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = manifest[key];
    if (!entry) throw new Error(`The manifest has no ${key}`);
    files.add(entry.file);
    for (const css of entry.css ?? []) files.add(css);
    queue.push(...(entry.imports ?? []));
  }
  return files;
}

/** The files of each window's startup graph, keyed by window. */
export function startupGraphs(manifest: ViteManifest): Record<string, Set<string>> {
  const entries = Object.entries(manifest).filter(([, entry]) => entry.isEntry);
  if (entries.length !== 1) throw new Error(`Expected one entry, found ${entries.length}`);
  const [entryKey, entry] = entries[0]!;
  const graphs: Record<string, Set<string>> = {};
  for (const [window, imports] of Object.entries(STARTUP_IMPORTS)) {
    for (const key of imports) {
      // A startup import that is no longer dynamic, or renamed, would silently
      // drop out of the measurement; stop and have the list updated instead.
      if (!entry.dynamicImports?.includes(key)) {
        throw new Error(`${entryKey} no longer imports ${key} dynamically; update STARTUP_IMPORTS`);
      }
    }
    graphs[window] = staticClosure(manifest, [entryKey, ...imports]);
  }
  return graphs;
}

async function sizeOf(file: string): Promise<Size> {
  const body = await readFile(path.join(distDir, file));
  return { raw: body.byteLength, gzip: gzipSync(body, { level: 9 }).byteLength };
}

const sum = (sizes: Size[]): Size =>
  sizes.reduce((total, size) => ({ raw: total.raw + size.raw, gzip: total.gzip + size.gzip }), {
    raw: 0,
    gzip: 0,
  });

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
const delta = (now: number, then: number | undefined) =>
  then === undefined
    ? 'new'
    : `${now >= then ? '+' : ''}${(((now - then) / then) * 100).toFixed(1)}%`;

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ViteManifest;
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Record<string, Size>;
  const allFiles = new Set(
    Object.values(manifest).flatMap((entry) => [entry.file, ...(entry.css ?? [])]),
  );
  const sizes = new Map<string, Size>();
  for (const file of allFiles) sizes.set(file, await sizeOf(file));

  const graphs = startupGraphs(manifest);
  const startup = new Set(Object.values(graphs).flatMap((graph) => [...graph]));
  const measured: Record<string, Size> = {};
  for (const [window, graph] of Object.entries(graphs)) {
    measured[window] = sum([...graph].map((file) => sizes.get(file)!));
  }
  measured.deferred = sum(
    [...allFiles].filter((file) => !startup.has(file)).map((file) => sizes.get(file)!),
  );

  const violations: string[] = [];
  for (const [file, size] of sizes) {
    if (file.endsWith('.js') && size.raw > CHUNK_LIMIT_BYTES) {
      violations.push(
        `${file}: ${kib(size.raw)} exceeds the ${kib(CHUNK_LIMIT_BYTES)} chunk limit`,
      );
    }
  }
  for (const window of Object.keys(graphs)) {
    const now = measured[window]!;
    const then = baseline[window];
    if (!then) {
      violations.push(`${window}: no baseline in ${path.relative(projectRoot, baselinePath)}`);
      continue;
    }
    for (const kind of ['raw', 'gzip'] as const) {
      const limit = Math.round(then[kind] * (1 + ALLOWED_GROWTH));
      if (now[kind] > limit) {
        violations.push(
          `${window} startup ${kind}: ${kib(now[kind])} exceeds ${kib(limit)} (baseline ${kib(then[kind])} + ${ALLOWED_GROWTH * 100}%)`,
        );
      }
    }
  }

  const rows = Object.entries(measured).map(([name, size]) => {
    const then = baseline[name];
    return `| ${name} | ${kib(size.raw)} | ${delta(size.raw, then?.raw)} | ${kib(size.gzip)} | ${delta(size.gzip, then?.gzip)} |`;
  });
  const table = [
    '| Graph | Raw | vs baseline | Gzip | vs baseline |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows,
  ].join('\n');
  console.log(
    `Startup bundle (deferred is everything no window awaits before rendering):\n${table}`,
  );
  await writeFile(reportPath, `${JSON.stringify({ measured, baseline, violations }, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Startup bundle\n\n${table}\n\n`);
  }

  if (violations.length > 0) {
    console.error(`Bundle budget exceeded:\n${violations.map((item) => `- ${item}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('Bundle budget passed.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
