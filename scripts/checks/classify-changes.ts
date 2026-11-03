import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RISK_LEVELS = ['0', '1', '1T', '1C', '2', '3', '4'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type Platform = 'linux' | 'windows' | 'macos';
export type Placement = 'local' | 'github';
export type ClassificationSource = 'working-tree' | 'branch' | 'pull-request' | 'push' | 'explicit';

export const GATE_DEFINITIONS = {
  'supply-chain': { platforms: ['linux'], placement: ['local', 'github'] },
  'lint-test-build': { platforms: ['linux'], placement: ['local', 'github'] },
  sast: { platforms: ['linux'], placement: ['local', 'github'] },
  'parser-regressions': { platforms: ['linux'], placement: ['local', 'github'] },
  'rust-linux': { platforms: ['linux'], placement: ['local', 'github'] },
  'rust-test': { platforms: ['windows'], placement: ['local', 'github'] },
  'rust-test-unix': { platforms: ['linux', 'macos'], placement: ['github'] },
  'rust-coverage': { platforms: ['windows'], placement: ['local', 'github'] },
  'visual-regression': { platforms: ['windows'], placement: ['local', 'github'] },
  'i18n-audit-sample': { platforms: ['windows'], placement: ['local', 'github'] },
  'packaged-smoke': {
    platforms: ['windows', 'linux', 'macos'],
    placement: ['local', 'github'],
  },
  'pages-build': { platforms: ['linux'], placement: ['local', 'github'] },
  installer: { platforms: ['windows'], placement: ['github'] },
} as const satisfies Record<
  string,
  { platforms: readonly Platform[]; placement: readonly Placement[] }
>;

export type GateId = keyof typeof GATE_DEFINITIONS;

export interface GateRequirement {
  id: GateId;
  platforms: Platform[];
  placement: Placement[];
  reasons: string[];
}

export interface ClassificationContext {
  source: ClassificationSource;
  base: string | null;
  head: string | null;
  forceFull?: boolean;
}

export interface ChangeClassification extends ClassificationContext {
  changedFiles: string[];
  risk: RiskLevel;
  affectedSubsystems: string[];
  requiredGates: GateRequirement[];
  optionalGates: GateRequirement[];
  invalidationInputs: string[];
  /** Compatibility outputs for the current workflow; requiredGates is authoritative. */
  rust: boolean;
  frontend: boolean;
}

export interface CollectedChanges {
  paths: string[];
  context: ClassificationContext;
}

export type GitRunner = (_args: string[], _cwd?: string) => string;

const BASE_GATES: readonly GateId[] = ['supply-chain', 'lint-test-build'];
const RUST_GATES: readonly GateId[] = [
  'sast',
  'parser-regressions',
  'rust-linux',
  'rust-test',
  'rust-test-unix',
  'rust-coverage',
  'packaged-smoke',
];
const FRONTEND_GATES: readonly GateId[] = [
  'sast',
  'visual-regression',
  'i18n-audit-sample',
  'packaged-smoke',
];
const FULL_GATES: readonly GateId[] = [
  ...BASE_GATES,
  ...RUST_GATES.filter((gate) => gate !== 'packaged-smoke'),
  ...FRONTEND_GATES.filter((gate) => gate !== 'packaged-smoke'),
  'packaged-smoke',
];
export const INVALIDATION_INPUTS = [
  'changed-file-contents',
  'base-sha',
  'head-sha',
  'diff-source',
  'dependency-manifests-and-lockfiles',
  'transitive-dependencies',
  'test-config-fixtures-and-helpers',
  'toolchain-and-action-versions',
  'workflow-definitions',
  'os-and-architecture',
  'environment',
  'build-mode',
  'whole-unfiltered-suite',
];

export const CROSS_LANGUAGE_SOURCES: readonly string[] = [
  'src/shared/settingsDefaults.json',
  'src/shared/executableExtensions.json',
  'src/i18n/locales/en.json',
];

const CLASSIFIER_FILES = new Set([
  'scripts/checks/classify-changes.ts',
  'scripts/checks/equivalent-tree-evidence.ts',
  'test/unit/tooling/classifyChanges.test.ts',
  'test/unit/tooling/equivalentTreeEvidence.test.ts',
]);
const INSTALLER_OR_UPDATER =
  /^(?:src-tauri\/installer\/|src-tauri\/src\/(?:runtime\/(?:updater|update_staging)|commands\/updater)|scripts\/release\/(?:test-installers|.*updater)|test\/e2e\/install)/;

interface PathImpact {
  risk: RiskLevel;
  subsystems: string[];
  reason: string;
  rust?: boolean;
  frontend?: boolean;
  legacyRust?: boolean;
  legacyFrontend?: boolean;
  full?: boolean;
  gates?: readonly GateId[] | undefined;
  smokePlatforms?: readonly Platform[];
}

function impact(
  risk: RiskLevel,
  subsystems: string[],
  reason: string,
  extra: Partial<PathImpact> = {},
): PathImpact {
  return { risk, subsystems, reason, ...extra };
}

function normalizePath(raw: string): string {
  const normalized = raw.trim().replaceAll('\\', '/');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function classifyPath(file: string, rustIncludes: ReadonlySet<string>): PathImpact {
  if (CLASSIFIER_FILES.has(file)) {
    return impact(
      '4',
      ['ci', 'classifier'],
      'CI selection or evidence reuse needs independent full confirmation',
      {
        full: true,
        legacyRust: true,
        legacyFrontend: true,
      },
    );
  }
  if (file.startsWith('scripts/packaged-smoke/')) {
    return impact('4', ['ci', 'packaged-smoke'], 'Windows packaged smoke tooling changed', {
      gates: ['packaged-smoke'],
      smokePlatforms: ['windows'],
      legacyRust: true,
      legacyFrontend: true,
    });
  }
  if (file === 'scripts/test-servers/iis.ps1' || file === 'scripts/test-servers/openssh.ps1') {
    return impact('4', ['installer', 'test-tooling'], 'installer test server tooling changed', {
      gates: ['installer'],
    });
  }
  if (
    file === 'package.json' ||
    file === 'src-tauri/Cargo.toml' ||
    file === 'src-tauri/tauri.conf.json' ||
    file === 'src-tauri/build.rs' ||
    file === 'rust-toolchain.toml' ||
    file === 'index.html' ||
    file === 'vite.config.ts' ||
    file === 'src/main.tsx' ||
    file === 'src/platform/tauriApi.ts' ||
    file === 'src-tauri/src/lib.rs' ||
    file.startsWith('src-tauri/capabilities/') ||
    file.startsWith('src-tauri/permissions/') ||
    file.startsWith('src-tauri/gen/') ||
    file.startsWith('src-tauri/icons/')
  ) {
    const installerImpact =
      file === 'src-tauri/tauri.conf.json' || file.startsWith('src-tauri/icons/');
    return impact(
      '4',
      ['build', 'frontend', 'rust', ...(installerImpact ? ['installer'] : [])],
      'an application build or IPC boundary changed',
      {
        full: true,
        gates:
          file === 'package.json' ? ['pages-build'] : installerImpact ? ['installer'] : undefined,
      },
    );
  }
  if (INSTALLER_OR_UPDATER.test(file)) {
    return impact('4', ['build', 'installer', 'updater'], 'installer or updater behavior changed', {
      full: true,
      gates: ['installer'],
    });
  }
  if (file === 'package-lock.json' || file === 'Cargo.lock') {
    const npm = file === 'package-lock.json';
    return impact(
      '2',
      ['dependencies', npm ? 'frontend' : 'rust'],
      'a lockfile changed without a manifest',
      {
        rust: !npm,
        frontend: npm,
        gates: npm ? ['pages-build'] : undefined,
      },
    );
  }
  if (rustIncludes.has(file)) {
    const frontend = file.startsWith('src/');
    const website = file.startsWith('docs/guide/');
    return impact(
      '3',
      [
        'rust',
        ...(frontend ? ['frontend'] : []),
        ...(website ? ['website'] : []),
        ...(file === 'src/i18n/locales/en.json' ? ['localization', 'visual'] : []),
      ],
      'the Rust crate embeds this file with include_str!/include_bytes!',
      {
        rust: true,
        frontend,
        gates: website ? ['pages-build'] : undefined,
      },
    );
  }
  if (file === 'src-tauri/Cargo.lock') {
    return impact('2', ['dependencies', 'rust'], 'the Cargo lockfile changed', { rust: true });
  }
  if (file.startsWith('src-tauri/src/commands/')) {
    return impact('3', ['rust', 'frontend', 'ipc'], 'a Tauri command crosses the IPC boundary', {
      rust: true,
      frontend: true,
    });
  }
  if (file.startsWith('src/platform/')) {
    return impact('3', ['frontend', 'rust', 'ipc'], 'renderer IPC code reaches Rust commands', {
      rust: true,
      frontend: true,
    });
  }
  if (
    file.startsWith('src-tauri/src/') ||
    file.startsWith('src-tauri/fuzz/') ||
    file.startsWith('src-tauri/examples/') ||
    file.startsWith('.cargo/') ||
    file === 'scripts/cargo.ts'
  ) {
    const parser = file.startsWith('src-tauri/src/protocol/') || file.startsWith('src-tauri/fuzz/');
    return impact(
      '3',
      ['rust', ...(parser ? ['parser'] : [])],
      'Rust code or its test inputs changed',
      {
        rust: true,
      },
    );
  }
  if (file.startsWith('src-tauri/')) {
    return impact(
      '4',
      ['rust', 'build', 'unknown'],
      'the Tauri file has no narrower proven impact',
      {
        full: true,
      },
    );
  }
  if (file.startsWith('src/')) {
    const localization = file.startsWith('src/i18n/');
    const shared = /^(?:src\/(?:components|shared|styles)\/)/.test(file);
    return impact(
      '3',
      [
        'frontend',
        ...(localization ? ['localization', 'visual'] : []),
        ...(shared ? ['shared', 'visual'] : []),
      ],
      shared
        ? 'shared frontend code or layout reaches multiple screens'
        : 'frontend source changed',
      { frontend: true },
    );
  }
  if (file.startsWith('test/visual/website-') || file === 'test/visual/playwright.site.config.ts') {
    return impact('1', ['website', 'tests'], 'website browser tests changed', {
      gates: ['pages-build'],
    });
  }
  if (file.startsWith('test/visual/')) {
    return impact('3', ['frontend', 'visual', 'tests'], 'visual tests or their helpers changed', {
      frontend: true,
    });
  }
  if (/^test\/unit\/tooling\/site[^/]*\.test\.ts$/.test(file)) {
    return impact('1', ['website', 'tests'], 'website tooling tests changed', {
      gates: ['pages-build'],
    });
  }
  if (file.startsWith('test/unit/') || file.startsWith('test/component/')) {
    return impact('1T', ['tests', 'test-helpers'], 'only unit or component tests changed');
  }
  if (file.startsWith('test/e2e/')) {
    return impact('1C', ['tests', 'test-tooling'], 'on-demand end-to-end tooling changed');
  }
  if (file.startsWith('test/fixtures/')) {
    return impact(
      '4',
      ['fixtures', 'unknown'],
      'no embedded Rust consumer was found for this fixture',
      {
        full: true,
      },
    );
  }
  if (
    file.startsWith('site/') ||
    file.startsWith('docs/guide/') ||
    file.startsWith('scripts/site/') ||
    file.startsWith('assets/')
  ) {
    return impact('1', ['website'], 'website content or tooling changed', {
      gates: ['pages-build'],
    });
  }
  if (file.endsWith('.md') || file.startsWith('docs/') || /^(?:LICENSE|NOTICE)$/.test(file)) {
    return impact('0', ['documentation'], 'only documentation or license prose changed');
  }
  if (file.startsWith('.semgrep/')) {
    return impact('1C', ['ci', 'security'], 'SAST rules or fixtures changed', {
      gates: ['sast'],
      legacyRust: true,
      legacyFrontend: true,
    });
  }
  if (file === 'scripts/checks/sast.ts') {
    return impact('1C', ['ci', 'security'], 'the SAST runner changed', { gates: ['sast'] });
  }
  if (file === 'scripts/checks/rust-check-linux.ts') {
    return impact('1C', ['ci', 'rust'], 'the Linux Rust check runner changed', {
      gates: ['rust-linux'],
    });
  }
  if (file.startsWith('scripts/checks/')) {
    return impact('1C', ['ci', 'test-tooling'], 'check tooling or its baseline changed');
  }
  if (file.startsWith('scripts/coverage/')) {
    return impact('1C', ['ci', 'coverage'], 'coverage tooling or floors changed', {
      gates: ['rust-coverage'],
      legacyRust: true,
    });
  }
  if (file.startsWith('scripts/release/')) {
    return impact('1C', ['ci', 'release'], 'release tooling changed');
  }
  if (
    file.startsWith('.github/') ||
    /^(?:eslint|vitest)\.config\.ts$/.test(file) ||
    /^\.prettier(?:rc\.json|ignore)$/.test(file)
  ) {
    return impact(
      '1C',
      ['ci', 'test-tooling'],
      'CI, lint, formatting or unit-test configuration changed',
    );
  }
  if (file === 'playwright.config.ts') {
    return impact(
      '3',
      ['frontend', 'visual', 'website'],
      'visual and website browser configuration changed',
      {
        frontend: true,
        gates: ['pages-build'],
      },
    );
  }
  if (/^tsconfig[^/]*\.json$/.test(file)) {
    return impact('3', ['frontend', 'build'], 'TypeScript configuration changed', {
      frontend: true,
    });
  }
  if (file.startsWith('public/')) {
    return impact('3', ['frontend'], 'a renderer public asset changed', {
      frontend: true,
      gates: file === 'public/favicon.ico' ? ['pages-build'] : undefined,
    });
  }
  if (/^scripts\/.*\.ts$/.test(file)) {
    return impact('3', ['frontend', 'test-tooling'], 'a TypeScript project tool changed', {
      frontend: true,
    });
  }
  if (
    file.startsWith('scripts/') ||
    /^(?:\.gitattributes|\.gitignore|\.editorconfig)$/.test(file)
  ) {
    return impact('1C', ['ci', 'test-tooling'], 'repository tooling changed');
  }
  return impact('4', ['unknown'], 'the changed path has no proven owner', {
    full: true,
    legacyRust: true,
    legacyFrontend: true,
  });
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

export function classifyChangeSet(
  paths: Iterable<string>,
  context: ClassificationContext = { source: 'explicit', base: null, head: null },
  includes: readonly string[] = discoverRustIncludes(),
): ChangeClassification {
  const changedFiles = [...new Set([...paths].map(normalizePath).filter(Boolean))].sort();
  const rustIncludes = new Set(includes);
  const risks: RiskLevel[] = [];
  const subsystems = new Set<string>();
  const gateReasons = new Map<GateId, { reasons: Set<string>; platforms: Set<Platform> }>();
  let legacyRust = false;
  let legacyFrontend = false;

  const addGate = (
    id: GateId,
    reason: string,
    platforms: readonly Platform[] = GATE_DEFINITIONS[id].platforms,
  ) => {
    const gate = gateReasons.get(id) ?? {
      reasons: new Set<string>(),
      platforms: new Set<Platform>(),
    };
    gate.reasons.add(reason);
    for (const platform of platforms) gate.platforms.add(platform);
    gateReasons.set(id, gate);
  };
  for (const gate of BASE_GATES) addGate(gate, 'every change requires the baseline checks');

  const apply = (item: PathImpact, file: string) => {
    risks.push(item.risk);
    for (const subsystem of item.subsystems) subsystems.add(subsystem);
    const reason = `${file}: ${item.reason}`;
    legacyRust ||= item.legacyRust ?? item.rust ?? item.full ?? false;
    legacyFrontend ||= item.legacyFrontend ?? item.frontend ?? item.full ?? false;
    if (item.full) for (const gate of FULL_GATES) addGate(gate, reason);
    if (item.rust) for (const gate of RUST_GATES) addGate(gate, reason);
    if (item.frontend) for (const gate of FRONTEND_GATES) addGate(gate, reason);
    for (const gate of item.gates ?? []) {
      addGate(gate, reason, gate === 'packaged-smoke' ? item.smokePlatforms : undefined);
    }
  };

  if (context.forceFull) {
    apply(
      impact('4', ['full'], 'a full run was explicitly requested', { full: true }),
      'force-all',
    );
  } else {
    for (const file of changedFiles) apply(classifyPath(file, rustIncludes), file);
  }

  const requiredGates = Object.keys(GATE_DEFINITIONS)
    .filter((id): id is GateId => gateReasons.has(id as GateId))
    .map((id) => {
      const gate = gateReasons.get(id)!;
      return {
        id,
        platforms: [...gate.platforms].sort(),
        placement: [...GATE_DEFINITIONS[id].placement],
        reasons: [...gate.reasons].sort(),
      };
    });
  return {
    changedFiles,
    source: context.source,
    base: context.base,
    head: context.head,
    risk: risks.reduce<RiskLevel>(
      (highest, risk) =>
        RISK_LEVELS.indexOf(risk) > RISK_LEVELS.indexOf(highest) ? risk : highest,
      '0',
    ),
    affectedSubsystems: [...subsystems].sort(),
    requiredGates,
    optionalGates: [],
    invalidationInputs: [...INVALIDATION_INPUTS],
    rust: legacyRust,
    frontend: legacyFrontend,
  };
}

/** Compatibility view used by existing callers. */
export function classifyChanges(
  paths: Iterable<string>,
): Pick<ChangeClassification, 'rust' | 'frontend'> {
  const { rust, frontend } = classifyChangeSet(paths);
  return { rust, frontend };
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
    source: Exclude<ClassificationSource, 'explicit'>;
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
        paths: [],
        context: { source, base: null, head: options.head, forceFull: true },
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
  const source = event === 'pull_request' ? 'pull-request' : event === 'push' ? 'push' : null;
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
  if (option(args, 'force-all') !== undefined || args.includes('--force-all')) {
    collected = { paths: [], context: { ...collected.context, forceFull: true } };
  }
  const result = classifyChangeSet(collected.paths, collected.context);
  const outputs = {
    rust: String(result.rust),
    frontend: String(result.frontend),
    risk: result.risk,
    'required-gates': JSON.stringify(result.requiredGates.map((gate) => gate.id)),
    'optional-gates': JSON.stringify(result.optionalGates.map((gate) => gate.id)),
    classification: JSON.stringify(result),
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
