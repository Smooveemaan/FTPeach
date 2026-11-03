import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  CROSS_LANGUAGE_SOURCES,
  GATE_DEFINITIONS,
  classifyChangeSet,
  classifyChanges,
  collectChangeSet,
  collectGitHubChangeSet,
  discoverRustIncludes,
  splitPaths,
  type ClassificationContext,
  type GateId,
  type GitRunner,
} from '../../../scripts/checks/classify-changes.ts';

const BASE: GateId[] = ['supply-chain', 'lint-test-build'];
const RUST: GateId[] = [
  ...BASE,
  'sast',
  'parser-regressions',
  'rust-linux',
  'rust-test',
  'rust-test-unix',
  'rust-coverage',
  'packaged-smoke',
];
const FRONTEND: GateId[] = [
  ...BASE,
  'sast',
  'visual-regression',
  'i18n-audit-sample',
  'packaged-smoke',
];
const FULL: GateId[] = [
  ...BASE,
  'sast',
  'parser-regressions',
  'rust-linux',
  'rust-test',
  'rust-test-unix',
  'rust-coverage',
  'visual-regression',
  'i18n-audit-sample',
  'packaged-smoke',
];
const CONTEXT: ClassificationContext = {
  source: 'pull-request',
  base: 'base-sha',
  head: 'head-sha',
};

function classify(paths: string[], context = CONTEXT) {
  return classifyChangeSet(paths, context);
}

function gateIds(paths: string[]): GateId[] {
  return classify(paths).requiredGates.map((gate) => gate.id);
}

function decision(paths: string[], context = CONTEXT) {
  const result = classify(paths, context);
  return {
    risk: result.risk,
    affectedSubsystems: result.affectedSubsystems,
    requiredGates: result.requiredGates,
    optionalGates: result.optionalGates,
    invalidationInputs: result.invalidationInputs,
    rust: result.rust,
    frontend: result.frontend,
  };
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

test('every risk level selects its documented concrete gates', () => {
  const cases: Array<[string, string, GateId[]]> = [
    ['0', 'docs/security.md', BASE],
    ['1', 'site/index.html', [...BASE, 'pages-build']],
    ['1T', 'test/unit/tooling/checkDocs.test.ts', BASE],
    ['1C', '.github/workflows/checks.yml', BASE],
    ['2', 'Cargo.lock', RUST],
    ['3', 'src-tauri/src/protocol/ftp.rs', RUST],
    ['4', 'src-tauri/Cargo.toml', FULL],
  ];
  for (const [risk, file, gates] of cases) {
    const result = classify([file]);
    assert.equal(result.risk, risk, file);
    assert.deepEqual(
      result.requiredGates.map((gate) => gate.id),
      gates,
      file,
    );
  }
  assert.equal(classify(['package-lock.json']).risk, '2');
  assert.deepEqual(gateIds(['package-lock.json']), [...FRONTEND, 'pages-build']);
  assert.equal(classify(['src/features/sites/useSites.ts']).risk, '3');
  assert.deepEqual(gateIds(['src/features/sites/useSites.ts']), FRONTEND);
});

test('cross-language, shared, IPC and installer impacts keep their specific gates', () => {
  assert.deepEqual(gateIds(['src/i18n/locales/en.json']), FULL);
  assert.deepEqual(gateIds(['src/styles/layout.css']), FRONTEND);
  assert.deepEqual(gateIds(['src/components/Dialog.tsx']), FRONTEND);
  assert.deepEqual(gateIds(['src/platform/ipcContracts.ts']), FULL);
  assert.deepEqual(gateIds(['src-tauri/src/commands/sites.rs']), FULL);
  assert.deepEqual(gateIds(['src-tauri/capabilities/main.json']), FULL);
  assert.deepEqual(gateIds(['src-tauri/tauri.conf.json']), [...FULL, 'installer']);
  assert.deepEqual(gateIds(['src-tauri/icons/icon.png']), [...FULL, 'installer']);
  assert.deepEqual(gateIds(['src-tauri/src/runtime/updater.rs']), [...FULL, 'installer']);
  assert.deepEqual(gateIds(['scripts/release/test-installers.ts']), [...FULL, 'installer']);
});

test('Windows smoke tooling selects only Windows smoke in the authoritative plan', () => {
  const result = classify(['scripts/packaged-smoke/smoke.ts']);
  assert.equal(result.risk, '4');
  assert.deepEqual(result.requiredGates, [
    {
      id: 'supply-chain',
      platforms: ['linux'],
      placement: ['local', 'github'],
      reasons: ['every change requires the baseline checks'],
    },
    {
      id: 'lint-test-build',
      platforms: ['linux'],
      placement: ['local', 'github'],
      reasons: ['every change requires the baseline checks'],
    },
    {
      id: 'packaged-smoke',
      platforms: ['windows'],
      placement: ['local', 'github'],
      reasons: ['scripts/packaged-smoke/smoke.ts: Windows packaged smoke tooling changed'],
    },
  ]);
  assert.deepEqual(
    { rust: result.rust, frontend: result.frontend },
    { rust: true, frontend: true },
    'legacy outputs keep the current workflow conservative until it consumes gate IDs',
  );
});

test('mixed changes take the highest risk and the union of every lower-level gate', () => {
  const result = classify(['README.md', 'site/index.html', 'src/components/Menu.tsx']);
  assert.equal(result.risk, '3');
  assert.deepEqual(
    result.requiredGates.map((gate) => gate.id),
    [...FRONTEND, 'pages-build'],
  );
  const docsAndCode = classify(['docs/architecture.md', 'src-tauri/src/lib.rs']);
  assert.equal(docsAndCode.risk, '4');
  assert.deepEqual(
    docsAndCode.requiredGates.map((gate) => gate.id),
    FULL,
  );
  assert.ok(docsAndCode.requiredGates.every((gate) => gate.reasons.length > 0));
});

test('unknown paths and classifier edits independently force the full public suite', () => {
  for (const file of [
    'unmapped/file.dat',
    'scripts/checks/classify-changes.ts',
    'test/unit/tooling/classifyChanges.test.ts',
  ]) {
    const result = classify([file]);
    assert.equal(result.risk, '4', file);
    assert.deepEqual(
      result.requiredGates.map((gate) => gate.id),
      FULL,
      file,
    );
    assert.deepEqual(result.optionalGates, [], file);
  }
});

test('automatically discovered Rust includes select Rust without hiding website impact', () => {
  const includes = discoverRustIncludes();
  for (const file of CROSS_LANGUAGE_SOURCES) assert.ok(includes.includes(file), file);
  assert.ok(includes.includes('docs/guide/protocol-reference.md'));
  assert.ok(includes.includes('test/fixtures/updater/dummy-update.bin'));
  assert.deepEqual(gateIds(['test/fixtures/updater/dummy-update.bin']), RUST);
  assert.deepEqual(gateIds(['docs/guide/protocol-reference.md']), [...RUST, 'pages-build']);
  assert.deepEqual(gateIds(['test/fixtures/not-embedded/cases.json']), FULL);
});

test('tests-only, shared helpers, locales and configuration keep distinct impacts', () => {
  assert.equal(classify(['test/component/helpers/render.tsx']).risk, '1T');
  assert.deepEqual(gateIds(['test/component/helpers/render.tsx']), BASE);
  assert.deepEqual(gateIds(['test/visual/helpers.ts']), FRONTEND);
  assert.deepEqual(gateIds(['src/i18n/locales/de.json']), FRONTEND);
  assert.deepEqual(gateIds(['.semgrep/security.yml']), [...BASE, 'sast']);
  assert.deepEqual(gateIds(['scripts/coverage/coverage-floors.json']), [...BASE, 'rust-coverage']);
  assert.deepEqual(gateIds(['test/e2e/install.vm.ts']), [...FULL, 'installer']);
});

test('every remaining path rule has a concrete risk and gate oracle', () => {
  const cases: Array<[string, string, GateId[]]> = [
    ['4', 'scripts/test-servers/iis.ps1', [...BASE, 'installer']],
    ['4', 'src-tauri/unmapped.dat', FULL],
    ['2', 'src-tauri/Cargo.lock', RUST],
    ['1C', 'test/e2e/transfer.vm.ts', BASE],
    ['1', 'test/unit/tooling/siteBuild.test.ts', [...BASE, 'pages-build']],
    ['1', 'docs/guide/index.md', [...BASE, 'pages-build']],
    ['1C', 'scripts/checks/sast.ts', [...BASE, 'sast']],
    ['1C', 'scripts/checks/rust-check-linux.ts', [...BASE, 'rust-linux']],
    ['1C', 'scripts/checks/check-generated-docs.ts', BASE],
    ['1C', 'scripts/release/portable.ts', BASE],
    ['3', 'playwright.config.ts', [...FRONTEND, 'pages-build']],
    ['3', 'tsconfig.json', FRONTEND],
    ['3', 'public/favicon.ico', [...FRONTEND, 'pages-build']],
    ['3', 'scripts/benchmarks/benchmark-frontend.ts', FRONTEND],
    ['1C', 'scripts/test-servers/ftp.ps1', BASE],
    ['1C', '.gitignore', BASE],
  ];
  for (const [risk, file, gates] of cases) {
    assert.equal(classify([file]).risk, risk, file);
    assert.deepEqual(gateIds([file]), gates, file);
  }
});

test('gate decisions explain their reasons, platforms and local/GitHub placement', () => {
  const result = classify(['src/i18n/locales/en.json'], {
    source: 'branch',
    base: 'old-base',
    head: 'new-head',
  });
  assert.equal(result.base, 'old-base');
  assert.equal(result.head, 'new-head');
  assert.equal(result.source, 'branch');
  assert.ok(result.invalidationInputs.includes('test-config-fixtures-and-helpers'));
  assert.ok(result.invalidationInputs.includes('whole-unfiltered-suite'));
  for (const gate of result.requiredGates) {
    assert.deepEqual(gate.placement, GATE_DEFINITIONS[gate.id].placement);
    assert.ok(gate.platforms.length > 0, gate.id);
    assert.ok(gate.reasons.length > 0, gate.id);
  }
  const smoke = result.requiredGates.find((gate) => gate.id === 'packaged-smoke');
  assert.deepEqual(smoke?.platforms, ['linux', 'macos', 'windows']);
});

test('deleted and renamed paths use the same impact rules as additions', () => {
  assert.deepEqual(
    gateIds(['src/shared/settingsDefaults.json', 'docs/a.md']),
    gateIds(['src/shared/settingsDefaults.json']),
  );
  assert.deepEqual(classifyChanges(['src-tauri/src/lib.rs']), { rust: true, frontend: true });
  assert.deepEqual(classifyChanges(['src/i18n/locales/de.json']), {
    rust: false,
    frontend: true,
  });
  assert.deepEqual(classifyChanges(['docs/a.md']), { rust: false, frontend: false });
});

test('empty, NUL-separated and line-separated input is read the way git writes it', () => {
  assert.deepEqual(splitPaths(''), ['']);
  assert.deepEqual(splitPaths('\0\0'), ['', '', '']);
  assert.deepEqual(classify(splitPaths('')).changedFiles, []);
  assert.deepEqual(
    classify(splitPaths('docs/a.md\0src-tauri/src/protocol/ftp.rs\0')).changedFiles,
    ['docs/a.md', 'src-tauri/src/protocol/ftp.rs'],
  );
  assert.deepEqual(classify(splitPaths('docs/a.md\nsrc/main.tsx\n')).risk, '4');
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
  assert.deepEqual(
    result.requiredGates.map((gate) => gate.id),
    FRONTEND,
  );
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
  assert.equal(result.risk, '4');
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
  assert.equal(classifyChangeSet(after.paths, after.context, []).risk, '4');
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
  assert.deepEqual(decision(local.paths, local.context), decision(pr.paths, pr.context));
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

test('force-all and a new push base conservatively select every public check', () => {
  const forced = collectGitHubChangeSet({
    GITHUB_EVENT_NAME: 'pull_request',
    FORCE_ALL: 'true',
    BASE_SHA: 'base',
    HEAD_SHA: 'head',
  });
  assert.deepEqual(gateIds(forced.paths), BASE, 'the helper alone does not apply force-all');
  const forcedResult = classifyChangeSet(forced.paths, forced.context, []);
  assert.equal(forcedResult.risk, '4');
  assert.deepEqual(
    forcedResult.requiredGates.map((gate) => gate.id),
    FULL,
  );

  const newPush = collectGitHubChangeSet({
    GITHUB_EVENT_NAME: 'push',
    BASE_SHA: '0000000000000000000000000000000000000000',
    HEAD_SHA: 'head',
  });
  assert.equal(newPush.context.forceFull, true);
  assert.deepEqual(
    classifyChangeSet(newPush.paths, newPush.context, []).requiredGates.map((gate) => gate.id),
    FULL,
  );
});

test('the JSON CLI preserves the stable contract and compatibility outputs', () => {
  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/checks/classify-changes.ts', '--json'],
    { input: 'docs/a.md\0', encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.risk, '0');
  assert.equal(result.source, 'explicit');
  assert.deepEqual(result.changedFiles, ['docs/a.md']);
  assert.deepEqual(
    result.requiredGates.map((gate: { id: GateId }) => gate.id),
    BASE,
  );
  assert.equal(result.rust, false);
  assert.equal(result.frontend, false);
});
