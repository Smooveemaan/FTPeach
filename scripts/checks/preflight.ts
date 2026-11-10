import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChangeSet, collectChangeSet, splitPaths } from './classify-changes.ts';

const root = path.resolve(fileURLToPath(import.meta.url), '../../..');

interface Step {
  name: string;
  command: string;
  args: string[];
  hintOnFailure?: string;
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

function runStep(step: Step): boolean {
  process.stdout.write(`  -> Running ${step.name}... `);
  const start = Date.now();
  const cmdLine = [step.command, ...step.args].join(' ');
  const res = spawnSync(cmdLine, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  const duration = ((Date.now() - start) / 1000).toFixed(1);
  if (res.status === 0) {
    console.log(`[PASS] (${duration}s)`);
    return true;
  }
  console.log(`[FAIL] (${duration}s)`);
  if (step.hintOnFailure) {
    console.error(`\n[Hint] ${step.hintOnFailure}\n`);
  }
  return false;
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

  const classification = classifyChangeSet(changedFiles, {
    source: forceAll ? 'explicit' : 'branch',
    base: null,
    head: null,
    forceFull: forceAll,
  });

  if (autoFix) {
    console.log('Running automatic generators...');
    spawnSync('npm run generate:all', {
      cwd: root,
      stdio: 'inherit',
      shell: true,
    });
  }

  const steps: Step[] = [];

  // 1. Documentation & localized text
  if (classification.requiredChecks.includes('check:docs')) {
    steps.push({
      name: 'check:docs',
      command: 'npm',
      args: ['run', 'check:docs'],
      hintOnFailure: 'Generated docs are stale. Run "npm run docs:generate" to regenerate them.',
    });
  }

  if (classification.requiredChecks.includes('i18n:check')) {
    steps.push({
      name: 'i18n:check',
      command: 'npm',
      args: ['run', 'i18n:check'],
      hintOnFailure: 'Locales mismatch en.json. Check missing translation keys or placeholders.',
    });
  }

  if (classification.requiredChecks.includes('check:verified-by')) {
    steps.push({
      name: 'check:verified-by',
      command: 'npm',
      args: ['run', 'check:verified-by'],
    });
  }

  if (classification.requiredChecks.includes('format:check')) {
    steps.push({
      name: 'format:check',
      command: 'npm',
      args: ['run', 'format:check'],
      hintOnFailure: 'Code style format check failed. Run "npm run format" to format files.',
    });
  }

  // 2. Supply chain & hygiene (if supply-chain gate triggered)
  if (classification.requiredGates.includes('supply-chain')) {
    steps.push({
      name: 'check:tracked-secrets',
      command: 'npm',
      args: ['run', 'check:tracked-secrets'],
      hintOnFailure:
        'Tracked secrets check failed. Verify no credentials or private keys are staged.',
    });
    steps.push({
      name: 'licenses:check',
      command: 'npm',
      args: ['run', 'licenses:check'],
      hintOnFailure: 'Third party notices are out of date. Run "npm run licenses:generate".',
    });
    steps.push({
      name: 'check:no-cyrillic',
      command: 'npm',
      args: ['run', 'check:no-cyrillic'],
    });
    steps.push({
      name: 'check:rust-boundaries',
      command: 'npm',
      args: ['run', 'check:rust-boundaries'],
    });
    steps.push({
      name: 'check:command-acl',
      command: 'npm',
      args: ['run', 'check:command-acl'],
    });
  }

  // 3. Frontend TypeScript & Linting
  if (classification.requiredGates.includes('lint-test-build')) {
    steps.push({
      name: 'lint',
      command: 'npm',
      args: ['run', 'lint'],
      hintOnFailure: 'ESLint, feature boundaries, or TypeScript typecheck failed.',
    });
    if (!classification.toolingOnly) {
      steps.push({
        name: 'test:unit',
        command: 'npm',
        args: ['run', 'test:unit'],
      });
    }
  }

  // 4. Rust checks
  if (
    classification.requiredGates.includes('rust-test') ||
    classification.requiredGates.includes('rust-linux')
  ) {
    steps.push({
      name: 'cargo fmt check',
      command: 'cargo',
      args: ['fmt', '--all', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--check'],
      hintOnFailure:
        'Rust formatting check failed. Run "cargo fmt --all --manifest-path src-tauri/Cargo.toml".',
    });
    steps.push({
      name: 'rust:check',
      command: 'npm',
      args: ['run', 'rust:check'],
    });
  }

  if (classification.requiredGates.includes('parser-regressions')) {
    steps.push({
      name: 'test:parser-regressions',
      command: 'npm',
      args: ['run', 'test:parser-regressions'],
    });
  }

  console.log(`Preflight running ${steps.length} targeted check(s):\n`);

  for (const step of steps) {
    const ok = runStep(step);
    if (!ok) {
      console.error(`\n[Preflight ABORTED] Check "${step.name}" failed.`);
      process.exit(1);
    }
  }

  console.log('\n[Preflight SUCCESS] All targeted checks passed successfully!');
}

if (import.meta.filename === process.argv[1]) {
  main().catch((err) => {
    console.error(`Preflight internal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
