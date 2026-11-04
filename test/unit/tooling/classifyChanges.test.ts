import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  GATES,
  classifyChangeSet,
  collectChangeSet,
  collectGitHubChangeSet,
  discoverRustIncludes,
  splitPaths,
  type ClassificationContext,
  type GateId,
  type GitRunner,
} from '../../../scripts/checks/classify-changes.ts';

const BASE: GateId[] = ['supply-chain'];
const RUST: GateId[] = [...BASE, 'sast', 'rust-test'];
const FRONTEND: GateId[] = [...BASE, 'lint-test-build', 'sast'];
const BOTH: GateId[] = [...FRONTEND, 'rust-test'];
const CONTEXT: ClassificationContext = { source: 'push', base: 'base-sha', head: 'head-sha' };

function classify(paths: string[], context = CONTEXT) {
  return classifyChangeSet(paths, context);
}
function gateIds(paths: string[]): GateId[] {
  return classify(paths).requiredGates;
}

function fakeGit(responses: Record<string, string>) {
  const calls: string[][] = [];
  const run: GitRunner = (args) => {
    calls.push(args);
    const key = args.join(' ');
    if (!(key in responses)) throw new Error(`unexpected git command: ${key}`);
    return responses[key]!;
  };
  return { calls, run };
}

test('ordinary changes select the affected code without release-only suites', () => {
  const cases: Array<[string, GateId[]]> = [
    ['docs/security.md', BASE],
    ['site/index.html', BASE],
    ['src/styles/layout.css', FRONTEND],
    ['src/features/sites/useSites.ts', FRONTEND],
    ['src/main.tsx', FRONTEND],
    ['src/i18n/locales/de.json', FRONTEND],
    ['test/component/helpers/render.tsx', FRONTEND],
    ['test/unit/tooling/classifyChanges.test.ts', FRONTEND],
    ['scripts/checks/classify-changes.ts', FRONTEND],
    ['test/visual/helpers.ts', FRONTEND],
    ['playwright.config.ts', FRONTEND],
    ['tsconfig.json', FRONTEND],
    ['src-tauri/src/runtime/updater.rs', RUST],
    ['src-tauri/Cargo.toml', RUST],
    ['src-tauri/Cargo.lock', RUST],
    ['src-tauri/tauri.conf.json', RUST],
    ['src-tauri/capabilities/main.json', RUST],
    ['rust-toolchain.toml', RUST],
    ['src/platform/ipcContracts.ts', BOTH],
    ['src-tauri/src/commands/sites.rs', BOTH],
    ['package.json', BOTH],
    ['package-lock.json', BOTH],
    ['.github/workflows/checks.yml', BOTH],
    ['.semgrep/security.yml', [...BASE, 'sast']],
    ['scripts/checks/sast.ts', FRONTEND],
    ['src-tauri/src/protocol/ftp.rs', [...BASE, 'sast', 'parser-regressions', 'rust-test']],
    ['src-tauri/fuzz/src/list.rs', [...BASE, 'sast', 'parser-regressions', 'rust-test']],
    ['unmapped/file.dat', [...FRONTEND, 'parser-regressions', 'rust-test']],
  ];
  for (const [file, gates] of cases) assert.deepEqual(gateIds([file]), gates, file);
});

test('mixed paths union their checks and normalize Windows paths without duplicates', () => {
  assert.deepEqual(
    gateIds(['README.md', './src/main.tsx', 'src-tauri\\src\\runtime\\updater.rs', 'src/main.tsx']),
    BOTH,
  );
  assert.deepEqual(classify(splitPaths('docs/a.md\0src/main.tsx\0')).changedFiles, [
    'docs/a.md',
    'src/main.tsx',
  ]);
  assert.deepEqual(gateIds(splitPaths('')), BASE);
  assert.deepEqual(gateIds(splitPaths('docs/a.md\nsrc/main.tsx\n')), FRONTEND);
});

test('embedded files select Rust as well as their own consumers', () => {
  const includes = discoverRustIncludes();
  for (const file of [
    'src/shared/settingsDefaults.json',
    'src/shared/executableExtensions.json',
    'src/i18n/locales/en.json',
    'docs/guide/protocol-reference.md',
    'test/fixtures/updater/dummy-update.bin',
  ])
    assert.ok(includes.includes(file), file);
  assert.deepEqual(gateIds(['src/i18n/locales/en.json']), BOTH);
  assert.deepEqual(gateIds(['docs/guide/protocol-reference.md']), RUST);

  const root = mkdtempSync(path.join(tmpdir(), 'ftpeach-includes-'));
  try {
    mkdirSync(path.join(root, 'src-tauri/src'), { recursive: true });
    writeFileSync(
      path.join(root, 'src-tauri/src/lib.rs'),
      'const X: &str = include_str!("../../shared/config.json");',
    );
    const discovered = discoverRustIncludes(root);
    assert.deepEqual(discovered, ['shared/config.json']);
    assert.deepEqual(
      classifyChangeSet(['shared/config.json'], CONTEXT, discovered).requiredGates,
      RUST,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every selected gate controls its actual workflow job', () => {
  const workflow = readFileSync('.github/workflows/checks.yml', 'utf8').split('\njobs:')[1]!;
  const jobs = new Map(
    [...workflow.matchAll(/^ {2}([\w-]+):\r?\n([\s\S]*?)(?=^ {2}[\w-]+:|$(?![\s\S]))/gm)].map(
      (match) => [match[1], match[2]],
    ),
  );
  assert.deepEqual([...jobs.keys()].filter((id) => id !== 'changes').sort(), [...GATES].sort());
  for (const id of GATES) {
    if (id === 'supply-chain') continue;
    assert.ok(jobs.get(id)?.includes('needs: changes'), id);
    assert.ok(
      jobs
        .get(id)
        ?.includes(`if: contains(fromJSON(needs.changes.outputs.required-gates), '${id}')`),
      id,
    );
  }
  assert.doesNotMatch(workflow, /outputs\.(?:rust|frontend|risk)/);
  assert.match(workflow, /run: npm test\r?\n\s+if: \$\{\{ !inputs.force-all \}\}/);
  assert.match(workflow, /run: npm run coverage\r?\n\s+if: inputs.force-all/);
});

test('working-tree collection unions staged, unstaged and untracked paths', () => {
  const { calls, run } = fakeGit({
    'rev-parse --verify HEAD^{commit}': 'head-sha\n',
    'diff --no-renames --name-only -z HEAD': 'src/app/App.tsx\0docs/a.md\0',
    'ls-files --others --exclude-standard -z': 'scripts/checks/new.ts\0src/app/App.tsx\0',
  });
  const collected = collectChangeSet({ source: 'working-tree' }, run);
  const result = classifyChangeSet(collected.paths, collected.context, []);
  assert.deepEqual(result.changedFiles, ['docs/a.md', 'scripts/checks/new.ts', 'src/app/App.tsx']);
  assert.deepEqual(result.requiredGates, FRONTEND);
  assert.equal(result.base, 'head-sha');
  assert.equal(result.head, 'head-sha');
  assert.equal(result.source, 'working-tree');
  assert.ok(calls.some((args) => args.includes('--no-renames')));
});

test('branch collection diffs the merge base through HEAD, not the last commit', () => {
  const { calls, run } = fakeGit({
    'rev-parse --verify HEAD^{commit}': 'head-sha\n',
    'merge-base origin/master head-sha': 'base-sha\n',
    'rev-parse --verify base-sha^{commit}': 'base-sha\n',
    'diff --no-renames --name-only -z base-sha head-sha': 'docs/a.md\0src-tauri/src/lib.rs\0',
  });
  const collected = collectChangeSet({ source: 'branch' }, run);
  const result = classifyChangeSet(collected.paths, collected.context, []);
  assert.equal(result.base, 'base-sha');
  assert.equal(result.head, 'head-sha');
  assert.ok(result.requiredGates.includes('rust-test'));
  assert.ok(
    calls.some((args) => args.join(' ') === 'diff --no-renames --name-only -z base-sha head-sha'),
  );
});

test('pull-request collection uses the supplied full base/head diff and records updates', () => {
  const first = fakeGit({
    'rev-parse --verify base-1^{commit}': 'base-1\n',
    'rev-parse --verify head-1^{commit}': 'head-1\n',
    'diff --no-renames --name-only -z base-1 head-1': 'src/app/App.tsx\0',
  });
  const updated = fakeGit({
    'rev-parse --verify base-2^{commit}': 'base-2\n',
    'rev-parse --verify head-2^{commit}': 'head-2\n',
    'diff --no-renames --name-only -z base-2 head-2': 'src/app/App.tsx\0src-tauri/src/lib.rs\0',
  });
  const before = collectChangeSet(
    { source: 'pull-request', base: 'base-1', head: 'head-1' },
    first.run,
  );
  const after = collectChangeSet(
    { source: 'pull-request', base: 'base-2', head: 'head-2' },
    updated.run,
  );
  assert.deepEqual(before.context, { source: 'pull-request', base: 'base-1', head: 'head-1' });
  assert.deepEqual(after.context, { source: 'pull-request', base: 'base-2', head: 'head-2' });
  assert.deepEqual(classifyChangeSet(after.paths, after.context, []).requiredGates, BOTH);
});

test('local and pull-request modes make the same decision for the same files', () => {
  const local = collectChangeSet(
    { source: 'working-tree' },
    fakeGit({
      'rev-parse --verify HEAD^{commit}': 'local-head\n',
      'diff --no-renames --name-only -z HEAD': 'src/i18n/locales/en.json\0',
      'ls-files --others --exclude-standard -z': '',
    }).run,
  );
  const pr = collectChangeSet(
    { source: 'pull-request', base: 'pr-base', head: 'pr-head' },
    fakeGit({
      'rev-parse --verify pr-base^{commit}': 'pr-base\n',
      'rev-parse --verify pr-head^{commit}': 'pr-head\n',
      'diff --no-renames --name-only -z pr-base pr-head': 'src/i18n/locales/en.json\0',
    }).run,
  );
  assert.deepEqual(
    classify(local.paths, local.context).requiredGates,
    classify(pr.paths, pr.context).requiredGates,
  );
});

test('Git failures and unsupported events are explicit errors, never empty PASS plans', () => {
  assert.throws(
    () =>
      collectChangeSet({ source: 'working-tree' }, () => {
        throw new Error('git unavailable');
      }),
    /git unavailable/,
  );
  assert.throws(
    () =>
      collectChangeSet({ source: 'pull-request', base: 'missing', head: 'head' }, () => {
        throw new Error('base is unavailable');
      }),
    /base is unavailable/,
  );
  assert.throws(
    () => collectGitHubChangeSet({ GITHUB_EVENT_NAME: 'issue_comment' }),
    /Unsupported GitHub event: issue_comment/,
  );
  assert.throws(
    () => collectChangeSet({ source: 'pull-request', base: '000000', head: 'head' }),
    /cannot have an empty base commit/,
  );
});

test('releases and manual full runs select every shared check without a base diff', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    const collected = collectGitHubChangeSet({
      GITHUB_EVENT_NAME: event,
      FORCE_ALL: 'true',
      HEAD_SHA: 'head',
    });
    assert.deepEqual(
      classifyChangeSet(collected.paths, collected.context, []).requiredGates,
      GATES,
    );
  }
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /workflow_dispatch:/);
  assert.ok(ci.includes("force-all: ${{ github.event_name == 'workflow_dispatch' }}"));
  const release = readFileSync('.github/workflows/release.yml', 'utf8');
  assert.match(
    release,
    /uses: \.\/\.github\/workflows\/checks.yml\r?\n\s+with:\r?\n\s+force-all: true/,
  );
  assert.throws(
    () => collectGitHubChangeSet({ GITHUB_EVENT_NAME: 'workflow_dispatch' }),
    /requires FORCE_ALL/,
  );
});

test('a first push classifies the whole tree without automatically running release suites', () => {
  const { run } = fakeGit({
    'rev-parse --verify head^{commit}': 'head',
    'ls-tree -r --name-only -z head': 'src/main.tsx\0src-tauri/src/lib.rs\0',
  });
  const collected = collectGitHubChangeSet(
    { GITHUB_EVENT_NAME: 'push', BASE_SHA: '000000', HEAD_SHA: 'head' },
    run,
  );
  assert.deepEqual(classifyChangeSet(collected.paths, collected.context, []).requiredGates, BOTH);
});

test('the CLI writes the selected job IDs for GitHub and supports explicit full runs', () => {
  for (const args of [[], ['--force-all'], ['--force-all=false']]) {
    const run = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/checks/classify-changes.ts', ...args],
      { input: 'src/main.tsx\0', encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      JSON.parse(run.stdout.trim().replace(/^required-gates=/, '')),
      args.includes('--force-all') ? GATES : FRONTEND,
    );
  }
});
