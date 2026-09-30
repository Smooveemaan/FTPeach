// The Rust half of the boundary gate that `check-feature-boundaries.ts` runs
// for `src/`. Rust has no `index.ts` to hide behind, so the rules here are
// about direction only: which module is allowed to name which.
//
// The rules, each paying for a defect that had already happened:
//
//   * Each zone may name only the zones listed for it in ALLOWED. The domain
//     zones sit below the Tauri command layer, so `use crate::commands::…`
//     inside one of them is a cycle; that is how `local_fs` came to import
//     `OkResult` from `commands::fs`.
//   * One command module may not name another. `commands/drag_out.rs` and
//     `commands/open_with.rs` both reached into `commands/transfer.rs` for
//     `pool_for`, which is a session lookup, not a command.
//   * No module may take part in an import cycle, however long.
//   * Every `crate::…` path names a real top-level module. `lib.rs` used to
//     glob-re-export four zones, so paths read `crate::vault` — names that did
//     not say which zone they came from and that no check could see.
//
// What it reads. Paths in `use` declarations, groups included
// (`crate::a::{b, c::d}`), and paths written inline, starting with `crate::`,
// `super::`, `self::`, or a child module's name. Comments and string literals
// are blanked first, so text never becomes an import. Code only tests compile
// — `tests.rs`, `*_tests.rs` and every `#[cfg(test)]` item — is held to the
// crate-path rule only: a test may reach into what it tests.
//
// What it does not read. This is a lexical check, not the compiler's module
// graph: paths produced by macros, `#[path]` attributes, `super::` inside an
// inline `mod` block of a production file, and names brought in through a
// glob (`use a::*` counts as naming `a`) are resolved no further. A child
// naming its own parent or ancestor is containment, not a cycle.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { codeOnly, isTestFile, splitInlineTests } from './rust-source.ts';

/**
 * What each zone's production code may name, as zones or `zone::module`
 * prefixes. `lib.rs` and `main.rs` are the composition root and may name
 * anything. Adding an edge is a design decision: write the reason beside it.
 */
export const ALLOWED: Record<string, readonly string[]> = {
  // The Tauri command layer: the one zone that may call into all the others.
  commands: [
    'application',
    'domain',
    'ipc',
    'local_fs',
    'native_drag',
    'protocol',
    'runtime',
    'security',
    'session',
    'store',
    'transfer',
  ],
  // Process and window lifecycle. `runtime::sensitive_plugin` registers the
  // commands that need a confirmed grant, so it names them.
  runtime: ['commands', 'local_fs', 'protocol', 'security', 'session', 'store', 'transfer'],
  application: [
    'domain',
    'ipc',
    'local_fs',
    'protocol',
    'runtime',
    'security',
    'session',
    'store',
    'transfer',
  ],
  session: ['protocol', 'transfer'],
  native_drag: ['ipc', 'local_fs', 'security', 'transfer'],
  // `runtime::sleep_guard` keeps Windows awake while the pool runs a transfer:
  // one process-wide switch, not a way into the runtime (HF-33).
  transfer: ['ipc', 'protocol', 'runtime::sleep_guard'],
  protocol: ['domain', 'ipc', 'local_fs', 'security', 'store', 'transfer'],
  store: ['domain', 'ipc', 'protocol', 'security'],
  // Security decides and asks; `runtime::confirmation_window` is how the
  // question is put on screen.
  // `domain` gives a bookmark's server the way a connect reads it.
  security: ['domain', 'ipc', 'local_fs', 'runtime::confirmation_window', 'store'],
  local_fs: ['ipc', 'protocol', 'session'],
  // Credentials hold their secrets in the wrapper that forgets them.
  domain: ['ipc', 'security::sensitive_string'],
  // The wire types depend on nothing in the crate.
  ipc: [],
};

const COMPOSITION_ROOT = new Set(['lib', 'main']);

export function sourceFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && path.extname(entry.name) === '.rs')
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function relative(file: string, sourceRoot: string): string {
  return path.relative(sourceRoot, file).split(path.sep).join('/');
}

/**
 * The zone a file belongs to: its top-level directory, or for a file in the
 * crate root its own name (`session.rs` is `session`). `null` for `lib.rs`
 * and `main.rs`.
 */
export function crateZone(file: string, sourceRoot: string): string | null {
  const [first, ...rest] = relative(file, sourceRoot).split('/');
  const zone = rest.length > 0 ? first! : first!.replace(/\.rs$/, '');
  return COMPOSITION_ROOT.has(zone) ? null : zone;
}

/** The module path a file answers to, e.g. `store/settings.rs` -> `store::settings`. */
function modulePath(file: string, sourceRoot: string): string[] {
  const segments = relative(file, sourceRoot).replace(/\.rs$/, '').split('/');
  if (segments.at(-1) === 'mod') segments.pop();
  if (segments.length === 1 && COMPOSITION_ROOT.has(segments[0]!)) return [];
  return segments;
}

/** The top-level modules `lib.rs` declares: directories plus root `.rs` files. */
function topLevelModules(sourceRoot: string): Set<string> {
  return new Set(
    fs
      .readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || path.extname(entry.name) === '.rs')
      .map((entry) => entry.name.replace(/\.rs$/, ''))
      .filter((name) => !COMPOSITION_ROOT.has(name)),
  );
}

/** `a::{b, c::{d, self}, e as f, *}` spelled out as `a::b`, `a::c::d`, `a::c`, `a::e`, `a`. */
export function expandUseTree(tree: string): string[] {
  // Aliases go first: once spaces are gone, `Class` and `C as Lass` look alike.
  const text = tree.replace(/\s+as\s+\w+/g, '').replace(/\s+/g, '');
  const split = (list: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < list.length; index += 1) {
      if (list[index] === '{') depth += 1;
      else if (list[index] === '}') depth -= 1;
      else if (list[index] === ',' && depth === 0) {
        parts.push(list.slice(start, index));
        start = index + 1;
      }
    }
    parts.push(list.slice(start));
    return parts.filter(Boolean);
  };
  const expand = (item: string, prefix: string[]): string[][] => {
    const brace = item.indexOf('{');
    if (brace >= 0) {
      const head = item.slice(0, brace).replace(/::$/, '');
      const base = head ? [...prefix, ...head.split('::')] : prefix;
      return split(item.slice(brace + 1, item.lastIndexOf('}'))).flatMap((part) =>
        expand(part, base),
      );
    }
    const name = item.replace(/::\*$/, '');
    if (name === 'self' || name === '*') return [prefix];
    return [[...prefix, ...name.split('::')]];
  };
  return expand(text.replace(/^::/, ''), []).map((segments) => segments.join('::'));
}

/** Every path a piece of Rust code names: `use` trees and inline paths. */
export function namedPaths(code: string): string[] {
  const paths = new Set<string>();
  const uses = /\buse\s+([^;]+);/g;
  for (const match of code.matchAll(uses)) {
    for (const used of expandUseTree(match[1]!)) paths.add(used);
  }
  const withoutUses = code.replace(uses, (whole) => whole.replace(/[^\n]/g, ' '));
  const inline = /\b(crate|super|self)((?:::[A-Za-z_]\w*)+)/g;
  for (const match of withoutUses.matchAll(inline)) paths.add(`${match[1]}${match[2]}`);
  return [...paths];
}

/**
 * `reference` as a path from the crate root, or `null` for a path that leaves
 * the crate (another crate, the standard library).
 */
function absolute(
  reference: string,
  from: string[],
  modules: Map<string, string>,
): string[] | null {
  const segments = reference.split('::');
  if (segments[0] === 'crate') return segments.slice(1);
  if (segments[0] === 'self' || segments[0] === 'super') {
    let base = [...from];
    while (segments[0] === 'self' || segments[0] === 'super') {
      if (segments.shift() === 'super') base = base.slice(0, -1);
    }
    return [...base, ...segments];
  }
  // Uniform paths: a child module's name reads like a crate name.
  const child = [...from, segments[0]!].join('::');
  return modules.has(child) ? [...from, ...segments] : null;
}

/** The file a crate path refers to, by longest matching module prefix. */
function resolve(segments: string[], modules: Map<string, string>): string | null {
  for (let length = segments.length; length > 0; length -= 1) {
    const file = modules.get(segments.slice(0, length).join('::'));
    if (file !== undefined) return file;
  }
  return null;
}

interface Reference {
  path: string[];
  file: string | null;
  production: boolean;
  /** Written as `crate::…`, not relative to the file. */
  fromCrate: boolean;
}

/** What `file` names, resolved from the crate root, split by who compiles it. */
function references(
  file: string,
  source: string,
  sourceRoot: string,
  modules: Map<string, string>,
): Reference[] {
  const from = modulePath(file, sourceRoot);
  const halves = isTestFile(file) ? { production: '', tests: source } : splitInlineTests(source);
  const found: Reference[] = [];
  for (const [text, production] of [
    [halves.production, true],
    [halves.tests, false],
  ] as const) {
    for (const reference of namedPaths(codeOnly(text))) {
      const segments = absolute(reference, from, modules);
      if (segments === null || segments.length === 0) continue;
      found.push({
        path: segments,
        file: resolve(segments, modules),
        production,
        fromCrate: reference.startsWith('crate::'),
      });
    }
  }
  return found;
}

export interface RustBoundaryCheckResult {
  errors: string[];
  fileCount: number;
}

export function runRustBoundaryCheck(
  sourceRoot: string,
  allowed: Record<string, readonly string[]> = ALLOWED,
): RustBoundaryCheckResult {
  const files = sourceFiles(sourceRoot);
  const topLevel = topLevelModules(sourceRoot);
  const modules = new Map(files.map((file) => [modulePath(file, sourceRoot).join('::'), file]));
  const errors: string[] = [];

  for (const zone of topLevel) {
    if (!(zone in allowed)) {
      errors.push(`${zone} has no entry in ALLOWED; say which zones it may name`);
    }
  }

  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const name = relative(file, sourceRoot);
    const zone = crateZone(file, sourceRoot);
    const own = modulePath(file, sourceRoot);
    const reported = new Set<string>();
    const report = (message: string) => {
      if (!reported.has(message)) errors.push(message);
      reported.add(message);
    };

    if (
      zone === 'security' &&
      /\b(WebviewWindowBuilder|DwmSetWindowAttribute|PhysicalPosition)\b/.test(source)
    ) {
      report(`${name} implements confirmation presentation; move it to runtime`);
    }

    const edges = new Set<string>();
    graph.set(file, edges);
    for (const reference of references(file, source, sourceRoot, modules)) {
      const [head, sibling] = reference.path;
      if (head === undefined) continue;
      if (!topLevel.has(head)) {
        // A relative path that climbs out of the tree is a `#[path]` module or
        // an inline `mod` this check does not follow; only a written
        // `crate::` path is held to the rule.
        if (!reference.fromCrate) continue;
        report(
          `${name} names crate::${head}, which is not a top-level module — ` +
            'spell the zone out (crate::security::vault, not crate::vault)',
        );
        continue;
      }
      if (!reference.production) continue;

      const target = reference.path.join('::');
      // A zone missing from the table is reported once, above.
      const permitted = zone === null ? undefined : allowed[zone];
      if (zone !== null && head !== zone && permitted !== undefined) {
        if (!permitted.some((prefix) => `${target}::`.startsWith(`${prefix}::`))) {
          report(
            `${name}: ${zone} may not name ${reference.path.slice(0, 2).join('::')} ` +
              `(allowed: ${permitted.join(', ') || 'nothing in the crate'})`,
          );
        }
      }

      // `commands/session/browse.rs` naming `commands::session` is a child
      // reaching its own parent, which is how the module tree already works.
      if (zone === 'commands' && head === 'commands' && sibling !== undefined) {
        const ownModule = own[1];
        if (ownModule !== undefined && sibling !== ownModule) {
          report(`${name} names a sibling command module, crate::commands::${sibling}`);
        }
      }

      // A module naming its own ancestor or descendant is containment, not
      // a dependency: a child uses its parent, a parent re-exports its child.
      const other = reference.file === null ? [] : modulePath(reference.file, sourceRoot);
      const within = (outer: string[], inner: string[]) =>
        outer.every((segment, index) => inner[index] === segment);
      if (reference.file !== null && !within(other, own) && !within(own, other)) {
        edges.add(reference.file);
      }
    }
  }

  const cycle = findCycle(graph);
  if (cycle.length > 0) {
    errors.push(
      `module import cycle: ${cycle.map((file) => relative(file, sourceRoot)).join(' -> ')}`,
    );
  }
  return { errors, fileCount: files.length };
}

/** The first cycle in `graph`, as the files on it in order. */
function findCycle(graph: Map<string, Set<string>>): string[] {
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (file: string): string[] | null => {
    if (onStack.has(file)) return [...stack.slice(stack.indexOf(file)), file];
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
  for (const file of graph.keys()) {
    const cycle = visit(file);
    if (cycle) return cycle;
  }
  return [];
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
