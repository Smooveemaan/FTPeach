import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChangeSet, collectChangeSet, splitPaths } from './classify-changes.ts';

const root = path.resolve(fileURLToPath(import.meta.url), '../../..');
const MAX_CONCURRENCY = 4;
const MAX_TARGETED_FILES = 200;
const FORMAT_CONFIG_PATTERN = /^(?:\.prettier.*|\.editorconfig)$/;
const FORMATTABLE_PATTERN = /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml)$/;
const COMPONENT_RELATED_PATTERN = /^(?:src|test\/component)\/.*\.(?:[cm]?[jt]sx?|json|css)$/;
const COMPONENT_FULL_PATTERN = /^(?:vitest\.config\.ts|test\/component\/helpers\/)/;

export interface Step {
  name: string;
  command: string;
  args: string[];
  hintOnFailure?: string;
}

export interface PreflightPlan {
  parallelSteps: Step[];
  rustSteps: Step[];
}

interface StepResult {
  step: Step;
  ok: boolean;
  duration: string;
  output: string;
}

function runGit(args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

function getUnpushedFiles(): string[] {
  // First try upstream tracking branch
  let base = '';
  const upstream = runGit(['rev-parse', '--abbrev-ref', '@{u}']).trim();
  if (upstream) {
    base = runGit(['merge-base', upstream, 'HEAD']).trim();
  }
  if (!base) {
    base = runGit(['merge-base', 'origin/master', 'HEAD']).trim();
  }
  if (!base) {
    base = runGit(['merge-base', 'master', 'HEAD']).trim();
  }
  if (!base) {
    return [];
  }
  const diff = runGit(['diff', '--no-renames', '--name-only', '-z', base, 'HEAD']);
  return splitPaths(diff).filter(Boolean);
}

function getWorkingTreeFiles(): string[] {
  try {
    const collected = collectChangeSet({ source: 'working-tree', cwd: root });
    return collected.paths.filter(Boolean);
  } catch {
    return [];
  }
}

export function buildPreflightPlan(
  changedFiles: readonly string[],
  options: {
    forceAll?: boolean;
    repoRoot?: string;
    fileExists?: (_relativePath: string) => boolean;
  } = {},
): PreflightPlan {
  const forceAll = options.forceAll ?? false;
  const repoRoot = options.repoRoot ?? root;
  const fileExists = options.fileExists ?? ((rel: string) => existsSync(path.join(repoRoot, rel)));
  const normalized = [
    ...new Set(changedFiles.map((file) => file.replaceAll('\\', '/').replace(/^\.\//, ''))),
  ];

  const classification = classifyChangeSet(normalized, {
    source: forceAll ? 'explicit' : 'branch',
    base: null,
    head: null,
    forceFull: forceAll,
  });

  const parallelSteps: Step[] = [];
  const rustSteps: Step[] = [];

  // 1. Documentation & localized text
  if (classification.requiredChecks.includes('check:docs')) {
    parallelSteps.push({
      name: 'check:docs',
      command: 'npm',
      args: ['run', 'check:docs'],
      hintOnFailure: 'Generated docs are stale. Run "npm run docs:generate" to regenerate them.',
    });
  }

  if (classification.requiredChecks.includes('i18n:check')) {
    parallelSteps.push({
      name: 'i18n:check',
      command: 'npm',
      args: ['run', 'i18n:check'],
      hintOnFailure: 'Locales mismatch en.json. Check missing translation keys or placeholders.',
    });
  }

  if (classification.requiredChecks.includes('check:verified-by')) {
    parallelSteps.push({
      name: 'check:verified-by',
      command: 'npm',
      args: ['run', 'check:verified-by'],
    });
  }

  if (classification.requiredChecks.includes('format:check')) {
    const formatConfigChanged = normalized.some((file) => FORMAT_CONFIG_PATTERN.test(file));
    const formatTargets = normalized.filter(
      (file) => file !== 'package-lock.json' && FORMATTABLE_PATTERN.test(file) && fileExists(file),
    );
    if (forceAll || formatConfigChanged || formatTargets.length > MAX_TARGETED_FILES) {
      parallelSteps.push({
        name: 'format:check',
        command: 'npm',
        args: ['run', 'format:check'],
        hintOnFailure: 'Code style format check failed. Run "npm run format" to format files.',
      });
    } else if (formatTargets.length > 0) {
      const prettierCli = path.join(repoRoot, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
      parallelSteps.push({
        name: `format:check (${formatTargets.length} file${formatTargets.length === 1 ? '' : 's'})`,
        command: process.execPath,
        args: [prettierCli, '--check', '--ignore-unknown', ...formatTargets],
        hintOnFailure: 'Code style format check failed. Run "npm run format" to format files.',
      });
    }
  }

  // 2. Supply chain & hygiene (if supply-chain gate triggered)
  if (classification.requiredGates.includes('supply-chain')) {
    parallelSteps.push({
      name: 'check:tracked-secrets',
      command: 'npm',
      args: ['run', 'check:tracked-secrets'],
      hintOnFailure:
        'Tracked secrets check failed. Verify no credentials or private keys are staged.',
    });
    parallelSteps.push({
      name: 'licenses:check',
      command: 'npm',
      args: ['run', 'licenses:check'],
      hintOnFailure: 'Third party notices are out of date. Run "npm run licenses:generate".',
    });
    parallelSteps.push({
      name: 'check:no-cyrillic',
      command: 'npm',
      args: ['run', 'check:no-cyrillic'],
    });
    parallelSteps.push({
      name: 'check:rust-boundaries',
      command: 'npm',
      args: ['run', 'check:rust-boundaries'],
    });
    parallelSteps.push({
      name: 'check:command-acl',
      command: 'npm',
      args: ['run', 'check:command-acl'],
    });
  }

  if (
    classification.requiredGates.includes('lint-test-build') ||
    classification.requiredGates.includes('rust-test')
  ) {
    parallelSteps.push({
      name: 'check:duplicates',
      command: 'npm',
      args: ['run', 'check:duplicates'],
      hintOnFailure:
        'Code duplication grew above baseline. See duplication-report/*/jscpd-report.json.',
    });
  }

  // 3. Frontend TypeScript, linting, and tests
  if (classification.requiredGates.includes('lint-test-build')) {
    parallelSteps.push({
      name: 'lint',
      command: 'npm',
      args: ['run', 'lint'],
      hintOnFailure: 'ESLint, feature boundaries, or TypeScript typecheck failed.',
    });
    if (!classification.toolingOnly) {
      parallelSteps.push({
        name: 'test:unit',
        command: 'npm',
        args: ['run', 'test:unit'],
      });
      const fullComponents =
        forceAll || normalized.some((file) => COMPONENT_FULL_PATTERN.test(file));
      const relatedTargets = normalized.filter(
        (file) => COMPONENT_RELATED_PATTERN.test(file) && fileExists(file),
      );
      if (fullComponents || relatedTargets.length > MAX_TARGETED_FILES) {
        parallelSteps.push({
          name: 'test:components',
          command: 'npm',
          args: ['run', 'test:components'],
        });
      } else if (relatedTargets.length > 0) {
        const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
        parallelSteps.push({
          name: 'test:components (related)',
          command: process.execPath,
          args: [vitestCli, 'related', '--run', '--passWithNoTests', ...relatedTargets],
        });
      }
    }
  }

  // 4. Rust checks (serial lane so Cargo does not contend on target locks)
  if (classification.requiredGates.includes('rust-test')) {
    rustSteps.push({
      name: 'cargo fmt check',
      command: 'cargo',
      args: ['fmt', '--all', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--check'],
      hintOnFailure:
        'Rust formatting check failed. Run "cargo fmt --all --manifest-path src-tauri/Cargo.toml".',
    });
    rustSteps.push({
      name: 'rust:check',
      command: 'npm',
      args: ['run', 'rust:check'],
    });
  }

  if (classification.requiredGates.includes('parser-regressions')) {
    rustSteps.push({
      name: 'test:parser-regressions',
      command: 'npm',
      args: ['run', 'test:parser-regressions'],
    });
  }

  return { parallelSteps, rustSteps };
}

function runStep(step: Step): Promise<StepResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const chunks: string[] = [];
    // npm is a .cmd batch file on Windows; pass a single command line to avoid Node DEP0190.
    const child =
      process.platform === 'win32' && step.command === 'npm'
        ? spawn([step.command, ...step.args].join(' '), {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true,
          })
        : spawn(step.command, step.args, {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    child.on('error', (error) => {
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      resolve({ step, ok: false, duration, output: error.message });
    });
    child.on('close', (code) => {
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      resolve({ step, ok: code === 0, duration, output: chunks.join('') });
    });
  });
}

async function runPlan(plan: PreflightPlan): Promise<StepResult[]> {
  const failures: StepResult[] = [];
  let aborted = false;

  const lanes: Step[][] = [
    ...plan.parallelSteps.map((step) => [step]),
    ...(plan.rustSteps.length > 0 ? [plan.rustSteps] : []),
  ];

  let nextLane = 0;
  const worker = async () => {
    while (!aborted) {
      const index = nextLane++;
      const lane = lanes[index];
      if (!lane) return;
      for (const step of lane) {
        if (aborted) return;
        const result = await runStep(step);
        const tag = result.ok ? 'PASS' : 'FAIL';
        console.log(`  [${tag}] ${step.name} (${result.duration}s)`);
        if (!result.ok) {
          failures.push(result);
          aborted = true;
          return;
        }
      }
    }
  };

  const workerCount = Math.min(MAX_CONCURRENCY, lanes.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  const isPrePush = args.includes('--pre-push');
  const forceAll = args.includes('--all') || args.includes('--force-all');
  const autoFix = args.includes('--fix') || args.includes('--generate');

  let changedFiles: string[] = [];

  if (forceAll) {
    console.log('Preflight: running full validation suite (--all requested)...');
  } else if (isPrePush) {
    changedFiles = getUnpushedFiles();
  } else {
    const unpushed = getUnpushedFiles();
    const wt = getWorkingTreeFiles();
    changedFiles = [...new Set([...unpushed, ...wt])];
  }

  if (!forceAll && changedFiles.length === 0) {
    console.log('Preflight OK: no changes detected. Workspace is clean and up to date.');
    return;
  }

  if (!forceAll) {
    console.log(`Preflight: analyzing ${changedFiles.length} changed file(s)...`);
  }

  if (autoFix) {
    console.log('Running automatic generators...');
    spawnSync('npm run generate:all', {
      cwd: root,
      stdio: 'inherit',
      shell: true,
    });
  }

  const plan = buildPreflightPlan(changedFiles, { forceAll });
  const totalSteps = plan.parallelSteps.length + plan.rustSteps.length;
  const start = Date.now();
  console.log(`Preflight running ${totalSteps} targeted check(s) in parallel:\n`);

  const failures = await runPlan(plan);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`\n--- ${failure.step.name} output ---`);
      if (failure.output.trim()) console.error(failure.output.trimEnd());
      if (failure.step.hintOnFailure) {
        console.error(`\n[Hint] ${failure.step.hintOnFailure}`);
      }
    }
    console.error(
      `\n[Preflight ABORTED] ${failures.length} check(s) failed: ${failures.map((f) => f.step.name).join(', ')}.`,
    );
    process.exit(1);
  }

  const totalDuration = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n[Preflight SUCCESS] All ${totalSteps} check(s) passed in ${totalDuration}s.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Preflight internal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
