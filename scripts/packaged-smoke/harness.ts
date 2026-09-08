import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDirectory, '..', '..');
const APP_PATH = path.join(REPO_ROOT, '.tools', 'smoke-target', 'debug', 'app.exe');

export async function runPackagedSmoke(timeoutMs = 30_000) {
  const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'ftpeach-smoke-'));
  const resultPath = path.join(isolatedRoot, 'result.txt');
  const child = spawn(APP_PATH, [], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      APPDATA: isolatedRoot,
      LOCALAPPDATA: isolatedRoot,
      FTPEACH_SMOKE_TEST: '1',
      FTPEACH_SMOKE_RESULT: resultPath,
    },
    stdio: process.env.TAURI_DRIVER_DEBUG ? 'inherit' : 'ignore',
  });

  try {
    const deadline = Date.now() + timeoutMs;
    let lastPhase = 'process-started';
    let successReported = false;
    while (Date.now() < deadline) {
      if (existsSync(resultPath)) {
        const result = readFileSync(resultPath, 'utf8');
        lastPhase = result;
        if (result === 'ok') successReported = true;
        if (result === 'backend-ready') {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        if (!successReported) throw new Error(result);
      }
      if (child.exitCode !== null) {
        if (successReported && child.exitCode === 0) return;
        throw new Error(`FTPeach smoke process exited early with code ${child.exitCode}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `packaged smoke test timed out after ${timeoutMs} ms (last phase: ${lastPhase})`,
    );
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}
