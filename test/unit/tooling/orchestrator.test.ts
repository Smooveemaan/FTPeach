import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { candidateNames, sha256, type Candidate } from '../../../scripts/release/candidate.ts';
import {
  assertDisposableVm,
  HyperVAdapter,
  runAcceptance,
  type AcceptanceAdapter,
  type ScenarioResult,
  type VmMetadata,
} from '../../../scripts/release/acceptance/orchestrator.ts';

test('workflow guest mode refuses a missing disposable marker', async (t) => {
  const previous = process.env.FTPEACH_DISPOSABLE_VM;
  delete process.env.FTPEACH_DISPOSABLE_VM;
  t.after(() => {
    if (previous === undefined) delete process.env.FTPEACH_DISPOSABLE_VM;
    else process.env.FTPEACH_DISPOSABLE_VM = previous;
  });
  const metadata = await new HyperVAdapter(undefined, undefined, true).metadata();
  assert.throws(() => assertDisposableVm(metadata), /disposable VM/);
});

test(
  'guest PowerShell preserves a scalar manifest hash argument',
  { skip: process.platform !== 'win32' },
  () => {
    const source = path
      .resolve(import.meta.dirname, '../../../scripts/release/acceptance/run-vm.ps1')
      .replaceAll("'", "''");
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `
    $tokens=$null; $errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile('${source}', [ref]$tokens, [ref]$errors)
    if ($errors) { throw 'Invalid PowerShell' }
    $function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-InVM'}, $true)
    Invoke-Expression $function.Extent.Text
    $Guest=$true
    Invoke-InVM {param($value) $value} -ArgumentList '${'a'.repeat(64)}'
  `,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(output.trim(), 'a'.repeat(64));
  },
);

const metadata: VmMetadata = {
  vmName: 'test-vm',
  checkpoint: 'clean',
  image: 'test-image',
  disposable: true,
  webView2: 'test',
};

async function fixture(): Promise<{ directory: string; candidate: Candidate }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ftpeach-acceptance-'));
  const files: Record<string, string> = {};
  for (const name of candidateNames('1.2.3')) {
    await writeFile(path.join(directory, name), name);
    files[name] = sha256(name);
  }
  const candidate: Candidate = {
    schema: 1,
    readiness: { sha: 'a'.repeat(40), version: '1.2.3' } as Candidate['readiness'],
    build: { runId: '123', attempt: '2', workflowSha: 'b'.repeat(40), tools: {} },
    files,
  };
  await writeFile(path.join(directory, 'candidate.json'), JSON.stringify(candidate));
  return { directory, candidate };
}

function passed(): ScenarioResult {
  return {
    scenario: 'candidate-smoke',
    status: 'passed',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    exitCode: 0,
    logs: [],
  };
}

function adapter(run: AcceptanceAdapter['run'] = async () => passed()) {
  let stops = 0;
  return {
    adapter: {
      metadata: async () => metadata,
      run,
      stop: async () => {
        stops++;
      },
    } satisfies AcceptanceAdapter,
    stops: () => stops,
  };
}

const options = (directory: string, controller: AcceptanceAdapter) => ({
  candidateId: '123:2',
  candidateDirectory: directory,
  resultsDirectory: path.join(directory, 'results'),
  toolsSha: 'c'.repeat(40),
  adapter: controller,
});

test('candidate smoke records identity and stops the VM after success', async () => {
  const { directory } = await fixture();
  const controller = adapter();
  const { report, failed } = await runAcceptance(options(directory, controller.adapter));
  assert.equal(failed, false);
  assert.equal(controller.stops(), 1);
  const result = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(result.candidateId, '123:2');
  assert.equal(result.applicationSha, 'a'.repeat(40));
  assert.match(result.manifestHash, /^[0-9a-f]{64}$/);
  assert.equal(result.results[0].status, 'passed');
});

test('changed package hash and candidate ID are rejected before VM startup', async () => {
  const { directory } = await fixture();
  const controller = adapter();
  await writeFile(path.join(directory, candidateNames('1.2.3')[0]!), 'changed');
  await assert.rejects(
    runAcceptance(options(directory, controller.adapter)),
    /Candidate file changed/,
  );
  assert.equal(controller.stops(), 0);

  const fresh = await fixture();
  await assert.rejects(
    runAcceptance({ ...options(fresh.directory, controller.adapter), candidateId: '123:3' }),
    /Candidate ID/,
  );
  assert.equal(controller.stops(), 0);
});

test('a non-disposable VM is blocked and cleaned up', async () => {
  const { directory } = await fixture();
  const controller = adapter();
  controller.adapter.metadata = async () => ({ ...metadata, disposable: false });
  const { failed } = await runAcceptance(options(directory, controller.adapter));
  assert.equal(failed, true);
  assert.equal(controller.stops(), 1);
  assert.throws(() => assertDisposableVm({ ...metadata, disposable: false }), /disposable VM/);
});

for (const [name, run] of [
  ['assertion failure', async () => ({ ...passed(), exitCode: 1 })],
  [
    'timeout',
    async () => {
      throw new Error('timed out');
    },
  ],
  [
    'forced process termination',
    async () => {
      throw new Error('killed');
    },
  ],
] as const) {
  test(`cleanup and failed result after ${name}`, async () => {
    const { directory } = await fixture();
    const controller = adapter(run);
    const { report, failed } = await runAcceptance(options(directory, controller.adapter));
    assert.equal(failed, true);
    assert.equal(controller.stops(), 1);
    const result = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(result.results[0].status, 'failed');
  });
}

test('cleanup failure cannot leave a passed result', async () => {
  const { directory } = await fixture();
  const controller = adapter();
  controller.adapter.stop = async () => {
    throw new Error('VM is still running');
  };
  const { report, failed } = await runAcceptance(options(directory, controller.adapter));
  assert.equal(failed, true);
  const result = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(result.results[0].status, 'failed');
});

test('shell requires every native observation', async () => {
  const facts = {
    shell: {
      dragSha256: 'e'.repeat(64),
      dragCancelled: true,
      openedWith: 'notepad',
      explorerFileSelected: true,
      explorerFolderSelected: true,
      explorerMultipleSelection: true,
      slowDoubleClickOpened: true,
      fastDoubleClickSelectedOnly: true,
      noRecycleBin: true,
      permanentDeleteCancelled: true,
      permanentDeleteConfirmed: true,
    },
  };
  const { directory } = await fixture();
  const valid = adapter(async () => ({ ...passed(), scenario: 'shell', facts }));
  const success = await runAcceptance({ ...options(directory, valid.adapter), scenario: 'shell' });
  assert.equal(success.failed, false);

  for (const field of Object.keys(facts.shell)) {
    const brokenFacts = structuredClone(facts);
    delete brokenFacts.shell[field as keyof typeof brokenFacts.shell];
    const broken = adapter(async () => ({ ...passed(), scenario: 'shell', facts: brokenFacts }));
    const outcome = await runAcceptance({
      ...options(directory, broken.adapter),
      scenario: 'shell',
    });
    assert.equal(outcome.failed, true, field);
    assert.equal(broken.stops(), 1);
  }
});

test('notification requires both native toast activation paths', async () => {
  const toast = {
    text: '3 files transferred',
    name: 'New notification from FTPeach, Transfer Complete, 3 files transferred.. 1 of 1',
    history: 'Transfer Complete\n3 files transferred',
    hiddenWindow: { visible: false, minimized: true },
    foreground: { handle: 123 },
    restored: true,
    trayRemoved: true,
  };
  const facts = {
    notification: {
      notificationSetting: 'On',
      doNotDisturb: 'Off',
      automaticDoNotDisturbDisabled: true,
      trayToast: toast,
      minimizedToast: toast,
    },
  };
  const { directory } = await fixture();
  const valid = adapter(async () => ({ ...passed(), scenario: 'notification', facts }));
  const success = await runAcceptance({
    ...options(directory, valid.adapter),
    scenario: 'notification',
  });
  assert.equal(success.failed, false);

  const brokenValues = [
    ['notificationSetting', 'DisabledByUser'],
    ['doNotDisturb', 'On'],
    ['automaticDoNotDisturbDisabled', false],
    ['trayToast', undefined],
    ['minimizedToast', undefined],
    ['trayToast', { ...toast, text: '2 files transferred' }],
    [
      'trayToast',
      {
        ...toast,
        name: 'New notification from another application, Transfer Complete, 3 files transferred.. 1 of 1',
      },
    ],
    ['minimizedToast', { ...toast, restored: false }],
    ['trayToast', { ...toast, trayRemoved: false }],
    ['trayToast', { ...toast, hiddenWindow: { visible: true, minimized: false } }],
    ['minimizedToast', { ...toast, hiddenWindow: { visible: true, minimized: false } }],
    ['trayToast', { ...toast, foreground: { handle: 0 } }],
    ['trayToast', { ...toast, history: 'Another application\n3 files transferred' }],
    ['trayToast', { ...toast, history: 'Transfer Complete13 files transferred' }],
  ] as const;
  for (const [field, value] of brokenValues) {
    const brokenFacts = { notification: { ...facts.notification, [field]: value } };
    const broken = adapter(async () => ({
      ...passed(),
      scenario: 'notification',
      facts: brokenFacts,
    }));
    const outcome = await runAcceptance({
      ...options(directory, broken.adapter),
      scenario: 'notification',
    });
    assert.equal(outcome.failed, true, field);
    assert.equal(broken.stops(), 1);
  }
});

test('portable requires all observed facts', async () => {
  const facts = {
    portable: {
      uploadedSha256: 'd'.repeat(64),
      notification: 'Transfer Complete | 1 file transferred',
      notificationName: 'FTPeach',
      notificationIcon: 'C:\\icon.ico',
      profileIsolated: true,
      readOnlyRejected: true,
    },
  };
  const { directory } = await fixture();
  const valid = adapter(async () => ({ ...passed(), scenario: 'portable', facts }));
  const success = await runAcceptance({
    ...options(directory, valid.adapter),
    scenario: 'portable',
  });
  assert.equal(success.failed, false);

  for (const field of [
    'notification',
    'notificationIcon',
    'profileIsolated',
    'readOnlyRejected',
  ] as const) {
    const brokenFacts = structuredClone(facts);
    delete brokenFacts.portable[field];
    const broken = adapter(async () => ({ ...passed(), scenario: 'portable', facts: brokenFacts }));
    const outcome = await runAcceptance({
      ...options(directory, broken.adapter),
      scenario: 'portable',
    });
    assert.equal(outcome.failed, true, field);
    assert.equal(broken.stops(), 1);
  }
});
