import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCommandAcl, toPermission } from './command-acl-source.ts';
import type { CommandAclSource } from './command-acl-source.ts';

interface PackageManifest {
  scripts?: Record<string, string>;
}

type BlockFactories = Readonly<Record<string, () => string>>;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const startPattern = /^<!-- generated:([a-z0-9-]+) -->$/;
const endPattern = /^<!-- \/generated:([a-z0-9-]+) -->$/;

const developmentCommandDescriptions = [
  ['dev', 'Run the desktop app with hot reload.'],
  [
    'dev:renderer',
    'Start Vite for browser-only interface work; native operations require the desktop app.',
  ],
  ['test', 'Run TypeScript unit tests and React component tests.'],
  ['lint', 'Check lint rules, feature boundaries, and TypeScript types.'],
  ['format:check', 'Check formatting without changing files.'],
  ['build', 'Build the renderer and check bundle size budgets.'],
  ['rust:check', 'Lint the backend as it ships, without running tests; a warning fails it.'],
  [
    'rust:test',
    'Run the Rust tests; ignored ones, such as those that need Docker or live servers, do not run.',
  ],
  ['rust:build:release', 'Build the native release executable without packaging an installer.'],
  [
    'build:tauri',
    'Build the production installer and signed update artifacts; requires updater signing credentials.',
  ],
  [
    'check',
    'Run every check CI runs, including coverage, browser tests, Clippy, licenses, and build checks.',
  ],
  [
    'clean',
    'Remove generated output, reports, and native build caches; see [cleanup options](#clean-up-build-output).',
  ],
] as const;

export function developmentCommands(manifest: PackageManifest): string {
  const rows = developmentCommandDescriptions.map(([script, description]) => {
    assert.ok(
      manifest.scripts?.[script],
      `package.json must define the documented ${script} script`,
    );
    const command = script === 'test' ? 'npm test' : `npm run ${script}`;
    return `| \`${command}\` | ${description} |`;
  });
  return ['| Command | What it does |', '| --- | --- |', ...rows].join('\n');
}

type InventoryAcl = Pick<
  CommandAclSource,
  'appCommands' | 'sensitiveCommands' | 'defaultPermissions' | 'confirmationPermissions'
>;

export function ipcCommandInventory(acl: InventoryAcl): string {
  const commands = [
    ...acl.appCommands.map((command) => ({ command, kind: 'app' })),
    ...acl.sensitiveCommands.map((command) => ({ command, kind: 'sensitive' })),
  ].sort((left, right) =>
    left.command < right.command ? -1 : left.command > right.command ? 1 : 0,
  );
  const rows = commands.map(({ command, kind }) => {
    const permission =
      kind === 'app' ? toPermission(command) : `sensitive:allow-${command.replaceAll('_', '-')}`;
    const main = acl.defaultPermissions.includes(permission) ? 'Yes' : 'No';
    const confirmation = acl.confirmationPermissions.includes(permission) ? 'Yes' : 'No';
    return `| \`${command}\` | ${kind} | ${main} | ${confirmation} |`;
  });
  return ['| Command | Kind | Main | Confirmation |', '| --- | --- | --- | --- |', ...rows].join(
    '\n',
  );
}

export function renderGeneratedBlocks(
  source: string,
  blocks: Readonly<Record<string, string>>,
  file = 'document',
): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const output: string[] = [];
  const seen = new Set<string>();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const start = startPattern.exec(line);
    const end = endPattern.exec(line);
    assert.ok(!end, `${file}:${index + 1}: unmatched closing marker ${end?.[1]}`);
    if (!start) {
      output.push(line);
      index += 1;
      continue;
    }

    const id = start[1]!;
    assert.ok(Object.hasOwn(blocks, id), `${file}:${index + 1}: unknown generated block ${id}`);
    assert.ok(!seen.has(id), `${file}:${index + 1}: duplicate generated block ${id}`);
    seen.add(id);
    output.push(line);
    index += 1;

    while (index < lines.length && lines[index] !== `<!-- /generated:${id} -->`) {
      assert.ok(
        !startPattern.test(lines[index]!),
        `${file}:${index + 1}: nested generated block in ${id}`,
      );
      assert.ok(
        !endPattern.test(lines[index]!),
        `${file}:${index + 1}: mismatched closing marker in ${id}`,
      );
      index += 1;
    }
    assert.ok(index < lines.length, `${file}: unclosed generated block ${id}`);
    output.push(...blocks[id]!.replace(/\n+$/, '').split('\n'), lines[index]!);
    index += 1;
  }

  for (const id of Object.keys(blocks)) {
    assert.ok(seen.has(id), `${file}: missing generated block ${id}`);
  }
  return output.join(newline);
}

export const GENERATED_DOC_LINKS = [
  { code: /^package\.json$/, document: 'docs/development.md', block: 'development-commands' },
  {
    code: /^src-tauri\/(?:build\.rs|capabilities\/.*|src\/(?:lib\.rs|runtime\/sensitive_plugin\.rs))$/,
    document: 'docs/ipc-permissions.md',
    block: 'ipc-command-inventory',
  },
] as const;

export function generatedBlockImpacts(paths: Iterable<string>) {
  const changed = [...paths].map((file) => file.replaceAll('\\', '/'));
  return GENERATED_DOC_LINKS.filter((link) => changed.some((file) => link.code.test(file))).map(
    ({ document, block }) => ({ document, block }),
  );
}

function blockFactories(
  manifest: PackageManifest,
  acl: CommandAclSource,
): Record<string, BlockFactories> {
  return {
    'docs/development.md': {
      'development-commands': () => developmentCommands(manifest),
    },
    'docs/ipc-permissions.md': {
      'ipc-command-inventory': () => ipcCommandInventory(acl),
    },
  };
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const [manifestSource, acl] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8'),
    loadCommandAcl(),
  ]);
  const manifest = JSON.parse(manifestSource) as PackageManifest;
  const stale: string[] = [];

  for (const [file, factories] of Object.entries(blockFactories(manifest, acl))) {
    const contents = Object.fromEntries(
      Object.entries(factories).map(([id, create]) => [id, create()]),
    );
    const source = await readFile(path.join(root, file), 'utf8');
    const generated = renderGeneratedBlocks(source, contents, file);
    if (generated === source) continue;
    stale.push(file);
    if (write) await writeFile(path.join(root, file), generated, 'utf8');
  }

  if (stale.length > 0 && !write) {
    throw new Error(
      `Generated documentation is stale: ${stale.join(', ')}\nRun npm run docs:generate`,
    );
  }
  console.log(
    write
      ? `Generated documentation OK: ${stale.length} file(s) updated`
      : 'Generated documentation OK: every block matches its source',
  );
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
