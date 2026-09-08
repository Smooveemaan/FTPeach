// The Rust half of the boundary gate that `check-feature-boundaries.ts` runs
// for `src/`. Rust has no `index.ts` to hide behind, so the rules here are
// about direction only: which module is allowed to name which.
//
// Three rules, each paying for a defect that had already happened:
//
//   * The domain zones sit below the Tauri command layer, so a
//     `use crate::commands::…` inside one of them is a cycle. That is how
//     `local_fs` came to import `OkResult` from `commands::fs`.
//   * One command module may not name another. `commands/drag_out.rs` and
//     `commands/open_with.rs` both reached into `commands/transfer.rs` for
//     `pool_for`, which is a session lookup, not a command.
//   * No module may take part in an import cycle, however long. The frontend
//     checker has had cycle detection since it was written; Rust had none.
//   * Every `crate::…` path names a real top-level module. `lib.rs` used to
//     glob-re-export four zones, so paths read `crate::vault`,
//     `crate::preview`, `crate::shutdown` -- names that did not say which
//     zone they came from and that no check could see.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Zones that implement behaviour and must not know about the IPC surface. */
const belowCommands = ['application', 'store', 'protocol', 'security', 'transfer', 'local_fs'];

const cratePathPattern = /\bcrate::((?:[a-z_][a-z0-9_]*)(?:::[a-z_][a-z0-9_]*)*)/g;

export function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return path.extname(entry.name) === '.rs' ? [entryPath] : [];
  });
}

/** Top-level directory under `src/`, or `null` for a file sitting in the root. */
export function crateZone(file: string, sourceRoot: string): string | null {
  const segments = path.relative(sourceRoot, file).split(path.sep);
  return segments.length > 1 ? (segments[0] ?? null) : null;
}

function relative(file: string, sourceRoot: string): string {
  return path.relative(sourceRoot, file).split(path.sep).join('/');
}

/** The module path a file answers to, e.g. `store/settings.rs` -> `store::settings`. */
function modulePath(file: string, sourceRoot: string): string {
  const segments = relative(file, sourceRoot).replace(/\.rs$/, '').split('/');
  if (segments.at(-1) === 'mod') segments.pop();
  return segments.join('::');
}

/** Every module path the crate root can name, e.g. `security::vault`. */
function moduleIndex(files: string[], sourceRoot: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of files) index.set(modulePath(file, sourceRoot), file);
  return index;
}

/** The top-level modules `lib.rs` declares: directories plus root `.rs` files. */
function topLevelModules(sourceRoot: string): Set<string> {
  return new Set(
    fs
      .readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || path.extname(entry.name) === '.rs')
      .map((entry) => entry.name.replace(/\.rs$/, ''))
      .filter((name) => name !== 'lib' && name !== 'main'),
  );
}

/** The file a `crate::…` path refers to, by longest matching module prefix. */
function resolveCratePath(reference: string, index: Map<string, string>): string | null {
  const segments = reference.split('::');
  for (let length = segments.length; length > 0; length -= 1) {
    const candidate = index.get(segments.slice(0, length).join('::'));
    if (candidate !== undefined) return candidate;
  }
  return null;
}

export function checkFile(
  file: string,
  sourceRoot: string,
  topLevel: Set<string>,
  contents = fs.readFileSync(file, 'utf8'),
): string[] {
  const zone = crateZone(file, sourceRoot);
  const relativeFile = relative(file, sourceRoot);
  const errors: string[] = [];
  if (
    zone === 'security' &&
    /\b(WebviewWindowBuilder|DwmSetWindowAttribute|PhysicalPosition)\b/.test(contents)
  ) {
    errors.push(`${relativeFile} implements confirmation presentation; move it to runtime`);
  }
  const unresolved = new Set<string>();
  let reachedCommands = false;

  for (const match of contents.matchAll(cratePathPattern)) {
    const reference = match[1];
    if (reference === undefined) continue;
    const [head, sibling] = reference.split('::');

    if (head !== undefined && !topLevel.has(head) && !unresolved.has(head)) {
      unresolved.add(head);
      errors.push(
        `${relativeFile} names crate::${head}, which is not a top-level module — ` +
          'spell the zone out (crate::security::vault, not crate::vault)',
      );
    }

    if (head === 'commands' && zone !== null && belowCommands.includes(zone) && !reachedCommands) {
      reachedCommands = true;
      errors.push(`${relativeFile} (${zone}) reaches into crate::commands`);
    }

    // `commands/session/browse.rs` naming `commands::session` is a child
    // reaching its own parent, which is how the module tree already works.
    if (head === 'commands' && zone === 'commands' && sibling !== undefined) {
      const own = relativeFile.split('/')[1]?.replace(/\.rs$/, '');
      if (own !== undefined && sibling !== own) {
        errors.push(`${relativeFile} names a sibling command module, crate::commands::${sibling}`);
      }
    }
  }

  return errors;
}

/** Reports the first cycle found, naming the modules on it in order. */
export function findModuleCycle(
  files: string[],
  sourceRoot: string,
  readSource: (_file: string) => string = (file) => fs.readFileSync(file, 'utf8'),
): string[] {
  const index = moduleIndex(files, sourceRoot);
  const graph = new Map<string, Set<string>>();

  for (const file of files) {
    const targets = new Set<string>();
    graph.set(file, targets);
    const contents = readSource(file);
    for (const match of contents.matchAll(cratePathPattern)) {
      const reference = match[1];
      if (reference === undefined) continue;
      const target = resolveCratePath(reference, index);
      if (target !== null && target !== file) targets.add(target);
    }
  }

  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const visit = (file: string): string[] | null => {
    if (onStack.has(file)) {
      const start = stack.indexOf(file);
      return [...stack.slice(start), file].map((entry) => relative(entry, sourceRoot));
    }
    if (visited.has(file)) return null;
    visited.add(file);
    onStack.add(file);
    stack.push(file);
    for (const target of graph.get(file) ?? []) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    stack.pop();
    onStack.delete(file);
    return null;
  };

  for (const file of files) {
    const cycle = visit(file);
    if (cycle) return cycle;
  }
  return [];
}

export interface RustBoundaryCheckResult {
  errors: string[];
  fileCount: number;
}

export function runRustBoundaryCheck(sourceRoot: string): RustBoundaryCheckResult {
  const files = sourceFiles(sourceRoot);
  const topLevel = topLevelModules(sourceRoot);
  const sources = new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]));
  const errors = files.flatMap((file) => checkFile(file, sourceRoot, topLevel, sources.get(file)!));
  const cycle = findModuleCycle(files, sourceRoot, (file) => sources.get(file)!);
  if (cycle.length > 0) errors.push(`module import cycle: ${cycle.join(' -> ')}`);
  return { errors, fileCount: files.length };
}

function main(): void {
  const sourceRoot = path.resolve('src-tauri', 'src');
  const { errors, fileCount } = runRustBoundaryCheck(sourceRoot);

  if (errors.length) {
    console.error(`Rust boundary check failed:\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }

  console.log(`Rust boundary check passed (${fileCount} files).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
