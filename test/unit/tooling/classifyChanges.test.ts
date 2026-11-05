import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CHECKS,
  GATES,
  classifyChangeSet,
  collectChangeSet,
  collectGitHubChangeSet,
  collectPackageChange,
  discoverRustIncludes,
  splitPaths,
  type ClassificationContext,
  type GateId,
  type GitRunner,
} from '../../../scripts/checks/classify-changes.ts';

const BASE: GateId[] = ['supply-chain'];
const TOOLING: GateId[] = [...BASE, 'lint-test-build'];
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
    ['test/unit/tooling/classifyChanges.test.ts', TOOLING],
    ['scripts/checks/classify-changes.ts', TOOLING],
    ['scripts/checks/check-bundle-budget.ts', FRONTEND],
    ['scripts/site/build.ts', BASE],
    ['test/unit/tooling/siteBuild.test.ts', BASE],
    ['test/visual/website-guide.spec.ts', BASE],
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
    ['.github/workflows/checks.yml', TOOLING],
    ['.semgrep/security.yml', [...BASE, 'sast']],
    ['scripts/checks/sast.ts', TOOLING],
    ['src-tauri/src/protocol/ftp.rs', [...BASE, 'sast', 'parser-regressions', 'rust-test']],
    ['src-tauri/fuzz/src/list.rs', [...BASE, 'sast', 'parser-regressions', 'rust-test']],
    ['unmapped/file.dat', [...FRONTEND, 'parser-regressions', 'rust-test']],
  ];
  for (const [file, gates] of cases) assert.deepEqual(gateIds([file]), gates, file);
});

test('check tooling does not build the app, while mixed changes still do', () => {
  assert.equal(classify(['scripts/checks/check-ci-parity.ts']).toolingOnly, true);
  assert.equal(classify(['scripts/checks/check-ci-parity.ts']).site, false);
  assert.equal(classify(['scripts/checks/check-ci-parity.ts', 'src/main.tsx']).toolingOnly, false);
  assert.equal(
    classify(['scripts/checks/check-ci-parity.ts'], { ...CONTEXT, forceFull: true }).toolingOnly,
    false,
  );
});

test('native safety and smoke fixes select their platform checks without a full run', () => {
  assert.deepEqual(gateIds(['src-tauri/src/local_fs/filesystem_safety.rs']), [
    ...RUST,
    'rust-test-unix',
  ]);
  for (const file of [
    'src-tauri/src/commands/smoke.rs',
    'src-tauri/src/runtime/shutdown.rs',
    'src-tauri/assets/smoke_test.js',
    'src-tauri/assets/acl_probe.js',
    'scripts/packaged-smoke/harness.ts',
    'scripts/packaged-smoke/smoke.ts',
    'test/unit/tooling/packagedSmoke.test.ts',
  ]) {
    const gates = gateIds([file]);
    assert.ok(gates.includes('packaged-smoke'), file);
    assert.ok(!gates.includes('rust-coverage'), file);
    assert.ok(!gates.includes('visual-regression'), file);
  }
});

test('baseline quality checks follow their inputs and full runs retain every check', () => {
  const cases: Array<[string, readonly string[]]> = [
    ['README.md', []],
    ['CHANGELOG.md', []],
    ['site/styles.css', []],
    ['docs/development.md', ['check:docs']],
    ['docs/ipc-permissions.md', ['check:docs']],
    ['docs/guide/transfers.md', ['check:verified-by']],
    ['docs/manual-checks.md', ['check:verified-by']],
    ['src/i18n/locales/de.json', ['i18n:check', 'format:check']],
    ['src/features/sites/useSites.ts', ['i18n:check', 'format:check']],
    ['src/shared/settingsDefaults.json', ['format:check']],
    ['src-tauri/src/lib.rs', ['check:docs', 'check:verified-by']],
    ['src-tauri/build.rs', ['check:docs', 'check:verified-by']],
    ['src-tauri/src/runtime/sensitive_plugin.rs', ['check:docs', 'check:verified-by']],
    ['src-tauri/capabilities/default.json', ['check:docs', 'format:check']],
    ['src-tauri/src/protocol/ftp.rs', ['check:verified-by']],
    ['test/unit/file-browser/paths.test.ts', ['check:verified-by', 'format:check']],
    ['test/component/file-browser/panes.test.tsx', ['check:verified-by', 'format:check']],
    ['test/visual/panes.spec.ts', ['check:verified-by', 'format:check']],
    ['scripts/site/build.ts', ['format:check']],
    ['.prettierignore', ['format:check']],
    ['.prettierrc.json', ['format:check']],
    ['.editorconfig', ['format:check']],
    ['.gitignore', ['format:check']],
    ['.github/workflows/pages.yml', ['format:check']],
    ['scripts/checks/check-locales.ts', CHECKS],
    ['scripts/checks/command-acl-source.ts', CHECKS],
    ['.github/workflows/checks.yml', CHECKS],
    ['package.json', CHECKS],
    ['package-lock.json', CHECKS],
  ];
  for (const [file, expected] of cases) {
    const result = classify([file]);
    assert.deepEqual(result.requiredChecks, expected, file);
    assert.ok(result.requiredGates.includes('supply-chain'), file);
  }
  assert.deepEqual(classify([]).requiredChecks, []);
  assert.deepEqual(classify([], { ...CONTEXT, forceFull: true }).requiredChecks, CHECKS);
  assert.deepEqual(
    classify(['docs/development.md', 'src\\i18n\\locales\\de.json']).requiredChecks,
    ['i18n:check', 'check:docs', 'format:check'],
  );
});

test('manifest check commands are isolated, while builds, dependencies and site scripts reach their consumers', () => {
  const before = {
    dependencies: { react: '1' },
    scripts: { check: 'old', build: 'vite build', 'site:test': 'old' },
  };
  const cases: Array<[typeof before, GateId[], boolean, boolean]> = [
    [{ ...before, scripts: { ...before.scripts, check: 'new' } }, TOOLING, true, false],
    [{ ...before, scripts: { ...before.scripts, build: 'new' } }, BOTH, false, false],
    [{ ...before, scripts: { ...before.scripts, 'site:test': 'new' } }, BASE, true, true],
    [{ ...before, dependencies: { react: '2' } }, BOTH, false, true],
    [before, BASE, true, false],
  ];
  for (const [after, gates, toolingOnly, site] of cases) {
    const result = classifyChangeSet(['package.json'], CONTEXT, [], { before, after });
    assert.deepEqual(result.requiredGates, gates);
    assert.equal(result.toolingOnly, toolingOnly);
    assert.equal(result.site, site);
  }
  const deleted = { ...before.scripts };
  delete (deleted as Partial<typeof deleted>).check;
  assert.deepEqual(
    classifyChangeSet(['package.json'], CONTEXT, [], {
      before,
      after: { ...before, scripts: deleted },
    }).requiredGates,
    TOOLING,
  );
  assert.equal(classify(['package.json']).site, true, 'missing comparison is conservative');
  assert.equal(classify(['package-lock.json']).site, true);
  assert.equal(
    classify(['playwright.config.ts']).site,
    true,
    'shared browser config affects Pages',
  );
  const callers = {
    scripts: {
      'check:shared': 'old',
      build: 'npm run check:shared',
      'site:test': 'npm run check:shared',
    },
  };
  const result = classifyChangeSet(['package.json'], CONTEXT, [], {
    before: callers,
    after: { scripts: { ...callers.scripts, 'check:shared': 'new' } },
  });
  assert.deepEqual(result.requiredGates, BOTH);
  assert.equal(result.site, true, 'a check invoked by site:test still requires website checks');
});

test('manifest comparison reads both revisions and uses working contents locally', () => {
  const before = { scripts: { check: 'old' } };
  const after = { scripts: { check: 'new' } };
  const { run } = fakeGit({
    'show base-sha:package.json': JSON.stringify(before),
    'show head-sha:package.json': JSON.stringify(after),
  });
  assert.deepEqual(collectPackageChange(CONTEXT, run), { before, after });
  assert.equal(collectPackageChange({ ...CONTEXT, base: null }, run), undefined);
  assert.deepEqual(
    collectPackageChange({ ...CONTEXT, source: 'working-tree' }, run)?.after,
    JSON.parse(readFileSync('package.json', 'utf8')),
  );
  assert.throws(() => collectPackageChange(CONTEXT, () => '{invalid'), SyntaxError);
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
  assert.deepEqual([...jobs.keys()].sort(), [...GATES, 'changes', 'full-result'].sort());
  const aggregate = jobs.get('full-result')!;
  const required = aggregate
    .match(/needs:\s*\[([\s\S]*?)\]/)![1]!
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  assert.deepEqual(required.sort(), [...GATES, 'changes'].sort());
  assert.ok(aggregate.includes('if: always() && inputs.force-all'));
  assert.doesNotMatch(jobs.get('rust-test-unix')!, /continue-on-error/);
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
  assert.match(workflow, /run: npm test\r?\n\s+if: .*tooling-only != 'true'/);
  assert.match(
    workflow,
    /run: npm run build\r?\n\s+if: needs.changes.outputs.tooling-only != 'true'/,
  );
  assert.match(
    workflow,
    /Test development tooling[\s\S]*?find test\/unit\/tooling.*! -name 'site\*\.test\.ts'/,
  );
  assert.match(workflow, /run: npm run check:duplicates/);
  assert.doesNotMatch(jobs.get('lint-test-build')!, /continue-on-error: true/);
  assert.match(workflow, /run: npm run coverage\r?\n\s+if: inputs.force-all/);
  const baseline = jobs.get('supply-chain')!.replaceAll('\r\n', '\n');
  assert.match(baseline, /needs: changes\r?\n\s+if: \$\{\{ !cancelled\(\) \}\}/);
  for (const check of CHECKS) {
    assert.ok(
      baseline.includes(
        `run: npm run ${check}\n        if: needs.changes.result != 'success' || contains(fromJSON(needs.changes.outputs.required-checks || '[]'), '${check}')`,
      ),
      check,
    );
  }
  for (const check of ['check:tracked-secrets', 'check:command-acl', 'licenses:check']) {
    assert.match(baseline, new RegExp(`run: npm run ${check}\\r?\\n      - `));
  }
  assert.ok(
    readFileSync('.github/workflows/checks.yml', 'utf8').includes(
      'required-checks: ${{ steps.classify.outputs.required-checks }}',
    ),
  );
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
  assert.ok(ci.includes("force-all: ${{ needs.mode.outputs.full == 'true' }}"));
  assert.ok(ci.includes('scripts/release/check-mode.ts'));
  const release = readFileSync('.github/workflows/release-next.yml', 'utf8');
  assert.match(release, /scripts\/release\/verify-readiness.ts/);
  assert.doesNotMatch(release, /uses: \.\/\.github\/workflows\/checks.yml/);
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
      JSON.parse(run.stdout.split(/\r?\n/)[0]!.replace(/^required-gates=/, '')),
      args.includes('--force-all') ? GATES : FRONTEND,
    );
    assert.deepEqual(
      JSON.parse(run.stdout.split(/\r?\n/)[1]!.replace(/^required-checks=/, '')),
      args.includes('--force-all') ? CHECKS : ['i18n:check', 'format:check'],
    );
  }
});
