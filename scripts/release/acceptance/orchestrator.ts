import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { sha256, verifyCandidate } from '../candidate.ts';

export type ScenarioStatus = 'passed' | 'failed' | 'not-run' | 'manual-required';
export interface VmMetadata {
  vmName: string;
  checkpoint: string;
  image: string;
  disposable: boolean;
  webView2: string;
}
export interface ScenarioResult {
  scenario: string;
  status: ScenarioStatus;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  logs: string[];
  facts?: {
    portable?: Record<string, unknown>;
    shell?: Record<string, unknown>;
    notification?: Record<string, unknown>;
  };
  error?: string;
}
export interface AcceptanceAdapter {
  metadata(): Promise<VmMetadata>;
  run(
    _candidateDirectory: string,
    _manifestHash: string,
    _scenario: string,
    _runId: string,
  ): Promise<ScenarioResult>;
  stop(): Promise<void>;
}

export function assertDisposableVm(metadata: VmMetadata): void {
  assert.equal(metadata.disposable, true, 'Candidate acceptance requires a disposable VM');
  assert.ok(
    metadata.vmName && metadata.checkpoint && metadata.image,
    'Identify the VM image and checkpoint',
  );
}

export type AcceptanceScenario = 'candidate-smoke' | 'portable' | 'shell' | 'notification';

export async function runAcceptance(options: {
  candidateId: string;
  candidateDirectory: string;
  resultsDirectory: string;
  toolsSha: string;
  scenario?: AcceptanceScenario;
  adapter: AcceptanceAdapter;
}): Promise<{ report: string; failed: boolean }> {
  const scenario = options.scenario ?? 'candidate-smoke';
  const candidate = await verifyCandidate(options.candidateDirectory);
  const candidateId = `${candidate.build.runId}:${candidate.build.attempt}`;
  assert.equal(candidateId, options.candidateId, 'Candidate ID does not match the manifest');
  const manifestHash = sha256(
    await readFile(path.join(options.candidateDirectory, 'candidate.json')),
  );
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}`;
  const runDirectory = path.join(options.resultsDirectory, runId);
  await mkdir(runDirectory, { recursive: true });
  const result: ScenarioResult = {
    scenario,
    status: 'not-run',
    startedAt: '',
    endedAt: '',
    exitCode: null,
    logs: [],
  };
  const reportPath = path.join(runDirectory, 'result.json');
  let failure: unknown;
  try {
    const metadata = await options.adapter.metadata();
    assertDisposableVm(metadata);
    const startedAt = new Date().toISOString();
    try {
      Object.assign(
        result,
        await options.adapter.run(options.candidateDirectory, manifestHash, scenario, runId),
      );
      assert.equal(result.scenario, scenario);
      assert.equal(result.status, 'passed');
      assert.equal(result.exitCode, 0);
      if (scenario === 'portable') {
        const facts = result.facts?.portable;
        assert.match(String(facts?.uploadedSha256 ?? ''), /^[0-9a-f]{64}$/);
        assert.ok(facts?.notification, 'Portable transfer notification was not observed');
        assert.equal(facts?.notificationName, 'FTPeach');
        assert.ok(facts?.notificationIcon, 'Portable notification icon was not observed');
        assert.equal(facts?.profileIsolated, true);
        assert.equal(facts?.readOnlyRejected, true);
      }
      if (scenario === 'shell') {
        const facts = result.facts?.shell;
        assert.match(String(facts?.dragSha256 ?? ''), /^[0-9a-f]{64}$/);
        assert.ok(facts?.openedWith, 'The text file handler window was not observed');
        for (const fact of [
          'dragCancelled',
          'explorerFileSelected',
          'explorerFolderSelected',
          'explorerMultipleSelection',
          'slowDoubleClickOpened',
          'fastDoubleClickSelectedOnly',
          'noRecycleBin',
          'permanentDeleteCancelled',
          'permanentDeleteConfirmed',
        ]) {
          assert.equal(facts?.[fact], true, `Shell fact was not observed: ${fact}`);
        }
      }
      if (scenario === 'notification') {
        const facts = result.facts?.notification;
        assert.equal(facts?.notificationSetting, 'On');
        assert.equal(facts?.doNotDisturb, 'Off');
        assert.equal(facts?.automaticDoNotDisturbDisabled, true);
        for (const mode of ['trayToast', 'minimizedToast']) {
          const toast = facts?.[mode] as Record<string, unknown> | undefined;
          assert.equal(toast?.text, '3 files transferred');
          assert.equal(
            toast?.name,
            'New notification from FTPeach, Transfer Complete, 3 files transferred.. 1 of 1',
          );
          assert.match(String(toast?.history ?? ''), /^Transfer Complete\s*3 files transferred$/);
          assert.equal(toast?.restored, true);
          assert.equal(toast?.trayRemoved, true);
          const hiddenWindow = toast?.hiddenWindow as Record<string, unknown> | undefined;
          if (mode === 'trayToast') assert.equal(hiddenWindow?.visible, false);
          else assert.equal(hiddenWindow?.minimized, true);
          const foreground = toast?.foreground as Record<string, unknown> | undefined;
          assert.ok(typeof foreground?.handle === 'number' && foreground.handle > 0);
        }
      }
    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      result.endedAt ||= new Date().toISOString();
      failure = error;
    }
    const report = {
      schema: 1,
      runId,
      candidateId,
      applicationSha: candidate.readiness.sha,
      manifestHash,
      toolsSha: options.toolsSha,
      vm: metadata,
      startedAt,
      endedAt: new Date().toISOString(),
      results: [result],
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2));
  } catch (error) {
    failure ||= error;
    result.status = 'failed';
    result.error = error instanceof Error ? error.message : String(error);
    result.endedAt = new Date().toISOString();
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          schema: 1,
          runId,
          candidateId,
          manifestHash,
          toolsSha: options.toolsSha,
          results: [result],
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await options.adapter.stop();
    } catch (error) {
      failure ||= error;
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            schema: 1,
            runId,
            candidateId,
            manifestHash,
            toolsSha: options.toolsSha,
            results: [result],
          },
          null,
          2,
        ),
      );
    }
  }
  return { report: reportPath, failed: failure !== undefined };
}

export class HyperVAdapter implements AcceptanceAdapter {
  private readonly vmName: string;
  private readonly credentialPath: string;
  private readonly guest: boolean;

  constructor(
    vmName = 'ftpeach-runner',
    credentialPath = path.join(process.env.LOCALAPPDATA ?? '', 'ftpeach-runner', 'credential.xml'),
    guest = false,
  ) {
    this.guest = guest;
    this.vmName = vmName;
    this.credentialPath = credentialPath;
  }

  async metadata(): Promise<VmMetadata> {
    return {
      vmName: this.vmName,
      checkpoint: 'clean',
      image: this.vmName,
      disposable:
        process.platform === 'win32' && (!this.guest || process.env.FTPEACH_DISPOSABLE_VM === '1'),
      webView2: 'recorded by the guest scenario',
    };
  }

  async run(
    candidateDirectory: string,
    manifestHash: string,
    scenario: AcceptanceScenario,
    runId: string,
  ): Promise<ScenarioResult> {
    const script = path.join(import.meta.dirname, 'run-vm.ps1');
    try {
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          ...(this.guest ? ['-Guest'] : []),
          '-VMName',
          this.vmName,
          '-CredentialPath',
          this.credentialPath,
          '-CandidateDirectory',
          candidateDirectory,
          '-ManifestHash',
          manifestHash,
          '-Scenario',
          scenario,
          '-RunId',
          runId,
        ],
        { timeout: 10 * 60_000, killSignal: 'SIGTERM', maxBuffer: 1024 * 1024 },
      );
      return JSON.parse(stdout) as ScenarioResult;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.guest || process.platform !== 'win32') return;
    await promisify(execFile)('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Stop-VM -Name '${this.vmName.replaceAll("'", "''")}' -TurnOff -Force -ErrorAction SilentlyContinue`,
    ]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const value = (name: string): string => {
    const index = process.argv.indexOf(name);
    assert.ok(index >= 0 && process.argv[index + 1], `${name} is required`);
    return process.argv[index + 1]!;
  };
  const candidateDirectory = path.resolve(value('--candidate'));
  const candidateId = value('--candidate-id');
  const resultsDirectory = path.resolve(value('--results'));
  const scenarioIndex = process.argv.indexOf('--scenario');
  const scenario = scenarioIndex < 0 ? 'candidate-smoke' : process.argv[scenarioIndex + 1];
  assert.ok(scenario, '--scenario needs a value');
  assert.ok(
    ['candidate-smoke', 'portable', 'shell', 'notification'].includes(scenario),
    'Unknown acceptance scenario',
  );
  const guest = process.argv.includes('--guest');
  const { execFileSync } = await import('node:child_process');
  const toolsSha = execFileSync('git', ['-C', import.meta.dirname, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const { report, failed } = await runAcceptance({
    candidateId,
    candidateDirectory,
    resultsDirectory,
    toolsSha,
    scenario: scenario as AcceptanceScenario,
    adapter: new HyperVAdapter(guest ? 'windows-latest' : undefined, undefined, guest),
  });
  console.log(report);
  if (failed) process.exitCode = 1;
}
