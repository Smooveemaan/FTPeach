import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const legalDirectory = path.join(root, 'docs', 'legal');
const npmOutputPath = path.join(legalDirectory, 'NPM_THIRD_PARTY_LICENSES.txt');
const rustOutputPath = path.join(legalDirectory, 'RUST_THIRD_PARTY_LICENSES.txt');
const cargoLockPath = path.join(root, 'src-tauri', 'Cargo.lock');
const checkOnly = process.argv.includes('--check');
const npmOnly = process.argv.includes('--npm-only');

function normalizeNewlines(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function sha256(value: string): string {
  return createHash('sha256').update(normalizeNewlines(value)).digest('hex');
}

function command(name: string, args: string[], cwd = root): string {
  const executable = process.platform === 'win32' && name === 'npm' ? 'npm.cmd' : name;
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${name} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function repositoryUrl(repository: unknown): string | undefined {
  if (typeof repository === 'string') return repository;
  if (repository && typeof repository === 'object' && 'url' in repository) {
    const url = (repository as { url?: unknown }).url;
    return typeof url === 'string' ? url : undefined;
  }
  return undefined;
}

async function npmReport(): Promise<string> {
  const lockSource = await readFile(path.join(root, 'package-lock.json'), 'utf8');
  const lock = JSON.parse(lockSource);
  const packages = lock.packages as Record<string, { dependencies?: Record<string, string> }>;
  const selected = new Set<string>();
  const queue = Object.keys(packages['']?.dependencies || {}).map((name) => `node_modules/${name}`);

  function resolveDependency(from: string, name: string): string | undefined {
    let directory = path.posix.dirname(from);
    while (true) {
      const candidate =
        directory === '.' ? `node_modules/${name}` : `${directory}/node_modules/${name}`;
      if (packages[candidate]) return candidate;
      const parent = path.posix.dirname(directory);
      if (parent === directory || directory === '.') return undefined;
      directory = parent;
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const packageKey = queue[cursor];
    if (!packageKey || selected.has(packageKey) || !packages[packageKey]) continue;
    selected.add(packageKey);
    for (const name of Object.keys(packages[packageKey].dependencies || {})) {
      const dependency = resolveDependency(packageKey, name);
      assert.ok(dependency, `Cannot resolve production dependency ${name} from ${packageKey}`);
      queue.push(dependency);
    }
  }

  const paths = [...selected].map((packageKey) => path.join(root, ...packageKey.split('/')));

  const sections: string[] = [];
  for (const packagePath of [...new Set(paths)].sort()) {
    const manifest = JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf8'));
    const filenames = await readdir(packagePath);
    const licenseFiles = filenames
      .filter((name) => /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(name))
      .sort((a, b) => a.localeCompare(b));
    assert.ok(licenseFiles.length > 0, `${manifest.name} ${manifest.version} has no license file`);

    const texts: string[] = [];
    for (const filename of licenseFiles) {
      texts.push(
        `${filename}\n${'-'.repeat(filename.length)}\n${normalizeNewlines(
          await readFile(path.join(packagePath, filename), 'utf8'),
        ).trim()}`,
      );
    }
    const source = repositoryUrl(manifest.repository) || manifest.homepage || '(not declared)';
    sections.push(
      `${manifest.name} ${manifest.version}\n${'='.repeat(`${manifest.name} ${manifest.version}`.length)}\n` +
        `Declared license: ${manifest.license || 'UNKNOWN'}\nSource: ${source}\n\n${texts.join('\n\n')}`,
    );
  }

  const lockHash = sha256(lockSource);
  return (
    `FTPeach npm runtime dependency licenses\n` +
    `========================================\n\n` +
    `Generated from package-lock.json. Do not edit manually.\n` +
    `package-lock.json SHA-256: ${lockHash}\n\n` +
    sections.join('\n\n\n') +
    '\n'
  );
}

async function generateRustReport(): Promise<void> {
  command(
    'cargo',
    [
      'about',
      'generate',
      'about.hbs',
      '--output-file',
      '../docs/legal/RUST_THIRD_PARTY_LICENSES.txt',
      '--locked',
      '--target',
      'x86_64-pc-windows-msvc',
      '--fail',
    ],
    path.join(root, 'src-tauri'),
  );
  const lockHash = sha256(await readFile(cargoLockPath, 'utf8'));
  const report = await readFile(rustOutputPath, 'utf8');
  await writeFile(
    rustOutputPath,
    `${report
      .replace(
        'Generated by cargo-about from src-tauri/Cargo.lock. Do not edit manually.',
        `Generated by cargo-about from src-tauri/Cargo.lock. Do not edit manually.\nCargo.lock SHA-256: ${lockHash}`,
      )
      .trimEnd()}\n`,
  );
}

const expectedNpm = await npmReport();
if (checkOnly) {
  assert.equal(
    normalizeNewlines(await readFile(npmOutputPath, 'utf8')),
    expectedNpm,
    'NPM license report is stale',
  );
  const rustReport = normalizeNewlines(await readFile(rustOutputPath, 'utf8'));
  const cargoLockHash = sha256(await readFile(cargoLockPath, 'utf8'));
  assert.ok(
    rustReport.includes(`Cargo.lock SHA-256: ${cargoLockHash}`),
    'Rust license report is stale; run npm run licenses:generate',
  );
  for (const license of [
    'Mozilla Public License 2.0',
    'Community Data License Agreement Permissive 2.0',
    'zlib License',
  ]) {
    assert.ok(rustReport.includes(license), `Rust license report is missing ${license}`);
  }
  console.log('Third-party license reports are present and current');
} else {
  await writeFile(npmOutputPath, expectedNpm);
  if (!npmOnly) await generateRustReport();
  console.log(
    npmOnly
      ? 'Generated npm third-party license report'
      : 'Generated npm and Rust third-party license reports',
  );
}
