import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { GENERATED_DOC_LINKS, generatedBlockImpacts } from './check-generated-docs.ts';

export const CHECKS = ['i18n:check', 'check:docs', 'check:verified-by', 'format:check'] as const;

export const GATES = [
  'supply-chain',
  'lint-test-build',
  'sast',
  'parser-regressions',
  'rust-linux',
  'rust-test',
  'rust-test-unix',
  'rust-coverage',
  'visual-regression',
  'i18n-audit-sample',
  'packaged-smoke',
] as const;
export type GateId = (typeof GATES)[number];
export type ClassificationSource =
  'working-tree' | 'branch' | 'pull-request' | 'push' | 'manual' | 'explicit';
export interface ClassificationContext {
  source: ClassificationSource;
  base: string | null;
  head: string | null;
  forceFull?: boolean;
}
export interface CollectedChanges {
  paths: string[];
  context: ClassificationContext;
}
export type GitRunner = (_args: string[], _cwd?: string) => string;
type PackageManifest = Record<string, unknown> & { scripts?: Record<string, string> };
export interface PackageChange {
  before: PackageManifest;
  after: PackageManifest;
}

export function discoverRustIncludes(
  root = fileURLToPath(new URL('../../', import.meta.url)),
): string[] {
  const crate = path.join(root, 'src-tauri');
  const found = new Set<string>();
  for (const entry of readdirSync(path.join(crate, 'src'), {
    recursive: true,
    encoding: 'utf8',
  })) {
    if (!entry.endsWith('.rs')) continue;
    const file = path.join(crate, 'src', entry);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"/g)) {
      const target = path.relative(root, path.resolve(path.dirname(file), match[1]!));
      const normalized = target.split(path.sep).join('/');
      if (!normalized.startsWith('src-tauri/') && !normalized.startsWith('../')) {
        found.add(normalized);
      }
    }
  }
  return [...found].sort();
}

/** Select checks by affected code; explicit full runs include every suite. */
export function classifyChangeSet(
  paths: Iterable<string>,
  context: ClassificationContext = { source: 'explicit', base: null, head: null },
  includes: readonly string[] = discoverRustIncludes(),
  packageChange?: PackageChange,
) {
  const changedFiles = [
    ...new Set(
      [...paths].map((file) => file.replaceAll('\\', '/').replace(/^\.\//, '')).filter(Boolean),
    ),
  ].sort();
  const selected = new Set<GateId>(['supply-chain']);
  let application = false;
  let site = false;
  const tooling = () => selected.add('lint-test-build');
  const frontend = () => {
    application = true;
    selected.add('lint-test-build');
    selected.add('sast');
  };
  const rust = () => {
    selected.add('rust-test');
    selected.add('sast');
  };
  const both = () => {
    frontend();
    rust();
  };

  for (const file of changedFiles) {
    if (includes.includes(file)) rust();
    if (
      /^(?:site\/|scripts\/site\/|docs\/guide\/|assets\/images\/)/.test(file) ||
      /^test\/unit\/tooling\/site.*\.test\.ts$/.test(file) ||
      /^test\/visual\/(?:website-.*\.spec\.ts|playwright\.site\.config\.ts)$/.test(file) ||
      ['public/favicon.ico', 'playwright.config.ts', '.github/workflows/pages.yml'].includes(file)
    )
      site = true;
    if (file === 'package.json' && packageChange) {
      const { scripts: before = {}, ...beforeFields } = packageChange.before;
      const { scripts: after = {}, ...afterFields } = packageChange.after;
      if (!isDeepStrictEqual(beforeFields, afterFields)) {
        both();
        site = true;
      }
      const changed = new Set(
        [...Object.keys(before), ...Object.keys(after)].filter(
          (name) => before[name] !== after[name],
        ),
      );
      // A changed helper also affects scripts that invoke it, including build/site commands.
      for (const name of changed) {
        for (const [caller, command] of [...Object.entries(before), ...Object.entries(after)]) {
          if (
            [...command.matchAll(/npm (?:run ([\w:-]+)|(test))\b/g)].some(
              (match) => (match[1] ?? match[2]) === name,
            )
          )
            changed.add(caller);
        }
      }
      for (const name of changed) {
        if (/^(?:pre|post)?site:/.test(name)) site = true;
        else if (
          /^(?:check(?::|$)|lint$|typecheck$|format(?::|$)|test(?::|$)|coverage$|i18n:|licenses:)/.test(
            name,
          )
        )
          tooling();
        else if (/^rust:(?:check|clippy|test|coverage)$/.test(name)) rust();
        else both();
      }
    } else if (file === 'package.json' || file === 'package-lock.json') {
      both();
      site = true;
    } else if (
      file === '.github/workflows/release.yml' ||
      file.startsWith('src/platform/') ||
      file.startsWith('src-tauri/src/commands/')
    ) {
      both();
    } else if (
      file.startsWith('src-tauri/') ||
      file.startsWith('.cargo/') ||
      file === 'Cargo.lock' ||
      file === 'rust-toolchain.toml' ||
      file === 'scripts/cargo.ts'
    ) {
      rust();
    } else if (file.startsWith('.semgrep/')) {
      selected.add('sast');
    } else if (
      file.startsWith('scripts/site/') ||
      /^test\/unit\/tooling\/site.*\.test\.ts$/.test(file) ||
      /^test\/visual\/(?:website-.*\.spec\.ts|playwright\.site\.config\.ts)$/.test(file)
    ) {
      // Pages checks these inputs independently.
    } else if (
      (file.startsWith('scripts/checks/') && file !== 'scripts/checks/check-bundle-budget.ts') ||
      file.startsWith('scripts/coverage/') ||
      file.startsWith('test/unit/tooling/') ||
      file === '.github/workflows/checks.yml' ||
      file === '.github/workflows/ci.yml'
    ) {
      tooling();
    } else if (
      file.startsWith('src/') ||
      file.startsWith('public/') ||
      file.startsWith('test/') ||
      file.startsWith('scripts/') ||
      /^(?:tsconfig.*\.json|(?:eslint|vitest|vite|playwright)\.config\.ts)$/.test(file) ||
      file === 'index.html' ||
      file.startsWith('.prettier')
    ) {
      frontend();
    } else if (
      file.endsWith('.md') ||
      file.startsWith('docs/') ||
      file.startsWith('site/') ||
      file.startsWith('assets/') ||
      file.startsWith('.github/') ||
      /^(?:LICENSE|NOTICE|\.gitignore|\.gitattributes|\.editorconfig)$/.test(file)
    ) {
      // Website builds and installer checks have their own workflows.
    } else if (!includes.includes(file)) {
      both();
      selected.add('parser-regressions');
    }
    if (file.startsWith('src-tauri/src/protocol/') || file.startsWith('src-tauri/fuzz/')) {
      selected.add('parser-regressions');
    }
    if (file === 'src-tauri/src/local_fs/filesystem_safety.rs') {
      selected.add('rust-test-unix');
    }
    if (
      [
        'src-tauri/src/commands/smoke.rs',
        'src-tauri/src/runtime/shutdown.rs',
        'src-tauri/assets/smoke_test.js',
        'src-tauri/assets/acl_probe.js',
        'test/unit/tooling/packagedSmoke.test.ts',
      ].includes(file) ||
      file.startsWith('scripts/packaged-smoke/')
    ) {
      selected.add('packaged-smoke');
    }
  }
  const checkTooling = changedFiles.some(
    (file) =>
      /^package(?:-lock)?\.json$/.test(file) ||
      file.startsWith('scripts/checks/') ||
      file === '.github/workflows/checks.yml',
  );
  const requiredChecks = CHECKS.filter((check) => {
    if (context.forceFull || checkTooling) return true;
    switch (check) {
      case 'i18n:check':
        return changedFiles.some((file) => /^src\/.*(?:\.tsx?|\/locales\/[^/]+\.json)$/.test(file));
      case 'check:docs':
        return (
          generatedBlockImpacts(changedFiles).length > 0 ||
          changedFiles.some((file) => GENERATED_DOC_LINKS.some((link) => link.document === file))
        );
      case 'check:verified-by':
        return changedFiles.some(
          (file) =>
            /^docs\/guide\/.*\.md$/.test(file) ||
            file === 'docs/manual-checks.md' ||
            /\.(?:rs|(?:test|spec)\.tsx?)$/.test(file),
        );
      case 'format:check':
        return changedFiles.some(
          (file) =>
            /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml)$/.test(file) ||
            file.startsWith('.prettier') ||
            file === '.editorconfig' ||
            file === '.gitignore',
        );
    }
  });
  return {
    ...context,
    changedFiles,
    requiredGates: GATES.filter((gate) => context.forceFull || selected.has(gate)),
    requiredChecks,
    toolingOnly: !context.forceFull && !application,
    site,
  };
}

/** Compare manifest contents, so changing a check command does not rebuild its consumers. */
export function collectPackageChange(
  context: ClassificationContext,
  run: GitRunner = runGit,
  cwd?: string,
): PackageChange | undefined {
  if (!context.base || context.forceFull) return undefined;
  const before = run(['show', `${context.base}:package.json`], cwd);
  const after =
    context.source === 'working-tree'
      ? readFileSync(path.join(cwd ?? '.', 'package.json'), 'utf8')
      : context.head
        ? run(['show', `${context.head}:package.json`], cwd)
        : null;
  return after === null ? undefined : { before: JSON.parse(before), after: JSON.parse(after) };
}

/** Splits `git diff -z` output, which is NUL-separated, or plain lines. */
export function splitPaths(input: string): string[] {
  return input.split(/\0|\r?\n/);
}

function runGit(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function existingCommit(run: GitRunner, cwd: string | undefined, revision: string): string {
  const sha = run(['rev-parse', '--verify', `${revision}^{commit}`], cwd).trim();
  if (!sha) throw new Error(`Git returned an empty commit for ${revision}`);
  return sha;
}

function diffPaths(run: GitRunner, cwd: string | undefined, base: string, head: string): string[] {
  return splitPaths(run(['diff', '--no-renames', '--name-only', '-z', base, head], cwd));
}

export function collectChangeSet(
  options: {
    source: Exclude<ClassificationSource, 'explicit' | 'manual'>;
    base?: string;
    head?: string;
    baseRef?: string;
    cwd?: string;
  },
  run: GitRunner = runGit,
): CollectedChanges {
  const { source, cwd } = options;
  if (source === 'working-tree') {
    const head = existingCommit(run, cwd, 'HEAD');
    const tracked = run(['diff', '--no-renames', '--name-only', '-z', 'HEAD'], cwd);
    const untracked = run(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
    return {
      paths: [...splitPaths(tracked), ...splitPaths(untracked)],
      context: { source, base: head, head },
    };
  }
  if (source === 'branch') {
    const head = existingCommit(run, cwd, options.head ?? 'HEAD');
    const base = run(['merge-base', options.baseRef ?? 'origin/master', head], cwd).trim();
    if (!base) throw new Error('Git returned an empty branch merge base');
    existingCommit(run, cwd, base);
    return { paths: diffPaths(run, cwd, base, head), context: { source, base, head } };
  }
  if (!options.base || !options.head) {
    throw new Error(`${source} classification requires explicit base and head commits`);
  }
  if (/^0+$/.test(options.base)) {
    if (source === 'push') {
      return {
        paths: splitPaths(
          run(['ls-tree', '-r', '--name-only', '-z', existingCommit(run, cwd, options.head)], cwd),
        ),
        context: { source, base: null, head: options.head },
      };
    }
    throw new Error('A pull request cannot have an empty base commit');
  }
  const base = existingCommit(run, cwd, options.base);
  const head = existingCommit(run, cwd, options.head);
  return { paths: diffPaths(run, cwd, base, head), context: { source, base, head } };
}

export function collectGitHubChangeSet(
  env: Record<string, string | undefined>,
  run: GitRunner = runGit,
): CollectedChanges {
  const event = env.GITHUB_EVENT_NAME;
  const source =
    event === 'pull_request'
      ? 'pull-request'
      : event === 'push'
        ? 'push'
        : event === 'workflow_dispatch'
          ? 'manual'
          : null;
  if (!source) throw new Error(`Unsupported GitHub event: ${event ?? '(missing)'}`);
  if (env.FORCE_ALL === 'true') {
    return {
      paths: [],
      context: {
        source,
        base: env.BASE_SHA || null,
        head: env.HEAD_SHA || null,
        forceFull: true,
      },
    };
  }
  if (source === 'manual') throw new Error('Manual CI requires FORCE_ALL=true');
  return collectChangeSet(
    {
      source,
      ...(env.BASE_SHA ? { base: env.BASE_SHA } : {}),
      ...(env.HEAD_SHA ? { head: env.HEAD_SHA } : {}),
    },
    run,
  );
}

function option(args: string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const source = option(args, 'source') ?? 'stdin';
  let collected: CollectedChanges;
  if (source === 'stdin') {
    collected = {
      paths: splitPaths(await readStdin()),
      context: {
        source: 'explicit',
        base: process.env.BASE_SHA || null,
        head: process.env.HEAD_SHA || null,
      },
    };
  } else if (source === 'github') {
    collected = collectGitHubChangeSet(process.env);
  } else if (
    source === 'working-tree' ||
    source === 'branch' ||
    source === 'pull-request' ||
    source === 'push'
  ) {
    const base = option(args, 'base');
    const head = option(args, 'head');
    const baseRef = option(args, 'base-ref');
    collected = collectChangeSet({
      source,
      ...(base ? { base } : {}),
      ...(head ? { head } : {}),
      ...(baseRef ? { baseRef } : {}),
    });
  } else {
    throw new Error(`Unsupported classification source: ${source}`);
  }
  if (option(args, 'force-all') === 'true' || args.includes('--force-all')) {
    collected = { paths: [], context: { ...collected.context, forceFull: true } };
  }
  const packageChange = collected.paths.includes('package.json')
    ? collectPackageChange(collected.context)
    : undefined;
  const result = classifyChangeSet(collected.paths, collected.context, undefined, packageChange);
  const outputs = {
    'required-gates': JSON.stringify(result.requiredGates),
    'required-checks': JSON.stringify(result.requiredChecks),
    'tooling-only': String(result.toolingOnly),
    site: String(result.site),
  };
  const text = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  process.stdout.write(
    args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : `${text}\n`,
  );
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${text}\n`);
}

if (import.meta.filename === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    console.error(`classify-changes: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
