import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distDir = path.join(projectRoot, 'dist');
const manifestPath = path.join(distDir, '.vite', 'manifest.json');

const ENTRY_LIMIT_BYTES = 200 * 1024;
const CHUNK_LIMIT_BYTES = 950 * 1024;

interface ManifestEntry {
  file: string;
  isEntry?: boolean;
}

type ViteManifest = Record<string, ManifestEntry>;

const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ViteManifest;
const javascriptFiles = [
  ...new Set(
    Object.values(manifest)
      .map((entry) => entry.file)
      .filter((file) => file.endsWith('.js')),
  ),
];

const sizes = new Map(
  await Promise.all(
    javascriptFiles.map(
      async (file) => [file, (await stat(path.join(distDir, file))).size] as const,
    ),
  ),
);

const violations: string[] = [];
for (const [file, size] of sizes) {
  if (size > CHUNK_LIMIT_BYTES) {
    violations.push(
      `${file}: ${formatKiB(size)} exceeds the ${formatKiB(CHUNK_LIMIT_BYTES)} chunk limit`,
    );
  }
}

for (const entry of Object.values(manifest).filter((item) => item.isEntry)) {
  const size = sizes.get(entry.file);
  if (size !== undefined && size > ENTRY_LIMIT_BYTES) {
    violations.push(
      `${entry.file}: ${formatKiB(size)} exceeds the ${formatKiB(ENTRY_LIMIT_BYTES)} entry limit`,
    );
  }
}

if (violations.length > 0) {
  console.error(`Bundle budget exceeded:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exitCode = 1;
} else {
  const entrySummary = Object.values(manifest)
    .filter((item) => item.isEntry)
    .map((entry) => `${entry.file} ${formatKiB(sizes.get(entry.file))}`)
    .join(', ');
  console.log(`Bundle budget passed (entry: ${entrySummary}).`);
}

function formatKiB(bytes: number | undefined): string {
  if (bytes === undefined) return 'missing';
  return `${(bytes / 1024).toFixed(2)} KiB`;
}
